const { backOnly } = require('../keyboards');
const { respond } = require('../helpers');

const HELP_TEXT = [
  '❓ <b>ApeX Utility Help</b> 🐒',
  '',
  '🍌 <b>Paste any Solana token address</b> to open its trading card.',
  '',
  '/start — Main menu',
  '/wallet — Create, import, export or remove your wallet',
  '/buy &lt;mint&gt; &lt;SOL&gt; — Buy a token with SOL',
  '/sell &lt;mint&gt; &lt;percent&gt; — Sell part of your bag',
  '/withdraw &lt;address&gt; &lt;amount|all&gt; — Send SOL out',
  '/revenue — Live revenue share stats & calculator',
  '/fees — Live Solana priority fees',
  '/cancel — Cancel the current action',
  '/help — Show this help',
].join('\n');

const SECURITY_TEXT = [
  '🛡️ <b>ApeX Security</b>',
  '',
  '• Private keys are encrypted (AES-256-GCM) before they are stored.',
  '• Messages containing private keys are deleted automatically.',
  '• Every trade and withdraw needs your confirmation and has slippage protection.',
  '• ApeX works in private chats only, never in groups.',
  '• ApeX staff will <b>never</b> DM you or ask for your private key.',
  '• Use a dedicated trading wallet, not your main wallet.',
].join('\n');

function register(bot) {
  bot.command('help', (ctx) => respond(ctx, HELP_TEXT, backOnly()));
  bot.callbackQuery('menu:help', (ctx) => respond(ctx, HELP_TEXT, backOnly()));
  bot.callbackQuery('menu:security', (ctx) => respond(ctx, SECURITY_TEXT, backOnly()));
}

module.exports = { register };
