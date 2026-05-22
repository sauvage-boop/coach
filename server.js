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
  const msg = await claudeWithRetry({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: COACH_PERSONA,
    messages: [{ role: 'user', content: `Write ONE post-match tweet. Be specific. Under 260 chars.\n\n${matchData}` }]
  });
  let text = msg.content[0].text.trim();
  if (text.length > 275) text = text.substring(0, 272) + '...';
  return text;
}

// ── CLAUDE WITH RETRY ────────────────────────────────────────
async function claudeWithRetry(params, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await claude.messages.create(params);
    } catch (e) {
      const is529 = e.message?.includes('529') || e.message?.includes('overloaded');
      if (is529 && i < retries - 1) {
        console.log(`⏳ Anthropic overloaded, retry ${i + 1}/${retries} in 30s...`);
        await new Promise(r => setTimeout(r, 30000));
      } else {
        throw e;
      }
    }
  }
}

async function postToTwitter(text) {
  try {
    const tweet = await twitter.v2.tweet(text);
    console.log('✅ Posted:', text.substring(0, 60) + '...');
    return { success: true, id: tweet.data.id, text };
  } catch (e) {
    const code = e.code || e.message;
    if (String(code).includes('403')) {
      console.log('⏸️  X rate limited (403) — skipping post, will retry next cycle');
    } else if (String(code).includes('429')) {
      console.log('⏸️  X too many requests (429) — skipping post');
    } else {
      console.error('❌ Twitter error:', e.message);
    }
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
    const msg = await claudeWithRetry({
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
async function generateWebsiteVerdict() {
  console.log('🌐 Generating website verdict...');
  try {
    // Step 1: Search for news
    const searchMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Search for the single most interesting FIFA World Cup 2026 news story from today. Return only the headline and a 2-sentence summary. Nothing else.'
      }]
    });

    const newsText = searchMsg.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join(' ')
      .trim();

    if (!newsText || newsText.length < 20) return;

    // Step 2: Generate verdict based on news
    const verdictMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `Based on this news: "${newsText}"

Write ONE tweet reacting to this as The Coach. Under 260 chars. End with $COACH. NO intro, NO explanation. Just the tweet text directly.`
      }]
    });

    const verdict = verdictMsg.content[0]?.text?.trim();
    if (!verdict || !verdict.includes('$COACH') || verdict.length > 280) return;

    // Determine topic
    const competition = newsText.toLowerCase().includes('group') ? 'WC 2026 Group Stage' :
                       newsText.toLowerCase().includes('squad') ? 'WC 2026 Squad News' :
                       newsText.toLowerCase().includes('injury') ? 'WC 2026 Injury News' : 'WC 2026 News';

    const data = loadData();
    data.posts.unshift({
      id: Date.now(),
      tweetId: null,
      text: verdict,
      match: null,
      competition,
      timestamp: new Date().toISOString(),
      posted: false,
      source: 'website'
    });
    if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
    saveData(data);
    console.log('🌐 Website verdict saved:', verdict.substring(0, 80) + '...');
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

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '173aca1b-d8da-4a82-be02-14017bf5584d';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function verifyCoachTransaction(txHash, expectedWallet, expectedAmount) {
  try {
    await new Promise(r => setTimeout(r, 3000)); // Wait for confirmation

    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    });

    const tx = res.data?.result;
    if (!tx) return { valid: false, error: 'Transaction not found' };

    // Check transaction is not failed
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed on-chain' };

    // Check instructions for SPL token transfer to treasury
    const instructions = tx.transaction?.message?.instructions || [];
    const innerInstructions = tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [];
    const allInstructions = [...instructions, ...innerInstructions];

    for (const ix of allInstructions) {
      const parsed = ix.parsed;
      if (!parsed) continue;

      // Check for SPL token transfer
      if ((parsed.type === 'transfer' || parsed.type === 'transferChecked') && parsed.info) {
        const info = parsed.info;
        const destination = info.destination || info.account;
        const amount = parseFloat(info.amount || info.tokenAmount?.uiAmount || 0);

        // Verify destination is treasury and amount matches
        if (destination === TREASURY_WALLET && amount >= expectedAmount * 0.99) {
          return { valid: true, amount, txHash };
        }
      }
    }

    // Also check pre/post token balances
    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];

    for (const post of postBalances) {
      if (post.owner === TREASURY_WALLET) {
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmount = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        const received = postAmount - preAmount;

        if (received >= expectedAmount * 0.99) {
          return { valid: true, amount: received, txHash };
        }
      }
    }

    return { valid: false, error: 'No valid $COACH transfer to treasury found in this transaction' };
  } catch (e) {
    console.error('Helius verification error:', e.message);
    return { valid: false, error: 'Verification failed: ' + e.message };
  }
}
const WAGER_FILE = path.join(__dirname, 'wagers.json');
const TREASURY_WALLET = 'DReFFztSXymUsNrKff4e6ozxMbQ3jdV6rCUEuuh9D3ty';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'thecoach2026';

function loadWagers() {
  if (!fs.existsSync(WAGER_FILE)) {
    const initial = { bets: [] };
    fs.writeFileSync(WAGER_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(WAGER_FILE, 'utf8'));
}

function saveWagers(data) {
  fs.writeFileSync(WAGER_FILE, JSON.stringify(data, null, 2));
}

const WC_MATCHES = [
  { id: 'wc_1', home: 'Mexico', away: 'South Africa', homeFlag: '🇲🇽', awayFlag: '🇿🇦', date: '2026-06-11T21:00:00Z', competition: 'WC 2026 Group A', status: 'open', odds: { home: 1.8, draw: 3.2, away: 5.0 } },
  { id: 'wc_2', home: 'Canada', away: 'Bosnia & Herzegovina', homeFlag: '🇨🇦', awayFlag: '🇧🇦', date: '2026-06-12T21:00:00Z', competition: 'WC 2026 Group B', status: 'open', odds: { home: 2.1, draw: 3.0, away: 3.8 } },
  { id: 'wc_3', home: 'USA', away: 'Paraguay', homeFlag: '🇺🇸', awayFlag: '🇵🇾', date: '2026-06-13T00:00:00Z', competition: 'WC 2026 Group C', status: 'open', odds: { home: 1.6, draw: 3.5, away: 6.0 } },
  { id: 'wc_4', home: 'Brazil', away: 'Morocco', homeFlag: '🇧🇷', awayFlag: '🇲🇦', date: '2026-06-14T00:00:00Z', competition: 'WC 2026 Group C', status: 'open', odds: { home: 1.5, draw: 4.0, away: 7.0 } },
  { id: 'wc_5', home: 'Germany', away: 'Curaçao', homeFlag: '🇩🇪', awayFlag: '🇨🇼', date: '2026-06-14T19:00:00Z', competition: 'WC 2026 Group E', status: 'open', odds: { home: 1.1, draw: 8.0, away: 20.0 } },
  { id: 'wc_6', home: 'Netherlands', away: 'Japan', homeFlag: '🇳🇱', awayFlag: '🇯🇵', date: '2026-06-14T22:00:00Z', competition: 'WC 2026 Group F', status: 'open', odds: { home: 1.7, draw: 3.3, away: 5.5 } },
  { id: 'wc_7', home: 'Spain', away: 'Cape Verde', homeFlag: '🇪🇸', awayFlag: '🇨🇻', date: '2026-06-15T18:00:00Z', competition: 'WC 2026 Group H', status: 'open', odds: { home: 1.2, draw: 6.0, away: 15.0 } },
  { id: 'wc_8', home: 'France', away: 'Senegal', homeFlag: '🇫🇷', awayFlag: '🇸🇳', date: '2026-06-15T21:00:00Z', competition: 'WC 2026 Group I', status: 'open', odds: { home: 1.4, draw: 4.5, away: 8.0 } },
  { id: 'wc_9', home: 'Argentina', away: 'Algeria', homeFlag: '🇦🇷', awayFlag: '🇩🇿', date: '2026-06-17T03:00:00Z', competition: 'WC 2026 Group J', status: 'open', odds: { home: 1.3, draw: 5.0, away: 10.0 } },
  { id: 'wc_10', home: 'England', away: 'Croatia', homeFlag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', awayFlag: '🇭🇷', date: '2026-06-16T22:00:00Z', competition: 'WC 2026 Group L', status: 'open', odds: { home: 1.6, draw: 3.5, away: 6.0 } },
];

function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Wager routes
app.get('/api/wager/matches', (req, res) => res.json(WC_MATCHES.filter(m => m.status === 'open')));
app.get('/api/wager/matches/all', (req, res) => res.json(WC_MATCHES));
app.get('/api/wager/treasury', (req, res) => res.json({ wallet: TREASURY_WALLET }));

app.post('/api/wager/bet', async (req, res) => {
  const { matchId, outcome, amount, walletAddress, txHash } = req.body;
  if (!matchId || !outcome || !amount || !walletAddress || !txHash) return res.status(400).json({ error: 'Missing fields' });
  const match = WC_MATCHES.find(m => m.id === matchId);
  if (!match || match.status !== 'open') return res.status(400).json({ error: 'Match not available' });
  if (!['home','draw','away'].includes(outcome)) return res.status(400).json({ error: 'Invalid outcome' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum 100 $COACH' });
  const data = loadWagers();
  if (data.bets.find(b => b.txHash === txHash)) return res.status(400).json({ error: 'Transaction already used' });

  // Verify transaction on Solana via Helius
  const verification = await verifyCoachTransaction(txHash, walletAddress, amount);
  if (!verification.valid) return res.status(400).json({ error: `Transaction invalid: ${verification.error}` });

  const odds = match.odds[outcome];
  const bet = { id: Date.now(), matchId, matchName: `${match.homeFlag} ${match.home} vs ${match.awayFlag} ${match.away}`, outcome, amount: verification.amount || amount, odds, potentialWin: Math.floor((verification.amount || amount) * odds), walletAddress, txHash, timestamp: new Date().toISOString(), status: 'pending' };
  data.bets.push(bet);
  saveWagers(data);
  console.log(`🎰 Verified bet: ${walletAddress.slice(0,6)} bet ${bet.amount} $COACH on ${outcome}`);
  res.json({ success: true, bet });
});

app.get('/api/wager/bets/:wallet', (req, res) => {
  const data = loadWagers();
  res.json(data.bets.filter(b => b.walletAddress === req.params.wallet));
});

app.get('/api/wager/bets/match/:matchId', (req, res) => {
  const data = loadWagers();
  const bets = data.bets.filter(b => b.matchId === req.params.matchId);
  res.json({ bets, total: bets.reduce((s,b) => s+b.amount, 0), byOutcome: { home: bets.filter(b=>b.outcome==='home').reduce((s,b)=>s+b.amount,0), draw: bets.filter(b=>b.outcome==='draw').reduce((s,b)=>s+b.amount,0), away: bets.filter(b=>b.outcome==='away').reduce((s,b)=>s+b.amount,0) } });
});

app.get('/api/wager/stats', (req, res) => {
  const data = loadWagers();
  res.json({ totalBets: data.bets.length, totalVolume: data.bets.reduce((s,b)=>s+b.amount,0), won: data.bets.filter(b=>b.status==='won').length, pending: data.bets.filter(b=>b.status==='pending').length });
});

app.get('/api/admin/bets', adminAuth, (req, res) => res.json(loadWagers().bets));

app.post('/api/admin/settle', adminAuth, (req, res) => {
  const { matchId, result } = req.body;
  if (!matchId || !result) return res.status(400).json({ error: 'Missing matchId or result' });
  const data = loadWagers();
  const winners = data.bets.filter(b => b.matchId === matchId && b.status === 'pending' && b.outcome === result);
  data.bets = data.bets.map(b => b.matchId === matchId && b.status === 'pending' ? { ...b, status: b.outcome === result ? 'won' : 'lost', settledAt: new Date().toISOString() } : b);
  const match = WC_MATCHES.find(m => m.id === matchId);
  if (match) match.status = 'settled';
  saveWagers(data);
  res.json({ success: true, result, winners: winners.map(w => ({ wallet: w.walletAddress, bet: w.amount, payout: w.potentialWin, odds: w.odds })), totalPayout: winners.reduce((s,w)=>s+w.potentialWin,0) });
});


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
