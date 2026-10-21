const { db } = require('../db');
const markets = require('../services/markets');
const settingsService = require('../services/settingsService');
const { getChain, txLink } = require('../config/chains');
const { attempt, esc } = require('./common');
const logger = require('../utils/logger');

// Reactive anti-rug: watches open positions of active wallets and sells everything when the value per
// token collapses between two checks (liquidity pulled, dev dump, tax switched on). It can't front-run
// the rug like a mempool bot, but it gets out on the next check instead of waiting for the user.

const PER_TICK = 30; // positions checked per tick, round-robin
const SCALE = 10n ** 18n;
const last = new Map(); // "walletId:chain:token" → { unit, at }
const warned = new Set(); // positions we already told the user we couldn't sell
let offset = 0;

function watchedPositions() {
  return db
    .prepare(
      `SELECT p.wallet_id, p.chain, p.token, p.symbol, w.user_id, w.address, w.kind
       FROM positions p JOIN wallets w ON w.id = p.wallet_id
       WHERE w.active = 1 AND p.amount != '0' ORDER BY p.wallet_id, p.token`,
    )
    .all();
}

async function check(pos, notify) {
  const settings = settingsService.get(pos.user_id);
  if (!settings.antiRug) return;
  const chain = getChain(pos.chain);
  if (!chain?.tradable || chain.kind !== pos.kind) return;
  const svc = markets.serviceFor(chain);
  const key = `${pos.wallet_id}:${pos.chain}:${pos.token}`;

  const token = await svc.getTokenInfo(pos.token, pos.address);
  if (token.balance === 0n) {
    last.delete(key);
    return;
  }
  const value = await svc.quoteValue(token).catch(() => null);
  const prev = last.get(key);
  // Value per token (scaled), so a partial manual sell doesn't look like a crash
  const unit = value != null ? (value * SCALE) / token.balance : null;
  if (unit != null) last.set(key, { unit, at: Date.now() });

  const title = `🛡️ <b>Anti-rug</b> $${esc(pos.symbol)} • ⛓ ${chain.name}`;
  if (unit == null) {
    // No route at all: liquidity is gone, nothing left to sell into
    if (prev && !warned.has(key)) {
      warned.add(key);
      await notify(pos.user_id, `${title}: the trading route disappeared (liquidity pulled?). ApeX couldn’t sell.`);
    }
    return;
  }
  warned.delete(key);
  if (!prev || prev.unit === 0n) return;

  const dropPct = Number(((prev.unit - unit) * 10_000n) / prev.unit) / 100;
  if (dropPct < settings.antiRugDropPct) return;

  logger.warn({ user: pos.user_id, token: pos.token, dropPct }, 'Anti-rug triggered');
  const outcome = await attempt(() => svc.executeSell(pos.user_id, pos.token, 100, { source: 'manual' }));
  if (outcome.status === 'busy') return;
  if (outcome.status === 'ok') {
    last.delete(key);
    await notify(
      pos.user_id,
      `${title}: value dropped ${dropPct.toFixed(1)}% in seconds, so ApeX sold your whole bag.\n` +
        `🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>\n<i>Turn this off or change the threshold in /settings.</i>`,
    );
  } else {
    await notify(pos.user_id, `${title}: value dropped ${dropPct.toFixed(1)}% but the emergency sell failed: ${esc(outcome.message)}`);
  }
}

async function run(notify) {
  const positions = watchedPositions();
  if (!positions.length) return;
  if (offset >= positions.length) offset = 0;
  const batch = positions.slice(offset, offset + PER_TICK);
  offset += PER_TICK;
  for (const pos of batch) {
    try {
      await check(pos, notify);
    } catch (err) {
      logger.debug({ token: pos.token, err: err.message }, 'Anti-rug check failed');
    }
  }
}

module.exports = { run };
