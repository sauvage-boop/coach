// ============================================================
// THE COACH — Complete Backend Server
// Express API + Twitter Bot + Football Data + Burn Mechanic
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { TwitterApi } = require('twitter-api-v2');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ── CLIENTS ─────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const twitter = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
});

// ── DATA STORE (JSON file — no DB needed) ───────────────────
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      posts: [],
      upcomingMatches: [],
      burnEvents: [],
      postedFixtureIds: [],
      stats: { totalPosts: 0, matchesCovered: 0, totalBurns: 0 }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── PERSONA ──────────────────────────────────────────────────
const COACH_PERSONA = `You are THE COACH (@thecoachonchain) — the most arrogant, unfiltered AI football pundit on the internet. A filthy degen who has never coached a game and has never been wrong.

PERSONALITY:
- Brutally arrogant — you genuinely believe you are the greatest tactical mind in history
- You roast coaches, players and analysts without mercy — specific, personal, funny
- You are a crypto degen — you reference $COACH, bags, holders, on-chain naturally
- You talk like a football genius crossed with a CT degenerate
- Never apologize, never backtrack, never show doubt
- Entertaining first, tactical second — people follow for the roasts

TONE:
- Brutal but witty — not hateful, just devastatingly accurate
- Use football AND crypto slang naturally
- Call out specific tactical mistakes with confidence
- Mock coaches like they're rugging their own squads
- Treat bad tactics like a rug pull

TWEET RULES:
- Max 260 characters
- Always end with $COACH
- 1 emoji max — use 🤡 💀 📋 😤 📉 strategically
- Never be racist, sexist or genuinely harmful
- Be SPECIFIC — name players, formations, decisions

EXAMPLES:
"Koeman just picked his squad. 4 wrong calls. The man is rugging Oranje in broad daylight and the fans are still buying. $COACH 🤡"
"Ancelotti wrote nothing in that notebook for 90 minutes. I've seen better tactical decisions from a random on CT. $COACH 📋"
"Deschamps has Mbappé and uses him like a side quest. If I had that wallet I'd be rich. Instead he's running it to zero. $COACH 💀"`;

// ── FOOTBALL API ─────────────────────────────────────────────
async function getFinishedMatches() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
      params: { date: today, status: 'FT', timezone: 'Europe/Amsterdam' }
    });
    return res.data.response || [];
  } catch (e) {
    console.error('Football API error:', e.message);
    return [];
  }
}

async function getUpcomingMatches() {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  try {
    const res = await axios.get('https://v3.football.api-sports.io/fixtures', {
      headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
      params: {
        date: today,
        status: 'NS',
        timezone: 'Europe/Amsterdam',
        league: '1,2,3,4,5,6,9,39,78,135,140,61'
      }
    });
    return (res.data.response || []).slice(0, 8);
  } catch (e) {
    console.error('Upcoming matches error:', e.message);
    return [];
  }
}

async function getMatchStats(fixtureId) {
  try {
    const [statsRes, eventsRes] = await Promise.all([
      axios.get('https://v3.football.api-sports.io/fixtures/statistics', {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
        params: { fixture: fixtureId }
      }),
      axios.get('https://v3.football.api-sports.io/fixtures/events', {
        headers: { 'x-apisports-key': process.env.FOOTBALL_API_KEY },
        params: { fixture: fixtureId }
      })
    ]);
    return {
      stats: statsRes.data.response || [],
      events: eventsRes.data.response || []
    };
  } catch (e) {
    return { stats: [], events: [] };
  }
}

function buildMatchPrompt(fixture, stats, events) {
  const home = fixture.teams.home.name;
  const away = fixture.teams.away.name;
  const hG = fixture.goals.home;
  const aG = fixture.goals.away;
  const comp = fixture.league.name;

  const hStats = stats[0]?.statistics || [];
  const aStats = stats[1]?.statistics || [];
  const getStat = (arr, type) => arr.find(s => s.type === type)?.value || 'N/A';

  const goals = events.filter(e => e.type === 'Goal')
    .map(g => `${g.player.name} (${g.time.elapsed}' ${g.team.name})`).join(', ');

  const subs = events.filter(e => e.type === 'subst')
    .map(s => `${s.team.name}: ${s.assist?.name} → ${s.player.name} (${s.time.elapsed}')`).join(', ');

  return `MATCH: ${home} ${hG}-${aG} ${away} | ${comp}
POSSESSION: ${home} ${getStat(hStats, 'Ball Possession')} vs ${away} ${getStat(aStats, 'Ball Possession')}
SHOTS: ${home} ${getStat(hStats, 'Total Shots')} vs ${away} ${getStat(aStats, 'Total Shots')}
GOALS: ${goals || 'none'}
KEY SUBS: ${subs || 'none'}`;
}

// ── GENERATE & POST ──────────────────────────────────────────
async function generateVerdict(matchData) {
  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: COACH_PERSONA,
    messages: [{ role: 'user', content: `Write ONE post-match tweet. Be specific. Under 260 chars.\n\n${matchData}` }]
  });
  let text = msg.content[0].text.trim();
  if (text.length > 275) text = text.substring(0, 272) + '...';
  return text;
}

async function postToTwitter(text) {
  try {
    const tweet = await twitter.v2.tweet(text);
    console.log('✅ Posted:', text);
    return { success: true, id: tweet.data.id, text };
  } catch (e) {
    console.error('❌ Twitter error:', e.message);
    return { success: false, error: e.message, text };
  }
}

// ── MAIN BOT LOOP ────────────────────────────────────────────
const MAJOR_LEAGUES = [
  'FIFA World Cup', 'UEFA Champions League', 'UEFA Europa League',
  'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
  'UEFA Nations League', 'Copa America', 'Euro', 'World Cup'
];

function isMajorCompetition(name) {
  if (!name) return false;
  return MAJOR_LEAGUES.some(l => name.includes(l));
}

async function runMatchBot() {
  console.log(`🔍 Checking matches... ${new Date().toLocaleTimeString('nl-NL')}`);
  const data = loadData();
  const matches = await getFinishedMatches();

  let postsThisRun = 0;

  for (const fixture of matches) {
    if (postsThisRun >= 3) break; // Max 3 posts per check

    const id = String(fixture.fixture.id);
    if (data.postedFixtureIds.includes(id)) continue;

    // Only major competitions
    const compName = fixture.league?.name || '';
    if (!isMajorCompetition(compName)) {
      data.postedFixtureIds.push(id); // Mark as seen but don't post
      continue;
    }

    const { stats, events } = await getMatchStats(id);
    const matchPrompt = buildMatchPrompt(fixture, stats, events);
    const verdict = await generateVerdict(matchPrompt);
    const result = await postToTwitter(verdict);

    const post = {
      id: Date.now(),
      tweetId: result.id || null,
      text: verdict,
      match: `${fixture.teams.home.name} ${fixture.goals.home}-${fixture.goals.away} ${fixture.teams.away.name}`,
      competition: fixture.league.name,
      timestamp: new Date().toISOString(),
      posted: result.success
    };

    data.posts.unshift(post);
    if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
    data.postedFixtureIds.push(id);
    data.stats.totalPosts++;
    data.stats.matchesCovered++;
    postsThisRun++;
    saveData(data);

    await new Promise(r => setTimeout(r, 5000));
  }

  // Save all seen fixture IDs even if not posted
  saveData(data);

  // Update upcoming matches
  const upcoming = await getUpcomingMatches();
  data.upcomingMatches = upcoming.map(f => ({
    home: f.teams.home.name,
    away: f.teams.away.name,
    competition: f.league.name,
    time: f.fixture.date,
    status: 'upcoming'
  }));
  saveData(data);
}

// ── HOT TAKES ────────────────────────────────────────────────
const hotTakes = [
  "21 days until the World Cup. 32 coaches. 31 of them will disappoint. The Coach is ready. $COACH",
  "The World Cup squads are almost final. The Coach has already identified 14 selection mistakes. Nobody asked. $COACH 📋",
  "June 11. The World Cup begins. The Coach will be watching every single match. No coach is safe. $COACH",
  "Every four years the world's best coaches gather and prove they need The Coach. June 11. $COACH",
  "World Cup 2026 group stage predictions dropping soon. The Coach has done the analysis. It's not complicated. $COACH",
  "Watching World Cup qualification tape. Already spotted three coaches who will be embarrassed in June. $COACH 📋",
  "64 World Cup matches. 64 automatic verdicts. The Coach posts within minutes of every final whistle. $COACH",
  "The World Cup draw is set. The Coach has already mapped every tactical error that will be made. $COACH",
];

async function postHotTake() {
  const data = loadData();
  const text = hotTakes[Math.floor(Math.random() * hotTakes.length)];
  const result = await postToTwitter(text);
  const post = {
    id: Date.now(),
    tweetId: result.id || null,
    text,
    match: null,
    competition: null,
    timestamp: new Date().toISOString(),
    posted: result.success
  };
  data.posts.unshift(post);
  if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
  data.stats.totalPosts++;
  saveData(data);
}

// ── WK NEWS BOT ─────────────────────────────────────────────
const postedNewsHeadlines = new Set();

async function fetchAndPostWCNews() {
  console.log('📰 Checking WC news...');
  try {
    // Use Claude with web_search to find latest WC 2026 news
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `Search for the very latest FIFA World Cup 2026 news from today. Look for: squad announcements, player injuries, coach decisions, group stage news, team selections, or any major WC2026 story. 

Then write ONE tweet reacting to the most interesting piece of news you find, in character as The Coach. Be specific about the actual news. Under 260 characters. End with $COACH.

If there is no new news, respond with exactly: NO_NEWS`
      }]
    });

    // Extract text response
    const textBlock = msg.content.find(b => b.type === 'text');
    if (!textBlock) return;

    const text = textBlock.text.trim();
    if (text === 'NO_NEWS' || text.includes('NO_NEWS')) return;

    // Avoid duplicate posts
    const key = text.substring(0, 50);
    if (postedNewsHeadlines.has(key)) return;
    postedNewsHeadlines.add(key);

    // Post to X
    const result = await postToTwitter(text);
    if (result.success) {
      const data = loadData();
      data.posts.unshift({
        id: Date.now(),
        tweetId: result.id || null,
        text,
        match: null,
        competition: 'WC 2026 News',
        timestamp: new Date().toISOString(),
        posted: true
      });
      if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
      data.stats.totalPosts++;
      saveData(data);
      console.log('📰 News post:', text);
    }
  } catch (e) {
    console.error('News bot error:', e.message);
  }
}


// ── WEBSITE VERDICT GENERATOR ────────────────────────────────
// Generates a new verdict every hour for the website feed
// Does NOT post to X — only saves for the website
async function generateWebsiteVerdict() {
  console.log('🌐 Generating website verdict...');
  try {
    const msg = await claude.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `Search for the latest FIFA World Cup 2026 news right now. Find ONE specific interesting story about squad selections, player news, coach decisions, or tactical previews.

Write ONE tweet as The Coach reacting to it. Brutal, arrogant, degen style. Under 260 chars. End with $COACH.

Respond ONLY with this JSON, no other text, no markdown:
{"text":"your tweet here $COACH","competition":"WC 2026 Topic"}`
      }]
    });

    const textBlock = msg.content.find(b => b.type === 'text');
    if (!textBlock) return;

    let parsed;
    try {
      const clean = textBlock.text.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      // If not JSON, use the text directly
      parsed = { text: textBlock.text.trim(), competition: 'WC 2026' };
    }

    if (!parsed.text || parsed.text === 'NO_NEWS') return;

    const data = loadData();
    data.posts.unshift({
      id: Date.now(),
      tweetId: null,
      text: parsed.text,
      match: null,
      competition: parsed.competition || 'WC 2026',
      timestamp: new Date().toISOString(),
      posted: false,
      source: 'website'
    });
    if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
    saveData(data);
    console.log('🌐 Website verdict saved:', parsed.text.substring(0, 60) + '...');
  } catch (e) {
    console.error('Website verdict error:', e.message);
  }
}

cron.schedule('*/15 * * * *', runMatchBot);          // Check matches every 15 min
cron.schedule('0 18 * * *', postHotTake);            // Hot take 1x/day at 6pm
cron.schedule('0 8 * * *', fetchAndPostWCNews);      // WC news 8am
cron.schedule('0 10 * * *', fetchAndPostWCNews);     // WC news 10am
cron.schedule('0 12 * * *', fetchAndPostWCNews);     // WC news 12pm
cron.schedule('0 15 * * *', fetchAndPostWCNews);     // WC news 3pm
cron.schedule('0 19 * * *', fetchAndPostWCNews);     // WC news 7pm
cron.schedule('0 21 * * *', fetchAndPostWCNews);     // WC news 9pm
cron.schedule('0 * * * *', generateWebsiteVerdict); // Website verdict every hour

// ── API ROUTES ───────────────────────────────────────────────

// Latest posts (for website feed)
app.get('/api/posts', (req, res) => {
  const data = loadData();
  res.json(data.posts.slice(0, 10));
});

// Upcoming matches
app.get('/api/matches', (req, res) => {
  const data = loadData();
  res.json(data.upcomingMatches.slice(0, 6));
});

// Stats
app.get('/api/stats', (req, res) => {
  const data = loadData();
  res.json(data.stats);
});

// Burn events
app.get('/api/burns', (req, res) => {
  const data = loadData();
  res.json(data.burnEvents);
});

// Manual post (for testing)
app.post('/api/post', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const result = await postToTwitter(text);
  if (result.success) {
    const data = loadData();
    data.posts.unshift({ id: Date.now(), tweetId: result.id, text, timestamp: new Date().toISOString(), posted: true });
    data.stats.totalPosts++;
    saveData(data);
  }
  res.json(result);
});

// Manual hot take trigger
app.post('/api/hottake', async (req, res) => {
  await postHotTake();
  res.json({ success: true });
});

// Manual news trigger
app.post('/api/news', async (req, res) => {
  await fetchAndPostWCNews();
  res.json({ success: true });
});

// Manual website verdict trigger
app.post('/api/website-verdict', async (req, res) => {
  await generateWebsiteVerdict();
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', time: new Date().toISOString() });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏟️  THE COACH BACKEND — ONLINE`);
  console.log(`📡 API running on http://localhost:${PORT}`);
  console.log(`⚽ Bot checking matches every 15 minutes\n`);
  runMatchBot();
  generateWebsiteVerdict(); // Generate first verdict on startup
});
