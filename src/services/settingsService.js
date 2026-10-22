const { db } = require('../db');
const { config, feeBpsFor } = require('../config');
const { getChain } = require('../config/chains');

// Per-user trading settings, stored as JSON on users.settings. Missing fields fall back to these defaults.
// The top-level trade fields are the buy side; `sell` holds the sell side's own values (any field left
// out there follows the buy side). SIDE_FIELDS lists what can differ between the two.
const SIDE_FIELDS = ['slippageBps', 'mevProtect', 'priorityMaxLamports', 'jitoTipLamports', 'gasBoostPct', 'maxImpactPct'];

const DEFAULTS = () => ({
  mevProtect: true, // Solana: Jito bundle; Ethereum/BSC: private RPC
  confirmTrades: true, // false = buy/sell buttons execute immediately
  slippageBps: { sol: config.jupiter.slippageBps, evm: config.evm.slippageBps },
  priorityMaxLamports: config.jupiter.priorityFeeMaxLamports, // Solana, used when MEV protection is off
  jitoTipLamports: config.jito.tipLamports, // Solana, used when MEV protection is on
  gasBoostPct: 0, // EVM: extra % on top of the suggested priority fee
  maxImpactPct: 0, // refuse trades whose price impact is above this %, 0 = no limit
  sell: {}, // sell-side overrides of SIDE_FIELDS
  antiRug: true, // sell a position automatically when its value suddenly collapses
  antiRugDropPct: 60, // ... by at least this much between two checks (~20 s apart)
  buyPresets: {}, // { [chainKey]: ['0.1', ...] }, overrides chain defaults
  sellPresets: [25, 50, 100],
  tradeWallets: {}, // { sol: [walletId, ...], evm: [...] }: wallets the bot's buy/sell buttons trade from (default: active)
});

// Allowed ranges, also used to validate user input
const LIMITS = {
  slippagePct: { sol: [0.1, 50], evm: [0.1, 20] }, // KyberSwap caps slippage at 20%
  priorityMaxSol: [0, 0.1],
  jitoTipSol: [0.000001, 0.1], // Jito minimum tip is 1000 lamports
  gasBoostPct: [0, 200],
  maxImpactPct: [0, 99], // 0 = off
  antiRugDropPct: [20, 95],
  buyPresets: 5,
  sellPresets: 4,
};
const GAS_BOOST_STEPS = [0, 10, 25, 50, 100];

function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

function read(userId) {
  const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(userId);
  try {
    return row ? JSON.parse(row.settings) : {};
  } catch {
    return {};
  }
}

const get = (userId) => merge(DEFAULTS(), read(userId));

// Shallow-merges a patch into the stored settings (nested objects are merged one level deep)
function update(userId, patch) {
  const stored = merge(read(userId), patch);
  // The sell side is replaced as a whole, so clearing a field makes it follow the buy side again
  if ('sell' in patch) stored.sell = patch.sell || {};
  db.prepare(
    `INSERT INTO users (id, settings, created_at) VALUES (?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings`,
  ).run(userId, JSON.stringify(stored), Date.now());
  return get(userId);
}

function reset(userId) {
  db.prepare("UPDATE users SET settings = '{}' WHERE id = ?").run(userId);
  return get(userId);
}

const buyPresets = (settings, chain) => settings.buyPresets[chain.key] || chain.buyPresets;

// The settings one side trades with: the buy side, or the buy side with the sell overrides on top
function sideSettings(settings, side = 'buy') {
  if (side !== 'sell') return settings;
  const sell = settings.sell || {};
  const out = { ...settings };
  for (const key of SIDE_FIELDS) {
    if (sell[key] == null) continue;
    out[key] = key === 'slippageBps' ? { ...settings.slippageBps, ...sell.slippageBps } : sell[key];
  }
  return out;
}

// Everything a trade on `chain` needs from the user's settings, plus the fee for this trade source
function tradeOptions(userId, chainOrKey, source = 'manual', side = 'buy') {
  const chain = typeof chainOrKey === 'string' ? getChain(chainOrKey) : chainOrKey;
  const s = sideSettings(get(userId), side);
  return {
    source,
    side,
    feeBps: feeBpsFor(chain.kind, source),
    slippageBps: s.slippageBps[chain.kind],
    mevProtect: s.mevProtect,
    priorityMaxLamports: s.priorityMaxLamports,
    jitoTipLamports: s.jitoTipLamports,
    gasBoostPct: s.gasBoostPct,
    maxImpactPct: s.maxImpactPct || 0,
  };
}

// The price impact limit guards buys from every source and manual sells. Automated sells (stop loss,
// anti-rug, DCA, copy) still go through: blocking them could trap a user in a collapsing token.
function checkImpact(quote, opts) {
  const max = opts.maxImpactPct;
  if (!max || quote.priceImpactPct == null || quote.priceImpactPct <= max) return;
  if (opts.side === 'sell' && opts.source !== 'manual') return;
  const { UserError } = require('./tradeCommon');
  throw new UserError(`Price impact ${quote.priceImpactPct.toFixed(2)}% is above your ${max}% limit. Trade less, or raise the limit in settings.`);
}

module.exports = { get, update, reset, buyPresets, sideSettings, tradeOptions, checkImpact, SIDE_FIELDS, LIMITS, GAS_BOOST_STEPS };
