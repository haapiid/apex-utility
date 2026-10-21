const modules = [
  require('./start'),
  require('./wallet'),
  require('./trade'),
  require('./positions'),
  require('./automation'),
  require('./copy'),
  require('./rewards'),
  require('./admin'),
  require('./web'),
  require('./settings'),
  require('./gas'),
  require('./revenue'),
  require('./help'),
  require('./text'), // must stay last: catches plain text
];

const COMMAND_LIST = [
  { command: 'start', description: '🐒 Main menu' },
  { command: 'wallet', description: '🍌 Your wallets' },
  { command: 'positions', description: '📊 Positions & PnL' },
  { command: 'buy', description: '🟢 Buy a token (any chain)' },
  { command: 'sell', description: '🔴 Sell a token' },
  { command: 'orders', description: '🤖 Limit, TP/SL, DCA & snipes' },
  { command: 'snipe', description: '🎯 Snipe a token at launch' },
  { command: 'copy', description: '👥 Copy trade a wallet' },
  { command: 'settings', description: '⚙️ Slippage, MEV, buy buttons' },
  { command: 'web', description: '🌐 Log in to ApeX Pro' },
  { command: 'withdraw', description: '📤 Withdraw coins' },
  { command: 'rewards', description: '💰 Claim rewards & cashback' },
  { command: 'referral', description: '🎁 Your invite link' },
  { command: 'revenue', description: '🍌 Revenue share stats' },
  { command: 'fees', description: '⛽ Priority fees & gas' },
  { command: 'help', description: '❓ Help' },
];

function registerCommands(bot) {
  modules.forEach((m) => m.register(bot));
}

module.exports = { registerCommands, COMMAND_LIST };
