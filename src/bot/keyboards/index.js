const { InlineKeyboard } = require('grammy');
const { SCENARIOS } = require('../../services/revenueService');

const backButton = (target = 'menu:main', label = '⬅️ Back') => InlineKeyboard.text(label, target);
const KIND_ICON = { sol: '◎', evm: '⟠' };

function mainMenu() {
  return new InlineKeyboard()
    .text('🐒 Wallets', 'menu:wallet')
    .text('📊 Positions', 'menu:positions')
    .row()
    .text('📜 History', 'menu:history')
    .text('⭐ Watchlist', 'menu:watchlist')
    .text('👁 Tracker', 'menu:tracker')
    .row()
    .text('⚡ Trade', 'menu:trade')
    .text('🤖 Orders', 'menu:orders')
    .row()
    .text('🎯 Sniper', 'menu:snipe')
    .text('💊 pump.fun', 'menu:pump')
    .row()
    .text('👥 Copy Trade', 'menu:copy')
    .text('💰 Rewards', 'menu:rewards')
    .row()
    .text('🎁 Referral', 'menu:referral')
    .text('🍌 Revenue Share', 'menu:revenue')
    .row()
    .text('⚙️ Settings', 'menu:settings')
    .text('⛽ Fees', 'menu:gas')
    .row()
    .text('🌐 ApeX Pro (web)', 'menu:web')
    .text('🛡️ Security', 'menu:security')
    .row()
    .text('❓ Help', 'menu:help');
}

/**
 * wallets: walletService.listWallets(userId); canCreate: { sol, evm } (under the per-kind limit)
 * Each wallet opens its detail screen; ✅ marks the active (trading) one.
 */
function walletMenu(wallets, canCreate) {
  const kb = new InlineKeyboard();
  if (!wallets.length) {
    return kb.text('🍌 Create Wallet', 'wallet:create').text('📥 Import Wallet', 'wallet:import').row().add(backButton());
  }
  wallets.forEach((w, i) => {
    kb.text(`${w.active ? '✅' : '▫️'} ${KIND_ICON[w.kind]} ${w.label}`, `wallet:open:${w.id}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row();
  if (canCreate.sol) kb.text('➕ Solana', 'wallet:new:sol');
  if (canCreate.evm) kb.text('➕ EVM', 'wallet:new:evm');
  kb.text('📥 Import', 'wallet:import').row();
  return kb.text('📤 Withdraw', 'wallet:withdraw').text('🔄 Refresh', 'wallet:refresh').row().add(backButton());
}

function walletDetailMenu(wallet) {
  const kb = new InlineKeyboard();
  if (!wallet.active) kb.text('✅ Use for trading', `wallet:use:${wallet.id}`).row();
  return kb
    .text('🔑 Export Key', `wallet:export:${wallet.id}`)
    .text('🗑️ Remove', `wallet:remove:${wallet.id}`)
    .row()
    .add(backButton('menu:wallet'));
}

function confirmMenu(action, label, cancelTarget = 'menu:wallet') {
  return new InlineKeyboard().text(`✅ ${label}`, `${action}:confirm`).text('❌ Cancel', cancelTarget);
}

// Callback data: <action>:<chain key>:<token address>[:<amount>] (stays under Telegram's 64 bytes)
// wallets: how many wallets the buttons trade from (0 = the user has only one, no picker)
function tokenMenu(chain, address, { buyPresets, sellPresets, wallets = 0 }) {
  const kb = new InlineKeyboard();
  const at = `${chain.key}:${address}`;
  if (wallets) kb.text(wallets > 1 ? `👛 Trading from ${wallets} wallets` : '👛 Wallets: active', `mw:${at}`).row();
  buyPresets.slice(0, 3).forEach((a) => kb.text(`🟢 Buy ${a} ${chain.native}`, `buy:${at}:${a}`));
  kb.row();
  buyPresets.slice(3).forEach((a) => kb.text(`🟢 Buy ${a} ${chain.native}`, `buy:${at}:${a}`));
  kb.text(`🟢 Buy X ${chain.native}`, `buyx:${at}`).row();
  sellPresets.forEach((p) => kb.text(`🔴 Sell ${p}%`, `sell:${at}:${p}`));
  kb.row().text('🎯 Limit / TP / SL', `ao:menu:${at}`).text('🔁 DCA', `ao:dca:${at}`).text('⭐ Watch', `wl:t:${at}`);
  return kb.row().text('🔄 Refresh', `tok:${at}`).text('📊 Positions', 'menu:positions').add(backButton('menu:main', '🏠 Menu'));
}

// Automation for one token: ao:<code>:<chain>:<address>
function orderTypeMenu(chain, address) {
  const at = `${chain.key}:${address}`;
  return new InlineKeyboard()
    .text('🟢 Limit buy (price drops)', `ao:lb:${at}`)
    .row()
    .text('📈 Take profit', `ao:tp:${at}`)
    .text('📉 Stop loss', `ao:sl:${at}`)
    .row()
    .add(backButton(`tok:${at}`));
}

function dcaTypeMenu(chain, address) {
  const at = `${chain.key}:${address}`;
  return new InlineKeyboard()
    .text('🟢 DCA buy', `ao:db:${at}`)
    .text('🔴 DCA sell', `ao:ds:${at}`)
    .row()
    .add(backButton(`tok:${at}`));
}

// items: [{ label, cancel }] for every open order / DCA plan / snipe
function ordersMenu(items) {
  const kb = new InlineKeyboard();
  items.forEach((item, i) => {
    kb.text(`❌ ${item.label}`, item.cancel);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🔄 Refresh', 'menu:orders').add(backButton());
}

// rules: pumpService.listRules(userId), one stop button each
function pumpMenu(rules) {
  const kb = new InlineKeyboard();
  rules.forEach((r, i) => {
    kb.text(`⏹ Stop rule ${i + 1}`, `pr:x:${r.id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('🔄 Refresh', 'menu:pump').add(backButton());
}

function copyMenu(targets) {
  const kb = new InlineKeyboard();
  targets.forEach((t, i) => {
    kb.text(`${t.active ? '🟢' : '⏸️'} ${t.label}`, `cp:o:${t.id}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('➕ Follow a wallet', 'cp:add').row().add(backButton());
}

function copyDetailMenu(t) {
  return new InlineKeyboard()
    .text(t.active ? '⏸️ Pause' : '▶️ Resume', `cp:p:${t.id}`)
    .text(t.copy_sells ? '🔴 Copy sells: ON' : '🔴 Copy sells: OFF', `cp:s:${t.id}`)
    .row()
    .text('🗑️ Unfollow', `cp:r:${t.id}`)
    .row()
    .add(backButton('menu:copy'));
}

// The same 0x address exists on several chains: let the user pick
function chainPickMenu(chains, address) {
  const kb = new InlineKeyboard();
  chains.forEach((c, i) => {
    kb.text(`⛓ ${c.name}`, `tok:${c.key}:${address}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().add(backButton('menu:main', '🏠 Menu'));
}

// Tick the wallets that trade: mwt:<chain>:<address>:<walletId>, all / active only: mwa:…
function walletPickMenu(chain, address, wallets, picked) {
  const at = `${chain.key}:${address}`;
  const kb = new InlineKeyboard();
  wallets.forEach((w, i) => {
    if (i && i % 3 === 0) kb.row();
    kb.text(`${picked.has(w.id) ? '✅' : '⬜'} ${w.label}`, `mwt:${at}:${w.id}`);
  });
  return kb
    .row()
    .text(picked.size === wallets.length ? '☝️ Active only' : '✅ All wallets', `mwa:${at}`)
    .row()
    .add(backButton(`tok:${at}`, '⬅️ Back to token'));
}

function tradeConfirmMenu(id) {
  return new InlineKeyboard().text('⚡ Confirm', `trade:ok:${id}`).text('❌ Cancel', `trade:no:${id}`);
}

function withdrawConfirmMenu(id) {
  return new InlineKeyboard().text('📤 Confirm Withdraw', `wd:ok:${id}`).text('❌ Cancel', `wd:no:${id}`);
}

function afterTradeMenu(chain, address) {
  const kb = new InlineKeyboard();
  if (address) kb.text('🍌 Open Token', `tok:${chain.key}:${address}`);
  return kb.text('📊 Positions', 'menu:positions').add(backButton('menu:main', '🏠 Menu'));
}

// rows: portfolio rows; each opens its token card
function positionsMenu(rows) {
  const kb = new InlineKeyboard();
  rows.forEach((r, i) => {
    kb.text(`${i + 1}. ${r.symbol}`, `tok:${r.chain.key}:${r.token}`);
    if (i % 3 === 2) kb.row();
  });
  return kb.row().text('🔄 Refresh', 'menu:positions').add(backButton('menu:main', '🏠 Menu'));
}

// labels: preformatted current values from the settings screen
function settingsMenu(labels) {
  return new InlineKeyboard()
    .text(`🛡️ MEV protection: ${labels.mev}`, 'set:mev')
    .row()
    .text(`✅ Confirm trades: ${labels.confirm}`, 'set:confirm')
    .row()
    .text(`🎯 Slippage SOL ${labels.slipSol}`, 'set:slip:sol')
    .text(`🎯 Slippage EVM ${labels.slipEvm}`, 'set:slip:evm')
    .row()
    .text(`💸 Jito tip ${labels.tip}`, 'set:tip')
    .text(`⚡ Priority ${labels.priority}`, 'set:prio')
    .row()
    .text(`⛽ EVM gas boost ${labels.gas}`, 'set:gas')
    .text(`📉 Max impact ${labels.impact}`, 'set:impact')
    .row()
    .text('🔴 Sell settings', 'menu:sellset')
    .row()
    .text(`🛡️ Anti-rug: ${labels.rug}`, 'set:rug')
    .text(`📉 Trigger ${labels.rugPct}`, 'set:rugpct')
    .row()
    .text('🟢 Buy buttons', 'set:buy')
    .text('🔴 Sell buttons', 'set:sell')
    .row()
    .text('♻️ Reset to defaults', 'set:reset')
    .row()
    .add(backButton());
}

// Sell side: "same as buy" toggle, then its own values when it has them
function sellSettingsMenu(labels) {
  const kb = new InlineKeyboard().text(`🔁 Same as buy: ${labels.own ? 'OFF' : 'ON'}`, 'ss:same').row();
  if (labels.own) {
    kb.text(`🛡️ MEV protection: ${labels.mev}`, 'ss:mev')
      .row()
      .text(`🎯 Slippage SOL ${labels.slipSol}`, 'ss:slip:sol')
      .text(`🎯 Slippage EVM ${labels.slipEvm}`, 'ss:slip:evm')
      .row()
      .text(`💸 Jito tip ${labels.tip}`, 'ss:tip')
      .text(`⚡ Priority ${labels.priority}`, 'ss:prio')
      .row()
      .text(`⛽ Gas boost ${labels.gas}`, 'ss:gas')
      .text(`📉 Max impact ${labels.impact}`, 'ss:impact')
      .row();
  }
  return kb.add(backButton('menu:settings'));
}

function settingsChainMenu(chains) {
  const kb = new InlineKeyboard();
  chains.forEach((c, i) => {
    kb.text(`⛓ ${c.name}`, `set:buy:${c.key}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().add(backButton('menu:settings'));
}

// claimable: chains (objects) with a native balance; cashback/burn only once $APEX is live
function rewardsMenu({ claimable, cashback, apexLive, slotCost }) {
  const kb = new InlineKeyboard();
  claimable.forEach((c, i) => {
    kb.text(`💸 Claim ${c.native} (${c.name})`, `rw:c:${c.key}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (cashback) kb.text('🎁 Claim cashback', 'rw:cb').row();
  if (apexLive) kb.text('🔥 Burn $APEX', 'rw:burn').text(`➕ Wallet slot (${slotCost} cr)`, 'rw:slot').row();
  return kb.text('🔄 Refresh', 'menu:rewards').text('🎁 Referral', 'menu:referral').row().add(backButton());
}

function adminMenu() {
  return new InlineKeyboard().text('💰 Distribute now', 'adm:dist').text('🔄 Refresh', 'adm:home').row().add(backButton());
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
  walletPickMenu,
  KIND_ICON,
  mainMenu,
  walletMenu,
  walletDetailMenu,
  confirmMenu,
  tokenMenu,
  chainPickMenu,
  tradeConfirmMenu,
  withdrawConfirmMenu,
  afterTradeMenu,
  positionsMenu,
  orderTypeMenu,
  dcaTypeMenu,
  ordersMenu,
  pumpMenu,
  copyMenu,
  copyDetailMenu,
  settingsMenu,
  sellSettingsMenu,
  settingsChainMenu,
  rewardsMenu,
  adminMenu,
  revenueMenu,
  backOnly,
  gasMenu,
};
