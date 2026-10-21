const { InlineKeyboard } = require('grammy');
const { SCENARIOS } = require('../../services/revenueService');

const BUY_PRESETS = ['0.1', '0.25', '0.5', '1', '2'];
const SELL_PRESETS = [25, 50, 100];

const backButton = (target = 'menu:main', label = '⬅️ Back') => InlineKeyboard.text(label, target);

function mainMenu() {
  return new InlineKeyboard()
    .text('🐒 Wallet', 'menu:wallet')
    .text('⚡ Trade', 'menu:trade')
    .row()
    .text('🍌 Revenue Share', 'menu:revenue')
    .text('⛽ Fees', 'menu:gas')
    .row()
    .text('🛡️ Security', 'menu:security')
    .text('❓ Help', 'menu:help');
}

function walletMenu(hasWallet) {
  const kb = new InlineKeyboard();
  if (hasWallet) {
    kb.text('🔄 Refresh', 'wallet:refresh')
      .text('📤 Withdraw', 'wallet:withdraw')
      .row()
      .text('🔑 Export Key', 'wallet:export')
      .text('🗑️ Remove', 'wallet:remove');
  } else {
    kb.text('🍌 Create Wallet', 'wallet:create').text('📥 Import Wallet', 'wallet:import');
  }
  return kb.row().add(backButton());
}

function confirmMenu(action, label, cancelTarget = 'menu:wallet') {
  return new InlineKeyboard().text(`✅ ${label}`, `${action}:confirm`).text('❌ Cancel', cancelTarget);
}

function tokenMenu(mint) {
  const kb = new InlineKeyboard();
  BUY_PRESETS.slice(0, 3).forEach((a) => kb.text(`🟢 Buy ${a} SOL`, `buy:${mint}:${a}`));
  kb.row();
  BUY_PRESETS.slice(3).forEach((a) => kb.text(`🟢 Buy ${a} SOL`, `buy:${mint}:${a}`));
  kb.text('🟢 Buy X SOL', `buyx:${mint}`).row();
  SELL_PRESETS.forEach((p) => kb.text(`🔴 Sell ${p}%`, `sell:${mint}:${p}`));
  return kb.row().text('🔄 Refresh', `tok:${mint}`).add(backButton('menu:main', '🏠 Menu'));
}

function tradeConfirmMenu(id) {
  return new InlineKeyboard().text('⚡ Confirm', `trade:ok:${id}`).text('❌ Cancel', `trade:no:${id}`);
}

function withdrawConfirmMenu(id) {
  return new InlineKeyboard().text('📤 Confirm Withdraw', `wd:ok:${id}`).text('❌ Cancel', `wd:no:${id}`);
}

function afterTradeMenu(mint) {
  const kb = new InlineKeyboard();
  if (mint) kb.text('🍌 Open Token', `tok:${mint}`);
  return kb.add(backButton('menu:main', '🏠 Menu'));
}

function revenueMenu() {
  const kb = new InlineKeyboard().text('📊 Live Stats', 'menu:revenue').row();
  Object.entries(SCENARIOS).forEach(([key, s]) => kb.text(s.label, `rev:${key}`));
  return kb.row().add(backButton());
}

function backOnly(target) {
  return new InlineKeyboard().add(backButton(target));
}

function gasMenu() {
  return new InlineKeyboard().text('🔄 Refresh', 'menu:gas').add(backButton());
}

module.exports = {
  mainMenu,
  walletMenu,
  confirmMenu,
  tokenMenu,
  tradeConfirmMenu,
  withdrawConfirmMenu,
  afterTradeMenu,
  revenueMenu,
  backOnly,
  gasMenu,
};
