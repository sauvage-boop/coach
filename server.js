// ════════════════════════════════════════
// RET4RTED — Main Server
// ════════════════════════════════════════

require('dotenv').config();

const express = require('express');
const http    = require('http');
const cors    = require('cors');
const cron    = require('node-cron');
const path    = require('path');
const config  = require('./config');

// Modules
const scanner = require('./src/scanner');
const whale   = require('./src/whale');
const calls   = require('./src/calls');
const ws      = require('./src/ws');
const routes  = require('./src/routes');

// ── App setup ─────────────────────────────
const app    = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Serve frontend HTML from root
app.use(express.static(path.join(__dirname, 'public')));

// REST API
app.use('/api', routes);

// ── WebSocket ──────────────────────────────
ws.init(server);

// ── Subscribe modules to each other ───────

// Scanner → push to all WS clients
scanner.subscribe((event, data) => {
  if (event === 'tokens:update') ws.push.tokenUpdate(data);
  if (event === 'tokens:full')   ws.push.tokenFull(data);
  if (event === 'tokens:alerts') {
    data.forEach(alert => {
      ws.push.newAlert(alert);
    });
  }
});

// Whale → push alerts to WS
whale.subscribe((event, data) => {
  if (event === 'whale:alert') ws.push.whaleAlert(data);
});

// Calls → push to WS
calls.subscribe((event, data) => {
  if (event === 'calls:alert') ws.push.callAlert(data);
});

// ── Scan loops ─────────────────────────────

// Token scan every 3 seconds
setInterval(async () => {
  await scanner.scan();
}, config.scanner.intervalMs);

// Whale scan every 10 seconds
setInterval(async () => {
  await whale.scan();
}, 10000);

// Calls scan every 5 seconds
setInterval(() => {
  calls.scan();
}, 5000);

// SOL price ticker every 2 seconds (mock)
let mockSolPrice = 178.40;
setInterval(() => {
  mockSolPrice += (Math.random() - 0.5) * 0.3;
  ws.push.solPrice(+mockSolPrice.toFixed(2));
}, 2000);

// ── Boot ───────────────────────────────────
async function start() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║   RET4RTED — Solana Degen Terminal  ║');
  console.log('╚════════════════════════════════════╝\n');
  console.log(`[Config] Mock mode: ${config.useMock}`);
  console.log(`[Config] Scan interval: ${config.scanner.intervalMs}ms`);

  // Init all modules
  await scanner.init();
  await whale.init();
  calls.init();

  // After init, push full state to any early WS connections
  const tokens = scanner.getAll();
  if (tokens.length > 0) ws.push.tokenFull(tokens);

  // Start HTTP + WS server
  server.listen(config.port, () => {
    console.log(`\n✅ Server running on http://localhost:${config.port}`);
    console.log(`📡 WebSocket on ws://localhost:${config.port}`);
    console.log(`🔧 API on http://localhost:${config.port}/api`);
    console.log(`\nEndpoints:`);
    console.log(`  GET  /api/tokens`);
    console.log(`  GET  /api/tokens/:id`);
    console.log(`  GET  /api/ai/thesis/:id`);
    console.log(`  GET  /api/whale/alerts`);
    console.log(`  GET  /api/twitter/:symbol`);
    console.log(`  GET  /api/calls`);
    console.log(`  GET  /api/pnl/:wallet`);
    console.log(`  POST /api/webhooks/telegram`);
    console.log(`  POST /api/webhooks/discord`);
    console.log(`\n👀 Scanning Solana...\n`);
  });
}

start().catch(err => {
  console.error('❌ Boot failed:', err);
  process.exit(1);
});
