const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('../config');
const logger = require('../utils/logger');

// SQLite (built into Node 22.13+). One file: data/apex.db. Synchronous API, so no races between await points.
fs.mkdirSync(path.dirname(config.db.path), { recursive: true });
const db = new DatabaseSync(config.db.path);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Each entry runs once, in order; PRAGMA user_version stores how many have run
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,                -- Telegram user id
    settings TEXT NOT NULL DEFAULT '{}',   -- JSON, see settingsService
    created_at INTEGER NOT NULL
  );
  CREATE TABLE wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,                    -- 'sol' | 'evm'
    address TEXT NOT NULL,
    encrypted_key TEXT NOT NULL,
    label TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,     -- the wallet used for trading, one per user and kind
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, kind, address)
  );
  CREATE TABLE trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    wallet_id INTEGER,
    chain TEXT NOT NULL,
    side TEXT NOT NULL,                    -- 'buy' | 'sell'
    source TEXT NOT NULL DEFAULT 'manual', -- manual | snipe | limit | dca | copy
    token TEXT NOT NULL,
    sol_volume REAL NOT NULL DEFAULT 0,    -- Solana trades
    fee_sol REAL NOT NULL DEFAULT 0,
    native_volume REAL NOT NULL DEFAULT 0, -- EVM trades
    volume_usd REAL NOT NULL DEFAULT 0,
    fee_usd REAL NOT NULL DEFAULT 0,
    signature TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX trades_at ON trades (at);
  CREATE INDEX trades_user_at ON trades (user_id, at);
  -- Average-cost position per wallet and token; amounts are raw integers stored as text (bigint)
  CREATE TABLE positions (
    wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    symbol TEXT NOT NULL,
    decimals INTEGER NOT NULL,
    amount TEXT NOT NULL DEFAULT '0',      -- tokens held (as tracked from our own trades)
    cost TEXT NOT NULL DEFAULT '0',        -- native spent on the tokens still held
    realized TEXT NOT NULL DEFAULT '0',    -- native profit/loss already taken (can be negative)
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (wallet_id, chain, token)
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // Phase 2: automation run by src/workers (prices are native coin per whole token)
  `
  CREATE TABLE orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    symbol TEXT NOT NULL,
    type TEXT NOT NULL,                    -- limit_buy | take_profit | stop_loss
    amount TEXT NOT NULL,                  -- limit_buy: native amount; take_profit/stop_loss: % of balance
    ref_price REAL NOT NULL,               -- price when the order was placed
    trigger_price REAL NOT NULL,           -- limit_buy/stop_loss fire at or below, take_profit at or above
    last_price REAL,
    status TEXT NOT NULL DEFAULT 'open',   -- open | filled | failed | cancelled | expired
    attempts INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    error TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX orders_status ON orders (status);
  CREATE TABLE dca_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,                    -- buy | sell
    amount TEXT NOT NULL,                  -- buy: native per run; sell: raw tokens per run
    runs_total INTEGER NOT NULL,
    runs_done INTEGER NOT NULL DEFAULT 0,
    interval_sec INTEGER NOT NULL,
    next_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',   -- open | done | failed | cancelled
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX dca_status ON dca_plans (status, next_at);
  CREATE TABLE snipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,                  -- native amount to buy
    safety INTEGER NOT NULL DEFAULT 1,     -- 1 = skip tokens that fail the safety scan
    status TEXT NOT NULL DEFAULT 'waiting',-- waiting | bought | failed | cancelled | expired
    attempts INTEGER NOT NULL DEFAULT 0,
    signature TEXT,
    error TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX snipes_status ON snipes (status);
  CREATE TABLE copy_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT NOT NULL,
    buy_amount TEXT NOT NULL,              -- native amount per copied buy
    copy_sells INTEGER NOT NULL DEFAULT 1, -- mirror the target's sells (same % of the bag)
    active INTEGER NOT NULL DEFAULT 1,
    cursor TEXT,                           -- Solana: last seen signature; EVM: last scanned block
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, chain, address)
  );
  `,
  // Phase 3: referral, revenue share, cashback, claims, burn credits. Native amounts are raw integers as text.
  `
  ALTER TABLE users ADD COLUMN ref_code TEXT;
  ALTER TABLE users ADD COLUMN referrer_id INTEGER;
  ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN extra_wallet_slots INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX users_ref_code ON users (ref_code);
  -- Credits to a user: referral / revenue in a chain's native coin; cashback in USD (chain = 'apex')
  CREATE TABLE rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    kind TEXT NOT NULL,                    -- referral | revenue | cashback
    amount TEXT NOT NULL DEFAULT '0',      -- raw native (referral, revenue)
    usd REAL NOT NULL DEFAULT 0,           -- USD value (cashback is paid out by this)
    ref TEXT,                              -- trade signature or epoch id
    created_at INTEGER NOT NULL
  );
  CREATE INDEX rewards_user ON rewards (user_id, chain);
  CREATE TABLE claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    kind TEXT NOT NULL,                    -- native | cashback
    amount TEXT NOT NULL,                  -- raw native, or raw $APEX for cashback
    usd REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL,                  -- pending | sent | failed (failed claims don't count)
    signature TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX claims_user ON claims (user_id, chain);
  -- Holder share of fees waiting for the next distribution, per chain
  CREATE TABLE revenue_pool (chain TEXT PRIMARY KEY, amount TEXT NOT NULL DEFAULT '0');
  CREATE TABLE epochs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    amount TEXT NOT NULL,                  -- distributed
    holders INTEGER NOT NULL,
    total_held TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE burns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount TEXT NOT NULL,                  -- raw $APEX
    credits INTEGER NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // Phase 4: ApeX Pro web login. Only hashes of codes and session tokens are stored.
  `
  CREATE TABLE web_login_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE INDEX web_sessions_user ON web_sessions (user_id);
  `,
  // Standalone accounts: web users without Telegram get negative ids (Telegram ids are always positive,
  // so a positive id means "Telegram linked"). Other login methods are identities attached to a user.
  `
  CREATE TABLE identities (
    provider TEXT NOT NULL,                -- sol | evm | google
    subject TEXT NOT NULL,                 -- wallet address, or Google account id
    user_id INTEGER NOT NULL,
    label TEXT,                            -- e.g. the Google email
    created_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX identities_user ON identities (user_id);
  -- One-time sign-in challenges (wallet messages, Google OAuth state); only hashes of the secrets
  CREATE TABLE auth_nonces (
    nonce_hash TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  -- Messages from the bot's background jobs, shown in ApeX Pro (and sent on Telegram when linked)
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX notifications_user ON notifications (user_id, id);
  `,
  // pump.fun sniper: standing rules that buy new launches or migrations from the PumpPortal feed,
  // and per-token snipes that wait for the token to migrate off the bonding curve
  `
  CREATE TABLE pump_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    mode TEXT NOT NULL,                    -- launch | migration
    amount TEXT NOT NULL,                  -- SOL per buy
    max_buys INTEGER NOT NULL,             -- the rule stops after this many buys
    buys_done INTEGER NOT NULL DEFAULT 0,
    keyword TEXT,                          -- launch only: name or symbol must contain it
    max_dev_pct REAL,                      -- launch only: skip when the creator bought more than this % of supply
    safety INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX pump_rules_active ON pump_rules (active);
  CREATE TABLE pump_buys (
    rule_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    mint TEXT NOT NULL,
    symbol TEXT,
    status TEXT NOT NULL,                  -- pending | bought | skipped | failed
    signature TEXT,
    error TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (rule_id, mint)
  );
  CREATE INDEX pump_buys_user ON pump_buys (user_id, at);
  ALTER TABLE snipes ADD COLUMN trigger TEXT NOT NULL DEFAULT 'tradable'; -- tradable | migration
  `,
  // ApeX Pro: watchlist, wallet tracker, security PIN, and launch stats of Solana tokens (bundles, snipers)
  `
  CREATE TABLE watchlist (
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chain, token)
  );
  CREATE TABLE tracked_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chain TEXT NOT NULL,
    address TEXT NOT NULL,
    label TEXT NOT NULL,
    notify INTEGER NOT NULL DEFAULT 1,     -- message the user on every trade
    cursor TEXT,                           -- Solana: last seen signature; EVM: last scanned block
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, chain, address)
  );
  CREATE TABLE tracker_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id INTEGER NOT NULL REFERENCES tracked_wallets(id) ON DELETE CASCADE,
    side TEXT NOT NULL,
    token TEXT NOT NULL,
    token_amount TEXT,
    decimals INTEGER,
    native TEXT,                           -- native coin spent (buy) or received (sell), raw units
    ref TEXT NOT NULL,                     -- signature / tx hash
    at INTEGER NOT NULL
  );
  CREATE INDEX tracker_events_track ON tracker_events (track_id, at);
  CREATE TABLE security_pins (
    user_id INTEGER PRIMARY KEY,
    pin_hash TEXT NOT NULL,                -- scrypt, hex
    salt TEXT NOT NULL,
    failed INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE token_launch (
    chain TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL,                  -- ok | unknown (too old / too many transactions to reach the start)
    first_slot INTEGER,
    bundled_pct REAL,                      -- % of supply bought by wallets in the launch slot (dev included)
    bundlers INTEGER,
    snipers INTEGER,                       -- wallets that first bought in the next 3 slots
    sniper_pct REAL,
    computed_at INTEGER NOT NULL,
    PRIMARY KEY (chain, token)
  );
  CREATE INDEX trades_user ON trades (user_id, at);
  `,
];

function migrate() {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < MIGRATIONS.length; i++) {
    transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    });
    logger.info({ version: i + 1 }, 'Database migrated');
  }
}

let depth = 0;
// Runs fn atomically (nested calls join the outer transaction)
function transaction(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const setMeta = (key, value) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));

// One-time import of the JSON stores used before SQLite (data/wallets.json, data/stats.json)
function importJsonStores() {
  const dataDir = path.dirname(config.db.path);
  const walletsFile = path.join(dataDir, 'wallets.json');
  const statsFile = path.join(dataDir, 'stats.json');
  if (getMeta('json_imported') || (!fs.existsSync(walletsFile) && !fs.existsSync(statsFile))) return;

  transaction(() => {
    const now = Date.now();
    let wallets = 0;
    if (fs.existsSync(walletsFile)) {
      const data = JSON.parse(fs.readFileSync(walletsFile, 'utf8'));
      const addUser = db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)');
      const addWallet = db.prepare(
        'INSERT OR IGNORE INTO wallets (user_id, kind, address, encrypted_key, label, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      );
      for (const [userId, entry] of Object.entries(data)) {
        // Oldest layout: Solana fields directly on the entry. Later: { sol: {...}, evm: {...} }
        const byKind = entry.address ? { sol: entry } : entry;
        addUser.run(Number(userId), now);
        for (const kind of ['sol', 'evm']) {
          const w = byKind[kind];
          if (!w?.address) continue;
          addWallet.run(Number(userId), kind, w.address, w.encryptedKey, 'W1', Date.parse(w.createdAt) || now);
          wallets++;
        }
      }
    }

    let trades = 0;
    if (fs.existsSync(statsFile)) {
      const data = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
      const add = db.prepare(
        `INSERT INTO trades (user_id, chain, side, token, sol_volume, fee_sol, native_volume, volume_usd, fee_usd, signature, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let volumeSol = 0;
      let feesSol = 0;
      for (const t of data.trades || []) {
        add.run(t.userId, t.chain || 'sol', t.side, t.token, t.solVolume || 0, t.feeSol || 0, t.nativeVolume || 0,
          t.volumeUsd || 0, t.feeUsd || 0, t.signature || null, t.at);
        volumeSol += t.solVolume || 0;
        feesSol += t.feeSol || 0;
        trades++;
      }
      // The JSON log kept only 30 days; keep the older part of the all-time totals
      const totals = data.totals || {};
      setMeta('legacy_volume_sol', Math.max(0, (totals.volumeSol || 0) - volumeSol));
      setMeta('legacy_fees_sol', Math.max(0, (totals.feesSol || 0) - feesSol));
      setMeta('legacy_trades', Math.max(0, (totals.trades || 0) - trades));
    }
    setMeta('json_imported', now);
    logger.info({ wallets, trades }, 'Imported JSON stores into SQLite');
  });

  // Keep the old files as a backup, out of the way
  for (const file of [walletsFile, statsFile]) {
    if (fs.existsSync(file)) fs.renameSync(file, file.replace(/\.json$/, '.imported.json'));
  }
}

migrate();
importJsonStores();

module.exports = { db, transaction, getMeta, setMeta };
