const { takePending, setPending } = require('../helpers');
const { isSolanaAddress } = require('../../config');
const { getChain, isEvmAddress } = require('../../config/chains');
const { handleImportKey } = require('./wallet');
const { handleSettingInput } = require('./settings');
const { handleAutomationInput } = require('./automation');
const { handleCopyInput } = require('./copy');
const { handleTrackInput } = require('./lists');
const { handleBurnInput } = require('./rewards');
const { openToken, showBuyQuote, ADDRESS_PATTERN } = require('./trade');

const ADDRESS_IN_TEXT = new RegExp(`(?:^|[^0-9A-Za-z])(${ADDRESS_PATTERN})(?![0-9A-Za-z])`);

// Plain text messages: answers to a pending prompt, or a pasted token address.
// Registered last so commands always win.
function register(bot) {
  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const state = takePending(ctx.from.id);
    if (state?.action === 'import_key') return handleImportKey(ctx);
    if (state?.action === 'setting') return handleSettingInput(ctx, state);
    if (state?.action === 'automation') return handleAutomationInput(ctx, state);
    if (state?.action === 'copy_add') return handleCopyInput(ctx, state);
    if (state?.action === 'track_add') return handleTrackInput(ctx, state);
    if (state?.action === 'burn') return handleBurnInput(ctx);
    if (state?.action === 'buy_amount') {
      if (!(Number(text) > 0)) {
        setPending(ctx.from.id, 'buy_amount', state.data); // keep waiting for a valid amount
        return ctx.reply('❌ Please send a positive number, e.g. 0.3 (or /cancel)');
      }
      return showBuyQuote(ctx, getChain(state.data.chain), state.data.address, text);
    }

    const address = text.match(ADDRESS_IN_TEXT)?.[1];
    if (address && (isEvmAddress(address) || isSolanaAddress(address))) return openToken(ctx, address);

    return ctx.reply('🐒 Paste a token address (Solana or 0x… EVM) to trade, or use /start for the menu.');
  });
}

module.exports = { register };
