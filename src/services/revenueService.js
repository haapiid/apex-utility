const { config } = require('../config');

/**
 * ApeX revenue sharing model:
 *   bot fees       = daily volume × BOT_FEE_BPS
 *   revenue pool   = bot fees × REVENUE_SHARE_BPS
 *   holder pool    = revenue pool × HOLDER_SPLIT_BPS  → split pro-rata by token holdings
 *   trader pool    = rest of the revenue pool         → split pro-rata by trading volume
 */
function splitFees(dailyFees) {
  const { revenueShareBps, holderSplitBps } = config.revenue;
  const revenuePool = (dailyFees * revenueShareBps) / 10_000;
  const holderPool = (revenuePool * holderSplitBps) / 10_000;
  return { revenuePool, holderPool, traderPool: revenuePool - holderPool };
}

function simulateRevenue({ dailyVolumeUsd, holdings = 0, userDailyVolumeUsd = 0 }) {
  const { botFeeBps, totalSupply } = config.revenue;

  const dailyFees = (dailyVolumeUsd * botFeeBps) / 10_000;
  const { revenuePool, holderPool, traderPool } = splitFees(dailyFees);

  const holderShare = totalSupply > 0 ? Math.min(holdings / totalSupply, 1) : 0;
  const volumeShare = dailyVolumeUsd > 0 ? Math.min(userDailyVolumeUsd / dailyVolumeUsd, 1) : 0;
  const userDaily = holderPool * holderShare + traderPool * volumeShare;

  return {
    dailyVolumeUsd,
    dailyFees,
    revenuePool,
    holderPool,
    traderPool,
    holderShare,
    volumeShare,
    user: {
      daily: userDaily,
      weekly: userDaily * 7,
      monthly: userDaily * 30,
      yearly: userDaily * 365,
    },
  };
}

const SCENARIOS = {
  small: { label: '🐒 Small Ape', dailyVolumeUsd: 100_000, holdings: 1_000, userDailyVolumeUsd: 500 },
  mid: { label: '🦍 Gorilla', dailyVolumeUsd: 1_000_000, holdings: 10_000, userDailyVolumeUsd: 5_000 },
  degen: { label: '🚀 Degen Ape', dailyVolumeUsd: 10_000_000, holdings: 50_000, userDailyVolumeUsd: 50_000 },
};

module.exports = { splitFees, simulateRevenue, SCENARIOS };
