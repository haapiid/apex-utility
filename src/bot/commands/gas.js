const { getGasInfo } = require('../../services/gasService');
const { gasMenu, backOnly } = require('../keyboards');
const { respond } = require('../helpers');
const { formatNumber, formatUsd, formatPrice } = require('../../utils/format');
const logger = require('../../utils/logger');

async function showGas(ctx) {
  try {
    const gas = await getGasInfo();
    const lines = [
      '⛽ <b>ApeX Fee Tracker — Solana</b>',
      '',
      `🧱 Slot: <code>${gas.slot}</code>`,
      '⚡ Priority fee (micro-lamports / CU):',
      `   🐢 Low ${formatNumber(gas.levels.low, 0)} • 🐒 Medium ${formatNumber(gas.levels.medium, 0)} • 🚀 High ${formatNumber(gas.levels.high, 0)}`,
      `🔁 Est. swap cost: ${formatNumber(gas.swapCostSol, 6)} SOL${gas.swapCostUsd != null ? ` (~${formatPrice(gas.swapCostUsd)})` : ''}`,
    ];
    if (gas.solPrice) lines.push(`💵 SOL price: ${formatUsd(gas.solPrice)}`);
    await respond(ctx, lines.join('\n'), gasMenu());
  } catch (err) {
    logger.warn({ err: err.message }, 'Fee info failed');
    await respond(ctx, '❌ Network is not responding. Please try again shortly.', backOnly());
  }
}

function register(bot) {
  bot.command(['gas', 'fees'], showGas);
  bot.callbackQuery('menu:gas', showGas);
}

module.exports = { register };
