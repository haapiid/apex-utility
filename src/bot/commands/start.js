const { mainMenu } = require('../keyboards');
const { respond, clearPending } = require('../helpers');
const { escapeHtml, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');
const { evmChains } = require('../../config/chains');
const rewardsService = require('../../services/rewardsService');

const chainNames = () => ['Solana', ...evmChains().map((c) => c.name)].join(' • ');

function welcomeText(ctx) {
  const name = escapeHtml(ctx.from?.first_name || 'Ape');
  const fee = `${bpsToPercent(config.fees.manualBps)} (snipes ${bpsToPercent(config.fees.snipeBps)})`;
  return [
    `🐒🍌 <b>Welcome to ApeX Utility, ${name}!</b>`,
    '',
    `Trade tokens faster on ${evmChains().length + 1} chains, right from Telegram. <b>Day-1 utility</b>, and a share of every fee goes back to the community.`,
    '',
    `⛓ <b>${chainNames()}</b>`,
    '',
    '⚡ <b>Instant trades</b> — paste a token address to buy or sell, the chain is detected for you',
    '🪐 <b>Best price</b> — routed through Jupiter (Solana) and KyberSwap (EVM)',
    '🐒 <b>Built-in wallets</b> — up to 5 per type, encrypted, Phantom & MetaMask compatible',
    '🥷 <b>MEV protection</b> — Jito on Solana, private RPCs on Ethereum & BSC',
    '📊 <b>Positions & PnL</b> — every bag in one place',
    '🤖 <b>Automation</b> — limit buys, take profit, stop loss, DCA, sniper, copy trading',
    '🛡️ <b>Anti-rug</b> — safety scan before you buy, auto-sell if liquidity gets pulled',
    `🍌 <b>Revenue share</b> — ${bpsToPercent(config.revenue.revenueShareBps)} of fees go to $${config.revenue.tokenSymbol} holders, claim gas-free`,
    `🎁 <b>Referral & cashback</b> — ${bpsToPercent(config.referral.shareBps)} of your friends’ fees, plus cashback on your own`,
    '',
    `Trading fee: <b>${fee}</b> • Slippage protection on every trade • Tune it all in /settings`,
    '',
    'Choose an option below to start aping 👇',
  ].join('\n');
}

function register(bot) {
  bot.command('start', async (ctx) => {
    clearPending(ctx.from.id);
    // "Log in with Telegram" on ApeX Pro links to t.me/<bot>?start=web
    if ((ctx.match || '').trim() === 'web') return require('./web').sendLoginCode(ctx);
    // Invite links: t.me/<bot>?start=ref_<code>
    const ref = /^ref_([a-z0-9]+)$/i.exec((ctx.match || '').trim());
    if (ref && rewardsService.bindReferrer(ctx.from.id, ref[1]).ok) {
      await ctx.reply('🎁 You joined through a friend’s invite. Welcome to the troop!');
    }
    return respond(ctx, welcomeText(ctx), mainMenu());
  });
  bot.callbackQuery('menu:main', (ctx) => respond(ctx, welcomeText(ctx), mainMenu()));
}

module.exports = { register };
