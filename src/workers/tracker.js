const trackerService = require('../services/trackerService');
const walletActivity = require('../services/walletActivity');
const { getChain, txLink } = require('../config/chains');
const { formatNumber, fromUnits, shortAddress } = require('../utils/format');
const { esc } = require('./common');
const logger = require('../utils/logger');

// Wallet tracker: store new trades of every tracked wallet and notify the users who asked for it.
// The same wallet tracked by several users is read once per tick.

let prunedAt = 0;

async function run(notify) {
  if (Date.now() - prunedAt > 60 * 60_000) {
    prunedAt = Date.now();
    trackerService.prune();
  }
  const groups = new Map(); // `${chain}:${address}` → rows
  for (const t of trackerService.all()) {
    const key = `${t.chain}:${t.address}`;
    groups.set(key, [...(groups.get(key) || []), t]);
  }
  for (const rows of groups.values()) {
    const chain = getChain(rows[0].chain);
    // Rows added later start from their own cursor; read from the oldest one so nobody misses trades
    const lead = rows.find((r) => r.cursor) || rows[0];
    try {
      const { events, cursor } = await walletActivity.eventsFor({ address: lead.address, cursor: lead.cursor }, chain);
      for (const row of rows) {
        if (cursor != null) trackerService.setCursor(row.id, cursor);
        if (!row.cursor) continue; // first look at this wallet for this user: start from now
        for (const e of events) {
          trackerService.addEvent(row.id, e);
          if (!row.notify) continue;
          const amount = e.native != null ? ` for ${formatNumber(fromUnits(e.native, chain.decimals), 4)} ${chain.native}` : '';
          await notify(
            row.user_id,
            `👁 <b>${esc(row.label)}</b> ${e.side === 'buy' ? '🟢 bought' : `🔴 sold ${e.percent ?? ''}%`} <code>${shortAddress(e.token, 6)}</code>${amount} • ⛓ ${chain.name}\n` +
              `🔗 <a href="${txLink(chain, e.ref)}">View transaction</a>`,
          );
        }
      }
    } catch (err) {
      logger.debug({ wallet: lead.address, err: err.message }, 'Wallet tracker read failed');
    }
  }
}

module.exports = { run };
