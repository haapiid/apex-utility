const automation = require('../../services/automationService');
const { friendlyError, UserError } = require('../../services/tradeCommon');
const { copyMenu, copyDetailMenu, confirmMenu } = require('../keyboards');
const { respond, setPending } = require('../helpers');
const { escapeHtml, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');
const { getChain, findChain, evmChains, addressLink } = require('../../config/chains');

const chainKeys = () => ['<code>sol</code>', ...evmChains().map((c) => `<code>${c.key}</code>`)].join(', ');

function showCopy(ctx) {
  const targets = automation.listCopyTargets(ctx.from.id);
  const lines = [
    '👥 <b>Copy trading</b>',
    '',
    'Follow a wallet and ApeX mirrors its trades from your active wallet: when it buys a token, you buy it for your',
    'fixed amount; when it sells, you sell the same share of your bag.',
    '',
  ];
  if (!targets.length) lines.push('<i>You don’t follow anyone yet.</i>');
  targets.forEach((t) => {
    const chain = getChain(t.chain);
    lines.push(
      `${t.active ? '🟢' : '⏸️'} <code>${escapeHtml(t.label)}</code> • ⛓ ${chain.name} • ${escapeHtml(t.buy_amount)} ${chain.native} per buy` +
        `${t.copy_sells ? '' : ' • sells not copied'}`,
    );
  });
  lines.push('', `<i>Fee ${bpsToPercent(config.fees.autoBps)} per copied trade. Checked every ~10 s. Only trades the wallet signs are copied.</i>`);
  return respond(ctx, lines.join('\n'), copyMenu(targets));
}

function showTarget(ctx, id) {
  const t = automation.getCopyTarget(ctx.from.id, id);
  if (!t) return showCopy(ctx);
  const chain = getChain(t.chain);
  return respond(
    ctx,
    [
      `👥 <b>Following ${escapeHtml(t.label)}</b> • ⛓ ${chain.name}`,
      '',
      `📍 <code>${escapeHtml(t.address)}</code>`,
      `🟢 Buy amount: ${escapeHtml(t.buy_amount)} ${chain.native}`,
      `🔴 Copy sells: ${t.copy_sells ? 'ON' : 'OFF'}`,
      `Status: ${t.active ? 'active' : 'paused'}`,
      `🔗 <a href="${addressLink(chain, t.address)}">View wallet</a>`,
    ].join('\n'),
    copyDetailMenu(t),
  );
}

// Typed "<chain> <wallet> <amount>" after tapping ➕ (routed from commands/text.js)
async function handleCopyInput(ctx, state) {
  const [chainArg, address, amount] = ctx.message.text.trim().split(/\s+/);
  const chain = findChain(chainArg);
  try {
    if (!chain || !address || !amount) throw new UserError('Send: <chain> <wallet address> <buy amount>');
    if (!chain.tradable) throw new UserError(`${chain.name} is coming soon.`);
    const t = automation.addCopyTarget(ctx.from.id, chain, address, amount);
    await ctx.reply(`✅ Now following <code>${escapeHtml(t.label)}</code> on ${chain.name}. New trades from now on are copied.`, {
      parse_mode: 'HTML',
    });
    return showCopy(ctx);
  } catch (err) {
    setPending(ctx.from.id, 'copy_add', state.data);
    return ctx.reply(`❌ ${friendlyError(err)}\n\nTry again or /cancel.`);
  }
}

function register(bot) {
  bot.command('copy', showCopy);
  bot.callbackQuery('menu:copy', showCopy);
  bot.callbackQuery(/^cp:o:(\d+)$/, (ctx) => showTarget(ctx, Number(ctx.match[1])));

  bot.callbackQuery('cp:add', async (ctx) => {
    setPending(ctx.from.id, 'copy_add');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(
      '➕ <b>Follow a wallet</b>\nSend: <code>&lt;chain&gt; &lt;wallet address&gt; &lt;buy amount&gt;</code>\n' +
        'Example: <code>sol 7xKX…9fQa 0.1</code> copies every buy with 0.1 SOL.\n' +
        `Chains: ${chainKeys()}\n\nType /cancel to abort.`,
      { parse_mode: 'HTML' },
    );
  });

  bot.callbackQuery(/^cp:p:(\d+)$/, (ctx) => {
    const t = automation.getCopyTarget(ctx.from.id, Number(ctx.match[1]));
    if (t) automation.updateCopyTarget(ctx.from.id, t.id, { active: t.active ? 0 : 1 });
    return showTarget(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^cp:s:(\d+)$/, (ctx) => {
    const t = automation.getCopyTarget(ctx.from.id, Number(ctx.match[1]));
    if (t) automation.updateCopyTarget(ctx.from.id, t.id, { copy_sells: t.copy_sells ? 0 : 1 });
    return showTarget(ctx, Number(ctx.match[1]));
  });
  bot.callbackQuery(/^cp:r:(\d+)$/, (ctx) =>
    respond(ctx, '🗑️ Stop following this wallet?', confirmMenu(`cp:r:${ctx.match[1]}`, 'Unfollow', `cp:o:${ctx.match[1]}`)),
  );
  bot.callbackQuery(/^cp:r:(\d+):confirm$/, (ctx) => {
    automation.removeCopyTarget(ctx.from.id, Number(ctx.match[1]));
    return showCopy(ctx);
  });
}

module.exports = { register, handleCopyInput };
