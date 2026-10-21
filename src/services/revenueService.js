const { config } = require('../config');

/**
 * ApeX revenue sharing model (see rewardsService for the live bookkeeping):
 *   bot fees     = daily volume × fee
 *   holder pool  = fees after referrals × REVENUE_SHARE_BPS → split pro-rata by $APEX holdings
 * The calculator assumes no referred volume (referrals shrink the pool by up to REFERRAL_SHARE_BPS).
 */
function simulateRevenue({ dailyVolumeUsd, holdings = 0 }) {
  const { botFeeBps, revenueShareBps, totalSupply } = config.revenue;
  const dailyFees = (dailyVolumeUsd * botFeeBps) / 10_000;
  const holderPool = (dailyFees * revenueShareBps) / 10_000;
  const holderShare = totalSupply > 0 ? Math.min(holdings / totalSupply, 1) : 0;
  const userDaily = holderPool * holderShare;
  return {
    dailyVolumeUsd,
    dailyFees,
    holderPool,
    holderShare,
    user: { daily: userDaily, weekly: userDaily * 7, monthly: userDaily * 30, yearly: userDaily * 365 },
  };
}

const SCENARIOS = {
  small: { label: '🐒 Small Ape', dailyVolumeUsd: 100_000, holdings: 1_000 },
  mid: { label: '🦍 Gorilla', dailyVolumeUsd: 1_000_000, holdings: 10_000 },
  degen: { label: '🚀 Degen Ape', dailyVolumeUsd: 10_000_000, holdings: 50_000 },
};

module.exports = { simulateRevenue, SCENARIOS };
