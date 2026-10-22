const pumpFeed = require('../services/pumpFeed');
const pumpService = require('../services/pumpService');
const automation = require('../services/automationService');
const safetyService = require('../services/safetyService');
const walletService = require('../services/walletService');
const tradeService = require('../services/tradeService');
const { CHAINS, txLink } = require('../config/chains');
const { shortAddress } = require('../utils/format');
const { attempt, MAX_ATTEMPTS, esc } = require('./common');
const logger = require('../utils/logger');

// pump.fun sniper. Feed events (pumpFeed) reserve a buy per matching rule and are bought right away;
// this job's tick keeps the feed open while it's needed and retries buys still waiting for a route.

const chain = CHAINS.sol;
const ROUTE_WAIT_MS = 90_000; // Jupiter usually routes a new pump.fun token within 2–5 s
const RETRY_MS = 3_000; // between checks of one token (Jupiter's free tier rate-limits bursts)

const jobs = new Map(); // `${ruleId}:${mint}` → { rule, mint, symbol, seenAt, attempts, busy }
let notify = async () => {};
let started = false;
let prunedAt = 0;

function enqueue(rule, mint, symbol) {
  if (!pumpService.reserveBuy(rule, mint, symbol)) return;
  const job = { rule, mint, symbol, seenAt: Date.now(), triedAt: 0, attempts: 0, busy: false };
  jobs.set(`${rule.id}:${mint}`, job);
  buy(job);
}

function onCreate(token) {
  for (const rule of pumpService.activeRules('launch')) {
    if (pumpService.matchesLaunch(rule, token)) enqueue(rule, token.mint, token.symbol);
  }
}

function onMigrate({ mint }) {
  for (const rule of pumpService.activeRules('migration')) enqueue(rule, mint, null);
}

function done(job, status, fields = {}) {
  jobs.delete(`${job.rule.id}:${job.mint}`);
  pumpService.finishBuy(job.rule, job.mint, status, fields);
}

const title = (job, symbol) =>
  `💊 pump.fun ${job.rule.mode === 'launch' ? 'launch' : 'migration'} snipe ${symbol ? `$${esc(symbol)}` : `<code>${shortAddress(job.mint, 6)}</code>`}`;

async function buy(job) {
  if (job.busy || Date.now() - job.triedAt < RETRY_MS) return;
  job.busy = true;
  job.triedAt = Date.now();
  try {
    const rule = pumpService.getRule(job.rule.user_id, job.rule.id);
    if (!rule?.active) return done(job, 'skipped', { error: 'Rule stopped' });
    const wallet = walletService.getWallet(rule.user_id, 'sol');
    if (!wallet) return done(job, 'skipped', { error: 'No Solana wallet' });

    // Not routable yet: wait (not counted as a failed try) until the window closes
    if ((await pumpService.pumpStage(job.mint)) === 'none') {
      if (Date.now() - job.seenAt > ROUTE_WAIT_MS) done(job, 'failed', { error: 'No trading route appeared' });
      return;
    }

    const token = await tradeService.getTokenInfo(job.mint, wallet.address);
    job.symbol = token.symbol || job.symbol;
    if (rule.safety) {
      const scan = await safetyService.scan(chain, token);
      if (scan.issues.length) return done(job, 'skipped', { error: scan.issues.join('; ') });
    }

    const outcome = await attempt(() => tradeService.executeBuy(rule.user_id, job.mint, rule.amount, { source: 'snipe' }));
    if (outcome.status === 'busy') return;
    if (outcome.status === 'ok') {
      done(job, 'bought', { signature: outcome.result.signature });
      const left = rule.max_buys - rule.buys_done - 1;
      await notify(
        rule.user_id,
        `✅ ${title(job, job.symbol)}: bought for ${esc(rule.amount)} SOL!\n` +
          `🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>\n` +
          (left > 0 ? `<i>${left} buy${left === 1 ? '' : 's'} left on this rule.</i>` : '<i>Rule finished: all its buys are used.</i>'),
      );
      return;
    }
    // An empty wallet would fail every launch: stop the rule once instead of failing each token
    if (outcome.status === 'user' && /^Not enough SOL/.test(outcome.message)) {
      done(job, 'failed', { error: outcome.message });
      if (pumpService.stopRule(rule.user_id, rule.id)) {
        await notify(rule.user_id, `⏹ ${title(job, job.symbol)}: rule stopped, your wallet is out of SOL.
${esc(outcome.message)}
Top up and arm it again in /pump.`);
      }
      return;
    }
    job.attempts++;
    if (outcome.status === 'error') logger.warn({ rule: rule.id, mint: job.mint, err: outcome.err.message }, 'pump.fun snipe error');
    if (job.attempts >= MAX_ATTEMPTS) {
      done(job, 'failed', { error: outcome.message });
      // Launch rules see many tokens: their failures stay in the Recent list instead of a message each
      if (rule.mode === 'migration') await notify(rule.user_id, `❌ ${title(job, job.symbol)} failed after ${job.attempts} tries: ${esc(outcome.message)}`);
    }
  } catch (err) {
    // Network / RPC trouble before the buy: retried on the next tick (rate limits aren't counted)
    if (err.response?.status === 429) return;
    job.attempts++;
    logger.debug({ mint: job.mint, err: err.message }, 'pump.fun snipe check failed');
    if (job.attempts >= MAX_ATTEMPTS * 2) done(job, 'failed', { error: err.message });
  } finally {
    job.busy = false;
  }
}

function start(notifier) {
  notify = notifier;
  started = true;
  pumpService.resetPending();
  pumpFeed.events.on('create', onCreate);
  pumpFeed.events.on('migrate', onMigrate);
}

async function run(notifier) {
  if (!started) start(notifier);
  if (Date.now() - prunedAt > 60 * 60_000) {
    prunedAt = Date.now();
    pumpService.prune();
  }
  pumpFeed.setWanted(pumpService.anyActive() || automation.waitingSnipes().some((s) => s.trigger === 'migration'));
  await Promise.all([...jobs.values()].map(buy));
}

// Close the feed when the workers stop
const stop = () => pumpFeed.close();

module.exports = { run, stop };
