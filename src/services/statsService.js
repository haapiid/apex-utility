const { db, getMeta } = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

// Solana trades carry sol_volume/fee_sol; EVM trades carry native_volume/volume_usd/fee_usd
function recordTrade({
  userId,
  walletId = null,
  chain = 'sol',
  side,
  source = 'manual',
  token,
  solVolume = 0,
  feeSol = 0,
  nativeVolume = 0,
  volumeUsd = 0,
  feeUsd = 0,
  signature = null,
}) {
  db.prepare(
    `INSERT INTO trades (user_id, wallet_id, chain, side, source, token, sol_volume, fee_sol, native_volume, volume_usd, fee_usd, signature, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, walletId, chain, side, source, token, solVolume, feeSol, nativeVolume, volumeUsd, feeUsd, signature, Date.now());
}

const one = (sql, ...params) => db.prepare(sql).get(...params);

function getStats(userId) {
  const since = Date.now() - DAY_MS;
  const sol24h = one(
    `SELECT COALESCE(SUM(sol_volume), 0) AS volume, COALESCE(SUM(fee_sol), 0) AS fees, COUNT(*) AS trades, COUNT(DISTINCT user_id) AS traders
     FROM trades WHERE chain = 'sol' AND at >= ?`,
    since,
  );
  const evm24h = one(
    `SELECT COALESCE(SUM(volume_usd), 0) AS volume, COALESCE(SUM(fee_usd), 0) AS fees, COUNT(*) AS trades
     FROM trades WHERE chain != 'sol' AND at >= ?`,
    since,
  );
  const allTime = one("SELECT COALESCE(SUM(sol_volume), 0) AS volume, COALESCE(SUM(fee_sol), 0) AS fees, COUNT(*) AS trades FROM trades WHERE chain = 'sol'");
  const allTimeEvm = one("SELECT COUNT(*) AS trades FROM trades WHERE chain != 'sol'");
  const mine24h = one("SELECT COALESCE(SUM(sol_volume), 0) AS volume, COUNT(*) AS trades FROM trades WHERE chain = 'sol' AND user_id = ? AND at >= ?", userId, since);
  const mine30d = one(
    "SELECT COALESCE(SUM(sol_volume), 0) AS volume, COALESCE(SUM(fee_sol), 0) AS fees FROM trades WHERE chain = 'sol' AND user_id = ? AND at >= ?",
    userId,
    Date.now() - MONTH_MS,
  );

  return {
    platform: {
      volume24h: sol24h.volume,
      fees24h: sol24h.fees,
      trades24h: sol24h.trades,
      traders24h: sol24h.traders,
      // All-time includes totals carried over from the old JSON log
      volumeSol: allTime.volume + Number(getMeta('legacy_volume_sol') || 0),
      feesSol: allTime.fees + Number(getMeta('legacy_fees_sol') || 0),
      trades: allTime.trades + allTimeEvm.trades + Number(getMeta('legacy_trades') || 0),
    },
    evm: { volumeUsd24h: evm24h.volume, feesUsd24h: evm24h.fees, trades24h: evm24h.trades },
    user: { volume24h: mine24h.volume, trades24h: mine24h.trades, volume30d: mine30d.volume, feesPaid30d: mine30d.fees },
  };
}

module.exports = { recordTrade, getStats };
