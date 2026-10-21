const { getPortfolio } = require('../../services/portfolioService');
const { positionsMenu, backOnly } = require('../keyboards');
const { respond } = require('../helpers');
const { formatNumber, formatNative, fromUnits, escapeHtml } = require('../../utils/format');
const logger = require('../../utils/logger');

const pnlLine = (r) => {
  if (r.cost == null) return '   PnL: <i>no cost data (not bought through ApeX)</i>';
  if (r.pnl == null) return `   PnL: <i>price unavailable right now</i> • cost ${formatNative(r.cost, r.chain)}`;
  const sign = r.pnl >= 0n ? '🟢 +' : '🔴 −';
  const abs = r.pnl >= 0n ? r.pnl : -r.pnl;
  const pct = r.pnlPct != null ? ` (${r.pnl >= 0n ? '+' : '−'}${formatNumber(Math.abs(r.pnlPct), 1)}%)` : '';
  return `   PnL: ${sign}${formatNative(abs, r.chain)}${pct} • cost ${formatNative(r.cost, r.chain)}`;
};

async function showPositions(ctx) {
  let portfolio;
  try {
    portfolio = await getPortfolio(ctx.from.id);
  } catch (err) {
    logger.warn({ err: err.message }, 'Portfolio failed');
    return respond(ctx, '❌ Couldn’t load your positions right now. Please try again.', backOnly());
  }
  const { wallets, rows, truncated } = portfolio;
  if (!wallets.sol && !wallets.evm) return respond(ctx, '🐒 Create a wallet first in /wallet.', backOnly());

  const lines = ['📊 <b>Positions</b> (active wallets)', ''];
  if (!rows.length) {
    lines.push('No open positions yet. Paste a token address to make your first trade 🍌');
  }
  rows.forEach((r, i) => {
    lines.push(
      `<b>${i + 1}. $${escapeHtml(r.symbol)}</b> • ⛓ ${r.chain.name}`,
      `   Holding: ${formatNumber(fromUnits(r.balance, r.decimals), 4)} • Value: <b>${r.value != null ? formatNative(r.value, r.chain) : 'n/a'}</b>`,
      pnlLine(r),
    );
    if (r.realized && r.realized !== 0n) {
      lines.push(`   Realized: ${r.realized > 0n ? '+' : '−'}${formatNative(r.realized > 0n ? r.realized : -r.realized, r.chain)}`);
    }
    lines.push('');
  });
  if (truncated) lines.push('<i>Showing the 10 most recent positions.</i>');
  lines.push('<i>Value = what you’d get selling everything now. Tap a token to trade it.</i>');
  return respond(ctx, lines.join('\n'), positionsMenu(rows));
}

function register(bot) {
  bot.command(['positions', 'portfolio', 'pnl'], showPositions);
  bot.callbackQuery('menu:positions', showPositions);
}

module.exports = { register };
