const { backOnly } = require('../keyboards');
const { respond } = require('../helpers');
const { allChains } = require('../../config/chains');

const HELP_TEXT = [
  '❓ <b>ApeX Utility Help</b> 🐒',
  '',
  '🍌 <b>Paste any token address</b> (Solana or 0x… EVM) to open its trading card. The chain is detected for you.',
  '',
  '/start — Main menu',
  '/wallet — Up to 5 Solana & 5 EVM wallets: create, import, switch, export, remove',
  '/positions — Your open positions with value and PnL',
  '/orders — Limit buys, take profit / stop loss, DCA plans and snipes (cancel them here)',
  '/snipe [chain] &lt;token&gt; &lt;amount&gt; — Buy the moment a token becomes tradable',
  '/copy — Follow wallets and mirror their trades',
  '/settings — Slippage, MEV protection, Jito tip, gas boost, buy/sell buttons',
  '/buy [chain] &lt;token&gt; &lt;amount&gt; — Buy a token with the chain’s coin',
  '/sell [chain] &lt;token&gt; &lt;percent&gt; — Sell part of your bag',
  '/withdraw [chain] &lt;address&gt; &lt;amount|all&gt; — Send coins out (chain needed for EVM)',
  '/rewards — Claim referral earnings, revenue share and cashback (gas-free); burn $APEX for credits',
  '/referral — Your invite link and earnings',
  '/revenue — Live revenue share pools & calculator',
  '/fees — Live Solana priority fees & EVM gas',
  '/cancel — Cancel the current action',
  '/help — Show this help',
  '',
  `⛓ Chain keys: ${allChains()
    .filter((c) => c.tradable)
    .map((c) => `<code>${c.key}</code> ${c.name}`)
    .join(' • ')}`,
].join('\n');

const SECURITY_TEXT = [
  '🛡️ <b>ApeX Security</b>',
  '',
  '• Private keys are encrypted (AES-256-GCM) before they are stored.',
  '• Messages containing private keys are deleted automatically.',
  '• Every trade has slippage protection; trades and withdraws ask for confirmation (trades: unless you turn it off in /settings).',
  '• MEV protection: Solana swaps go through Jito, Ethereum through Flashbots Protect, BSC through PancakeSwap MEV Guard.',
  '• Token cards show a safety scan (honeypot, taxes, freeze/mint authority). The sniper skips risky tokens by default.',
  '• Anti-rug watches your positions and sells if a token’s value suddenly collapses (it reacts within ~20 s; it can’t front-run a rug).',
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
