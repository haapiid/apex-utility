const { Bot, GrammyError, HttpError } = require('grammy');
const { config } = require('../config');
const { evmChains } = require('../config/chains');
const { registerCommands, COMMAND_LIST } = require('./commands');
const logger = require('../utils/logger');

const RATE_WINDOW_MS = 5_000;
const RATE_MAX_UPDATES = 12;

function rateLimit() {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    for (const [id, times] of hits) if (times.at(-1) < cutoff) hits.delete(id);
  }, 60_000).unref();

  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return next();
    const now = Date.now();
    const times = (hits.get(id) || []).filter((t) => now - t < RATE_WINDOW_MS);
    times.push(now);
    hits.set(id, times);
    if (times.length > RATE_MAX_UPDATES) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: '🐒 Slow down, ape! Try again in a few seconds.' }).catch(() => {});
      return;
    }
    return next();
  };
}

function createBot() {
  const bot = new Bot(config.bot.token);

  // Wallet bot: private chats only so keys and balances never leak in groups
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== 'private') {
      if (ctx.message?.text?.startsWith('/')) {
        await ctx.reply('🐒 ApeX Utility only works in a private chat. Message me directly!');
      }
      return;
    }
    return next();
  });
  bot.use(rateLimit());

  registerCommands(bot);

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) logger.error({ desc: e.description }, 'Telegram API error');
    else if (e instanceof HttpError) logger.error({ err: e.message }, 'Could not reach Telegram');
    else logger.error({ err: e?.message, stack: e?.stack }, 'Unhandled bot error');
  });

  return bot;
}

// Commands menu + profile texts shown in Telegram
async function setupProfile(bot) {
  await bot.api.setMyCommands(COMMAND_LIST);
  await bot.api.setMyShortDescription('🐒 Trade tokens on Solana, Ethereum, BSC, Base & more on Telegram. Day-1 utility & revenue sharing 🍌');
  await bot.api.setMyDescription(
    '🐒🍌 ApeX Utility\n\n' +
      `⛓ ${['Solana', ...evmChains().map((c) => c.name)].join(' • ')}\n\n` +
      '⚡ Buy & sell any token by pasting its address\n' +
      '🪐 Best price via Jupiter & KyberSwap\n' +
      '🐒 Built-in encrypted Solana & EVM wallets\n' +
      '🍌 Revenue sharing for holders & active traders\n' +
      '⛽ Live priority fees\n\n' +
      'Tap Start to begin.',
  );
}

module.exports = { createBot, setupProfile };
