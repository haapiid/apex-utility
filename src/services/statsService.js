const { config } = require('../config');
const { createJsonStore } = require('../utils/jsonStore');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 30 * DAY_MS;

// trades: [{ userId, side, token, solVolume, feeSol, signature, at }]
const store = createJsonStore(config.stats.storePath, { trades: [], totals: { volumeSol: 0, feesSol: 0, trades: 0 } });

function recordTrade({ userId, side, token, solVolume, feeSol, signature }) {
  const data = store.load();
  const now = Date.now();
  data.trades.push({ userId, side, token, solVolume, feeSol, signature, at: now });
  data.trades = data.trades.filter((t) => now - t.at < KEEP_MS);
  data.totals.volumeSol += solVolume;
  data.totals.feesSol += feeSol;
  data.totals.trades += 1;
  store.save();
}

function sum(trades, key) {
  return trades.reduce((acc, t) => acc + t[key], 0);
}

function getStats(userId) {
  const data = store.load();
  const since = Date.now() - DAY_MS;
  const last24h = data.trades.filter((t) => t.at >= since);
  const mine24h = last24h.filter((t) => t.userId === userId);
  const mineAll = data.trades.filter((t) => t.userId === userId);

  return {
    platform: {
      volume24h: sum(last24h, 'solVolume'),
      fees24h: sum(last24h, 'feeSol'),
      trades24h: last24h.length,
      traders24h: new Set(last24h.map((t) => t.userId)).size,
      ...data.totals,
    },
    user: {
      volume24h: sum(mine24h, 'solVolume'),
      trades24h: mine24h.length,
      volume30d: sum(mineAll, 'solVolume'),
      feesPaid30d: sum(mineAll, 'feeSol'),
    },
  };
}

module.exports = { recordTrade, getStats };
