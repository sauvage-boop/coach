// ============================================================
// THE COACH — Wager Backend
// Solana $COACH token wagering system
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const {
  Connection, PublicKey, Keypair, Transaction,
  SystemProgram, LAMPORTS_PER_SOL
} = require('@solana/web3.js');
const {
  getAssociatedTokenAddress, createTransferInstruction,
  TOKEN_PROGRAM_ID, getAccount
} = require('@solana/spl-token');
const bs58 = require('bs58');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ───────────────────────────────────────────────────
const TREASURY_WALLET = process.env.TREASURY_WALLET || 'DReFFztSXymUsNrKff4e6ozxMbQ3jdV6rCUEuuh9D3ty';
const COACH_TOKEN_MINT = process.env.COACH_TOKEN_MINT || ''; // Fill after pump.fun launch
const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'thecoach2026';

const connection = new Connection(RPC_URL, 'confirmed');

// ── DATA STORE ───────────────────────────────────────────────
const WAGER_FILE = path.join(__dirname, 'wagers.json');

function loadWagers() {
  if (!fs.existsSync(WAGER_FILE)) {
    const initial = { matches: [], bets: [], settled: [] };
    fs.writeFileSync(WAGER_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(WAGER_FILE, 'utf8'));
}

function saveWagers(data) {
  fs.writeFileSync(WAGER_FILE, JSON.stringify(data, null, 2));
}

// ── MATCHES (WC 2026 opening matches) ────────────────────────
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

// ── VERIFY TRANSACTION ───────────────────────────────────────
async function verifyTransaction(txHash, expectedFrom, expectedAmount) {
  try {
    await new Promise(r => setTimeout(r, 3000)); // Wait for confirmation
    const tx = await connection.getParsedTransaction(txHash, { maxSupportedTransactionVersion: 0 });
    if (!tx) return { valid: false, error: 'Transaction not found' };

    const instructions = tx.transaction.message.instructions;
    for (const ix of instructions) {
      if (ix.parsed?.type === 'transferChecked' || ix.parsed?.type === 'transfer') {
        const info = ix.parsed.info;
        if (
          info.destination &&
          info.amount &&
          parseInt(info.amount) >= expectedAmount * 1000000 // assuming 6 decimals
        ) {
          return { valid: true, amount: parseInt(info.amount) / 1000000 };
        }
      }
    }
    return { valid: false, error: 'Transfer not found in transaction' };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// ── API ROUTES ───────────────────────────────────────────────

// Get all open matches
app.get('/api/wager/matches', (req, res) => {
  res.json(WC_MATCHES.filter(m => m.status === 'open'));
});

// Get all matches including settled
app.get('/api/wager/matches/all', (req, res) => {
  res.json(WC_MATCHES);
});

// Get treasury wallet
app.get('/api/wager/treasury', (req, res) => {
  res.json({ wallet: TREASURY_WALLET, token: COACH_TOKEN_MINT });
});

// Place a bet
app.post('/api/wager/bet', async (req, res) => {
  const { matchId, outcome, amount, walletAddress, txHash } = req.body;

  if (!matchId || !outcome || !amount || !walletAddress || !txHash) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const match = WC_MATCHES.find(m => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.status !== 'open') return res.status(400).json({ error: 'Betting closed for this match' });
  if (!['home', 'draw', 'away'].includes(outcome)) return res.status(400).json({ error: 'Invalid outcome' });
  if (amount < 100) return res.status(400).json({ error: 'Minimum bet is 100 $COACH' });

  const data = loadWagers();

  // Check if tx already used
  const txExists = data.bets.find(b => b.txHash === txHash);
  if (txExists) return res.status(400).json({ error: 'Transaction already used' });

  // Verify transaction on Solana
  const verification = await verifyTransaction(txHash, walletAddress, amount);
  if (!verification.valid) {
    return res.status(400).json({ error: `Transaction invalid: ${verification.error}` });
  }

  const odds = match.odds[outcome];
  const potentialWin = Math.floor(amount * odds);

  const bet = {
    id: Date.now(),
    matchId,
    matchName: `${match.homeFlag} ${match.home} vs ${match.awayFlag} ${match.away}`,
    outcome,
    amount,
    odds,
    potentialWin,
    walletAddress,
    txHash,
    timestamp: new Date().toISOString(),
    status: 'pending'
  };

  data.bets.push(bet);
  saveWagers(data);

  console.log(`✅ Bet placed: ${walletAddress} bet ${amount} $COACH on ${outcome} for ${match.home} vs ${match.away}`);
  res.json({ success: true, bet });
});

// Get bets for a wallet
app.get('/api/wager/bets/:wallet', (req, res) => {
  const data = loadWagers();
  const bets = data.bets.filter(b => b.walletAddress === req.params.wallet);
  res.json(bets);
});

// Get all bets for a match
app.get('/api/wager/bets/match/:matchId', (req, res) => {
  const data = loadWagers();
  const bets = data.bets.filter(b => b.matchId === req.params.matchId);
  const total = bets.reduce((sum, b) => sum + b.amount, 0);
  const byOutcome = {
    home: bets.filter(b => b.outcome === 'home').reduce((s, b) => s + b.amount, 0),
    draw: bets.filter(b => b.outcome === 'draw').reduce((s, b) => s + b.amount, 0),
    away: bets.filter(b => b.outcome === 'away').reduce((s, b) => s + b.amount, 0),
  };
  res.json({ bets, total, byOutcome });
});

// ── ADMIN ROUTES ─────────────────────────────────────────────

// Admin auth middleware
function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Get all bets (admin)
app.get('/api/admin/bets', adminAuth, (req, res) => {
  const data = loadWagers();
  res.json(data.bets);
});

// Settle a match (admin)
app.post('/api/admin/settle', adminAuth, (req, res) => {
  const { matchId, result } = req.body; // result: 'home', 'draw', or 'away'
  if (!matchId || !result) return res.status(400).json({ error: 'Missing matchId or result' });

  const data = loadWagers();
  const matchBets = data.bets.filter(b => b.matchId === matchId && b.status === 'pending');
  const winners = matchBets.filter(b => b.outcome === result);
  const losers = matchBets.filter(b => b.outcome !== result);

  // Mark bets as settled
  data.bets = data.bets.map(b => {
    if (b.matchId === matchId && b.status === 'pending') {
      return { ...b, status: b.outcome === result ? 'won' : 'lost', settledAt: new Date().toISOString() };
    }
    return b;
  });

  // Update match status
  const match = WC_MATCHES.find(m => m.id === matchId);
  if (match) match.status = 'settled';

  saveWagers(data);

  console.log(`🏆 Match settled: ${matchId} — Result: ${result}`);
  console.log(`Winners: ${winners.length} | Losers: ${losers.length}`);

  res.json({
    success: true,
    result,
    winners: winners.map(w => ({
      wallet: w.walletAddress,
      bet: w.amount,
      payout: w.potentialWin,
      odds: w.odds
    })),
    losers: losers.length,
    totalPayout: winners.reduce((s, w) => s + w.potentialWin, 0)
  });
});

// Stats
app.get('/api/wager/stats', (req, res) => {
  const data = loadWagers();
  const total = data.bets.reduce((s, b) => s + b.amount, 0);
  const won = data.bets.filter(b => b.status === 'won').length;
  const pending = data.bets.filter(b => b.status === 'pending').length;
  res.json({ totalBets: data.bets.length, totalVolume: total, won, pending });
});

// Health
app.get('/api/wager/health', (req, res) => res.json({ status: 'online' }));

const PORT = process.env.WAGER_PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🎰 THE COACH WAGER SERVER — ONLINE`);
  console.log(`📡 Running on port ${PORT}`);
  console.log(`💰 Treasury: ${TREASURY_WALLET}\n`);
});
