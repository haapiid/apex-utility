const { db } = require('../db');
const { UserError } = require('./tradeCommon');
const { isSolanaAddress } = require('../config');
const { isEvmAddress } = require('../config/chains');

// Wallet tracker (ApeX Pro): watch any wallet's trades without copying them. src/workers/tracker.js
// reads new trades (src/services/walletActivity.js), stores them as tracker_events and, if asked,
// notifies the user. Events are kept for 7 days.

const MAX_TRACKED = 30;
const EVENT_TTL_MS = 7 * 24 * 60 * 60_000;

function add(userId, chain, address, label) {
  const valid = chain.kind === 'sol' ? isSolanaAddress(address) : isEvmAddress(address);
  if (!valid) throw new UserError(`That is not a ${chain.name} wallet address.`);
  const n = db.prepare('SELECT COUNT(*) AS n FROM tracked_wallets WHERE user_id = ?').get(userId).n;
  if (n >= MAX_TRACKED) throw new UserError(`You can track up to ${MAX_TRACKED} wallets.`);
  const stored = chain.kind === 'evm' ? address.toLowerCase() : address;
  const name = String(label || '').trim().slice(0, 24) || `${address.slice(0, 4)}…${address.slice(-4)}`;
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO tracked_wallets (user_id, chain, address, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, chain.key, stored, name, Date.now());
    return get(userId, Number(lastInsertRowid));
  } catch (err) {
    if (/UNIQUE/.test(err.message)) throw new UserError('You already track that wallet on this chain.');
    throw err;
  }
}

const get = (userId, id) => db.prepare('SELECT * FROM tracked_wallets WHERE id = ? AND user_id = ?').get(id, userId) || null;
const list = (userId) => db.prepare('SELECT * FROM tracked_wallets WHERE user_id = ? ORDER BY id').all(userId);
const all = () => db.prepare('SELECT * FROM tracked_wallets ORDER BY id').all();
const remove = (userId, id) => db.prepare('DELETE FROM tracked_wallets WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
const setCursor = (id, cursor) => db.prepare('UPDATE tracked_wallets SET cursor = ? WHERE id = ?').run(String(cursor), id);

function update(userId, id, fields) {
  const patch = {};
  if ('notify' in fields) patch.notify = fields.notify ? 1 : 0;
  if ('label' in fields) patch.label = String(fields.label || '').trim().slice(0, 24) || 'Wallet';
  const keys = Object.keys(patch);
  if (!keys.length) return get(userId, id);
  db.prepare(`UPDATE tracked_wallets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`).run(...keys.map((k) => patch[k]), id, userId);
  return get(userId, id);
}

function addEvent(trackId, e) {
  db.prepare(
    'INSERT INTO tracker_events (track_id, side, token, token_amount, decimals, native, ref, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(trackId, e.side, e.token, e.tokenAmount ?? null, e.decimals ?? null, e.native ?? null, e.ref, e.at || Date.now());
}

/** Latest trades of the user's tracked wallets (or one of them), newest first */
function events(userId, { trackId, limit = 50 } = {}) {
  const params = [userId];
  let extra = '';
  if (trackId) {
    extra = ' AND w.id = ?';
    params.push(Number(trackId));
  }
  return db
    .prepare(
      `SELECT e.*, w.chain, w.address, w.label FROM tracker_events e JOIN tracked_wallets w ON w.id = e.track_id
       WHERE w.user_id = ?${extra} ORDER BY e.at DESC, e.id DESC LIMIT ?`,
    )
    .all(...params, Math.min(200, Number(limit) || 50));
}

const prune = () => db.prepare('DELETE FROM tracker_events WHERE at < ?').run(Date.now() - EVENT_TTL_MS);

module.exports = { add, get, list, all, remove, update, setCursor, addEvent, events, prune, MAX_TRACKED };
