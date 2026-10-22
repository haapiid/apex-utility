const { db } = require('../db');
const { getChain, txLink } = require('../config/chains');

// A user's own trade history (bot + ApeX Pro + automation), newest first, from the trades table.
// Symbols come from the position the trade belongs to (positions keep them after a full sell).

const SOURCES = ['manual', 'snipe', 'limit', 'dca', 'copy', 'antirug']; // antirug pays the manual fee
const MAX_LIMIT = 100;

/** filters: { chain, side, source, token, before (trade id), limit } */
function list(userId, filters = {}) {
  const where = ['t.user_id = ?'];
  const params = [userId];
  if (filters.chain && getChain(filters.chain)) where.push('t.chain = ?') && params.push(filters.chain);
  if (filters.side === 'buy' || filters.side === 'sell') where.push('t.side = ?') && params.push(filters.side);
  if (filters.source && SOURCES.includes(filters.source)) where.push('t.source = ?') && params.push(filters.source);
  if (filters.token) where.push('lower(t.token) = lower(?)') && params.push(String(filters.token));
  if (Number(filters.before) > 0) where.push('t.id < ?') && params.push(Number(filters.before));
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(filters.limit) || 50));

  const rows = db
    .prepare(
      `SELECT t.*, w.label AS wallet_label, w.address AS wallet_address, p.symbol AS symbol
       FROM trades t
       LEFT JOIN wallets w ON w.id = t.wallet_id
       LEFT JOIN positions p ON p.wallet_id = t.wallet_id AND p.chain = t.chain AND p.token = t.token
       WHERE ${where.join(' AND ')}
       ORDER BY t.id DESC
       LIMIT ?`,
    )
    .all(...params, limit + 1);

  const more = rows.length > limit;
  return {
    rows: rows.slice(0, limit).map((t) => {
      const chain = getChain(t.chain);
      const isSol = chain?.kind === 'sol';
      return {
        id: t.id,
        at: t.at,
        chain: t.chain,
        side: t.side,
        source: t.source,
        token: t.token,
        symbol: t.symbol || null,
        native: isSol ? t.sol_volume : t.native_volume, // whole coins
        fee: isSol ? t.fee_sol : null,
        usd: t.volume_usd || null,
        wallet: t.wallet_id ? { id: t.wallet_id, label: t.wallet_label, address: t.wallet_address } : null,
        signature: t.signature,
        txUrl: t.signature && chain ? txLink(chain, t.signature) : null,
      };
    }),
    next: more ? rows[limit - 1].id : null,
  };
}

module.exports = { list, SOURCES };
