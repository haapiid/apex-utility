const automation = require('../services/automationService');
const markets = require('../services/markets');
const walletService = require('../services/walletService');
const { getChain, txLink } = require('../config/chains');
const { toUnits, formatNumber } = require('../utils/format');
const { attempt, MAX_ATTEMPTS, esc } = require('./common');
const logger = require('../utils/logger');

const LABEL = { limit_buy: '🟢 Limit buy', take_profit: '📈 Take profit', stop_loss: '📉 Stop loss' };
const fmtPrice = (p) => formatNumber(p, p < 0.0001 ? 12 : 8);

// Checks every open order's price and executes the ones that hit their trigger
async function run(notify) {
  for (const order of automation.openOrders()) {
    const chain = getChain(order.chain);
    const title = `${LABEL[order.type]} $${esc(order.symbol)} • ⛓ ${chain.name}`;
    if (order.expires_at < Date.now()) {
      automation.updateOrder(order.id, { status: 'expired' });
      await notify(order.user_id, `⌛ <b>${title}</b> expired without triggering.`);
      continue;
    }
    const wallet = walletService.getWallet(order.user_id, chain.kind);
    if (!wallet) continue;

    try {
      const svc = markets.serviceFor(chain);
      const token = await svc.getTokenInfo(order.token, wallet.address);
      let price;
      if (order.type === 'limit_buy') {
        price = await automation.buyPrice(chain, token, toUnits(order.amount, chain.decimals));
      } else {
        const raw = (token.balance * BigInt(order.amount)) / 100n;
        if (raw <= 0n) {
          // Sold already (manually or by the other half of a TP/SL pair)
          automation.updateOrder(order.id, { status: 'cancelled', error: 'No tokens left' });
          await notify(order.user_id, `🗑️ <b>${title}</b> cancelled: you no longer hold this token.`);
          continue;
        }
        price = await automation.sellPrice(chain, token, raw);
      }
      automation.updateOrder(order.id, { last_price: price });

      const hit = order.type === 'take_profit' ? price >= order.trigger_price : price <= order.trigger_price;
      if (!hit) continue;

      const outcome = await attempt(() =>
        order.type === 'limit_buy'
          ? svc.executeBuy(order.user_id, order.token, order.amount, { source: 'limit' })
          : svc.executeSell(order.user_id, order.token, Number(order.amount), { source: 'limit' }),
      );
      if (outcome.status === 'busy') continue;
      if (outcome.status === 'ok') {
        const sig = outcome.result.signature;
        automation.updateOrder(order.id, { status: 'filled', signature: sig });
        await notify(
          order.user_id,
          `✅ <b>${title}</b> filled at ~${fmtPrice(price)} ${chain.native}/token.\n🔗 <a href="${txLink(chain, sig)}">View transaction</a>`,
        );
        continue;
      }
      const attempts = order.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      automation.updateOrder(order.id, { attempts, error: outcome.message, ...(failed && { status: 'failed' }) });
      if (outcome.status === 'error') logger.warn({ id: order.id, err: outcome.err.message }, 'Order execution error');
      if (failed) await notify(order.user_id, `❌ <b>${title}</b> failed after ${attempts} tries: ${esc(outcome.message)}`);
    } catch (err) {
      // Price check failed (RPC / route hiccup): just try again next tick
      logger.debug({ id: order.id, err: err.message }, 'Order price check failed');
    }
  }
}

module.exports = { run, LABEL };
