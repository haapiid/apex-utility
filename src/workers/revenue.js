const rewardsService = require('../services/rewardsService');
const { getChain } = require('../config/chains');
const { formatNative } = require('../utils/format');
const logger = require('../utils/logger');

// Tells each holder what a distribution paid them
async function notifyHolders(result, notify) {
  for (const [userId, amounts] of result.perUser) {
    const lines = Object.entries(amounts).map(([chain, amount]) => `   ${formatNative(amount, getChain(chain), 8)}`);
    await notify(userId, `💰 <b>Revenue share paid!</b> You received:\n${lines.join('\n')}\n\nClaim it any time in /rewards.`);
  }
}

// Distributes the holder pools once per epoch (REVENUE_EPOCH_HOURS)
async function run(notify) {
  if (Date.now() < rewardsService.nextEpochAt()) return;
  const result = await rewardsService.distribute();
  if (!result.ok) {
    logger.info({ reason: result.reason }, 'Revenue epoch skipped');
    return;
  }
  await notifyHolders(result, notify);
}

module.exports = { run, notifyHolders };
