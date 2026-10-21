const modules = [
  require('./start'),
  require('./wallet'),
  require('./trade'),
  require('./gas'),
  require('./revenue'),
  require('./help'),
  require('./text'), // must stay last: catches plain text
];

const COMMAND_LIST = [
  { command: 'start', description: '🐒 Main menu' },
  { command: 'wallet', description: '🍌 Your wallet' },
  { command: 'buy', description: '🟢 Buy a token with SOL' },
  { command: 'sell', description: '🔴 Sell a token' },
  { command: 'withdraw', description: '📤 Withdraw SOL' },
  { command: 'revenue', description: '🍌 Revenue share stats' },
  { command: 'fees', description: '⛽ Solana priority fees' },
  { command: 'help', description: '❓ Help' },
];

function registerCommands(bot) {
  modules.forEach((m) => m.register(bot));
}

module.exports = { registerCommands, COMMAND_LIST };
