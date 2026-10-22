const markets = require('../../services/markets');
const walletService = require('../../services/walletService');
const settingsService = require('../../services/settingsService');
const safetyService = require('../../services/safetyService');
const { withTimeout } = require('../../services/tradeCommon');
const { tokenMenu, chainPickMenu, tradeConfirmMenu, afterTradeMenu, backOnly, walletPickMenu } = require('../keyboards');
const { respond, editProgress, setPending, createConfirmation, takeConfirmation } = require('../helpers');
const {
  formatNumber,
  formatPrice,
  formatCompactUsd,
  formatNative,
  fromUnits,
  shortAddress,
  escapeHtml,
  bpsToPercent,
} = require('../../utils/format');
const { config, isSolanaAddress } = require('../../config');
const { CHAINS, getChain, findChain, evmChains, isEvmAddress, txLink } = require('../../config/chains');
const logger = require('../../utils/logger');

// EVM (0x…) or Solana (base58) token address
const ADDRESS_PATTERN = '0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}';
// Callback prefix "<chain>:" is optional so buttons sent before multi-chain (Solana only) still work
const AT = `(?:([a-z]+):)?(${ADDRESS_PATTERN})`;

// Fee and slippage for this user's trade on a chain
const tradeOpts = (ctx, chain, side = 'buy') => settingsService.tradeOptions(ctx.from.id, chain, 'manual', side);
const feeLabel = (opts) => bpsToPercent(opts.feeBps);
const slippageLabel = (opts) => bpsToPercent(opts.slippageBps);
const fmtUnits = (raw, decimals) => formatNumber(fromUnits(raw, decimals), 6);
const impactLabel = (pct) => (pct == null ? 'n/a' : `${formatNumber(pct, 2)}%`);
const isTokenAddress = (address) => isEvmAddress(address) || isSolanaAddress(address);

function tradeHelp() {
  return [
    '⚡ <b>ApeX Trade</b>',
    '',
    '🍌 <b>Fastest way:</b> paste a token address in this chat.',
    `⛓ Chains: ${evmChains().reduce((s, c) => `${s}, ${c.name}`, 'Solana')}`,
    '',
    'Or use commands (chain is optional, it’s detected from the address):',
    '<code>/buy [chain] &lt;token&gt; &lt;amount&gt;</code>',
    '<code>/sell [chain] &lt;token&gt; &lt;percent&gt;</code>',
    '',
    `Solana via Jupiter • EVM via KyberSwap • Fee: ${bpsToPercent(config.fees.manualBps)} (snipes ${bpsToPercent(config.fees.snipeBps)})`,
    'Change slippage, MEV protection and buy buttons in /settings.',
  ].join('\n');
}

// ---------- Wallets the buy/sell buttons trade from ----------
// Stored per wallet kind in settings (tradeWallets); defaults to the active wallet. Several wallets = one
// trade per wallet, one after another, each reported on its own.

function tradeWallets(userId, kind) {
  const all = walletService.listWallets(userId, kind);
  const ids = settingsService.get(userId).tradeWallets?.[kind] || [];
  const picked = all.filter((w) => ids.includes(w.id));
  return picked.length ? picked : all.filter((w) => w.active);
}

// True when the plain single-wallet flow applies (only the active wallet is picked)
const onlyActive = (wallets) => wallets.length === 1 && wallets[0].active;

function saveTradeWallets(userId, kind, ids) {
  settingsService.update(userId, { tradeWallets: { [kind]: ids } });
}

async function showWalletPicker(ctx, chain, address) {
  const all = walletService.listWallets(ctx.from.id, chain.kind);
  const picked = new Set(tradeWallets(ctx.from.id, chain.kind).map((w) => w.id));
  const svc = markets.serviceFor(chain);
  const balances = await Promise.all(all.map((w) => withTimeout(svc.getNativeBalance(w.address), 6_000).catch(() => null)));
  const lines = [
    `👛 <b>Trade from which ${walletService.KIND_LABEL[chain.kind]} wallets?</b>`,
    '',
    'The buy and sell buttons trade from every ticked wallet, one after another. Each wallet pays the full amount (or sells its own %).',
    '',
    ...all.map(
      (w, i) =>
        `${picked.has(w.id) ? '✅' : '⬜'} ${escapeHtml(w.label)}${w.active ? ' (active)' : ''} • <code>${shortAddress(w.address)}</code> • ${balances[i] == null ? '?' : formatNative(balances[i], chain, 4)}`,
    ),
    '',
    `Applies to all ${walletService.KIND_LABEL[chain.kind]} tokens. Limit orders, DCA and snipes keep using the active wallet.`,
  ];
  return respond(ctx, lines.join('\n'), walletPickMenu(chain, address, all, picked));
}

// Which chain a token address belongs to. Responds and returns null when it can't decide.
async function resolveChain(ctx, address, hint) {
  if (hint) {
    if (!hint.tradable) {
      await respond(ctx, `⏳ Trading on ${hint.name} is coming soon.`, backOnly());
      return null;
    }
    if ((hint.kind === 'evm') !== isEvmAddress(address)) {
      await respond(ctx, `❌ That is not a ${hint.name} token address.`, backOnly());
      return null;
    }
    return hint;
  }
  if (!isEvmAddress(address)) return CHAINS.sol;

  const found = await markets.detectEvmChains(address);
  if (found.length === 1) return found[0];
  if (!found.length) {
    await respond(ctx, `❌ No token contract at this address on ${evmChains().map((c) => c.name).join(', ')}.`, backOnly());
  } else {
    await respond(ctx, '⛓ This address exists on several chains. Which one do you want to trade?', chainPickMenu(found, address));
  }
  return null;
}

// From a callback: chain key captured by AT (missing on old Solana-only buttons)
function chainFromMatch(key) {
  const chain = key ? getChain(key) : CHAINS.sol;
  return chain?.tradable ? chain : null;
}

async function showToken(ctx, chain, address) {
  const svc = markets.serviceFor(chain);
  const wallet = walletService.getWallet(ctx.from.id, chain.kind);
  try {
    const token = await svc.getTokenInfo(address, wallet?.address);
    const sym = escapeHtml(token.symbol);

    let rate = null;
    let rateError = null;
    try {
      rate = await svc.previewRate(token);
    } catch (err) {
      rateError = svc.friendlyError(err);
    }
    const price = token.usdPrice ?? rate?.usdPrice;
    // Safety scan (cached 10 min); never block the card on it
    const safety = await withTimeout(
      safetyService.scan(chain, token, { canSell: async () => (await svc.quoteValue(token, 10n ** BigInt(token.decimals))) > 0n }),
      6_000,
    ).catch(() => null);

    const lines = [`🍌 <b>${escapeHtml(token.name)}</b> ($${sym}) • ⛓ ${chain.name}`, `📜 <code>${token.address}</code>`, ''];
    if (price != null) lines.push(`💵 Price: <b>${formatPrice(price)}</b>`);
    if (token.mcap) lines.push(`📊 Market cap: ${formatCompactUsd(token.mcap)}`);
    lines.push(
      rate
        ? `💧 1 ${chain.native} ≈ <b>${fmtUnits(rate.amountOut, token.decimals)} ${sym}</b>`
        : `💧 ${escapeHtml(rateError)}`,
    );
    if (safety) lines.push(safetyService.summary(safety));

    if (wallet) {
      const balance = await svc.getNativeBalance(wallet.address);
      lines.push('', `💼 You hold: <b>${fmtUnits(token.balance, token.decimals)} ${sym}</b>`, `💰 Wallet: ${formatNative(balance, chain)}`);
    } else {
      lines.push('', `🐒 Create a ${walletService.KIND_LABEL[chain.kind]} wallet in /wallet to trade this token.`);
    }
    const from = wallet ? tradeWallets(ctx.from.id, chain.kind) : [];
    if (from.length && !onlyActive(from)) lines.push(`👛 Buttons trade from: <b>${from.map((w) => escapeHtml(w.label)).join(', ')}</b>`);
    const opts = tradeOpts(ctx, chain);
    lines.push(
      '',
      `Fee ${feeLabel(opts)} • Slippage ${slippageLabel(opts)} • via ${markets.routerName(chain)}`,
      `🛡️ MEV protection: ${opts.mevProtect ? `ON (${markets.mevLabel(chain)})` : 'OFF'}`,
    );

    const settings = settingsService.get(ctx.from.id);
    return respond(
      ctx,
      lines.join('\n'),
      tokenMenu(chain, token.address, {
        buyPresets: settingsService.buyPresets(settings, chain),
        sellPresets: settings.sellPresets,
        wallets: walletService.listWallets(ctx.from.id, chain.kind).length > 1 ? from.length : 0,
      }),
    );
  } catch (err) {
    logger.warn({ err: err.message, chain: chain.key, address }, 'Token lookup failed');
    return respond(ctx, `❌ ${escapeHtml(svc.friendlyError(err))}`, backOnly());
  }
}

// Pasted address or /buy without an amount: detect the chain, then show the token card
async function openToken(ctx, address, hint) {
  const chain = await resolveChain(ctx, address, hint);
  if (chain) await showToken(ctx, chain, address);
}

function noWallet(ctx, chain) {
  return respond(ctx, `🐒 Create a ${walletService.KIND_LABEL[chain.kind]} wallet first in /wallet.`, backOnly());
}

// With "Confirm trades" off in /settings, a buy/sell request trades right away
const skipConfirm = (ctx) => !settingsService.get(ctx.from.id).confirmTrades;

// Several wallets (or one that isn't active): no single quote fits them all, so confirm the plan instead
async function showMultiConfirm(ctx, chain, address, side, amount, wallets) {
  const payload = { side, chain: chain.key, address, amount, walletIds: wallets.map((w) => w.id) };
  if (skipConfirm(ctx)) return runTrade(ctx, payload);
  const svc = markets.serviceFor(chain);
  let symbol;
  try {
    symbol = `$${escapeHtml((await svc.getTokenInfo(address)).symbol)}`;
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(svc.friendlyError(err))}`, backOnly());
  }
  const opts = tradeOpts(ctx, chain, side);
  const n = wallets.length;
  const id = createConfirmation(ctx.from.id, payload);
  const lines = [
    `${side === 'buy' ? '🟢 <b>Confirm Buy' : '🔴 <b>Confirm Sell'} — ${symbol}</b> • ⛓ ${chain.name}`,
    `👛 ${n} wallet${n > 1 ? 's' : ''}: ${wallets.map((w) => escapeHtml(w.label)).join(', ')}`,
    '',
    side === 'buy'
      ? `💸 Each wallet pays: <b>${escapeHtml(String(amount))} ${chain.native}</b> • total <b>${formatNumber(Number(amount) * n, 6)} ${chain.native}</b>`
      : `💸 Each wallet sells: <b>${amount}%</b> of its own ${symbol}`,
    `🍌 Bot fee: ${feeLabel(opts)} of each trade • Slippage ${slippageLabel(opts)}`,
    `🥷 MEV protection: ${opts.mevProtect ? markets.mevLabel(chain) : 'off'}`,
    '',
    '⚡ Trades go out one wallet after another. A wallet that can’t trade (e.g. not enough balance) is skipped and listed.',
  ];
  return respond(ctx, lines.join('\n'), tradeConfirmMenu(id));
}

async function showBuyQuote(ctx, chain, address, amount) {
  const wallet = walletService.getWallet(ctx.from.id, chain.kind);
  if (!wallet) return noWallet(ctx, chain);
  const from = tradeWallets(ctx.from.id, chain.kind);
  if (!onlyActive(from)) return showMultiConfirm(ctx, chain, address, 'buy', amount, from);
  if (skipConfirm(ctx)) return runTrade(ctx, { side: 'buy', chain: chain.key, address, amount });
  const svc = markets.serviceFor(chain);
  const opts = tradeOpts(ctx, chain);
  try {
    const q = await svc.quoteBuy(address, amount, wallet.address, opts);
    const sym = escapeHtml(q.token.symbol);
    const id = createConfirmation(ctx.from.id, { side: 'buy', chain: chain.key, address: q.token.address, amount });
    return respond(
      ctx,
      [
        `🟢 <b>Confirm Buy — $${sym}</b> • ⛓ ${chain.name}`,
        `👛 Wallet ${wallet.label}`,
        '',
        `💸 You pay: <b>${formatNative(q.amountIn, chain)}</b>`,
        `🍌 Bot fee (${feeLabel(opts)}): ${formatNative(q.fee, chain, 9)}`,
        `🎯 Est. received: <b>${fmtUnits(q.amountOut, q.token.decimals)} ${sym}</b>`,
        `🛡️ Min. received (${slippageLabel(opts)} slippage): ${fmtUnits(q.minOut, q.token.decimals)} ${sym}`,
        `📉 Price impact: ${impactLabel(q.priceImpactPct)}`,
        `🥷 MEV protection: ${opts.mevProtect ? markets.mevLabel(chain) : 'off'}`,
        '',
        `⏳ Quote valid for 2 minutes. ${chain.kind === 'sol' ? 'Network fee / Jito tip' : 'Gas'} is paid separately.`,
      ].join('\n'),
      tradeConfirmMenu(id),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(svc.friendlyError(err))}`, backOnly());
  }
}

async function showSellQuote(ctx, chain, address, percent) {
  const wallet = walletService.getWallet(ctx.from.id, chain.kind);
  if (!wallet) return noWallet(ctx, chain);
  const from = tradeWallets(ctx.from.id, chain.kind);
  if (!onlyActive(from)) return showMultiConfirm(ctx, chain, address, 'sell', percent, from);
  if (skipConfirm(ctx)) return runTrade(ctx, { side: 'sell', chain: chain.key, address, amount: percent });
  const svc = markets.serviceFor(chain);
  const opts = tradeOpts(ctx, chain, 'sell');
  try {
    const q = await svc.quoteSell(address, percent, wallet.address, opts);
    const sym = escapeHtml(q.token.symbol);
    const id = createConfirmation(ctx.from.id, { side: 'sell', chain: chain.key, address: q.token.address, amount: percent });
    return respond(
      ctx,
      [
        `🔴 <b>Confirm Sell — $${sym}</b> • ⛓ ${chain.name}`,
        `👛 Wallet ${wallet.label}`,
        '',
        `💸 You sell: <b>${fmtUnits(q.amountIn, q.token.decimals)} ${sym}</b> (${percent}%)`,
        `🎯 Est. received: <b>${formatNative(q.nativeOut - q.fee, chain)}</b>`,
        `🍌 Bot fee (${feeLabel(opts)}): ~${formatNative(q.fee, chain, 9)}`,
        `🛡️ Min. before fee (${slippageLabel(opts)} slippage): ${formatNative(q.minOut, chain)}`,
        `📉 Price impact: ${impactLabel(q.priceImpactPct)}`,
        `🥷 MEV protection: ${opts.mevProtect ? markets.mevLabel(chain) : 'off'}`,
        '',
        chain.kind === 'evm'
          ? '⏳ Quote valid for 2 minutes. The first sell of a token needs a one-time approval (extra gas).'
          : '⏳ Quote valid for 2 minutes.',
      ].join('\n'),
      tradeConfirmMenu(id),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(svc.friendlyError(err))}`, backOnly());
  }
}

async function handleConfirm(ctx) {
  await ctx.answerCallbackQuery();
  const payload = takeConfirmation(ctx.match[1], ctx.from.id);
  if (!payload) return respond(ctx, '⌛ This quote expired. Request a new one.', backOnly());
  return runTrade(ctx, payload);
}

// Executes a buy/sell, showing progress in the button's message (or a new message for commands/typed amounts)
async function runTrade(ctx, payload) {
  const chain = getChain(payload.chain);
  const svc = markets.serviceFor(chain);
  const isBuy = payload.side === 'buy';
  const startText = isBuy ? '⚡ Sending buy…' : '⚡ Sending sell…';
  let message = ctx.callbackQuery?.message;
  if (message) await editProgress(ctx, message, startText);
  else message = await ctx.reply(startText);

  if (payload.walletIds) return runMulti(ctx, payload, chain, svc, message);

  const onSubmitted = (sig) =>
    editProgress(ctx, message, `🚀 <b>Submitted</b> — <a href="${txLink(chain, sig)}">${shortAddress(sig, 6)}</a>\n⏳ Confirming…`);
  const onApproving = () => editProgress(ctx, message, '🔓 Approving the token for trading (one-time)…');

  try {
    if (isBuy) {
      const { signature, quote } = await svc.executeBuy(ctx.from.id, payload.address, payload.amount, { onSubmitted });
      await editProgress(
        ctx,
        message,
        `✅ <b>Bought $${escapeHtml(quote.token.symbol)}!</b> • ⛓ ${chain.name}\n\n` +
          `Spent ${formatNative(quote.amountIn, chain)}\n` +
          `🔗 <a href="${txLink(chain, signature)}">View transaction</a>`,
        afterTradeMenu(chain, quote.token.address),
      );
    } else {
      const { signature, quote, received } = await svc.executeSell(ctx.from.id, payload.address, payload.amount, {
        onSubmitted,
        onApproving,
      });
      await editProgress(
        ctx,
        message,
        `✅ <b>Sold ${payload.amount}% $${escapeHtml(quote.token.symbol)}!</b> • ⛓ ${chain.name}\n\n` +
          `Received ~${formatNative(received, chain)}\n` +
          `🔗 <a href="${txLink(chain, signature)}">View transaction</a>`,
        afterTradeMenu(chain, quote.token.address),
      );
    }
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, payload }, 'Trade failed');
    await editProgress(ctx, message, `❌ Trade failed: ${escapeHtml(svc.friendlyError(err))}`, afterTradeMenu(chain, payload.address));
  }
}

// One trade per picked wallet, one after another; the message lists each result as it lands
async function runMulti(ctx, payload, chain, svc, message) {
  const isBuy = payload.side === 'buy';
  const userId = ctx.from.id;
  const header = `${isBuy ? '🟢 Buying' : '🔴 Selling'} from ${payload.walletIds.length} wallets • ⛓ ${chain.name}`;
  const lines = [];
  let ok = 0;
  let symbol = null;
  for (const id of payload.walletIds) {
    const w = walletService.getWalletById(userId, id);
    if (!w || w.kind !== chain.kind) {
      lines.push('❌ A wallet was removed, skipped.');
      continue;
    }
    const label = escapeHtml(w.label);
    await editProgress(ctx, message, [header, '', ...lines, `⏳ ${label}: sending…`].join('\n'));
    try {
      const res = isBuy
        ? await svc.executeBuy(userId, payload.address, payload.amount, { walletId: w.id })
        : await svc.executeSell(userId, payload.address, payload.amount, { walletId: w.id });
      symbol ||= res.quote.token.symbol;
      ok++;
      const what = isBuy ? `spent ${formatNative(res.quote.amountIn, chain)}` : `received ~${formatNative(res.received, chain)}`;
      lines.push(`✅ ${label}: ${what} • <a href="${txLink(chain, res.signature)}">tx</a>`);
    } catch (err) {
      logger.warn({ err: err.message, userId, walletId: w.id, payload }, 'Multi-wallet trade failed for one wallet');
      lines.push(`❌ ${label}: ${escapeHtml(svc.friendlyError(err))}`);
    }
  }
  const verb = isBuy ? 'bought' : 'sold';
  const title = ok
    ? `✅ <b>${ok} of ${payload.walletIds.length} wallets ${verb}${symbol ? ` $${escapeHtml(symbol)}` : ''}</b> • ⛓ ${chain.name}`
    : `❌ <b>No wallet ${verb}</b> • ⛓ ${chain.name}`;
  await editProgress(ctx, message, [title, '', ...lines].join('\n'), afterTradeMenu(chain, payload.address));
}

// "/buy [chain] <token> <amount>"
function parseArgs(ctx) {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  const hint = findChain(args[0]);
  if (hint) args.shift();
  const [address, amount] = args;
  return { hint, address, amount, valid: Boolean(address && isTokenAddress(address)) };
}

function register(bot) {
  bot.callbackQuery('menu:trade', (ctx) => respond(ctx, tradeHelp(), backOnly()));

  bot.command(['buy', 'swap'], async (ctx) => {
    const { hint, address, amount, valid } = parseArgs(ctx);
    if (!valid) return respond(ctx, tradeHelp(), backOnly());
    const chain = await resolveChain(ctx, address, hint);
    if (!chain) return null;
    if (!(Number(amount) > 0)) return showToken(ctx, chain, address);
    return showBuyQuote(ctx, chain, address, amount);
  });

  bot.command('sell', async (ctx) => {
    const { hint, address, amount, valid } = parseArgs(ctx);
    const percent = Number.parseInt(String(amount).replace('%', ''), 10);
    if (!valid) return respond(ctx, tradeHelp(), backOnly());
    const chain = await resolveChain(ctx, address, hint);
    if (!chain) return null;
    if (!(percent > 0 && percent <= 100)) return showToken(ctx, chain, address);
    return showSellQuote(ctx, chain, address, percent);
  });

  // Callbacks: ctx.match = [all, chainKey?, address, amount?]
  const withChain = (handler) => async (ctx) => {
    const chain = chainFromMatch(ctx.match[1]);
    if (!chain) return ctx.answerCallbackQuery('This chain is not available.');
    return handler(ctx, chain, ctx.match[2], ctx.match[3]);
  };

  bot.callbackQuery(new RegExp(`^tok:${AT}$`), withChain((ctx, chain, address) => showToken(ctx, chain, address)));
  bot.callbackQuery(
    new RegExp(`^buy:${AT}:([\\d.]+)$`),
    withChain((ctx, chain, address, amount) => showBuyQuote(ctx, chain, address, amount)),
  );
  bot.callbackQuery(
    new RegExp(`^sell:${AT}:(\\d+)$`),
    withChain((ctx, chain, address, percent) => showSellQuote(ctx, chain, address, Number(percent))),
  );
  bot.callbackQuery(
    new RegExp(`^buyx:${AT}$`),
    withChain(async (ctx, chain, address) => {
      setPending(ctx.from.id, 'buy_amount', { chain: chain.key, address });
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `🟢 How much ${chain.native} do you want to spend? Reply with a number, e.g. <code>${chain.buyPresets[1]}</code>\n\nType /cancel to abort.`,
        { parse_mode: 'HTML' },
      );
    }),
  );

  // Wallet picker: mw:<chain>:<address> opens it, mwt:…:<walletId> toggles one, mwa:… all / active only
  bot.callbackQuery(new RegExp(`^mw:${AT}$`), withChain((ctx, chain, address) => showWalletPicker(ctx, chain, address)));
  bot.callbackQuery(
    new RegExp(`^mwt:${AT}:(\\d+)$`),
    withChain(async (ctx, chain, address, walletId) => {
      const all = walletService.listWallets(ctx.from.id, chain.kind);
      const ids = new Set(tradeWallets(ctx.from.id, chain.kind).map((w) => w.id));
      const id = Number(walletId);
      if (!all.some((w) => w.id === id)) return ctx.answerCallbackQuery('That wallet no longer exists.');
      if (ids.has(id)) {
        if (ids.size === 1) return ctx.answerCallbackQuery('Keep at least one wallet ticked.');
        ids.delete(id);
      } else ids.add(id);
      saveTradeWallets(ctx.from.id, chain.kind, [...ids]);
      return showWalletPicker(ctx, chain, address);
    }),
  );
  bot.callbackQuery(
    new RegExp(`^mwa:${AT}$`),
    withChain(async (ctx, chain, address) => {
      const all = walletService.listWallets(ctx.from.id, chain.kind);
      const picked = tradeWallets(ctx.from.id, chain.kind);
      saveTradeWallets(ctx.from.id, chain.kind, picked.length === all.length ? [] : all.map((w) => w.id));
      return showWalletPicker(ctx, chain, address);
    }),
  );

  bot.callbackQuery(/^trade:ok:(\w+)$/, handleConfirm);
  bot.callbackQuery(/^trade:no:(\w+)$/, (ctx) => {
    takeConfirmation(ctx.match[1], ctx.from.id);
    return respond(ctx, '❌ Trade cancelled.', backOnly());
  });
}

module.exports = { register, openToken, showBuyQuote, ADDRESS_PATTERN };
