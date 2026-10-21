const automation = require('../services/automationService');
const markets = require('../services/markets');
const safetyService = require('../services/safetyService');
const walletService = require('../services/walletService');
const { getChain, txLink } = require('../config/chains');
const { toUnits, shortAddress } = require('../utils/format');
const { attempt, MAX_ATTEMPTS, esc } = require('./common');
const logger = require('../utils/logger');

// Buys each waiting snipe as soon as its token exists and has a trading route (1% snipe fee)
async function run(notify) {
  for (const snipe of automation.waitingSnipes()) {
    const chain = getChain(snipe.chain);
    const title = `🎯 Snipe <code>${shortAddress(snipe.token, 6)}</code> • ⛓ ${chain.name}`;
    if (snipe.expires_at < Date.now()) {
      automation.updateSnipe(snipe.id, { status: 'expired' });
      await notify(snipe.user_id, `⌛ ${title} expired: the token never became tradable.`);
      continue;
    }
    const wallet = walletService.getWallet(snipe.user_id, chain.kind);
    if (!wallet) continue;
    const svc = markets.serviceFor(chain);

    // Not live yet (no token, no pool) → throws; keep waiting quietly
    let token;
    try {
      token = await svc.getTokenInfo(snipe.token, wallet.address);
      await svc.quoteTokensFor(token, toUnits(snipe.amount, chain.decimals));
    } catch {
      continue;
    }

    if (snipe.safety) {
      const scan = await safetyService.scan(chain, token, { canSell: async () => (await svc.quoteValue(token, 10n ** BigInt(token.decimals))) > 0n });
      if (scan.issues.length) {
        automation.updateSnipe(snipe.id, { status: 'failed', error: scan.issues.join('; ') });
        await notify(snipe.user_id, `🛑 ${title} skipped by the safety filter:\n• ${scan.issues.map(esc).join('\n• ')}`);
        continue;
      }
    }

    const outcome = await attempt(() => svc.executeBuy(snipe.user_id, snipe.token, snipe.amount, { source: 'snipe' }));
    if (outcome.status === 'busy') continue;
    if (outcome.status === 'ok') {
      automation.updateSnipe(snipe.id, { status: 'bought', signature: outcome.result.signature });
      await notify(
        snipe.user_id,
        `✅ ${title}: bought $${esc(token.symbol)} for ${esc(snipe.amount)} ${chain.native}!\n` +
          `🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>`,
      );
      continue;
    }
    const attempts = snipe.attempts + 1;
    const failed = attempts >= MAX_ATTEMPTS;
    automation.updateSnipe(snipe.id, { attempts, error: outcome.message, ...(failed && { status: 'failed' }) });
    if (outcome.status === 'error') logger.warn({ id: snipe.id, err: outcome.err.message }, 'Snipe error');
    if (failed) await notify(snipe.user_id, `❌ ${title} failed after ${attempts} tries: ${esc(outcome.message)}`);
  }
}

module.exports = { run };
