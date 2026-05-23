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
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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

async function postToTwitter(text, competition = '') {
  try {
    const tweet = await twitter.v2.tweet(text);
    console.log('✅ Posted:', text.substring(0, 60) + '...');
    // Auto-post to Telegram
    if (competition) postVerdictToTelegram(text, competition);
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
  "20 days until the World Cup. 48 coaches. 47 of them are going to embarrass themselves. The Coach has the receipts ready. $COACH 📋",
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
    // Step 1: Search for WC 2026 news only
    const searchMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{
        role: 'user',
        content: 'Search for FIFA World Cup 2026 news only. Must be about: WC2026 squad announcements, WC2026 player selections, WC2026 coach decisions, WC2026 group stage, WC2026 injuries. NO club football. NO other tournaments. ONE specific WC2026 story. Return only headline + 1 sentence. Nothing else.'
      }]
    });

    const newsText = searchMsg.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    if (!newsText || newsText.length < 20) return;

    // Only post if it's actually WC2026 content
    const wcKeywords = ['world cup', 'wc2026', 'wc 2026', 'squad', 'fifa', 'group', 'qualifier', 'selection', '2026'];
    const isWC = wcKeywords.some(k => newsText.toLowerCase().includes(k));
    if (!isWC) { console.log('📰 Skipping non-WC news'); return; }

    // Step 2: Generate roast tweet about the news
    const verdictMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system: COACH_PERSONA,
      messages: [{
        role: 'user',
        content: `News: "${newsText.substring(0, 200)}"

Write ONLY a tweet reacting to this. No intro. No explanation. Start directly with your opinion. Under 260 chars. Must end with $COACH.`
      }]
    });

    let text = verdictMsg.content[0]?.text?.trim();
    if (!text) return;

    // STRICT validation - must end with $COACH and be under 280 chars
    if (!text.includes('$COACH')) return;
    if (text.length > 280) text = text.substring(0, 277) + '...';

    // Must not be an intro sentence
    const badPhrases = ["I'll search", "I will search", "Let me", "Here's", "I found", "Based on"];
    if (badPhrases.some(p => text.startsWith(p))) return;

    // Avoid duplicates
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

// ── DM ROAST BOT ─────────────────────────────────────────────
const COACH_CA = process.env.COACH_CA || ''; // Fill after pump.fun launch
const BURN_ADDRESS = '1nc1nerator11111111111111111111111111111111'; // Solana burn address
const ROAST_PRICE = parseInt(process.env.ROAST_PRICE || '1000'); // 1000 $COACH default

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

    // Check post token balances for burn address
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

    // Also check via instruction parsing
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

    // Get DM events
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

      // Skip bot's own reply messages and empty
      if (!text || text.startsWith('Done.') || text.startsWith('The Coach sees') || text.startsWith('Verifying') || text.startsWith('Request expired')) continue;

      // ── STEP 1: @ROAST request ──
      const roastMatch = text.match(/@ROAST\s+@?(\S+)/i);
      if (roastMatch) {
        const targetHandle = roastMatch[1].replace('@', '');
        console.log(`🎯 Roast request: @${targetHandle} from DM`);

        // If no CA yet, roast for free
        if (!COACH_CA) {
          await executeRoast(dm, targetHandle, convId);
          continue;
        }

        // Store pending roast and ask for payment
        data.pendingRoasts[convId] = { targetHandle, requestedAt: Date.now() };
        saveData(data);

        try {
          await twitter.v2.sendDmInConversation(convId, {
            text: `The Coach sees your request. 👀\n\nTo roast @${targetHandle}, burn ${ROAST_PRICE} $COACH to the burn address:\n\n1nc1nerator11111111111111111111111111111111\n\nThen reply with: TX:[your transaction hash]\n\nTokens are permanently burned. No refunds. The Coach delivers. $COACH 📋`
          });
        } catch(e) {}
        continue;
      }

      // ── STEP 2: TX hash confirmation ──
      const txMatch = text.match(/TX:\s*([A-Za-z0-9]{40,})/i);
      if (txMatch && data.pendingRoasts[convId]) {
        const txHash = txMatch[1].trim();
        const pending = data.pendingRoasts[convId];

        // Check if request is not too old (24 hours)
        if (Date.now() - pending.requestedAt > 86400000) {
          delete data.pendingRoasts[convId];
          saveData(data);
          try { await twitter.v2.sendDmInConversation(convId, { text: `Request expired. Start over with @ROAST @username. $COACH` }); } catch(e) {}
          continue;
        }

        console.log(`🔥 Verifying burn tx for @${pending.targetHandle}: ${txHash}`);

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

        // Burn verified — execute roast
        console.log(`✅ Burn verified: ${verification.burned} $COACH burned for roast of @${pending.targetHandle}`);
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
      console.log(`📋 Got context for @${targetHandle}`);
    }
  } catch(e) {
    console.log(`⚠️ Could not get context for @${targetHandle}: ${e.message}`);
  }

  try {
    const roastMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system: COACH_PERSONA,
      messages: [{ role: 'user', content: `Roast @${targetHandle} HARD as The Coach. Brutal, specific, degen. You know who they are.\n\n${targetContext ? `Context: ${targetContext}` : ''}\n\nONE tweet. Under 260 chars. Must start with @${targetHandle} or include @${targetHandle} early. Must end with $COACH. No intro. Direct roast only.` }]
    });

    let roastText = roastMsg.content[0]?.text?.trim();
    console.log(`📝 Generated roast: ${roastText?.substring(0, 80)}...`);
    if (!roastText || !roastText.includes('$COACH')) {
      console.log('❌ Roast validation failed - missing $COACH');
      return;
    }
    if (roastText.length > 280) roastText = roastText.substring(0, 277) + '...';

    const posted = await postToTwitter(roastText);

    if (posted.success) {
      const replyText = burnedAmount
        ? `Done. ${burnedAmount.toLocaleString()} $COACH burned forever. The Coach has spoken. Check the timeline. 🔥`
        : `Done. The Coach has spoken. Check the timeline.\n\n⚠️ Coming soon: roasts will cost $COACH — permanently burned. Buy $COACH on pump.fun when it drops. $COACH 📋`;

      try { 
        await twitter.v2.sendDmInConversation(convId, { text: replyText }); 
      } catch(e) {
        console.log(`⚠️ Could not send DM reply: ${e.message}`);
      }

      const freshData = loadData();
      freshData.posts.unshift({ id: Date.now(), tweetId: posted.id, text: roastText, match: null, competition: `Roast: @${targetHandle}`, timestamp: new Date().toISOString(), posted: true, source: 'roast_request' });
      if (freshData.posts.length > 50) freshData.posts = freshData.posts.slice(0, 50);
      freshData.stats.totalPosts++;
      saveData(freshData);
      console.log(`🔥 Roast posted for @${targetHandle}`);
    }
  } catch(e) {
    console.error(`❌ executeRoast error for @${targetHandle}:`, e.message);
  }
}

// ── TELEGRAM BOT COMMANDS ────────────────────────────────────

// /roast @username — roast someone and post on X
bot.onText(/\/roast\s+@?(\S+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const targetHandle = match[1].replace('@', '');
  const requesterName = msg.from.first_name || 'Someone';

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
    messages: [{ role: 'user', content: `Roast @${targetHandle} HARD as The Coach. Brutal, specific, degen.\n\n${targetContext ? `Context: ${targetContext}` : ''}\n\nONE tweet. Under 260 chars. Must include @${targetHandle} early so they get notified. Must end with $COACH. No intro.` }]
  });

  let roastText = roastMsg.content[0]?.text?.trim();
  if (!roastText || !roastText.includes('$COACH')) {
    bot.sendMessage(chatId, `❌ The Coach couldn't roast @${targetHandle} right now. Try again.`);
    return;
  }
  if (roastText.length > 280) roastText = roastText.substring(0, 277) + '...';

  // Post on X
  const posted = await postToTwitter(roastText);
  if (posted.success) {
    bot.sendMessage(chatId, `🔥 Posted on X:\n\n"${roastText}"\n\nhttps://x.com/thecoachonchain`);

    const data = loadData();
    data.posts.unshift({ id: Date.now(), tweetId: posted.id, text: roastText, match: null, competition: `Roast: @${targetHandle}`, timestamp: new Date().toISOString(), posted: true, source: 'telegram_roast' });
    if (data.posts.length > 50) data.posts = data.posts.slice(0, 50);
    data.stats.totalPosts++;
    saveData(data);
  } else {
    bot.sendMessage(chatId, `⏸️ X is rate limited. Roast saved, will post soon:\n\n"${roastText}"`);
  }
});

// /ask [question] — press conference mode
bot.onText(/\/ask\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];
  const askerName = msg.from.first_name || 'Someone';

  try {
    const answerMsg = await claudeWithRetry({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: COACH_PERSONA,
      messages: [{ role: 'user', content: `You are at a press conference. ${askerName} asks: "${question}"\n\nAnswer as The Coach — arrogant, confident, entertaining. 2-4 sentences. End with $COACH.` }]
    });

    const answer = answerMsg.content[0]?.text?.trim();
    if (answer) {
      bot.sendMessage(chatId, `📋 *The Coach responds:*\n\n${answer}`, { parse_mode: 'Markdown' });
    }
  } catch(e) {
    bot.sendMessage(chatId, `❌ The Coach is busy. Try again.`);
  }
});

// /verdict — latest verdict from the website feed
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

// /start — welcome message
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🏟️ *THE COACH is here.*\n\nNever coached. Never been wrong.\n\n📋 *Commands:*\n/roast @username — destroy someone on X\n/ask [question] — press conference\n/predict — WC 2026 predictions\n/lineup [country] — ideal lineup\n/rate @coach — rate a coach /10\n/hottake — controversial hot take\n/history [coach] — compare to historical flop\n/verdict — latest verdict\n/treasury — treasury wallet info\n/burn — burn stats\n/price — $COACH price\n/help — all commands\n\nRoast requests cost $COACH after launch. For now — on the house. $COACH 📋`, { parse_mode: 'Markdown' });
});

bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));

// /predict — WK predictions
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

// /lineup [country] — ideal lineup
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

// /rate @coach — rate a coach
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

// /hottake — random hot take
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

// /history [coach] — compare to historical flop
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

// /treasury — treasury info
bot.onText(/\/treasury/, (msg) => {
  const chatId = msg.chat.id;
  const data = loadData();
  const totalBets = data.bets?.reduce((s,b) => s+b.amount, 0) || 0;
  bot.sendMessage(chatId, `💰 *THE COACH'S TREASURY:*\n\nWallet: \`${TREASURY_WALLET}\`\n\nTotal wagered: ${totalBets.toLocaleString()} $COACH\n\n🔗 [View on Solscan](https://solscan.io/account/${TREASURY_WALLET})\n\nBuybacks announced on X. Every transaction verifiable. $COACH 📋`, { parse_mode: 'Markdown' });
});

// /burn — burn stats
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

// /price — token price (after launch)
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

// Auto-post verdicts to Telegram when posted on X
async function postVerdictToTelegram(text, competition) {
  if (!process.env.TELEGRAM_CHANNEL_ID) return;
  try {
    await bot.sendMessage(process.env.TELEGRAM_CHANNEL_ID, `📋 *THE COACH:*\n\n${text}\n\n_${competition}_`, { parse_mode: 'Markdown' });
  } catch(e) {}
}

// /help
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `🏟️ *THE COACH — COMMANDS:*\n\n/roast @username — destroy someone on X\n/ask [question] — press conference\n/predict — WC 2026 predictions\n/lineup [country] — ideal lineup\n/rate @coach — rate a coach /10\n/hottake — controversial opinion\n/history [coach] — compare to historical flop\n/verdict — latest verdict\n/treasury — treasury info\n/burn — burn stats\n/price — $COACH price\n\nNever coached. Never been wrong. $COACH 📋`, { parse_mode: 'Markdown' });
});

cron.schedule('*/15 * * * *', runMatchBot);          // Check matches every 15 min
cron.schedule('0 18 * * *', postHotTake);            // Hot take 1x/day at 6pm
cron.schedule('0 8 * * *', fetchAndPostWCNews);      // WC news 8am
cron.schedule('0 10 * * *', fetchAndPostWCNews);     // WC news 10am
cron.schedule('0 12 * * *', fetchAndPostWCNews);     // WC news 12pm
cron.schedule('0 15 * * *', fetchAndPostWCNews);     // WC news 3pm
cron.schedule('0 19 * * *', fetchAndPostWCNews);     // WC news 7pm
cron.schedule('0 21 * * *', fetchAndPostWCNews);     // WC news 9pm
cron.schedule('0 * * * *', generateWebsiteVerdict); // Website verdict every hour
cron.schedule('*/5 * * * *', checkAndProcessDMs);   // Check DMs every 5 min

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

// Clear processed DMs (admin)
app.post('/api/admin/clear-dms', adminAuth, (req, res) => {
  const data = loadData();
  const count = data.processedDMs?.length || 0;
  data.processedDMs = [];
  data.pendingRoasts = {};
  saveData(data);
  console.log(`🧹 Cleared ${count} processed DMs`);
  res.json({ success: true, cleared: count });
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
