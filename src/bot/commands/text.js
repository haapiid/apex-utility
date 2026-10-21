const { takePending, setPending } = require('../helpers');
const { isSolanaAddress } = require('../../config');
const { handleImportKey } = require('./wallet');
const { showToken, showBuyQuote, MINT_PATTERN } = require('./trade');

const MINT_IN_TEXT = new RegExp(`(?:^|[^1-9A-HJ-NP-Za-km-z])(${MINT_PATTERN})(?![1-9A-HJ-NP-Za-km-z])`);

// Plain text messages: answers to a pending prompt, or a pasted token address.
// Registered last so commands always win.
function register(bot) {
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const state = takePending(ctx.from.id);
    if (state?.action === 'import_key') return handleImportKey(ctx);
    if (state?.action === 'buy_amount') {
      if (!(Number(text) > 0)) {
        setPending(ctx.from.id, 'buy_amount', state.data); // keep waiting for a valid amount
        return ctx.reply('❌ Please send a positive number, e.g. 0.3 (or /cancel)');
      }
      return showBuyQuote(ctx, state.data.mint, text);
    }

    const mint = text.match(MINT_IN_TEXT)?.[1];
    if (mint && isSolanaAddress(mint)) return showToken(ctx, mint);

    return ctx.reply('🐒 Paste a Solana token address to trade, or use /start for the menu.');
  });
}

module.exports = { register };
