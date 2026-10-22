const { db } = require('../db');
const { config } = require('../config');
const { allChains } = require('../config/chains');
const markets = require('./markets');
const logger = require('../utils/logger');

// Public fee & pool dashboard for ApeX Pro. Aggregates only, never anything per user:
// fees and volume per chain, referral share, holder pool, distributions, claims, and the treasury /
// rewards wallets with their live balances so anyone can check them on an explorer.

const CACHE_MS = 60_000;
const DAY_MS = 86_400_000;
let cache = null;

const big = (v) => BigInt(v ?? 0);
const sumRaw = (rows) => rows.reduce((t, r) => t + big(r.amount), 0n);

function tradeTotals(chain, since) {
  const sol = chain.kind === 'sol';
  return db
    .prepare(
      `SELECT COUNT(*) AS trades, COUNT(DISTINCT user_id) AS traders,
              COALESCE(SUM(${sol ? 'sol_volume' : 'volume_usd'}), 0) AS volume,
              COALESCE(SUM(${sol ? 'fee_sol' : 'fee_usd'}), 0) AS fees
       FROM trades WHERE chain = ? AND at >= ?`,
    )
    .get(chain.key, since);
}

async function build() {
  const rewards = require('./rewardsService'); // lazy: rewardsService → markets → trade services
  const now = Date.now();
  const pools = rewards.pools();
  const chains = [];
  for (const chain of allChains().filter((c) => c.tradable)) {
    const referral = sumRaw(db.prepare("SELECT amount FROM rewards WHERE chain = ? AND kind = 'referral'").all(chain.key));
    const distributed = sumRaw(db.prepare('SELECT amount FROM epochs WHERE chain = ?').all(chain.key));
    const claimed = sumRaw(db.prepare("SELECT amount FROM claims WHERE chain = ? AND kind = 'native' AND status = 'sent'").all(chain.key));
    const treasury = chain.kind === 'sol' ? config.revenue.treasury || null : config.evm.treasury || null;
    const rewardsWallet = rewards.rewardsAddress(chain.kind);
    const svc = markets.serviceFor(chain);
    const [treasuryBalance, rewardsBalance] = await Promise.all([
      treasury ? svc.getNativeBalance(treasury).catch(() => null) : null,
      rewardsWallet ? svc.getNativeBalance(rewardsWallet).catch(() => null) : null,
    ]);
    chains.push({
      chain: chain.key,
      feeUnit: chain.kind === 'sol' ? 'SOL' : 'USD',
      day: tradeTotals(chain, now - DAY_MS),
      month: tradeTotals(chain, now - 30 * DAY_MS),
      all: tradeTotals(chain, 0),
      referral,
      pool: pools[chain.key] || 0n,
      distributed,
      claimed,
      treasury,
      treasuryBalance,
      rewardsWallet,
      rewardsBalance,
    });
  }
  const usd = (sql) => db.prepare(sql).get().v;
  return {
    at: now,
    fees: config.fees,
    split: { referralBps: config.referral.shareBps, holderBps: config.revenue.revenueShareBps, cashbackMultiplier: config.apex.cashbackMultiplier },
    epochHours: config.revenue.epochHours,
    nextEpochAt: rewards.nextEpochAt(),
    apexLive: Boolean(rewards.apexToken()),
    minHold: config.apex.minHold,
    cashback: {
      earnedUsd: usd("SELECT COALESCE(SUM(usd), 0) AS v FROM rewards WHERE kind = 'cashback'"),
      claimedUsd: usd("SELECT COALESCE(SUM(usd), 0) AS v FROM claims WHERE kind = 'cashback' AND status = 'sent'"),
    },
    chains,
    epochs: db.prepare('SELECT chain, amount, holders, at FROM epochs ORDER BY id DESC LIMIT 20').all(),
  };
}

async function overview() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const value = await build();
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    logger.error({ err: err.message }, 'Transparency overview failed');
    if (cache) return cache.value;
    throw err;
  }
}

module.exports = { overview };
