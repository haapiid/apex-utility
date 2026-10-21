const tradeService = require('../../services/tradeService');
const walletService = require('../../services/walletService');
const { tokenMenu, tradeConfirmMenu, afterTradeMenu, backOnly } = require('../keyboards');
const { respond, editProgress, setPending, createConfirmation, takeConfirmation } = require('../helpers');
const {
  formatNumber,
  formatPrice,
  formatCompactUsd,
  formatSol,
  fromUnits,
  shortAddress,
  escapeHtml,
  bpsToPercent,
} = require('../../utils/format');
const { config, isSolanaAddress } = require('../../config');
const { SOL_MINT, LAMPORTS_PER_SOL } = require('../../config/solana');
const logger = require('../../utils/logger');

const MINT_PATTERN = '[1-9A-HJ-NP-Za-km-z]{32,44}';

const feeLabel = () => (config.revenue.feesEnabled ? bpsToPercent(config.revenue.botFeeBps) : '0%');
const slippageLabel = () => bpsToPercent(config.jupiter.slippageBps);
const fmtUnits = (raw, decimals) => formatNumber(fromUnits(raw, decimals), 6);

const TRADE_HELP = [
  '⚡ <b>ApeX Trade</b>',
  '',
  '🍌 <b>Fastest way:</b> paste a Solana token address (mint) in this chat.',
  '',
  'Or use commands:',
  '<code>/buy &lt;mint&gt; &lt;SOL amount&gt;</code>',
  '<code>/sell &lt;mint&gt; &lt;percent&gt;</code>',
  '',
  `Routed via Jupiter • Fee: ${feeLabel()} • Max slippage: ${slippageLabel()}`,
].join('\n');

async function showToken(ctx, mint) {
  const wallet = walletService.getWallet(ctx.from.id);
  try {
    const token = await tradeService.getTokenInfo(mint, wallet?.address);
    const sym = escapeHtml(token.symbol);
    const lines = [`🍌 <b>${escapeHtml(token.name)}</b> ($${sym})`, `📜 <code>${token.address}</code>`, ''];

    if (token.usdPrice != null) lines.push(`💵 Price: <b>${formatPrice(token.usdPrice)}</b>`);
    if (token.mcap) lines.push(`📊 Market cap: ${formatCompactUsd(token.mcap)}`);
    try {
      const q = await tradeService.getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: LAMPORTS_PER_SOL });
      lines.push(`💧 1 SOL ≈ <b>${fmtUnits(q.outAmount, token.decimals)} ${sym}</b>`);
    } catch (err) {
      lines.push(`💧 ${escapeHtml(tradeService.friendlyError(err))}`);
    }

    if (wallet) {
      const lamports = await walletService.getBalance(wallet.address);
      lines.push('', `💼 You hold: <b>${fmtUnits(token.balance, token.decimals)} ${sym}</b>`, `💰 Wallet: ${formatSol(lamports)}`);
    } else {
      lines.push('', '🐒 Create a wallet in /wallet to trade this token.');
    }
    lines.push('', `Fee ${feeLabel()} • Slippage ${slippageLabel()} • via Jupiter`);

    return respond(ctx, lines.join('\n'), tokenMenu(token.address));
  } catch (err) {
    logger.warn({ err: err.message, mint }, 'Token lookup failed');
    return respond(ctx, `❌ ${escapeHtml(tradeService.friendlyError(err))}`, backOnly());
  }
}

async function showBuyQuote(ctx, mint, solAmount) {
  const wallet = walletService.getWallet(ctx.from.id);
  if (!wallet) return respond(ctx, '🐒 Create a wallet first in /wallet.', backOnly());
  try {
    const q = await tradeService.quoteBuy(mint, solAmount, wallet.address);
    const sym = escapeHtml(q.token.symbol);
    const id = createConfirmation(ctx.from.id, { side: 'buy', mint: q.token.address, amount: solAmount });
    return respond(
      ctx,
      [
        `🟢 <b>Confirm Buy — $${sym}</b>`,
        '',
        `💸 You pay: <b>${formatSol(q.amountIn)}</b>`,
        `🍌 Bot fee (${feeLabel()}): ${formatSol(q.fee, 9)}`,
        `🎯 Est. received: <b>${fmtUnits(q.amountOut, q.token.decimals)} ${sym}</b>`,
        `🛡️ Min. received (${slippageLabel()} slippage): ${fmtUnits(q.minOut, q.token.decimals)} ${sym}`,
        `📉 Price impact: ${formatNumber(q.priceImpactPct, 2)}%`,
        '',
        '⏳ Quote valid for 2 minutes. Network fee is paid separately.',
      ].join('\n'),
      tradeConfirmMenu(id),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(tradeService.friendlyError(err))}`, backOnly());
  }
}

async function showSellQuote(ctx, mint, percent) {
  const wallet = walletService.getWallet(ctx.from.id);
  if (!wallet) return respond(ctx, '🐒 Create a wallet first in /wallet.', backOnly());
  try {
    const q = await tradeService.quoteSell(mint, percent, wallet.address);
    const sym = escapeHtml(q.token.symbol);
    const id = createConfirmation(ctx.from.id, { side: 'sell', mint: q.token.address, amount: percent });
    return respond(
      ctx,
      [
        `🔴 <b>Confirm Sell — $${sym}</b>`,
        '',
        `💸 You sell: <b>${fmtUnits(q.amountIn, q.token.decimals)} ${sym}</b> (${percent}%)`,
        `🎯 Est. received: <b>${formatSol(q.solOut - q.fee)}</b>`,
        `🍌 Bot fee (${feeLabel()}): ~${formatSol(q.fee, 9)}`,
        `🛡️ Min. before fee (${slippageLabel()} slippage): ${formatSol(q.minOut)}`,
        `📉 Price impact: ${formatNumber(q.priceImpactPct, 2)}%`,
        '',
        '⏳ Quote valid for 2 minutes.',
      ].join('\n'),
      tradeConfirmMenu(id),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(tradeService.friendlyError(err))}`, backOnly());
  }
}

async function handleConfirm(ctx) {
  await ctx.answerCallbackQuery();
  const payload = takeConfirmation(ctx.match[1], ctx.from.id);
  if (!payload) return respond(ctx, '⌛ This quote expired. Request a new one.', backOnly());

  const message = ctx.callbackQuery.message;
  const isBuy = payload.side === 'buy';
  await editProgress(ctx, message, isBuy ? '⚡ Sending buy…' : '⚡ Sending sell…');

  const onSubmitted = (sig) =>
    editProgress(ctx, message, `🚀 <b>Submitted</b> — <a href="${tradeService.txLink(sig)}">${shortAddress(sig, 6)}</a>\n⏳ Confirming…`);

  try {
    if (isBuy) {
      const { signature, quote } = await tradeService.executeBuy(ctx.from.id, payload.mint, payload.amount, { onSubmitted });
      await editProgress(
        ctx,
        message,
        `✅ <b>Bought $${escapeHtml(quote.token.symbol)}!</b>\n\n` +
          `Spent ${formatSol(quote.amountIn)}\n` +
          `🔗 <a href="${tradeService.txLink(signature)}">View on Solscan</a>`,
        afterTradeMenu(quote.token.address),
      );
    } else {
      const { signature, quote, received } = await tradeService.executeSell(ctx.from.id, payload.mint, payload.amount, { onSubmitted });
      await editProgress(
        ctx,
        message,
        `✅ <b>Sold ${payload.amount}% $${escapeHtml(quote.token.symbol)}!</b>\n\n` +
          `Received ~${formatSol(received)}\n` +
          `🔗 <a href="${tradeService.txLink(signature)}">View on Solscan</a>`,
        afterTradeMenu(quote.token.address),
      );
    }
  } catch (err) {
    logger.error({ err: err.message, userId: ctx.from.id, payload }, 'Trade failed');
    await editProgress(ctx, message, `❌ Trade failed: ${escapeHtml(tradeService.friendlyError(err))}`, afterTradeMenu(payload.mint));
  }
}

function parseArgs(ctx) {
  const [mint, amount] = (ctx.match || '').trim().split(/\s+/);
  return { mint, amount, valid: Boolean(mint && amount && isSolanaAddress(mint)) };
}

function register(bot) {
  bot.callbackQuery('menu:trade', (ctx) => respond(ctx, TRADE_HELP, backOnly()));

  bot.command(['buy', 'swap'], (ctx) => {
    const { mint, amount, valid } = parseArgs(ctx);
    if (!valid || !(Number(amount) > 0)) return respond(ctx, TRADE_HELP, backOnly());
    return showBuyQuote(ctx, mint, amount);
  });

  bot.command('sell', (ctx) => {
    const { mint, amount, valid } = parseArgs(ctx);
    const percent = Number.parseInt(String(amount).replace('%', ''), 10);
    if (!valid || !(percent > 0 && percent <= 100)) return respond(ctx, TRADE_HELP, backOnly());
    return showSellQuote(ctx, mint, percent);
  });

  bot.callbackQuery(new RegExp(`^tok:(${MINT_PATTERN})$`), (ctx) => showToken(ctx, ctx.match[1]));
  bot.callbackQuery(new RegExp(`^buy:(${MINT_PATTERN}):([\\d.]+)$`), (ctx) => showBuyQuote(ctx, ctx.match[1], ctx.match[2]));
  bot.callbackQuery(new RegExp(`^sell:(${MINT_PATTERN}):(\\d+)$`), (ctx) => showSellQuote(ctx, ctx.match[1], Number(ctx.match[2])));
  bot.callbackQuery(new RegExp(`^buyx:(${MINT_PATTERN})$`), async (ctx) => {
    setPending(ctx.from.id, 'buy_amount', { mint: ctx.match[1] });
    await ctx.answerCallbackQuery();
    await ctx.reply('🟢 How much SOL do you want to spend? Reply with a number, e.g. <code>0.3</code>\n\nType /cancel to abort.', {
      parse_mode: 'HTML',
    });
  });

  bot.callbackQuery(/^trade:ok:(\w+)$/, handleConfirm);
  bot.callbackQuery(/^trade:no:(\w+)$/, (ctx) => {
    takeConfirmation(ctx.match[1], ctx.from.id);
    return respond(ctx, '❌ Trade cancelled.', backOnly());
  });
}

module.exports = { register, showToken, showBuyQuote, MINT_PATTERN };
