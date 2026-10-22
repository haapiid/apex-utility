const { db } = require('../db');
const jupiter = require('./jupiterService');
const walletService = require('./walletService');
const { UserError } = require('./tradeCommon');
const { SOL_MINT } = require('../config/solana');
const { toUnits } = require('../utils/format');

// pump.fun sniper rules (data + validation). src/workers/pump.js runs them from the pumpFeed events.
//   launch     buy every new pump.fun token that passes the rule's filters
//   migration  buy every token the moment it migrates from the bonding curve to PumpSwap

const MODES = ['launch', 'migration'];
const MAX_RULES = 5;
const MAX_BUYS = 100;
const SOL_DECIMALS = 9;

// Jupiter labels the bonding curve "Pump.fun" and the post-migration pool "Pump.fun Amm"
const CURVE_LABEL = 'Pump.fun';

/** 'none' (no route yet) | 'curve' (still on the bonding curve) | 'migrated' (trades elsewhere) */
async function pumpStage(mint) {
  try {
    const quote = await jupiter.getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: 10_000_000n, slippageBps: 5000 });
    return quote.routePlan?.some((p) => p.swapInfo?.label === CURVE_LABEL) ? 'curve' : 'migrated';
  } catch (err) {
    if (err instanceof jupiter.NoRouteError) return 'none';
    throw err;
  }
}

function parseSol(amount) {
  try {
    if (toUnits(amount, SOL_DECIMALS) <= 0n) throw new Error();
  } catch {
    throw new UserError('Invalid SOL amount.');
  }
  return String(amount).trim();
}

/** opts: { maxBuys, keyword, maxDevPct, safety } */
function createRule(userId, mode, amount, opts = {}) {
  if (!MODES.includes(mode)) throw new UserError('Mode must be launch or migration.');
  if (!walletService.getWallet(userId, 'sol')) throw new UserError('Create a Solana wallet first in /wallet.');
  const count = db.prepare('SELECT COUNT(*) AS n FROM pump_rules WHERE user_id = ? AND active = 1').get(userId).n;
  if (count >= MAX_RULES) throw new UserError(`You can have up to ${MAX_RULES} active pump.fun rules.`);
  const sol = parseSol(amount);
  const maxBuys = Number(opts.maxBuys ?? 5);
  if (!Number.isInteger(maxBuys) || maxBuys < 1 || maxBuys > MAX_BUYS) throw new UserError(`Max buys must be a whole number from 1 to ${MAX_BUYS}.`);

  let keyword = null;
  let maxDevPct = null;
  if (mode === 'launch') {
    keyword = String(opts.keyword ?? '').trim().toLowerCase().slice(0, 32) || null;
    if (opts.maxDevPct != null && opts.maxDevPct !== '') {
      maxDevPct = Number(String(opts.maxDevPct).replace('%', ''));
      if (!Number.isFinite(maxDevPct) || maxDevPct < 0 || maxDevPct > 100) throw new UserError('Max dev buy must be between 0 and 100%.');
    }
  }

  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO pump_rules (user_id, mode, amount, max_buys, keyword, max_dev_pct, safety, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, mode, sol, maxBuys, keyword, maxDevPct, opts.safety === false ? 0 : 1, now, now);
  return getRule(userId, Number(lastInsertRowid));
}

const getRule = (userId, id) => db.prepare('SELECT * FROM pump_rules WHERE id = ? AND user_id = ?').get(id, userId) || null;
const listRules = (userId) => db.prepare('SELECT * FROM pump_rules WHERE user_id = ? AND active = 1 ORDER BY id').all(userId);
const activeRules = (mode) => db.prepare('SELECT * FROM pump_rules WHERE active = 1 AND mode = ? ORDER BY id').all(mode);
const anyActive = () => Boolean(db.prepare('SELECT 1 FROM pump_rules WHERE active = 1 LIMIT 1').get());

const stopRule = (userId, id) =>
  db.prepare('UPDATE pump_rules SET active = 0, updated_at = ? WHERE id = ? AND user_id = ? AND active = 1').run(Date.now(), id, userId).changes > 0;

// Does a new token pass a launch rule's filters?
function matchesLaunch(rule, token) {
  if (rule.keyword && !`${token.name} ${token.symbol}`.toLowerCase().includes(rule.keyword)) return false;
  if (rule.max_dev_pct != null && token.devBuyPct > rule.max_dev_pct) return false;
  return true;
}

// Claims one buy of the rule's budget for this mint; false when the rule is used up or the user
// already buys this mint through another rule
function reserveBuy(rule, mint, symbol) {
  const now = Date.now();
  const used = db.prepare("SELECT COUNT(*) AS n FROM pump_buys WHERE rule_id = ? AND status IN ('pending', 'bought')").get(rule.id).n;
  if (used >= rule.max_buys) return false;
  const taken = db.prepare("SELECT 1 FROM pump_buys WHERE user_id = ? AND mint = ? AND status IN ('pending', 'bought')").get(rule.user_id, mint);
  if (taken) return false;
  return (
    db.prepare("INSERT OR IGNORE INTO pump_buys (rule_id, user_id, mint, symbol, status, at) VALUES (?, ?, ?, ?, 'pending', ?)")
      .run(rule.id, rule.user_id, mint, symbol || null, now).changes > 0
  );
}

function finishBuy(rule, mint, status, fields = {}) {
  db.prepare('UPDATE pump_buys SET status = ?, signature = ?, error = ?, at = ? WHERE rule_id = ? AND mint = ?').run(
    status,
    fields.signature ?? null,
    fields.error ?? null,
    Date.now(),
    rule.id,
    mint,
  );
  if (status !== 'bought') return;
  db.prepare('UPDATE pump_rules SET buys_done = buys_done + 1, updated_at = ? WHERE id = ?').run(Date.now(), rule.id);
  db.prepare('UPDATE pump_rules SET active = 0 WHERE id = ? AND buys_done >= max_buys').run(rule.id);
}

const recentBuys = (userId, limit = 10) =>
  db.prepare("SELECT * FROM pump_buys WHERE user_id = ? AND status != 'pending' ORDER BY at DESC LIMIT ?").all(userId, limit);

// Skipped / failed launches pile up fast with broad rules: keep three days
const prune = () => db.prepare("DELETE FROM pump_buys WHERE status IN ('skipped', 'failed') AND at < ?").run(Date.now() - 3 * 24 * 60 * 60_000);

// After a restart, buys left pending never finished: don't count them against the budget
const resetPending = () => db.prepare("UPDATE pump_buys SET status = 'failed', error = 'Interrupted by a restart' WHERE status = 'pending'").run();

module.exports = {
  MODES,
  pumpStage,
  createRule,
  getRule,
  listRules,
  activeRules,
  anyActive,
  stopRule,
  matchesLaunch,
  reserveBuy,
  finishBuy,
  recentBuys,
  resetPending,
  prune,
};
