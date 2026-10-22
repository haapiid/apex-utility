const automation = require('../services/automationService');
const markets = require('../services/markets');
const walletActivity = require('../services/walletActivity');
const { getChain, txLink } = require('../config/chains');
const { shortAddress } = require('../utils/format');
const { attempt, esc } = require('./common');
const logger = require('../utils/logger');

// Copy trading: watch each followed wallet (src/services/walletActivity.js) and mirror its trades from
// the user's active wallet.
//   buy  → the target spent the native coin and received a token → buy it for the user's fixed amount
//   sell → the target sent a token away → sell the same share of the user's bag (if copy_sells is on)

// ---------- Mirroring ----------

async function mirror(target, chain, event, notify) {
  const svc = markets.serviceFor(chain);
  const who = `👥 Copy <code>${esc(target.label)}</code> • ⛓ ${chain.name}`;
  const outcome = await attempt(() =>
    event.side === 'buy'
      ? svc.executeBuy(target.user_id, event.token, target.buy_amount, { source: 'copy' })
      : svc.executeSell(target.user_id, event.token, Math.min(100, event.percent), { source: 'copy' }),
  );
  if (outcome.status === 'ok') {
    const what = event.side === 'buy' ? `bought for ${esc(target.buy_amount)} ${chain.native}` : `sold ${Math.min(100, event.percent)}% of your bag`;
    await notify(
      target.user_id,
      `${who}: ${what} — $${esc(outcome.result.quote.token.symbol)}\n🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>`,
    );
    return;
  }
  // Selling something we never bought isn't worth a message
  if (event.side === 'sell' && /don’t hold/.test(outcome.message || '')) return;
  if (outcome.status === 'error') logger.warn({ target: target.id, err: outcome.err.message }, 'Copy trade error');
  await notify(
    target.user_id,
    `⚠️ ${who}: couldn’t copy a ${event.side} of <code>${shortAddress(event.token, 6)}</code>: ${esc(outcome.message || 'busy, skipped')}`,
  );
}

async function run(notify) {
  for (const target of automation.activeCopyTargets()) {
    const chain = getChain(target.chain);
    try {
      const { events, cursor } = await walletActivity.eventsFor(target, chain);
      // Save the cursor first: a crash mid-way must not replay (and double-buy) the same trades
      if (cursor != null && String(cursor) !== String(target.cursor)) automation.setCopyCursor(target.id, cursor);
      for (const event of events) {
        if (event.side === 'sell' && !target.copy_sells) continue;
        await mirror(target, chain, event, notify);
      }
    } catch (err) {
      logger.debug({ target: target.id, err: err.message }, 'Copy watch failed');
    }
  }
}

module.exports = { run };
