const { db } = require('../db');
const { UserError } = require('./tradeCommon');
const { getChain } = require('../config/chains');

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

const has = (userId, chain, token) => Boolean(db.prepare('SELECT 1 FROM watchlist WHERE user_id = ? AND chain = ? AND token = ?').get(userId, chain.key, norm(chain, token)));

// Adds or removes; returns true when the token is now on the list
function toggle(userId, chain, token) {
  if (has(userId, chain, token)) {
    remove(userId, chain, token);
    return false;
  }
  add(userId, chain, token);
  return true;
}

// The list with each token's most liquid pair (DexScreener, 30 tokens per call per chain); pair is null if unknown
async function overview(userId) {
  const marketData = require('./marketData');
  const rows = list(userId);
  const byChain = new Map();
  for (const w of rows) byChain.set(w.chain, [...(byChain.get(w.chain) || []), w.token]);
  const found = new Map();
  await Promise.all(
    [...byChain].map(async ([key, tokens]) => {
      const chain = getChain(key);
      if (!chain?.tradable) return;
      for (let i = 0; i < tokens.length; i += 30) {
        const batch = tokens.slice(i, i + 30);
        const pairs = await marketData.tokenPairs(chain, batch).catch(() => []);
        for (const t of batch) {
          const best = pairs
            .filter((p) => String(p.token.address).toLowerCase() === t.toLowerCase())
            .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))[0];
          if (best) found.set(`${key}:${t}`, best);
        }
      }
    }),
  );
  return rows.map((w) => ({ ...w, pair: found.get(`${w.chain}:${w.token}`) || null }));
}

module.exports = { add, remove, list, has, toggle, overview, MAX };
