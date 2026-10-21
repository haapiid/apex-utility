const walletService = require('../../services/walletService');
const markets = require('../../services/markets');
const { friendlyError } = require('../../services/tradeCommon');
const { KIND_ICON, walletMenu, walletDetailMenu, confirmMenu, backOnly, withdrawConfirmMenu } = require('../keyboards');
const {
  respond,
  editProgress,
  setPending,
  clearPending,
  createConfirmation,
  takeConfirmation,
} = require('../helpers');
const { formatNative, shortAddress, escapeHtml } = require('../../utils/format');
const { CHAINS, getChain, findChain, evmChains, isEvmAddress, txLink, addressLink } = require('../../config/chains');
const logger = require('../../utils/logger');

const { KIND_LABEL } = walletService;
const KEY_FORMAT = { sol: 'base58, Phantom-compatible', evm: 'hex, MetaMask-compatible' };

const withdrawUsage = () =>
  '📤 <b>Withdraw</b>\n\n' +
  'Send coins from your <b>active</b> wallet to any address.\n\n' +
  '◎ Solana: <code>/withdraw &lt;address&gt; &lt;amount|all&gt;</code>\n' +
  '⟠ EVM: <code>/withdraw &lt;chain&gt; &lt;address&gt; &lt;amount|all&gt;</code>\n\n' +
  'Example: <code>/withdraw base 0x12…ab 0.05</code>\n' +
  `Chains: ${evmChains().map((c) => `<code>${c.key}</code>`).join(', ')}`;

const solBalance = (address) =>
  walletService
    .getBalance(address)
    .then((b) => formatNative(b, CHAINS.sol))
    .catch(() => 'n/a');

// Native balance on every EVM chain, one line per chain
async function evmBalanceLines(address) {
  const chains = evmChains();
  const balances = await Promise.all(
    chains.map((c) =>
      markets
        .serviceFor(c)
        .getNativeBalance(address)
        .then((b) => formatNative(b, c))
        .catch(() => 'n/a'),
    ),
  );
  return chains.map((c, i) => `   ${c.name}: ${balances[i]}`);
}

function canCreate(userId) {
  return Object.fromEntries(walletService.KINDS.map((k) => [k, walletService.listWallets(userId, k).length < walletService.walletLimit(userId)]));
}

async function showWallet(ctx) {
  const userId = ctx.from.id;
  const wallets = walletService.listWallets(userId);
  if (!wallets.length) {
    return respond(
      ctx,
      '🐒 <b>ApeX Wallets</b>\n\nYou don’t have a wallet yet. Create one (you get a Solana and an EVM wallet) ' +
        'or import an existing one (Phantom, Solflare, MetaMask, Rabby, …).',
      walletMenu(wallets, canCreate(userId)),
    );
  }

  const lines = ['🐒 <b>ApeX Wallets</b>', '<i>✅ = active wallet, used for trading. Tap a wallet to manage it.</i>', ''];
  const sol = wallets.filter((w) => w.kind === 'sol');
  if (sol.length) {
    const balances = await Promise.all(sol.map((w) => solBalance(w.address)));
    lines.push(`${KIND_ICON.sol} <b>Solana</b>`);
    sol.forEach((w, i) => lines.push(`${w.active ? '✅' : '▫️'} ${w.label} <code>${w.address}</code>`, `   💰 ${balances[i]}`));
    lines.push('');
  }
  const evm = wallets.filter((w) => w.kind === 'evm');
  if (evm.length) {
    lines.push(`${KIND_ICON.evm} <b>EVM</b> (same address on every EVM chain)`);
    for (const w of evm) {
      lines.push(`${w.active ? '✅' : '▫️'} ${w.label} <code>${w.address}</code>`);
      if (w.active) lines.push(...(await evmBalanceLines(w.address)));
    }
    lines.push('');
  }
  lines.push('<i>Deposit to these addresses to start trading.</i>');
  return respond(ctx, lines.join('\n'), walletMenu(wallets, canCreate(userId)));
}

async function showWalletDetail(ctx, walletId) {
  const wallet = walletService.getWalletById(ctx.from.id, walletId);
  if (!wallet) return showWallet(ctx);
  const chain = wallet.kind === 'sol' ? CHAINS.sol : evmChains()[0];
  const lines = [
    `${KIND_ICON[wallet.kind]} <b>${KIND_LABEL[wallet.kind]} wallet ${wallet.label}</b>${wallet.active ? ' • ✅ active' : ''}`,
    '',
    `📍 <code>${wallet.address}</code>`,
  ];
  if (wallet.kind === 'sol') lines.push(`💰 ${await solBalance(wallet.address)}`);
  else lines.push('💰 Balances:', ...(await evmBalanceLines(wallet.address)));
  lines.push(`🔗 <a href="${addressLink(chain, wallet.address)}">View on explorer</a>`);
  return respond(ctx, lines.join('\n'), walletDetailMenu(wallet));
}

function walletError(err, userId) {
  if (err.code === 'duplicate') return `⚠️ That ${KIND_LABEL[err.kind]} wallet is already in ApeX.`;
  if (err.code === 'limit') return `⚠️ You can have up to ${walletService.walletLimit(userId)} ${KIND_LABEL[err.kind]} wallets. Remove one, or unlock more slots with burn credits in 💰 Rewards.`;
  return null;
}

async function handleImportKey(ctx) {
  await ctx.deleteMessage().catch(() => {});
  const userId = ctx.from.id;
  try {
    const wallet = walletService.importWallet(userId, ctx.message.text);
    await ctx.reply(
      `✅ <b>${KIND_LABEL[wallet.kind]} wallet ${wallet.label} imported</b> and set as active.\n\n📍 <code>${wallet.address}</code>`,
      { parse_mode: 'HTML', reply_markup: walletMenu(walletService.listWallets(userId), canCreate(userId)) },
    );
  } catch (err) {
    await ctx.reply(walletError(err, userId) || '❌ That private key is not valid. Try again from 🐒 Wallets.', {
      reply_markup: walletMenu(walletService.listWallets(userId), canCreate(userId)),
    });
  }
}

async function handleWithdrawCommand(ctx) {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  let chain = findChain(args[0]);
  if (chain) args.shift();
  const [to, rawAmount] = args;
  if (!to || !rawAmount) return respond(ctx, withdrawUsage(), backOnly('menu:wallet'));
  if (!chain) {
    if (isEvmAddress(to)) {
      return respond(
        ctx,
        `⛓ Which chain? Put it before the address, e.g. <code>/withdraw base ${shortAddress(to)} ${escapeHtml(rawAmount)}</code>\n\n` +
          `Chains: ${evmChains().map((c) => `<code>${c.key}</code>`).join(', ')}`,
        backOnly('menu:wallet'),
      );
    }
    chain = CHAINS.sol;
  }
  if (!chain.tradable) return respond(ctx, `⏳ ${chain.name} is coming soon.`, backOnly('menu:wallet'));
  const amount = rawAmount.toLowerCase();

  try {
    const from = walletService.getWallet(ctx.from.id, chain.kind);
    const quote = await markets.serviceFor(chain).quoteWithdraw(ctx.from.id, to, amount);
    const id = createConfirmation(ctx.from.id, { chain: chain.key, to, amount });
    await respond(
      ctx,
      [
        `📤 <b>Confirm Withdraw</b> • ⛓ ${chain.name}`,
        '',
        `From: ${from.label} <code>${shortAddress(from.address, 6)}</code>`,
        `Amount: <b>${formatNative(quote.value, chain, 9)}</b>${quote.sweep ? ` (entire balance minus ${chain.kind === 'sol' ? 'network fee' : 'gas'})` : ''}`,
        `To: <code>${quote.to}</code>`,
        '',
        '⚠️ Double-check the address and the chain. Transfers can’t be reversed.',
      ].join('\n'),
      withdrawConfirmMenu(id),
    );
  } catch (err) {
    await respond(ctx, `❌ ${escapeHtml(friendlyError(err))}`, backOnly('menu:wallet'));
  }
}

async function handleWithdrawConfirm(ctx) {
  await ctx.answerCallbackQuery();
  const payload = takeConfirmation(ctx.match[1], ctx.from.id);
  if (!payload) return respond(ctx, '⌛ This request expired. Run /withdraw again.', backOnly('menu:wallet'));

  const chain = getChain(payload.chain);
  const message = ctx.callbackQuery.message;
  await editProgress(ctx, message, '📤 Sending transfer…');
  try {
    const { signature } = await markets.serviceFor(chain).executeWithdraw(ctx.from.id, payload.to, payload.amount, {
      onSubmitted: (sig) =>
        editProgress(ctx, message, `🚀 <b>Submitted</b> — <a href="${txLink(chain, sig)}">${shortAddress(sig, 6)}</a>\n⏳ Confirming…`),
    });
    await editProgress(
      ctx,
      message,
      `✅ <b>Withdraw complete!</b> • ⛓ ${chain.name}\n\n🔗 <a href="${txLink(chain, signature)}">View transaction</a>`,
      backOnly('menu:wallet'),
    );
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, chain: chain.key }, 'Withdraw failed');
    await editProgress(ctx, message, `❌ Withdraw failed: ${escapeHtml(friendlyError(err))}`, backOnly('menu:wallet'));
  }
}

async function createAndShow(ctx, created) {
  const lines = created.map((w) => `${KIND_ICON[w.kind]} ${KIND_LABEL[w.kind]} ${w.label}: <code>${w.address}</code>`);
  await respond(
    ctx,
    `🍌 <b>Wallet created!</b> (set as active)\n\n${lines.join('\n')}\n\n` +
      (created.some((w) => w.kind === 'evm') ? '<i>The EVM address works on every EVM chain ApeX supports.</i>\n\n' : '') +
      '⚠️ Open the wallet and tap <b>Export Key</b> now to back up the private key. Then deposit to start trading.',
    walletMenu(walletService.listWallets(ctx.from.id), canCreate(ctx.from.id)),
  );
}

function register(bot) {
  bot.command('wallet', showWallet);
  bot.callbackQuery(['menu:wallet', 'wallet:refresh'], showWallet);
  bot.callbackQuery(/^wallet:open:(\d+)$/, (ctx) => showWalletDetail(ctx, Number(ctx.match[1])));

  bot.callbackQuery('wallet:create', async (ctx) => {
    const created = walletService.createMissingWallets(ctx.from.id);
    if (!created.length) return showWallet(ctx);
    return createAndShow(ctx, created);
  });

  bot.callbackQuery(/^wallet:new:(sol|evm)$/, async (ctx) => {
    try {
      return await createAndShow(ctx, [walletService.createWallet(ctx.from.id, ctx.match[1])]);
    } catch (err) {
      const text = walletError(err, ctx.from.id);
      if (!text) throw err;
      return respond(ctx, text, backOnly('menu:wallet'));
    }
  });

  bot.callbackQuery(/^wallet:use:(\d+)$/, async (ctx) => {
    const wallet = walletService.setActive(ctx.from.id, Number(ctx.match[1]));
    if (wallet) await ctx.answerCallbackQuery(`✅ ${KIND_LABEL[wallet.kind]} ${wallet.label} is now active`).catch(() => {});
    return showWalletDetail(ctx, Number(ctx.match[1]));
  });

  bot.callbackQuery('wallet:import', async (ctx) => {
    setPending(ctx.from.id, 'import_key');
    await respond(
      ctx,
      '📥 <b>Import Wallet</b>\n\nSend your <b>private key</b> as the next message (valid for 2 minutes):\n' +
        '◎ Solana: base58 (Phantom/Solflare export) or a JSON byte array\n' +
        '⟠ EVM: 0x… hex (MetaMask/Rabby export)\n\n' +
        `The wallet type is detected automatically. Up to ${walletService.walletLimit(ctx.from.id)} wallets per type. ` +
        'Your message is deleted right after it’s processed.\n\nType /cancel to abort.',
      backOnly('menu:wallet'),
    );
  });

  bot.callbackQuery('wallet:withdraw', (ctx) => respond(ctx, withdrawUsage(), backOnly('menu:wallet')));
  bot.command('withdraw', handleWithdrawCommand);
  bot.callbackQuery(/^wd:ok:(\w+)$/, handleWithdrawConfirm);
  bot.callbackQuery(/^wd:no:(\w+)$/, (ctx) => {
    takeConfirmation(ctx.match[1], ctx.from.id);
    return respond(ctx, '❌ Withdraw cancelled.', backOnly('menu:wallet'));
  });

  bot.callbackQuery(/^wallet:export:(\d+)$/, (ctx) => {
    const wallet = walletService.getWalletById(ctx.from.id, Number(ctx.match[1]));
    if (!wallet) return showWallet(ctx);
    return respond(
      ctx,
      `🛡️ <b>Export key of ${KIND_LABEL[wallet.kind]} ${wallet.label}</b>\n\nAnyone with your private key can drain your wallet. ` +
        'Make sure nobody can see your screen. The key is deleted automatically after 60 seconds.',
      confirmMenu(`wallet:export:${wallet.id}`, 'Show Key', `wallet:open:${wallet.id}`),
    );
  });
  bot.callbackQuery(/^wallet:export:(\d+):confirm$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const wallet = walletService.getWalletById(ctx.from.id, Number(ctx.match[1]));
    const key = wallet && walletService.exportPrivateKey(ctx.from.id, wallet.id);
    if (!key) return showWallet(ctx);
    const msg = await ctx.reply(
      `🔑 ${KIND_LABEL[wallet.kind]} ${wallet.label} — tap to reveal (${KEY_FORMAT[wallet.kind]}):\n<tg-spoiler><code>${key}</code></tg-spoiler>`,
      { parse_mode: 'HTML' },
    );
    setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
  });

  bot.callbackQuery(/^wallet:remove:(\d+)$/, (ctx) => {
    const wallet = walletService.getWalletById(ctx.from.id, Number(ctx.match[1]));
    if (!wallet) return showWallet(ctx);
    return respond(
      ctx,
      `🗑️ <b>Remove ${KIND_LABEL[wallet.kind]} wallet ${wallet.label}?</b>\n\n<code>${wallet.address}</code>\n\n` +
        'The wallet will be removed from ApeX. Any funds are <b>lost forever</b> unless you saved the private key!',
      confirmMenu(`wallet:remove:${wallet.id}`, 'Yes, Remove', `wallet:open:${wallet.id}`),
    );
  });
  bot.callbackQuery(/^wallet:remove:(\d+):confirm$/, async (ctx) => {
    walletService.removeWallet(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery('🗑️ Wallet removed').catch(() => {});
    return showWallet(ctx);
  });

  bot.command('cancel', async (ctx) => {
    clearPending(ctx.from.id);
    await ctx.reply('❌ Cancelled.');
  });
}

module.exports = { register, handleImportKey };
