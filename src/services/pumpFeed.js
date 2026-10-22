const { EventEmitter } = require('events');
const { config } = require('../config');
const logger = require('../utils/logger');

// Live pump.fun events from PumpPortal's free WebSocket feed (Node's built-in WebSocket).
//   'create'  { mint, name, symbol, creator, devBuyPct, signature }
//   'migrate' { mint, signature }  the token left the bonding curve for PumpSwap
// Connected only while something needs it (setWanted, or ApeX Pro's live list was viewed in the last
// minute); reconnects with backoff. The latest events are kept for ApeX Pro's live list.

const TOTAL_SUPPLY = 1_000_000_000; // every pump.fun token, in whole tokens
const MIGRATED_TTL_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 60_000;
const VIEW_KEEPALIVE_MS = 60_000;
const RECENT = { create: 30, migrate: 20 };

const events = new EventEmitter();
const migrated = new Map(); // mint → seen at
let ws = null;
let wanted = false;
let backoff = 1_000;
let retryTimer = null;
let connectedAt = 0;
let viewedAt = 0;
const recent = { create: [], migrate: [] };

function remember(kind, event) {
  recent[kind].unshift({ ...event, at: Date.now() });
  recent[kind].length = Math.min(recent[kind].length, RECENT[kind]);
}

function handle(raw) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!m?.mint) return;
  if (m.txType === 'create') {
    const token = {
      mint: m.mint,
      name: String(m.name || ''),
      symbol: String(m.symbol || ''),
      creator: m.traderPublicKey || null,
      devBuyPct: (Number(m.initialBuy) || 0) / TOTAL_SUPPLY * 100,
      signature: m.signature || null,
    };
    remember('create', token);
    events.emit('create', token);
  } else if (m.txType === 'migrate') {
    const event = { mint: m.mint, signature: m.signature || null };
    migrated.set(m.mint, Date.now());
    remember('migrate', event);
    events.emit('migrate', event);
  }
}

function connect() {
  if (ws || !wanted) return;
  const socket = new WebSocket(config.pump.feedUrl);
  ws = socket;
  socket.onopen = () => {
    connectedAt = Date.now();
    backoff = 1_000;
    socket.send(JSON.stringify({ method: 'subscribeNewToken' }));
    socket.send(JSON.stringify({ method: 'subscribeMigration' }));
    logger.info('pump.fun feed connected');
  };
  socket.onmessage = (e) => handle(e.data);
  socket.onerror = (e) => logger.debug({ err: e.message }, 'pump.fun feed error');
  socket.onclose = () => {
    if (ws === socket) ws = null;
    connectedAt = 0;
    if (!wanted) return;
    logger.warn({ retryMs: backoff }, 'pump.fun feed closed, reconnecting');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };
}

// Open the feed while true (or while someone watches the live list), close it when nobody needs it
function setWanted(value) {
  wanted = Boolean(value) || Date.now() - viewedAt < VIEW_KEEPALIVE_MS;
  if (wanted) return connect();
  clearTimeout(retryTimer);
  retryTimer = null;
  if (ws) {
    const socket = ws;
    ws = null;
    socket.close();
    logger.info('pump.fun feed closed (no active pump rules or migration snipes)');
  }
}

function hasMigrated(mint) {
  const at = migrated.get(mint);
  if (!at) return false;
  if (Date.now() - at > MIGRATED_TTL_MS) {
    migrated.delete(mint);
    return false;
  }
  return true;
}

const status = () => ({ connected: connectedAt > 0, since: connectedAt || null });

// ApeX Pro's live list: viewing it keeps the feed open for a minute
function live() {
  viewedAt = Date.now();
  if (!wanted) setWanted(true);
  return { ...status(), launches: recent.create, migrations: recent.migrate };
}

// Shutdown: close regardless of viewers
function close() {
  viewedAt = 0;
  setWanted(false);
}

module.exports = { events, setWanted, hasMigrated, status, live, close };
