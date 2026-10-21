const automation = require('../services/automationService');
const markets = require('../services/markets');
const { getChain, txLink } = require('../config/chains');
const { attempt, MAX_ATTEMPTS, esc } = require('./common');
const logger = require('../utils/logger');

// Executes the DCA runs that are due
async function run(notify) {
  for (const plan of automation.dueDca()) {
    const chain = getChain(plan.chain);
    const svc = markets.serviceFor(chain);
    const title = `🔁 DCA ${plan.side} $${esc(plan.symbol)} • ⛓ ${chain.name}`;

    const outcome = await attempt(() =>
      plan.side === 'buy'
        ? svc.executeBuy(plan.user_id, plan.token, plan.amount, { source: 'dca' })
        : svc.executeSell(plan.user_id, plan.token, 100, { source: 'dca', amountRaw: plan.amount }),
    );
    if (outcome.status === 'busy') continue;

    const next = Date.now() + plan.interval_sec * 1000;
    if (outcome.status === 'ok') {
      const runsDone = plan.runs_done + 1;
      const done = runsDone >= plan.runs_total;
      automation.updateDca(plan.id, { runs_done: runsDone, next_at: next, failures: 0, ...(done && { status: 'done' }) });
      await notify(
        plan.user_id,
        `${title}: run ${runsDone}/${plan.runs_total} done${done ? ' — plan complete ✅' : ''}.\n` +
          `🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>`,
      );
      continue;
    }
    const failures = plan.failures + 1;
    const failed = failures >= MAX_ATTEMPTS;
    automation.updateDca(plan.id, { failures, next_at: next, error: outcome.message, ...(failed && { status: 'failed' }) });
    if (outcome.status === 'error') logger.warn({ id: plan.id, err: outcome.err.message }, 'DCA run error');
    await notify(
      plan.user_id,
      failed
        ? `❌ ${title} stopped after ${failures} failed runs: ${esc(outcome.message)}`
        : `⚠️ ${title}: run skipped (${esc(outcome.message)}). Retrying at the next interval.`,
    );
  }
}

module.exports = { run };
