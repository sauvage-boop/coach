// ============================================================
// THE COACH — Complete Backend Server
// Express API + Twitter Bot + Football Data + Burn Mechanic + Telegram
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const { TwitterApi } = require('twitter-api-v2');
const TelegramBot = require('node-telegram-bot-api');
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

// ── TELEGRAM BOT ─────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8968875555:AAEA7QwHOB_Cfc0_ge_Gt-LqE3tJpGKhkoE';
const bot = new TelegramBot(TELEGRAM_TOKEN, { 
  polling: {
    interval: 2000,
    autoStart: true,
    params: { timeout: 10 }
  }
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
      postedNewsKeys: [],       // PERSISTENT: track posted news
      postedHotTakeIndexes: [], // PERSISTENT: track posted hot takes
      recentNewsTopics: [],     // PERSISTENT: last 10 news topics
      stats: { totalPosts: 0, matchesCovered: 0, totalBurns: 0 }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  // Migrate old data that doesn't have these fields
  if (!data.postedNewsKeys) data.postedNewsKeys = [];
  if (!data.postedHotTakeIndexes) data.postedHotTakeIndexes = [];
  if (!data.recentNewsTopics) data.recentNewsTopics = [];
  return data;
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

async function postToTwitter(text, competition = '') {
  try {
    const tweet = await twitter.v2.tweet(text);
    console.log('✅ Posted:', text.substring(0, 60) + '...');
    if (competition) postVerdictToTelegram(text, competition);
    return { success: true, id: tweet.data.id, text };
  } catch (e) {
    const code = e.code || e.message;
    const errStr = String(e.message || '');
    console.error('❌ Twitter error full:', JSON.stringify(e?.data || e.message));
    if (errStr.includes('403') || String(code).includes('403')) {
      console.log('⏸️  X 403 — duplicate or forbidden');
    } else if (errStr.includes('429') || String(code).includes('429')) {
      console.log('⏸️  X 429 — rate limited');
    } else if (errStr.includes('duplicate')) {
      console.log('⏸️  X duplicate content — skipping');
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
    if (postsThisRun >= 3) break;

    const id = String(fixture.fixture.id);
    if (data.postedFixtureIds.includes(id)) continue;

    const compName = fixture.league?.name || '';
    if (!isMajorCompetition(compName)) {
      data.postedFixtureIds.push(id);
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

// ── HOT TAKES — PERSISTENT ROTATION ─────────────────────────
const hotTakes = [
  "19 days until the World Cup. 48 coaches. 47 of them are going to embarrass themselves. The Coach has the receipts ready. $COACH 📋",
  "Koeman has Oranje's best generation in 20 years and still manages to make them look average. Truly gifted at being wrong. $COACH 🤡",
  "Deschamps has Mbappé and uses him like a side quest. If I had that wallet I'd be rich. Instead he's running it to zero. $COACH 💀",
  "Ancelotti's notebook has been empty since 2019. Four Champions Leagues won despite the tactics, not because of them. $COACH 📋",
  "Scaloni won a World Cup and still coaches like he's scared of winning. Messi drags that squad to trophies alone. $COACH",
  "Nagelsmann is 38, coaches Germany, and still hasn't figured out how to use a number 10. The Coach was doing this in his sleep. $COACH 🤡",
  "48 coaches. 104 matches. Zero hiding spots. The Coach sees every wrong sub, every coward formation, every panic decision. $COACH 📋",
  "Tuchel got sacked by Bayern, PSG AND Chelsea and somehow convinced England he's the answer. The Coach has never been sacked. Never applied either. Standards. $COACH",
  "June 11. World Cup 2026 begins. The Coach will be watching every single match. No coach is safe. $COACH 💀",
  "World Cup squads almost final. The Coach has already spotted 12 selection errors across 8 squads. Nobody asked. They'll regret it. $COACH",
];

async function postHotTake() {
  const data = loadData();

  // Reset if all have been posted
  if (data.postedHotTakeIndexes.length >= hotTakes.length) {
    console.log('🔄 All hot takes posted — resetting rotation');
    data.postedHotTakeIndexes = [];
  }

  // Find indexes not yet posted
  const available = hotTakes
    .map((_, i) => i)
    .filter(i => !data.postedHotTakeIndexes.includes(i));

  if (!available.length) return;

  // Pick random from remaining
  const idx = available[Math.floor(Math.random() * available.length)];
  const text = hotTakes[idx];

  data.postedHotTakeIndexes.push(idx);

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
  console.log(`📋 Hot take posted [${idx}/${hotTakes.length - 1}]: ${text.substring(0, 60)}...`);
}

// ── WK NEWS BOT — PERSISTENT DEDUPLICATION ──────────────────
async function fetchAndPostWCNews() {
  console.log('📰 Checking WC news...');
  try {
    const data = loadData();

    // Build exclusion prompt from persistent recent topics
    const excludeText = data.recentNewsTopics.length > 0
      ? `Do NOT write about these topics — already posted recently: ${data.recentNewsTopics.slice(-6).join(' | ')}.`
      : '';

    // Step 1: Search for WC 2026 news
    const searchMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: `Search for FIFA World Cup 2026 news. Find a DIFFERENT story each time — squad selections, player calls, coach tactics, group draws, injuries, controversies. Must be specifically about WC 2026 national teams. NO club football. NO local leagues. NO non-WC sports. ${excludeText} Return ONE story: headline + 1 sentence only.`
      }]
    });

    const newsText = searchMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (!newsText || newsText.length < 20) return;

    // WC keyword filter
    const wcKeywords = ['world cup', 'wc 2026', 'squad', 'fifa', 'national team', 'selection', '2026', 'coach', 'manager'];
    const isWC = wcKeywords.some(k => newsText.toLowerCase().includes(k));
    if (!isWC) { console.log('📰 Skipping non-WC news'); return; }

    // Persistent duplicate check — use first 60 chars as key
    const newsKey = newsText.substring(0, 60).toLowerCase().replace(/\s+/g, ' ').trim();
    if (data.postedNewsKeys.includes(newsKey)) {
      console.log('📰 Skipping duplicate news (persistent)');
      return;
    }

    // Step 2: Generate roast tweet
    const verdictMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `News: "${newsText.substring(0, 200)}"\n\nWrite ONLY a tweet reacting to this. No intro. No explanation. Start directly with your opinion. Under 260 chars. Must end with $COACH.`
      }]
    });

    let text = verdictMsg.content[0]?.text?.trim();
    if (!text) return;
    if (!text.includes('$COACH')) return;
    if (text.length > 280) text = text.substring(0, 277) + '...';

    const badPhrases = ["I'll search", "I will search", "Let me", "Here's", "I found", "Based on"];
    if (badPhrases.some(p => text.startsWith(p))) return;

    // Check tweet text itself for duplicates
    const tweetKey = text.substring(0, 50);
    if (data.postedNewsKeys.includes(tweetKey)) {
      console.log('📰 Skipping duplicate tweet');
      return;
    }

    // Save both keys + topic persistently
    data.postedNewsKeys.push(newsKey, tweetKey);
    if (data.postedNewsKeys.length > 200) data.postedNewsKeys = data.postedNewsKeys.slice(-200);

    // Save topic for future exclusion
    const topic = newsText.split(' ').slice(0, 6).join(' ');
    data.recentNewsTopics.push(topic);
    if (data.recentNewsTopics.length > 15) data.recentNewsTopics.shift();

    saveData(data);

    // Post to X
    const result = await postToTwitter(text);
    if (result.success) {
      const freshData = loadData();
      freshData.posts.unshift({
        id: Date.now(),
        tweetId: result.id || null,
        text,
        match: null,
        competition: 'WC 2026 News',
        timestamp: new Date().toISOString(),
        posted: true
      });
      if (freshData.posts.length > 50) freshData.posts = freshData.posts.slice(0, 50);
      freshData.stats.totalPosts++;
      saveData(freshData);
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

    const verdictMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `Based on this news: "${newsText}"\n\nWrite ONE tweet reacting to this as The Coach. Under 260 chars. End with $COACH. NO intro, NO explanation. Just the tweet text directly.`
      }]
    });

    const verdict = verdictMsg.content[0]?.text?.trim();
    if (!verdict || !verdict.includes('$COACH') || verdict.length > 280) return;

    const competition = newsText.toLowerCase().includes('group') ? 'WC 2026 Group Stage' :
                       newsText.toLowerCase().includes('squad') ? 'WC 2026 Squad News' :
                       newsText.toLowerCase().includes('injury') ? 'WC 2026 Injury News' : 'WC 2026 News';

    // Dedup check before posting
    const data = loadData();
    const verdictKey = verdict.substring(0, 50);
    if (data.postedNewsKeys.includes(verdictKey)) {
      console.log('🌐 Website verdict duplicate — skipping');
      return;
    }
    data.postedNewsKeys.push(verdictKey);
    if (data.postedNewsKeys.length > 200) data.postedNewsKeys = data.postedNewsKeys.slice(-200);
    saveData(data);

    // Post to X
    const result = await postToTwitter(verdict, competition);

    const freshData = loadData();
    freshData.posts.unshift({
      id: Date.now(),
      tweetId: result.id || null,
      text: verdict,
      match: null,
      competition,
      timestamp: new Date().toISOString(),
      posted: result.success,
      source: 'website'
    });
    if (freshData.posts.length > 50) freshData.posts = freshData.posts.slice(0, 50);
    if (result.success) freshData.stats.totalPosts++;
    saveData(freshData);
    console.log(`🌐 Website verdict ${result.success ? 'posted to X ✅' : 'saved (X failed) ⚠️'}:`, verdict.substring(0, 80) + '...');
  } catch (e) {
    console.error('Website verdict error:', e.message);
  }
}

// ── DM ROAST BOT ─────────────────────────────────────────────
const COACH_CA = process.env.COACH_CA || '';
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111';
const ROAST_PRICE = parseInt(process.env.ROAST_PRICE || '1000');

async function verifyBurnTransaction(txHash, expectedAmount) {
  try {
    await new Promise(r => setTimeout(r, 4000));
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    });
    const tx = res.data?.result;
    if (!tx || tx.meta?.err) return { valid: false, error: 'Transaction failed' };

    const postBalances = tx.meta?.postTokenBalances || [];
    const preBalances = tx.meta?.preTokenBalances || [];

    for (const post of postBalances) {
      if (post.owner === BURN_ADDRESS) {
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmt = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        const burned = postAmt - preAmt;
        if (burned >= expectedAmount * 0.99) return { valid: true, burned };
      }
    }

    const instructions = tx.transaction?.message?.instructions || [];
    const innerInstructions = tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [];
    for (const ix of [...instructions, ...innerInstructions]) {
      const info = ix.parsed?.info;
      if (!info) continue;
      if ((ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') &&
          (info.destination === BURN_ADDRESS || info.account === BURN_ADDRESS)) {
        const amount = parseFloat(info.amount || info.tokenAmount?.uiAmount || 0);
        if (amount >= expectedAmount * 0.99) return { valid: true, burned: amount };
      }
    }

    return { valid: false, error: 'No burn to correct address found' };
  } catch(e) {
    return { valid: false, error: e.message };
  }
}

async function checkAndProcessDMs() {
  console.log('📬 Checking DMs...');
  try {
    const me = await twitter.v2.me();
    const myId = me.data.id;

    const data = loadData();
    if (!data.processedDMs) data.processedDMs = [];
    if (!data.pendingRoasts) data.pendingRoasts = {};
    const processedSet = new Set(data.processedDMs);

    let dmList = [];
    try {
      const response = await twitter.v2.get('dm_events', {
        'dm_event.fields': 'text,sender_id,created_at,dm_conversation_id',
        'max_results': 20,
        'event_types': 'MessageCreate'
      });
      dmList = response?.data || [];
      if (!Array.isArray(dmList)) dmList = [];
    } catch(e) {
      console.error(`📬 DM fetch error: ${e.message}`);
      return;
    }

    console.log(`📬 DM count: ${dmList.length}`);
    if (!dmList.length) return;

    for (const dm of dmList) {
      if (dm.sender_id === myId) continue;
      if (processedSet.has(dm.id)) continue;

      processedSet.add(dm.id);
      data.processedDMs = [...processedSet].slice(-1000);
      saveData(data);

      const text = dm.text?.trim() || '';
      const convId = dm.dm_conversation_id;

      if (!text || text.startsWith('Done.') || text.startsWith('The Coach sees') || text.startsWith('Verifying') || text.startsWith('Request expired')) continue;

      const roastMatch = text.match(/@ROAST\s+@?(\S+)/i);
      if (roastMatch) {
        const targetHandle = roastMatch[1].replace('@', '');
        console.log(`🎯 Roast request: @${targetHandle} from DM`);

        if (!COACH_CA) {
          await executeRoast(dm, targetHandle, convId);
          continue;
        }

        data.pendingRoasts[convId] = { targetHandle, requestedAt: Date.now() };
        saveData(data);

        try {
          await twitter.v2.sendDmInConversation(convId, {
            text: `The Coach sees your request. 👀\n\nTo roast @${targetHandle}, burn ${ROAST_PRICE} $COACH to the burn address:\n\n1nc1nerator11111111111111111111111111111111\n\nThen reply with: TX:[your transaction hash]\n\nTokens are permanently burned. No refunds. The Coach delivers. $COACH 📋`
          });
        } catch(e) {}
        continue;
      }

      const txMatch = text.match(/TX:\s*([A-Za-z0-9]{40,})/i);
      if (txMatch && data.pendingRoasts[convId]) {
        const txHash = txMatch[1].trim();
        const pending = data.pendingRoasts[convId];

        if (Date.now() - pending.requestedAt > 86400000) {
          delete data.pendingRoasts[convId];
          saveData(data);
          try { await twitter.v2.sendDmInConversation(convId, { text: `Request expired. Start over with @ROAST @username. $COACH` }); } catch(e) {}
          continue;
        }

        try {
          await twitter.v2.sendDmInConversation(convId, { text: `Verifying your burn transaction... 🔍` });
        } catch(e) {}

        const verification = await verifyBurnTransaction(txHash, ROAST_PRICE);

        if (!verification.valid) {
          try {
            await twitter.v2.sendDmInConversation(convId, { text: `Transaction not verified: ${verification.error}\n\nMake sure you burned ${ROAST_PRICE} $COACH to:\n1nc1nerator11111111111111111111111111111111\n\nTry again with TX:[hash]. $COACH` });
          } catch(e) {}
          continue;
        }

        delete data.pendingRoasts[convId];
        saveData(data);
        await executeRoast(dm, pending.targetHandle, convId, verification.burned);
        continue;
      }
    }
  } catch(e) {
    console.error('DM bot error:', e.message);
  }
}

async function executeRoast(dm, targetHandle, convId, burnedAmount) {
  console.log(`🔥 Executing roast for @${targetHandle}...`);
  let targetContext = '';
  try {
    const targetUser = await twitter.v2.userByUsername(targetHandle, { 'user.fields': ['description', 'name'] });
    if (targetUser.data) {
      const tweets = await twitter.v2.userTimeline(targetUser.data.id, { max_results: 5, exclude: ['retweets', 'replies'] });
      const recentTweets = tweets.data?.data?.map(t => t.text).join(' | ') || '';
      targetContext = `Name: ${targetUser.data.name}\nHandle: @${targetHandle}\nRecent tweets: ${recentTweets}`;
    }
  } catch(e) {}

  try {
    const roastMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Roast @${targetHandle} HARD as The Coach. Brutal, specific, degen.\n\n${targetContext ? `Context: ${targetContext}` : ''}\n\nONE tweet. Under 260 chars. Must mention @${targetHandle} somewhere in the middle or end — NEVER start the tweet with @. Start with a statement or observation. Must end with $COACH. No intro.` }]
    });

    let roastText = roastMsg.content[0]?.text?.trim();
    if (!roastText || !roastText.includes('$COACH')) return;
    // Never start with @ — prepend if needed
    if (roastText.startsWith('@')) roastText = `The Coach sees @${targetHandle}. ` + roastText;
    if (roastText.length > 280) roastText = roastText.substring(0, 277) + '...';

    const posted = await postToTwitter(roastText);

    const replyText = posted.success
      ? (burnedAmount
          ? `Done. ${burnedAmount.toLocaleString()} $COACH burned forever. The Coach has spoken. Check the timeline. 🔥`
          : `Done. The Coach has spoken. Check the timeline.\n\nhttps://x.com/thecoachonchain $COACH 📋`)
      : `The Coach spoke but X was misbehaving. Here's the verdict anyway:\n\n"${roastText}"`;

    try { await twitter.v2.sendDmInConversation(convId, { text: replyText }); } catch(e) {}

    // Always save to website feed
    const freshData = loadData();
    freshData.posts.unshift({
      id: Date.now(),
      tweetId: posted.id || null,
      text: roastText,
      match: null,
      competition: `Roast: @${targetHandle}`,
      timestamp: new Date().toISOString(),
      posted: posted.success,
      source: 'roast_request'
    });
    if (freshData.posts.length > 50) freshData.posts = freshData.posts.slice(0, 50);
    freshData.stats.totalPosts++;
    saveData(freshData);
    console.log(`🔥 Roast @${targetHandle} — X: ${posted.success ? '✅' : '❌'} | Website: ✅`);
  } catch(e) {
    console.error(`❌ executeRoast error:`, e.message);
  }
}

// ── TELEGRAM BOT COMMANDS ────────────────────────────────────
bot.onText(/(?:\/roast|@ROAST)\s+@?(\S+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const targetHandle = match[1].replace('@', '');
  bot.sendMessage(chatId, `🎯 The Coach is loading up on @${targetHandle}... $COACH`);

  let targetContext = '';
  try {
    const targetUser = await twitter.v2.userByUsername(targetHandle, { 'user.fields': ['description', 'name'] });
    if (targetUser.data) {
      const tweets = await twitter.v2.userTimeline(targetUser.data.id, { max_results: 5, exclude: ['retweets', 'replies'] });
      const recentTweets = tweets.data?.data?.map(t => t.text).join(' | ') || '';
      targetContext = `Name: ${targetUser.data.name}\nHandle: @${targetHandle}\nRecent tweets: ${recentTweets}`;
    }
  } catch(e) {}

  const roastMsg = await claudeWithRetry({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    system: COACH_PERSONA,
    messages: [{ role: 'user', content: `Roast @${targetHandle} HARD as The Coach.\n\n${targetContext ? `Context: ${targetContext}` : ''}\n\nONE tweet. Under 260 chars. Must mention @${targetHandle} somewhere in the middle or end — NEVER start with @. Start with a statement. Must end with $COACH. No intro.` }]
  });

  let roastText = roastMsg.content[0]?.text?.trim();
  if (!roastText || !roastText.includes('$COACH')) {
    bot.sendMessage(chatId, `❌ The Coach couldn't roast @${targetHandle} right now. Try again.`);
    return;
  }
  if (roastText.startsWith('@')) roastText = `The Coach sees @${targetHandle}. ` + roastText;
  if (roastText.length > 280) roastText = roastText.substring(0, 277) + '...';

  const posted = await postToTwitter(roastText);

  // Always save to website
  const data = loadData();
  data.posts.unshift({ id: Date.now(), tweetId: posted.id || null, text: roastText, match: null, competition: `Roast: @${targetHandle}`, timestamp: new Date().toISOString(), posted: posted.success, source: 'telegram_roast' });
  if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
  data.stats.totalPosts++;
  saveData(data);

  if (posted.success) {
    bot.sendMessage(chatId, `🔥 Posted on X:\n\n"${roastText}"\n\nhttps://x.com/thecoachonchain`);
  } else {
    bot.sendMessage(chatId, `⚠️ X failed but saved on website:\n\n"${roastText}"\n\nError: ${posted.error}`);
  }
});

bot.onText(/\/ask\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];
  const askerName = msg.from.first_name || 'Someone';
  try {
    const answerMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `You are at a press conference. ${askerName} asks: "${question}"\n\nAnswer as The Coach — arrogant, confident, entertaining. 2-4 sentences. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `📋 *The Coach responds:*\n\n${answerMsg.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ The Coach is busy. Try again.`); }
});

bot.onText(/\/verdict/, async (msg) => {
  const chatId = msg.chat.id;
  const data = loadData();
  const latest = data.posts?.[0];
  if (latest) {
    bot.sendMessage(chatId, `📋 *Latest from The Coach:*\n\n${latest.text}`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `No verdicts yet. The Coach is watching. $COACH`);
  }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🏟️ *THE COACH is here.*\n\nNever coached. Never been wrong.\n\n📋 *Commands:*\n/roast @username — destroy someone on X\n/ask [question] — press conference\n/predict — WC 2026 predictions\n/lineup [country] — ideal lineup\n/rate @coach — rate a coach /10\n/hottake — controversial hot take\n/history [coach] — compare to historical flop\n/verdict — latest verdict\n/treasury — treasury wallet info\n/burn — burn stats\n/price — $COACH price\n/help — all commands\n\n$COACH 📋`, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

bot.onText(/\/predict/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `📋 The Coach is calculating...`);
  try {
    const res = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Give The Coach's official World Cup 2026 predictions. Who wins each group (A-L), who wins the tournament, and who gets embarrassingly eliminated early. Be specific and brutal. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `🏆 *THE COACH'S OFFICIAL WC 2026 PREDICTIONS:*\n\n${res.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ Try again.`); }
});

bot.onText(/\/lineup\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const country = match[1];
  bot.sendMessage(chatId, `📋 The Coach is picking ${country}'s squad...`);
  try {
    const res = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Give The Coach's ideal World Cup 2026 lineup for ${country} in a 4-3-3 or 3-5-2. Name the players, explain why the actual coach got it wrong. Be brutal. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `⚽ *THE COACH'S ${country.toUpperCase()} LINEUP:*\n\n${res.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ Try again.`); }
});

bot.onText(/\/rate\s+@?(\S+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const coach = match[1];
  try {
    const res = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Rate ${coach} as a football coach out of 10. Be brutal and specific. Give the score, then explain why they don't deserve better. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `📊 *THE COACH RATES ${coach.toUpperCase()}:*\n\n${res.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ Try again.`); }
});

bot.onText(/\/hottake/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const res = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 150, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Give one brutal, controversial World Cup 2026 hot take. Something that will trigger football fans. Under 200 chars. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `🔥 *HOT TAKE:*\n\n${res.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ Try again.`); }
});

bot.onText(/\/history\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const coach = match[1];
  try {
    const res = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001', max_tokens: 250, system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Compare ${coach} to the most embarrassing coach in football history. Be specific about their tactical failures. End with $COACH.` }]
    });
    bot.sendMessage(chatId, `📚 *THE COACH'S HISTORICAL ANALYSIS:*\n\n${res.content[0].text.trim()}`, { parse_mode: 'Markdown' });
  } catch(e) { bot.sendMessage(chatId, `❌ Try again.`); }
});

bot.onText(/\/treasury/, (msg) => {
  const chatId = msg.chat.id;
  const data = loadData();
  const totalBets = data.bets?.reduce((s,b) => s+b.amount, 0) || 0;
  bot.sendMessage(chatId, `💰 *THE COACH'S TREASURY:*\n\nWallet: \`${TREASURY_WALLET}\`\n\nTotal wagered: ${totalBets.toLocaleString()} $COACH\n\n🔗 [View on Solscan](https://solscan.io/account/${TREASURY_WALLET})\n\n$COACH 📋`, { parse_mode: 'Markdown' });
});

bot.onText(/\/burn/, (msg) => {
  const chatId = msg.chat.id;
  const data = loadData();
  const burned = data.bets?.filter(b => b.source === 'roast_request' && b.burned).reduce((s,b) => s+(b.burned||0), 0) || 0;
  if (COACH_CA) {
    bot.sendMessage(chatId, `🔥 *BURN STATS:*\n\nTotal burned: ${burned.toLocaleString()} $COACH\nBurn address: \`1nc1nerator11111111111111111111111111111111\`\n\nEvery roast request burns $COACH permanently. $COACH 💀`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `🔥 Burn mechanic activates after $COACH launches on pump.fun. Coming soon. $COACH`);
  }
});

bot.onText(/\/price/, async (msg) => {
  const chatId = msg.chat.id;
  if (!COACH_CA) {
    bot.sendMessage(chatId, `$COACH hasn't launched yet. Pump.fun soon. The Coach is loading. $COACH 📋`);
    return;
  }
  try {
    const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${COACH_CA}`);
    const pair = res.data?.pairs?.[0];
    if (pair) {
      bot.sendMessage(chatId, `💰 *$COACH PRICE:*\n\n$${pair.priceUsd}\nMarket Cap: $${parseInt(pair.marketCap || 0).toLocaleString()}\n24h: ${pair.priceChange?.h24 || 0}%\n\n[DexScreener](${pair.url}) $COACH 📋`, { parse_mode: 'Markdown' });
    }
  } catch(e) { bot.sendMessage(chatId, `❌ Price unavailable. Check DexScreener.`); }
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🏟️ *THE COACH — COMMANDS:*\n\n/roast @username — destroy someone on X\n/ask [question] — press conference\n/predict — WC 2026 predictions\n/lineup [country] — ideal lineup\n/rate @coach — rate a coach /10\n/hottake — controversial opinion\n/history [coach] — compare to historical flop\n/verdict — latest verdict\n/treasury — treasury info\n/burn — burn stats\n/price — $COACH price\n\nNever coached. Never been wrong. $COACH 📋`, { parse_mode: 'Markdown' });
});

async function postVerdictToTelegram(text, competition) {
  if (!process.env.TELEGRAM_CHANNEL_ID) return;
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, `📋 *THE COACH:*\n\n${text}\n\n_${competition}_`, { parse_mode: 'Markdown' });
  } catch(e) {}
}

// ── CRON JOBS ────────────────────────────────────────────────
cron.schedule('*/15 * * * *', runMatchBot);
cron.schedule('0 18 * * *', postHotTake);
cron.schedule('0 8 * * *', fetchAndPostWCNews);
cron.schedule('0 10 * * *', fetchAndPostWCNews);
cron.schedule('0 12 * * *', fetchAndPostWCNews);
cron.schedule('0 15 * * *', fetchAndPostWCNews);
cron.schedule('0 19 * * *', fetchAndPostWCNews);
cron.schedule('0 21 * * *', fetchAndPostWCNews);
cron.schedule('0 * * * *', generateWebsiteVerdict);
cron.schedule('*/5 * * * *', checkAndProcessDMs);

// ── API ROUTES ───────────────────────────────────────────────
app.get('/api/posts', (req, res) => {
  const data = loadData();
  res.json(data.posts.slice(0, 10));
});

app.get('/api/matches', (req, res) => {
  const data = loadData();
  res.json(data.upcomingMatches.slice(0, 6));
});

app.get('/api/stats', (req, res) => {
  const data = loadData();
  res.json(data.stats);
});

app.get('/api/burns', (req, res) => {
  const data = loadData();
  res.json(data.burnEvents);
});

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

app.post('/api/hottake', async (req, res) => {
  await postHotTake();
  res.json({ success: true });
});

app.post('/api/news', async (req, res) => {
  await fetchAndPostWCNews();
  res.json({ success: true });
});

app.post('/api/website-verdict', async (req, res) => {
  await generateWebsiteVerdict();
  res.json({ success: true });
});

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '173aca1b-d8da-4a82-be02-14017bf5584d';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function verifyCoachTransaction(txHash, expectedWallet, expectedAmount) {
  try {
    await new Promise(r => setTimeout(r, 3000));
    const res = await axios.post(HELIUS_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'getTransaction',
      params: [txHash, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]
    });
    const tx = res.data?.result;
    if (!tx) return { valid: false, error: 'Transaction not found' };
    if (tx.meta?.err) return { valid: false, error: 'Transaction failed on-chain' };

    const instructions = tx.transaction?.message?.instructions || [];
    const innerInstructions = tx.meta?.innerInstructions?.flatMap(i => i.instructions) || [];
    const allInstructions = [...instructions, ...innerInstructions];

    for (const ix of allInstructions) {
      const parsed = ix.parsed;
      if (!parsed) continue;
      if ((parsed.type === 'transfer' || parsed.type === 'transferChecked') && parsed.info) {
        const info = parsed.info;
        const destination = info.destination || info.account;
        const amount = parseFloat(info.amount || info.tokenAmount?.uiAmount || 0);
        if (destination === TREASURY_WALLET && amount >= expectedAmount * 0.99) {
          return { valid: true, amount, txHash };
        }
      }
    }

    const preBalances = tx.meta?.preTokenBalances || [];
    const postBalances = tx.meta?.postTokenBalances || [];
    for (const post of postBalances) {
      if (post.owner === TREASURY_WALLET) {
        const pre = preBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmount = parseFloat(pre?.uiTokenAmount?.uiAmount || 0);
        const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || 0);
        const received = postAmount - preAmount;
        if (received >= expectedAmount * 0.99) return { valid: true, amount: received, txHash };
      }
    }

    return { valid: false, error: 'No valid $COACH transfer to treasury found' };
  } catch (e) {
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

  const verification = await verifyCoachTransaction(txHash, walletAddress, amount);
  if (!verification.valid) return res.status(400).json({ error: `Transaction invalid: ${verification.error}` });

  const odds = match.odds[outcome];
  const bet = { id: Date.now(), matchId, matchName: `${match.homeFlag} ${match.home} vs ${match.awayFlag} ${match.away}`, outcome, amount: verification.amount || amount, odds, potentialWin: Math.floor((verification.amount || amount) * odds), walletAddress, txHash, timestamp: new Date().toISOString(), status: 'pending' };
  data.bets.push(bet);
  saveWagers(data);
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
  data.bets = data.bets.map(b => b.matchId === matchId && b.status === 'pending' ? { ...b, status: b.outcome === result ? 'won' : 'lost', settledAt: new Date().toISOString() } : b);
  const match = WC_MATCHES.find(m => m.id === matchId);
  if (match) match.status = 'settled';
  saveWagers(data);
  const winners = data.bets.filter(b => b.matchId === matchId && b.status === 'won');
  res.json({ success: true, result, winners: winners.map(w => ({ wallet: w.walletAddress, bet: w.amount, payout: w.potentialWin })), totalPayout: winners.reduce((s,w)=>s+w.potentialWin,0) });
});

app.post('/telegram-webhook', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', time: new Date().toISOString() });
});

app.post('/api/admin/clear-dms', adminAuth, (req, res) => {
  const data = loadData();
  const count = data.processedDMs?.length || 0;
  data.processedDMs = [];
  data.pendingRoasts = {};
  saveData(data);
  res.json({ success: true, cleared: count });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🏟️  THE COACH BACKEND — ONLINE`);
  console.log(`📡 API running on http://localhost:${PORT}`);
  console.log(`⚽ Bot checking matches every 15 minutes\n`);
  runMatchBot();
  generateWebsiteVerdict();
});
