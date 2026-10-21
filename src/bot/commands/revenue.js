const { simulateRevenue, splitFees, SCENARIOS } = require('../../services/revenueService');
const statsService = require('../../services/statsService');
const { revenueMenu } = require('../keyboards');
const { respond } = require('../helpers');
const { formatUsd, formatNumber, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');

const sol = (v) => `${formatNumber(v, 4)} SOL`;

function renderLiveStats(userId) {
  const { platform, user } = statsService.getStats(userId);
  const { botFeeBps, revenueShareBps, holderSplitBps } = config.revenue;
  const { revenuePool, traderPool } = splitFees(platform.fees24h);
  const volumeShare = platform.volume24h > 0 ? user.volume24h / platform.volume24h : 0;

  return [
    '🍌 <b>ApeX Revenue Share — Live</b>',
    '',
    '📊 <b>Platform (last 24h)</b>',
    `   Volume: <b>${sol(platform.volume24h)}</b> • ${platform.trades24h} trades • ${platform.traders24h} traders`,
    `   Fees collected: ${sol(platform.fees24h)}`,
    `   Revenue pool (${bpsToPercent(revenueShareBps)}): <b>${sol(revenuePool)}</b>`,
    `   ├ 🐒 Holders (${bpsToPercent(holderSplitBps)}): ${sol(revenuePool - traderPool)}`,
    `   └ ⚡ Active traders: ${sol(traderPool)}`,
    '',
    '👤 <b>You</b>',
    `   24h volume: ${sol(user.volume24h)} (${formatNumber(volumeShare * 100, 2)}% of platform)`,
    `   Est. trader reward (24h): <b>${sol(traderPool * volumeShare)}</b>`,
    `   30d volume: ${sol(user.volume30d)} • Fees paid: ${sol(user.feesPaid30d)}`,
    '',
    `📈 All-time: ${sol(platform.volumeSol)} volume • ${platform.trades} trades`,
    '',
    `<i>Trading fee ${bpsToPercent(botFeeBps)}. Rewards are estimates until distribution.</i>`,
    'Tap a scenario below to see what you could earn at scale.',
  ].join('\n');
}

function renderSimulation(input, title) {
  const r = simulateRevenue(input);
  const { botFeeBps, revenueShareBps, holderSplitBps, tokenSymbol, totalSupply } = config.revenue;

  return [
    `<b>${title}</b>`,
    '',
    `📊 Daily bot volume: <b>${formatUsd(r.dailyVolumeUsd)}</b>`,
    `💸 Bot fees (${bpsToPercent(botFeeBps)}): ${formatUsd(r.dailyFees)}`,
    `🍌 Revenue pool (${bpsToPercent(revenueShareBps)} of fees): <b>${formatUsd(r.revenuePool)}</b>`,
    `   ├ 🐒 Holder pool (${bpsToPercent(holderSplitBps)}): ${formatUsd(r.holderPool)}`,
    `   └ ⚡ Trader pool: ${formatUsd(r.traderPool)}`,
    '',
    '👤 <b>Your position</b>',
    `   ├ Holding: ${formatNumber(input.holdings)} / ${formatNumber(totalSupply)} ${tokenSymbol} (${formatNumber(r.holderShare * 100, 4)}%)`,
    `   └ Daily volume: ${formatUsd(input.userDailyVolumeUsd)} (${formatNumber(r.volumeShare * 100, 4)}%)`,
    '',
    '💰 <b>Estimated earnings</b>',
    `   Daily: <b>${formatUsd(r.user.daily)}</b>`,
    `   Weekly: ${formatUsd(r.user.weekly)}`,
    `   Monthly: ${formatUsd(r.user.monthly)}`,
    `   Yearly: ${formatUsd(r.user.yearly)}`,
    '',
    '<i>⚠️ Projection only, not a guarantee of returns.</i>',
    'Custom: <code>/revenue &lt;daily_volume_usd&gt; &lt;your_tokens&gt; &lt;your_volume_usd&gt;</code>',
  ].join('\n');
}

function register(bot) {
  bot.command('revenue', (ctx) => {
    const [volume, holdings, userVolume] = (ctx.match || '').trim().split(/\s+/).map(Number);
    if (!(volume > 0)) return respond(ctx, renderLiveStats(ctx.from.id), revenueMenu());
    return respond(
      ctx,
      renderSimulation(
        {
          dailyVolumeUsd: volume,
          holdings: holdings > 0 ? holdings : 0,
          userDailyVolumeUsd: userVolume > 0 ? userVolume : 0,
        },
        '🍌 Revenue Calculator',
      ),
      revenueMenu(),
    );
  });

  bot.callbackQuery('menu:revenue', (ctx) => respond(ctx, renderLiveStats(ctx.from.id), revenueMenu()));

  bot.callbackQuery(/^rev:(\w+)$/, (ctx) => {
    const scenario = SCENARIOS[ctx.match[1]];
    if (!scenario) return ctx.answerCallbackQuery('Scenario not found');
    return respond(ctx, renderSimulation(scenario, `${scenario.label} — Scenario`), revenueMenu());
  });
}

module.exports = { register };
