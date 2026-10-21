const markets = require('./markets');
const positionService = require('./positionService');
const walletService = require('./walletService');
const solanaTrade = require('./tradeService');
const { getChain } = require('../config/chains');
const logger = require('../utils/logger');

const MAX_ROWS = 10;
// Quote a few tokens at a time: free Jupiter/KyberSwap tiers rate-limit bursts
const CONCURRENCY = 3;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Open positions of the user's active wallets, valued at the current sell price.
 * Tracked positions (bought through ApeX) have a cost basis; other Solana tokens found in the wallet are
 * listed without one. Cost is scaled down if the wallet now holds fewer tokens than we tracked.
 * Row: { chain, token, symbol, decimals, balance, value, cost, realized, pnl, pnlPct } (raw bigints; pnl null if unknown)
 */
async function getPortfolio(userId) {
  const wallets = walletService.getWallets(userId);
  const tracked = [];
  for (const wallet of [wallets.sol, wallets.evm].filter(Boolean)) {
    for (const p of positionService.listOpen(wallet.id)) tracked.push({ ...p, owner: wallet.address });
  }

  // Solana tokens held but not traded through ApeX
  let extra = [];
  if (wallets.sol) {
    const known = new Set(tracked.filter((p) => p.chain === 'sol').map((p) => p.token));
    try {
      extra = (await solanaTrade.listHoldings(wallets.sol.address))
        .filter((h) => !known.has(h.address))
        .map((h) => ({ chain: 'sol', token: h.address, owner: wallets.sol.address, cost: null, realized: 0n }));
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to list Solana holdings');
    }
  }

  const candidates = [...tracked, ...extra].slice(0, MAX_ROWS);
  const rows = await mapLimit(candidates, CONCURRENCY, async (p) => {
    const chain = getChain(p.chain);
    const svc = markets.serviceFor(chain);
    try {
      const token = await svc.getTokenInfo(p.token, p.owner);
      if (token.balance === 0n) return null;
      const value = await svc.quoteValue(token).catch(() => null);
      let cost = p.cost;
      if (cost != null && p.amount > 0n && token.balance < p.amount) cost = (cost * token.balance) / p.amount;
      const pnl = cost != null && value != null ? value - cost : null;
      return {
        chain,
        token: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        balance: token.balance,
        value,
        cost,
        realized: p.realized,
        pnl,
        pnlPct: pnl != null && cost > 0n ? (Number(pnl) / Number(cost)) * 100 : null,
      };
    } catch (err) {
      logger.debug({ err: err.message, token: p.token }, 'Portfolio row failed');
      return null;
    }
  });
  return { wallets, rows: rows.filter(Boolean), truncated: tracked.length + extra.length > MAX_ROWS };
}

module.exports = { getPortfolio };
