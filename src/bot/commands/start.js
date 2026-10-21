const { mainMenu } = require('../keyboards');
const { respond, clearPending } = require('../helpers');
const { escapeHtml, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');

function welcomeText(ctx) {
  const name = escapeHtml(ctx.from?.first_name || 'Ape');
  const fee = config.revenue.feesEnabled ? bpsToPercent(config.revenue.botFeeBps) : '0%';
  return [
    `🐒🍌 <b>Welcome to ApeX Utility, ${name}!</b>`,
    '',
    'Trade Solana tokens faster, right from Telegram. <b>Day-1 utility</b>, and a share of every fee goes back to the community.',
    '',
    '⚡ <b>Instant trades</b> — paste a token address to buy or sell',
    '🪐 <b>Best price</b> — routed through Jupiter across all Solana DEXs',
    '🐒 <b>Built-in wallet</b> — encrypted, Phantom-compatible',
    `🍌 <b>Revenue share</b> — ${bpsToPercent(config.revenue.revenueShareBps)} of fees go to holders & active traders`,
    '',
    `Trading fee: <b>${fee}</b> • Slippage protection on every trade`,
    '',
    'Choose an option below to start aping 👇',
  ].join('\n');
}

function register(bot) {
  bot.command('start', (ctx) => {
    clearPending(ctx.from.id);
    return respond(ctx, welcomeText(ctx), mainMenu());
  });
  bot.callbackQuery('menu:main', (ctx) => respond(ctx, welcomeText(ctx), mainMenu()));
}

module.exports = { register };
