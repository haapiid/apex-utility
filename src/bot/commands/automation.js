const automation = require('../../services/automationService');
const { friendlyError } = require('../../services/tradeCommon');
const { orderTypeMenu, dcaTypeMenu, ordersMenu, backOnly } = require('../keyboards');
const { respond, setPending } = require('../helpers');
const { formatNumber, fromUnits, shortAddress, escapeHtml, bpsToPercent } = require('../../utils/format');
const { config, isSolanaAddress } = require('../../config');
const { CHAINS, getChain, findChain, isEvmAddress, evmChains } = require('../../config/chains');
const { LABEL } = require('../../workers/orders');

// Limit orders (limit buy, take profit, stop loss), DCA plans and the sniper

const AT = '([a-z]+):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})';
const fmtPrice = (p) => formatNumber(p, p < 0.0001 ? 12 : 8);
const ago = (ms) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
};
const every = (sec) => (sec % 86400 === 0 ? `${sec / 86400}d` : sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`);

// What each order type asks the user to type
const PROMPTS = {
  lb: (c) => `🟢 <b>Limit buy</b>\nSend: <code>&lt;${c.native} amount&gt; &lt;price drop %&gt;</code>\nExample <code>${c.buyPresets[1]} 30</code> buys for ${c.buyPresets[1]} ${c.native} once the price is 30% lower than now.`,
  tp: () => '📈 <b>Take profit</b>\nSend: <code>&lt;% of bag to sell&gt; &lt;price rise %&gt;</code>\nExample <code>50 100</code> sells half your bag when the price doubles (+100%).',
  sl: () => '📉 <b>Stop loss</b>\nSend: <code>&lt;% of bag to sell&gt; &lt;price drop %&gt;</code>\nExample <code>100 25</code> sells everything if the price falls 25% from now.',
  db: (c) => `🟢 <b>DCA buy</b>\nSend: <code>&lt;${c.native} per buy&gt; &lt;number of buys&gt; &lt;interval&gt;</code>\nExample <code>${c.buyPresets[0]} 10 1h</code> buys ${c.buyPresets[0]} ${c.native} every hour, 10 times.`,
  ds: () => '🔴 <b>DCA sell</b>\nSend: <code>&lt;% of bag&gt; &lt;number of sells&gt; &lt;interval&gt;</code>\nExample <code>100 5 30m</code> sells your whole bag in 5 equal parts, one every 30 minutes.',
};
const ORDER_CODE = { lb: 'limit_buy', tp: 'take_profit', sl: 'stop_loss' };

async function ask(ctx, code, chain, address) {
  setPending(ctx.from.id, 'automation', { code, chain: chain.key, address });
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(`${PROMPTS[code](chain)}\n\nType /cancel to abort.`, { parse_mode: 'HTML' });
}

// Typed answer to one of the prompts above (routed from commands/text.js)
async function handleAutomationInput(ctx, state) {
  const { code, address } = state.data;
  const chain = getChain(state.data.chain);
  const parts = ctx.message.text.trim().split(/\s+/);
  const wait = await ctx.reply('⏳ Checking the current price…');
  try {
    let text;
    if (ORDER_CODE[code]) {
      if (parts.length !== 2) throw new Error('format');
      const order = await automation.createOrder(ctx.from.id, chain, address, ORDER_CODE[code], parts[0], parts[1]);
      const what = code === 'lb' ? `buy for ${escapeHtml(order.amount)} ${chain.native}` : `sell ${order.amount}% of your bag`;
      text =
        `✅ <b>${LABEL[order.type]} placed</b> — $${escapeHtml(order.symbol)} • ⛓ ${chain.name}\n\n` +
        `Will ${what} when the price ${order.type === 'take_profit' ? 'reaches' : 'falls to'} ` +
        `<b>${fmtPrice(order.trigger_price)}</b> ${chain.native}/token (now ${fmtPrice(order.ref_price)}).\n` +
        `Checked every ~15 s, valid for 7 days. Fee ${bpsToPercent(config.fees.autoBps)}.`;
    } else {
      if (parts.length !== 3) throw new Error('format');
      const side = code === 'db' ? 'buy' : 'sell';
      const { plan, token } = await automation.createDca(ctx.from.id, chain, address, side, parts[0], parts[1], parts[2]);
      const per = side === 'buy' ? `${escapeHtml(plan.amount)} ${chain.native}` : `${formatNumber(fromUnits(plan.amount, token.decimals), 4)} ${escapeHtml(plan.symbol)}`;
      text =
        `✅ <b>DCA ${side} started</b> — $${escapeHtml(plan.symbol)} • ⛓ ${chain.name}\n\n` +
        `${side === 'buy' ? 'Buying' : 'Selling'} ${per} every ${every(plan.interval_sec)}, ${plan.runs_total} times. First run within a minute.`;
    }
    await ctx.api.editMessageText(wait.chat.id, wait.message_id, text, { parse_mode: 'HTML', reply_markup: backOnly('menu:orders') });
  } catch (err) {
    setPending(ctx.from.id, 'automation', state.data); // let the user try again
    const msg = err.message === 'format' ? 'That doesn’t match the format above.' : friendlyError(err);
    await ctx.api.editMessageText(wait.chat.id, wait.message_id, `❌ ${escapeHtml(msg)}\n\nTry again or /cancel.`);
  }
}

// ---------- /orders ----------

function ordersText(userId) {
  const orders = automation.listOrders(userId);
  const plans = automation.listDca(userId);
  const snipes = automation.listSnipes(userId);
  const items = [];
  const lines = ['🤖 <b>Orders & automation</b>', ''];

  lines.push(`<b>Limit / TP / SL</b> (${orders.length})`);
  orders.forEach((o, i) => {
    const chain = getChain(o.chain);
    const what = o.type === 'limit_buy' ? `buy ${escapeHtml(o.amount)} ${chain.native}` : `sell ${o.amount}%`;
    const change = o.last_price ? ` • now ${fmtPrice(o.last_price)}` : '';
    lines.push(`${i + 1}. ${LABEL[o.type]} $${escapeHtml(o.symbol)} (${chain.name}): ${what} at ${fmtPrice(o.trigger_price)}${change}`);
    items.push({ label: `Order ${i + 1}`, cancel: `ox:${o.id}` });
  });
  if (!orders.length) lines.push('<i>None. Open a token and tap 🎯 Limit / TP / SL.</i>');

  lines.push('', `<b>DCA plans</b> (${plans.length})`);
  plans.forEach((p, i) => {
    const chain = getChain(p.chain);
    lines.push(`${i + 1}. 🔁 ${p.side} $${escapeHtml(p.symbol)} (${chain.name}): ${p.runs_done}/${p.runs_total} done, every ${every(p.interval_sec)}`);
    items.push({ label: `DCA ${i + 1}`, cancel: `dx:${p.id}` });
  });
  if (!plans.length) lines.push('<i>None. Open a token and tap 🔁 DCA.</i>');

  lines.push('', `<b>Snipes</b> (${snipes.length})`);
  snipes.forEach((s, i) => {
    const chain = getChain(s.chain);
    const what = s.trigger === 'migration' ? 'waiting for migration' : 'waiting';
    lines.push(`${i + 1}. 🎯 <code>${shortAddress(s.token, 6)}</code> (${chain.name}): ${escapeHtml(s.amount)} ${chain.native}, ${what} ${ago(s.created_at)}`);
    items.push({ label: `Snipe ${i + 1}`, cancel: `sx:${s.id}` });
  });
  if (!snipes.length) lines.push('<i>None. See 🎯 Sniper.</i>');

  lines.push('', '<i>Orders run from your active wallet. Tap ❌ to cancel one.</i>');
  return { text: lines.join('\n'), items };
}

function showOrders(ctx) {
  const { text, items } = ordersText(ctx.from.id);
  return respond(ctx, text, ordersMenu(items));
}

// ---------- /snipe ----------

const sniperHelp = () =>
  [
    '🎯 <b>Sniper</b>',
    '',
    'Buy a token the moment it becomes tradable: ApeX checks every few seconds until a trading route exists, then buys.',
    '',
    '<code>/snipe [chain] &lt;token&gt; &lt;amount&gt;</code>',
    'Examples:',
    '<code>/snipe &lt;solana mint&gt; 0.5</code>',
    '<code>/snipe base 0x… 0.02</code> (chain needed for EVM tokens)',
    '<code>/snipe &lt;pump.fun mint&gt; 0.5 migration</code> buys when it migrates to PumpSwap',
    '',
    '💊 Snipe every new pump.fun launch or migration instead: /pump',
    '',
    `🛡️ Safety filter on by default: honeypots, high taxes and freeze authority are skipped. Add <code>unsafe</code> at the end to turn it off.`,
    `Fee ${bpsToPercent(config.fees.snipeBps)} • Snipes expire after 24 hours • Your MEV and slippage settings apply.`,
    `⛓ Chains: <code>sol</code>, ${evmChains().map((c) => `<code>${c.key}</code>`).join(', ')}`,
  ].join('\n');

async function handleSnipe(ctx) {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) return respond(ctx, sniperHelp(), backOnly());
  let chain = findChain(args[0]);
  if (chain) args.shift();
  // Trailing flags, in any order: "unsafe", "migration"
  let unsafe = false;
  let trigger = 'tradable';
  while (args.length > 2) {
    const flag = args.at(-1).toLowerCase();
    if (flag === 'unsafe') unsafe = true;
    else if (flag === 'migration' || flag === 'migrate') trigger = 'migration';
    else break;
    args.pop();
  }
  const [address, amount] = args;
  if (!address || !amount) return respond(ctx, sniperHelp(), backOnly());
  if (!chain) {
    if (isEvmAddress(address)) return respond(ctx, '⛓ Add the chain for EVM tokens, e.g. <code>/snipe base 0x… 0.02</code>', backOnly());
    if (!isSolanaAddress(address)) return respond(ctx, '❌ That is not a token address.', backOnly());
    chain = CHAINS.sol;
  }
  if (!chain.tradable) return respond(ctx, `⏳ ${chain.name} is coming soon.`, backOnly());
  try {
    const snipe = await automation.createSnipe(ctx.from.id, chain, address, amount, !unsafe, trigger);
    const when = snipe.trigger === 'migration' ? 'the moment it migrates from pump.fun to PumpSwap (valid 7 days)' : 'as soon as it’s tradable';
    return respond(
      ctx,
      `🎯 <b>Snipe armed</b> • ⛓ ${chain.name}\n\n<code>${escapeHtml(snipe.token)}</code>\n` +
        `Buys for <b>${escapeHtml(snipe.amount)} ${chain.native}</b> ${when}. Safety filter: ${snipe.safety ? 'ON' : 'OFF'}.\n` +
        'You’ll get a message when it fires. Manage it in 🤖 Orders.',
      backOnly('menu:orders'),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(friendlyError(err))}`, backOnly());
  }
}

function register(bot) {
  bot.command(['orders', 'auto'], showOrders);
  bot.callbackQuery('menu:orders', showOrders);
  bot.command('snipe', handleSnipe);
  bot.callbackQuery('menu:snipe', (ctx) => respond(ctx, sniperHelp(), backOnly()));

  const withToken = (handler) => (ctx) => {
    const chain = getChain(ctx.match[1]);
    if (!chain?.tradable) return ctx.answerCallbackQuery('This chain is not available.');
    return handler(ctx, chain, ctx.match[2]);
  };
  bot.callbackQuery(new RegExp(`^ao:menu:${AT}$`), withToken((ctx, chain, address) =>
    respond(ctx, '🎯 <b>Automate this token</b>\nOrders trigger on the price measured with your own trade size.', orderTypeMenu(chain, address)),
  ));
  bot.callbackQuery(new RegExp(`^ao:dca:${AT}$`), withToken((ctx, chain, address) =>
    respond(ctx, '🔁 <b>DCA</b> — spread a buy or a sell over time.', dcaTypeMenu(chain, address)),
  ));
  bot.callbackQuery(new RegExp(`^ao:(lb|tp|sl|db|ds):${AT}$`), (ctx) => {
    const chain = getChain(ctx.match[2]);
    if (!chain?.tradable) return ctx.answerCallbackQuery('This chain is not available.');
    return ask(ctx, ctx.match[1], chain, ctx.match[3]);
  });

  const cancel = (fn, what) => async (ctx) => {
    const ok = fn(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery(ok ? `${what} cancelled` : 'Already closed').catch(() => {});
    return showOrders(ctx);
  };
  bot.callbackQuery(/^ox:(\d+)$/, cancel(automation.cancelOrder, 'Order'));
  bot.callbackQuery(/^dx:(\d+)$/, cancel(automation.cancelDca, 'DCA plan'));
  bot.callbackQuery(/^sx:(\d+)$/, cancel(automation.cancelSnipe, 'Snipe'));
}

module.exports = { register, handleAutomationInput };
