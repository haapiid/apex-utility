const settingsService = require('../../services/settingsService');
const { settingsMenu, sellSettingsMenu, settingsChainMenu, confirmMenu } = require('../keyboards');
const { respond, setPending } = require('../helpers');
const { formatNumber, bpsToPercent, lamportsToSol } = require('../../utils/format');
const { config } = require('../../config');
const { allChains, getChain } = require('../../config/chains');

const { LIMITS, GAS_BOOST_STEPS } = settingsService;
const onOff = (v) => (v ? 'ON' : 'OFF');
const sol = (lamports) => `${formatNumber(lamportsToSol(BigInt(lamports)), 6)} SOL`;
const tradableChains = () => allChains().filter((c) => c.tradable);
const impactLabel = (pct) => (pct ? `${pct}%` : 'off');
const hasOwnSell = (s) => Object.keys(s.sell || {}).length > 0;

// One line per side-specific value, for the settings screens
function sideLines(v) {
  return [
    `🛡️ MEV protection: ${onOff(v.mevProtect)}`,
    `🎯 Slippage: Solana ${bpsToPercent(v.slippageBps.sol)} • EVM ${bpsToPercent(v.slippageBps.evm)}`,
    `💸 Jito tip: ${sol(v.jitoTipLamports)} • ⚡ Max priority fee: ${sol(v.priorityMaxLamports)}`,
    `⛽ EVM gas boost: +${v.gasBoostPct}% • 📉 Max price impact: ${impactLabel(v.maxImpactPct)}`,
  ];
}

function settingsText(s) {
  const presets = tradableChains()
    .map((c) => `   ${c.name}: ${settingsService.buyPresets(s, c).join(' / ')} ${c.native}`)
    .join('\n');
  return [
    '⚙️ <b>Settings</b>',
    '',
    `🛡️ <b>MEV protection: ${onOff(s.mevProtect)}</b>`,
    '   Solana swaps go through Jito with a tip; Ethereum and BSC use a private RPC.',
    `✅ <b>Confirm trades: ${onOff(s.confirmTrades)}</b>`,
    `   ${s.confirmTrades ? 'Every buy/sell asks for confirmation.' : 'Buy/sell buttons trade instantly.'}`,
    `🎯 <b>Slippage:</b> Solana ${bpsToPercent(s.slippageBps.sol)} • EVM ${bpsToPercent(s.slippageBps.evm)}`,
    `💸 <b>Jito tip</b> (MEV on): ${sol(s.jitoTipLamports)}`,
    `⚡ <b>Max priority fee</b> (MEV off): ${sol(s.priorityMaxLamports)}`,
    `⛽ <b>EVM gas boost:</b> +${s.gasBoostPct}% on the priority fee`,
    `📉 <b>Max price impact:</b> ${impactLabel(s.maxImpactPct)}`,
    `🔴 <b>Sells:</b> ${hasOwnSell(s) ? 'their own settings (🔴 Sell settings)' : 'same as buys'}`,
    '   The values above are for buys. Sells can have more slippage or a bigger tip to get out fast.',
    `🛡️ <b>Anti-rug: ${onOff(s.antiRug)}</b>`,
    `   Sells a position automatically if its value drops ${s.antiRugDropPct}%+ between two checks (~20 s).`,
    '',
    '🟢 <b>Buy buttons</b>',
    presets,
    `🔴 <b>Sell buttons:</b> ${s.sellPresets.map((p) => `${p}%`).join(' / ')}`,
    '',
    `<i>Fees: ${bpsToPercent(config.fees.manualBps)} manual trades • ${bpsToPercent(config.fees.snipeBps)} snipes</i>`,
  ].join('\n');
}

function showSettings(ctx) {
  const s = settingsService.get(ctx.from.id);
  return respond(
    ctx,
    settingsText(s),
    settingsMenu({
      mev: onOff(s.mevProtect),
      confirm: onOff(s.confirmTrades),
      slipSol: bpsToPercent(s.slippageBps.sol),
      slipEvm: bpsToPercent(s.slippageBps.evm),
      tip: sol(s.jitoTipLamports),
      priority: sol(s.priorityMaxLamports),
      gas: `+${s.gasBoostPct}%`,
      rug: onOff(s.antiRug),
      rugPct: `${s.antiRugDropPct}%`,
      impact: impactLabel(s.maxImpactPct),
    }),
  );
}

// Sells: "same as buy", or their own MEV / slippage / tip / priority / gas / price impact
function showSellSettings(ctx) {
  const s = settingsService.get(ctx.from.id);
  const own = hasOwnSell(s);
  const v = settingsService.sideSettings(s, 'sell');
  const text = [
    '🔴 <b>Sell settings</b>',
    '',
    own ? 'Sells use their own values:' : 'Sells use the same values as buys. Turn off "Same as buy" to set them apart.',
    '',
    ...sideLines(v),
    '',
    '<i>The price impact limit only stops manual sells. Stop loss, anti-rug, DCA and copy sells always go through.</i>',
  ].join('\n');
  return respond(
    ctx,
    text,
    sellSettingsMenu({
      own,
      mev: onOff(v.mevProtect),
      slipSol: bpsToPercent(v.slippageBps.sol),
      slipEvm: bpsToPercent(v.slippageBps.evm),
      tip: sol(v.jitoTipLamports),
      priority: sol(v.priorityMaxLamports),
      gas: `+${v.gasBoostPct}%`,
      impact: impactLabel(v.maxImpactPct),
    }),
  );
}

// Saves fields of one side: the buy side lives at the top level, the sell side in `sell`
function patchSide(userId, side, patch) {
  if (side !== 'sell') return settingsService.update(userId, patch);
  const current = settingsService.get(userId).sell || {};
  const next = { ...current, ...patch };
  if (patch.slippageBps) next.slippageBps = { ...current.slippageBps, ...patch.slippageBps };
  return settingsService.update(userId, { sell: next });
}

// Asks the user to type a value; handleSettingInput() receives it (via commands/text.js)
async function ask(ctx, field, data, prompt) {
  setPending(ctx.from.id, 'setting', { field, ...data });
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.reply(`${prompt}\n\nType /cancel to abort.`, { parse_mode: 'HTML' });
}

const inRange = (n, [min, max]) => Number.isFinite(n) && n >= min && n <= max;
const solToLamportsNumber = (n) => Math.round(n * 1e9);

// Returns an error message, or null after saving the setting
function applySetting(userId, { field, kind, chain, side = 'buy' }, text) {
  const n = Number(text.replace('%', '').trim());
  switch (field) {
    case 'slippage': {
      const range = LIMITS.slippagePct[kind];
      if (!inRange(n, range)) return `Slippage must be between ${range[0]}% and ${range[1]}%.`;
      patchSide(userId, side, { slippageBps: { [kind]: Math.round(n * 100) } });
      return null;
    }
    case 'tip':
      if (!inRange(n, LIMITS.jitoTipSol)) return `Jito tip must be between ${LIMITS.jitoTipSol[0]} and ${LIMITS.jitoTipSol[1]} SOL.`;
      patchSide(userId, side, { jitoTipLamports: solToLamportsNumber(n) });
      return null;
    case 'priority':
      if (!inRange(n, LIMITS.priorityMaxSol)) return `Priority fee must be between 0 and ${LIMITS.priorityMaxSol[1]} SOL.`;
      patchSide(userId, side, { priorityMaxLamports: solToLamportsNumber(n) });
      return null;
    case 'impact': {
      const range = LIMITS.maxImpactPct;
      if (!inRange(n, range)) return `The limit must be between ${range[0]} and ${range[1]}% (0 = off).`;
      patchSide(userId, side, { maxImpactPct: n });
      return null;
    }
    case 'antiRugDropPct': {
      const range = LIMITS.antiRugDropPct;
      if (!inRange(n, range)) return `The trigger must be between ${range[0]}% and ${range[1]}%.`;
      settingsService.update(userId, { antiRugDropPct: Math.round(n) });
      return null;
    }
    case 'buyPresets': {
      const values = text.split(/[\s,]+/).filter(Boolean);
      const valid = values.length >= 1 && values.length <= LIMITS.buyPresets && values.every((v) => /^\d*\.?\d+$/.test(v) && Number(v) > 0);
      if (!valid) return `Send 1 to ${LIMITS.buyPresets} positive amounts separated by commas, e.g. 0.1, 0.25, 0.5`;
      settingsService.update(userId, { buyPresets: { [chain]: values } });
      return null;
    }
    case 'sellPresets': {
      const values = text.split(/[\s,%]+/).filter(Boolean).map(Number);
      const valid = values.length >= 1 && values.length <= LIMITS.sellPresets && values.every((v) => Number.isInteger(v) && v >= 1 && v <= 100);
      if (!valid) return `Send 1 to ${LIMITS.sellPresets} whole percentages (1-100) separated by commas, e.g. 25, 50, 100`;
      settingsService.update(userId, { sellPresets: values });
      return null;
    }
    default:
      return 'Unknown setting.';
  }
}

async function handleSettingInput(ctx, state) {
  const error = applySetting(ctx.from.id, state.data, ctx.message.text);
  if (error) {
    setPending(ctx.from.id, 'setting', state.data); // keep waiting for a valid value
    return ctx.reply(`❌ ${error}\n\nTry again or /cancel.`);
  }
  await ctx.reply('✅ Saved.');
  return state.data.side === 'sell' ? showSellSettings(ctx) : showSettings(ctx);
}

function register(bot) {
  bot.command('settings', showSettings);
  bot.callbackQuery('menu:settings', showSettings);

  bot.callbackQuery('set:mev', (ctx) => {
    settingsService.update(ctx.from.id, { mevProtect: !settingsService.get(ctx.from.id).mevProtect });
    return showSettings(ctx);
  });
  bot.callbackQuery('set:confirm', (ctx) => {
    settingsService.update(ctx.from.id, { confirmTrades: !settingsService.get(ctx.from.id).confirmTrades });
    return showSettings(ctx);
  });
  bot.callbackQuery('set:rug', (ctx) => {
    settingsService.update(ctx.from.id, { antiRug: !settingsService.get(ctx.from.id).antiRug });
    return showSettings(ctx);
  });
  bot.callbackQuery('set:rugpct', (ctx) => {
    const [min, max] = LIMITS.antiRugDropPct;
    return ask(ctx, 'antiRugDropPct', {}, `📉 Sell automatically when a position loses at least how many % in ~20 s? (${min}-${max}), e.g. <code>60</code>`);
  });
  bot.callbackQuery('set:gas', (ctx) => {
    const current = settingsService.get(ctx.from.id).gasBoostPct;
    const next = GAS_BOOST_STEPS[(GAS_BOOST_STEPS.indexOf(current) + 1) % GAS_BOOST_STEPS.length] ?? 0;
    settingsService.update(ctx.from.id, { gasBoostPct: next });
    return showSettings(ctx);
  });

  bot.callbackQuery(/^set:slip:(sol|evm)$/, (ctx) => {
    const kind = ctx.match[1];
    const [min, max] = LIMITS.slippagePct[kind];
    return ask(ctx, 'slippage', { kind }, `🎯 New ${kind === 'sol' ? 'Solana' : 'EVM'} slippage in % (${min}-${max}), e.g. <code>3</code>`);
  });
  bot.callbackQuery('set:tip', (ctx) =>
    ask(ctx, 'tip', {}, '💸 New Jito tip in SOL, e.g. <code>0.0005</code>\nA higher tip lands faster when the network is busy.'),
  );
  bot.callbackQuery('set:prio', (ctx) =>
    ask(ctx, 'priority', {}, '⚡ New max priority fee in SOL (used when MEV protection is off), e.g. <code>0.001</code>'),
  );
  bot.callbackQuery('set:buy', (ctx) => respond(ctx, '🟢 Change the buy buttons of which chain?', settingsChainMenu(tradableChains())));
  bot.callbackQuery(/^set:buy:([a-z]+)$/, (ctx) => {
    const chain = getChain(ctx.match[1]);
    if (!chain?.tradable) return ctx.answerCallbackQuery('Unknown chain');
    return ask(
      ctx,
      'buyPresets',
      { chain: chain.key },
      `🟢 New ${chain.name} buy buttons in ${chain.native}, up to ${LIMITS.buyPresets}, e.g. <code>${chain.buyPresets.join(', ')}</code>`,
    );
  });
  bot.callbackQuery('set:sell', (ctx) =>
    ask(ctx, 'sellPresets', {}, `🔴 New sell buttons in %, up to ${LIMITS.sellPresets}, e.g. <code>25, 50, 100</code>`),
  );

  bot.callbackQuery('set:impact', (ctx) =>
    ask(ctx, 'impact', {}, '📉 Refuse buys (and manual sells) whose price impact is above how many %? e.g. <code>15</code>, or <code>0</code> for no limit'),
  );

  // ---------- sell side ----------
  bot.callbackQuery('menu:sellset', showSellSettings);
  bot.callbackQuery('ss:same', (ctx) => {
    const s = settingsService.get(ctx.from.id);
    // Turning "same as buy" off starts the sell side from the current buy values
    const sell = hasOwnSell(s) ? {} : Object.fromEntries(settingsService.SIDE_FIELDS.map((k) => [k, s[k]]));
    settingsService.update(ctx.from.id, { sell });
    return showSellSettings(ctx);
  });
  const sellValue = (ctx, key) => settingsService.sideSettings(settingsService.get(ctx.from.id), 'sell')[key];
  bot.callbackQuery('ss:mev', (ctx) => {
    patchSide(ctx.from.id, 'sell', { mevProtect: !sellValue(ctx, 'mevProtect') });
    return showSellSettings(ctx);
  });
  bot.callbackQuery('ss:gas', (ctx) => {
    const current = sellValue(ctx, 'gasBoostPct');
    patchSide(ctx.from.id, 'sell', { gasBoostPct: GAS_BOOST_STEPS[(GAS_BOOST_STEPS.indexOf(current) + 1) % GAS_BOOST_STEPS.length] ?? 0 });
    return showSellSettings(ctx);
  });
  bot.callbackQuery(/^ss:slip:(sol|evm)$/, (ctx) => {
    const kind = ctx.match[1];
    const [min, max] = LIMITS.slippagePct[kind];
    return ask(ctx, 'slippage', { kind, side: 'sell' }, `🔴 Sell slippage on ${kind === 'sol' ? 'Solana' : 'EVM'} in % (${min}-${max}), e.g. <code>10</code>`);
  });
  bot.callbackQuery('ss:tip', (ctx) => ask(ctx, 'tip', { side: 'sell' }, '🔴 Jito tip for sells in SOL, e.g. <code>0.001</code>'));
  bot.callbackQuery('ss:prio', (ctx) => ask(ctx, 'priority', { side: 'sell' }, '🔴 Max priority fee for sells in SOL (MEV off), e.g. <code>0.002</code>'));
  bot.callbackQuery('ss:impact', (ctx) => ask(ctx, 'impact', { side: 'sell' }, '🔴 Refuse manual sells whose price impact is above how many %? e.g. <code>30</code>, or <code>0</code> for no limit'));

  bot.callbackQuery('set:reset', (ctx) =>
    respond(ctx, '♻️ Reset all settings to the defaults?', confirmMenu('set:reset', 'Reset', 'menu:settings')),
  );
  bot.callbackQuery('set:reset:confirm', (ctx) => {
    settingsService.reset(ctx.from.id);
    return showSettings(ctx);
  });
}

module.exports = { register, handleSettingInput };
