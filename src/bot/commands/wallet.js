const walletService = require('../../services/walletService');
const tradeService = require('../../services/tradeService');
const { walletMenu, confirmMenu, backOnly, withdrawConfirmMenu } = require('../keyboards');
const {
  respond,
  editProgress,
  setPending,
  clearPending,
  createConfirmation,
  takeConfirmation,
} = require('../helpers');
const { formatSol, shortAddress, escapeHtml } = require('../../utils/format');
const logger = require('../../utils/logger');

const WITHDRAW_USAGE =
  '📤 <b>Withdraw SOL</b>\n\n' +
  'Send SOL from your ApeX wallet to any Solana address:\n' +
  '<code>/withdraw &lt;address&gt; &lt;amount|all&gt;</code>\n\n' +
  'Example: <code>/withdraw 7xKX…9fQa 0.5</code>';

async function showWallet(ctx) {
  const wallet = walletService.getWallet(ctx.from.id);
  if (!wallet) {
    return respond(
      ctx,
      '🐒 <b>ApeX Wallet</b>\n\nYou don’t have a wallet yet. Create a new one or import an existing Solana wallet (Phantom, Solflare, …).',
      walletMenu(false),
    );
  }

  let balanceLine;
  try {
    const lamports = await walletService.getBalance(wallet.address);
    balanceLine = `💰 Balance: <b>${formatSol(lamports)}</b>`;
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to fetch balance');
    balanceLine = '💰 Balance: <i>network unavailable, try Refresh</i>';
  }

  return respond(
    ctx,
    [
      '🐒 <b>ApeX Wallet</b>',
      '',
      `📍 Address: <code>${wallet.address}</code>`,
      balanceLine,
      `🔗 <a href="${tradeService.accountLink(wallet.address)}">View on Solscan</a>`,
      '',
      '<i>Deposit SOL to this address to start trading.</i>',
    ].join('\n'),
    walletMenu(true),
  );
}

async function handleImportKey(ctx) {
  await ctx.deleteMessage().catch(() => {});
  try {
    const address = walletService.importWallet(ctx.from.id, ctx.message.text);
    await ctx.reply(`✅ <b>Wallet imported!</b>\n\n📍 <code>${address}</code>`, {
      parse_mode: 'HTML',
      reply_markup: walletMenu(true),
    });
  } catch {
    await ctx.reply('❌ That private key is not valid. Try again from 🐒 Wallet.', {
      reply_markup: walletMenu(false),
    });
  }
}

async function handleWithdrawCommand(ctx) {
  const [to, rawAmount] = (ctx.match || '').trim().split(/\s+/);
  if (!to || !rawAmount) return respond(ctx, WITHDRAW_USAGE, backOnly('menu:wallet'));
  const amount = rawAmount.toLowerCase();

  try {
    const quote = await tradeService.quoteWithdraw(ctx.from.id, to, amount);
    const id = createConfirmation(ctx.from.id, { to, amount });
    await respond(
      ctx,
      [
        '📤 <b>Confirm Withdraw</b>',
        '',
        `Amount: <b>${formatSol(quote.value, 9)}</b>${quote.sweep ? ' (entire balance minus network fee)' : ''}`,
        `To: <code>${quote.to}</code>`,
        '',
        '⚠️ Double-check the address. Transfers can’t be reversed.',
      ].join('\n'),
      withdrawConfirmMenu(id),
    );
  } catch (err) {
    await respond(ctx, `❌ ${escapeHtml(tradeService.friendlyError(err))}`, backOnly('menu:wallet'));
  }
}

async function handleWithdrawConfirm(ctx) {
  await ctx.answerCallbackQuery();
  const payload = takeConfirmation(ctx.match[1], ctx.from.id);
  if (!payload) return respond(ctx, '⌛ This request expired. Run /withdraw again.', backOnly('menu:wallet'));

  const message = ctx.callbackQuery.message;
  await editProgress(ctx, message, '📤 Sending transfer…');
  try {
    const { signature } = await tradeService.executeWithdraw(ctx.from.id, payload.to, payload.amount, {
      onSubmitted: (sig) =>
        editProgress(ctx, message, `🚀 <b>Submitted</b> — <a href="${tradeService.txLink(sig)}">${shortAddress(sig, 6)}</a>\n⏳ Confirming…`),
    });
    await editProgress(
      ctx,
      message,
      `✅ <b>Withdraw complete!</b>\n\n🔗 <a href="${tradeService.txLink(signature)}">View transaction</a>`,
      backOnly('menu:wallet'),
    );
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id }, 'Withdraw failed');
    await editProgress(ctx, message, `❌ Withdraw failed: ${escapeHtml(tradeService.friendlyError(err))}`, backOnly('menu:wallet'));
  }
}

function register(bot) {
  bot.command('wallet', showWallet);
  bot.callbackQuery(['menu:wallet', 'wallet:refresh'], showWallet);

  bot.callbackQuery('wallet:create', async (ctx) => {
    if (walletService.getWallet(ctx.from.id)) return showWallet(ctx);
    const address = walletService.createWallet(ctx.from.id);
    await respond(
      ctx,
      `🍌 <b>Wallet created!</b>\n\n📍 <code>${address}</code>\n\n` +
        '⚠️ Tap <b>Export Key</b> now and store your private key somewhere safe (it also works in Phantom). Then deposit SOL to start trading.',
      walletMenu(true),
    );
  });

  bot.callbackQuery('wallet:import', async (ctx) => {
    if (walletService.getWallet(ctx.from.id)) {
      return respond(ctx, '⚠️ You already have a wallet. Remove it first before importing another one.', backOnly('menu:wallet'));
    }
    setPending(ctx.from.id, 'import_key');
    await respond(
      ctx,
      '📥 <b>Import Wallet</b>\n\nSend your Solana <b>private key</b> as the next message (valid for 2 minutes).\n' +
        'Base58 (Phantom/Solflare export) or a JSON byte array both work.\n' +
        'Your message is deleted right after it’s processed.\n\nType /cancel to abort.',
      backOnly('menu:wallet'),
    );
  });

  bot.callbackQuery('wallet:withdraw', (ctx) => respond(ctx, WITHDRAW_USAGE, backOnly('menu:wallet')));
  bot.command('withdraw', handleWithdrawCommand);
  bot.callbackQuery(/^wd:ok:(\w+)$/, handleWithdrawConfirm);
  bot.callbackQuery(/^wd:no:(\w+)$/, (ctx) => {
    takeConfirmation(ctx.match[1], ctx.from.id);
    return respond(ctx, '❌ Withdraw cancelled.', backOnly('menu:wallet'));
  });

  bot.callbackQuery('wallet:export', (ctx) =>
    respond(
      ctx,
      '🛡️ <b>Export Private Key</b>\n\nAnyone with your private key can drain your wallet. ' +
        'Make sure nobody can see your screen. The key is deleted automatically after 60 seconds.',
      confirmMenu('wallet:export', 'Show Key'),
    ),
  );

  bot.callbackQuery('wallet:export:confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    const key = walletService.exportPrivateKey(ctx.from.id);
    if (!key) return showWallet(ctx);
    const msg = await ctx.reply(`🔑 Tap to reveal (base58, Phantom-compatible):\n<tg-spoiler><code>${key}</code></tg-spoiler>`, {
      parse_mode: 'HTML',
    });
    setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), 60_000);
  });

  bot.callbackQuery('wallet:remove', (ctx) =>
    respond(
      ctx,
      '🗑️ <b>Remove wallet?</b>\n\nThe wallet will be removed from ApeX. Any funds are <b>lost forever</b> unless you saved the private key!',
      confirmMenu('wallet:remove', 'Yes, Remove'),
    ),
  );

  bot.callbackQuery('wallet:remove:confirm', async (ctx) => {
    walletService.removeWallet(ctx.from.id);
    await respond(ctx, '🗑️ Wallet removed from ApeX Utility.', walletMenu(false));
  });

  bot.command('cancel', async (ctx) => {
    clearPending(ctx.from.id);
    await ctx.reply('❌ Cancelled.');
  });
}

module.exports = { register, handleImportKey };
