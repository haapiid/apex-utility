const { db } = require('../db');
const { UserError } = require('./tradeCommon');

// Starred tokens per user (ApeX Pro). EVM addresses are stored lowercase so a token is starred once.

const MAX = 100;
const norm = (chain, token) => (chain.kind === 'evm' ? token.toLowerCase() : token);

function add(userId, chain, token) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM watchlist WHERE user_id = ?').get(userId).n;
  if (n >= MAX) throw new UserError(`Your watchlist is full (${MAX} tokens).`);
  db.prepare('INSERT OR IGNORE INTO watchlist (user_id, chain, token, added_at) VALUES (?, ?, ?, ?)').run(userId, chain.key, norm(chain, token), Date.now());
}

const remove = (userId, chain, token) =>
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND chain = ? AND token = ?').run(userId, chain.key, norm(chain, token)).changes > 0;

const list = (userId) => db.prepare('SELECT chain, token, added_at FROM watchlist WHERE user_id = ? ORDER BY added_at DESC').all(userId);

module.exports = { add, remove, list, MAX };
