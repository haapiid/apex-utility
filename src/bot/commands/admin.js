const rewardsService = require('../../services/rewardsService');
const { adminMenu, confirmMenu } = require('../keyboards');
const { respond } = require('../helpers');
const { formatNative, formatUsd, escapeHtml } = require('../../utils/format');
const { config } = require('../../config');
const { getChain } = require('../../config/chains');
const { notifyHolders } = require('../../workers/revenue');
const { createNotifier } = require('../../services/notificationService');

// Owner tools (ADMIN_IDS): what the rewards wallet owes vs. holds, and manual distribution
const isAdmin = (ctx) => config.adminIds.includes(ctx.from?.id);

async function showAdmin(ctx) {
  const { rows, cashbackUsd } = await rewardsService.liabilities();
  const lines = ['🛠️ <b>Admin — rewards</b>', '', '<b>Per chain</b>: owed to users • rewards wallet balance • pool waiting'];
  for (const r of rows) {
    const short = r.balance != null && r.balance < r.owed ? ' ⚠️ top up' : '';
    lines.push(
      `${r.chain.name}: ${formatNative(r.owed, r.chain, 6)} • ${r.balance != null ? formatNative(r.balance, r.chain, 6) : 'no wallet'}${short} • ${formatNative(r.pool, r.chain, 6)}`,
    );
  }
  const apex = rewardsService.apexToken();
  lines.push(
    '',
    `🎁 Cashback owed: ${formatUsd(cashbackUsd)} in $${config.revenue.tokenSymbol}`,
    `🍌 $APEX: ${apex ? `<code>${escapeHtml(apex.address)}</code> on ${apex.chain.name}` : 'not configured (APEX_TOKEN_ADDRESS)'}`,
    `👛 Rewards wallets: SOL <code>${rewardsService.rewardsAddress('sol') || 'not set'}</code>, EVM <code>${rewardsService.rewardsAddress('evm') || 'not set'}</code>`,
    '',
    '<i>Fees land in the treasury; move the holder pools + referral earnings to the rewards wallets so claims can be paid.</i>',
  );
  const last = rewardsService.lastEpochs(3);
  if (last.length) {
    lines.push('', '<b>Last distributions</b>');
    last.forEach((e) => lines.push(`${new Date(e.at).toISOString().slice(0, 16)} ${getChain(e.chain).name}: ${formatNative(BigInt(e.amount), getChain(e.chain), 6)} to ${e.holders} holders`));
  }
  return respond(ctx, lines.join('\n'), adminMenu());
}

function register(bot) {
  const guard = (fn) => (ctx) => (isAdmin(ctx) ? fn(ctx) : ctx.callbackQuery ? ctx.answerCallbackQuery('Admins only') : null);
  bot.command('admin', guard(showAdmin));
  bot.callbackQuery('adm:home', guard(showAdmin));
  bot.callbackQuery('adm:dist', guard((ctx) => respond(ctx, '💰 Distribute all holder pools now?', confirmMenu('adm:dist', 'Distribute', 'adm:home'))));
  bot.callbackQuery(
    'adm:dist:confirm',
    guard(async (ctx) => {
      const result = await rewardsService.distribute();
      if (result.ok) await notifyHolders(result, createNotifier(ctx.api));
      await ctx.answerCallbackQuery({ text: result.ok ? `Paid ${result.holders} holders` : result.reason, show_alert: true }).catch(() => {});
      return showAdmin(ctx);
    }),
  );
}

module.exports = { register };
