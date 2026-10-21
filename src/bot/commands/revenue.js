const { simulateRevenue, SCENARIOS } = require('../../services/revenueService');
const rewardsService = require('../../services/rewardsService');
const statsService = require('../../services/statsService');
const { revenueMenu } = require('../keyboards');
const { respond } = require('../helpers');
const { formatUsd, formatNumber, formatNative, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');
const { allChains, getChain } = require('../../config/chains');

const sol = (v) => `${formatNumber(v, 4)} SOL`;

function countdown(at) {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

function renderLiveStats() {
  const { platform, evm } = statsService.getStats(0);
  const { revenueShareBps, epochHours, tokenSymbol } = config.revenue;
  const pools = rewardsService.pools();
  const poolLines = allChains()
    .filter((c) => c.tradable && pools[c.key] > 0n)
    .map((c) => `   ${c.name}: <b>${formatNative(pools[c.key], c, 6)}</b>`);
  const last = rewardsService.lastEpochs(1)[0];

  return [
    '🍌 <b>ApeX Revenue Share — Live</b>',
    '',
    `<b>${bpsToPercent(revenueShareBps)} of all trading fees</b> (after referrals) go to $${tokenSymbol} holders,`,
    `split by how much you hold (min. ${config.apex.minHold} $${tokenSymbol} in your ApeX wallets).`,
    `Paid every ${epochHours}h in the coin the fees were paid in. Claim in 💰 Rewards, gas-free.`,
    '',
    `⏳ <b>Next distribution in ${countdown(rewardsService.nextEpochAt())}</b>`,
    '🏦 Holder pool waiting:',
    ...(poolLines.length ? poolLines : ['   <i>empty so far</i>']),
    last ? `🧾 Last: ${formatNative(BigInt(last.amount), getChain(last.chain), 6)} to ${last.holders} holders` : '🧾 No distribution yet',
    '',
    '📊 <b>Last 24h</b>',
    `   Solana: ${sol(platform.volume24h)} volume • ${platform.trades24h} trades`,
    `   EVM: ${formatUsd(evm.volumeUsd24h)} volume • ${evm.trades24h} trades`,
    `📈 All-time: ${sol(platform.volumeSol)} Solana volume • ${platform.trades} trades`,
    '',
    rewardsService.apexToken() ? null : `<i>$${tokenSymbol} hasn’t launched yet: pools keep filling and are paid once it does.</i>`,
    'Tap a scenario below to see what holders could earn at scale.',
  ]
    .filter((l) => l != null)
    .join('\n');
}

function renderSimulation(input, title) {
  const r = simulateRevenue(input);
  const { botFeeBps, revenueShareBps, tokenSymbol, totalSupply } = config.revenue;
  return [
    `<b>${title}</b>`,
    '',
    `📊 Daily bot volume: <b>${formatUsd(r.dailyVolumeUsd)}</b>`,
    `💸 Bot fees (${bpsToPercent(botFeeBps)}): ${formatUsd(r.dailyFees)}`,
    `🍌 Holder pool (${bpsToPercent(revenueShareBps)}): <b>${formatUsd(r.holderPool)}</b>`,
    '',
    `👤 Holding ${formatNumber(input.holdings)} / ${formatNumber(totalSupply)} $${tokenSymbol} (${formatNumber(r.holderShare * 100, 4)}%)`,
    '',
    '💰 <b>Estimated earnings</b>',
    `   Daily: <b>${formatUsd(r.user.daily)}</b>`,
    `   Weekly: ${formatUsd(r.user.weekly)}`,
    `   Monthly: ${formatUsd(r.user.monthly)}`,
    `   Yearly: ${formatUsd(r.user.yearly)}`,
    '',
    '<i>⚠️ Projection only, not a guarantee of returns. Assumes no referred volume.</i>',
    'Custom: <code>/revenue &lt;daily_volume_usd&gt; &lt;your_tokens&gt;</code>',
  ].join('\n');
}

function register(bot) {
  bot.command('revenue', (ctx) => {
    const [volume, holdings] = (ctx.match || '').trim().split(/\s+/).map(Number);
    if (!(volume > 0)) return respond(ctx, renderLiveStats(), revenueMenu());
    return respond(ctx, renderSimulation({ dailyVolumeUsd: volume, holdings: holdings > 0 ? holdings : 0 }, '🍌 Revenue Calculator'), revenueMenu());
  });

  bot.callbackQuery('menu:revenue', (ctx) => respond(ctx, renderLiveStats(), revenueMenu()));

  bot.callbackQuery(/^rev:(\w+)$/, (ctx) => {
    const scenario = SCENARIOS[ctx.match[1]];
    if (!scenario) return ctx.answerCallbackQuery('Scenario not found');
    return respond(ctx, renderSimulation(scenario, `${scenario.label} — Scenario`), revenueMenu());
  });
}

module.exports = { register };
