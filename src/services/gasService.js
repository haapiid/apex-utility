const { PublicKey } = require('@solana/web3.js');
const connection = require('./connection');
const { BASE_TX_FEE_LAMPORTS, ESTIMATED_SWAP_COMPUTE_UNITS } = require('../config/solana');
const { lamportsToSol } = require('../utils/format');
const { getSolPriceUsd } = require('./priceService');

// Busiest writable account on Solana DEXs (Raydium SOL-USDC pool): a good proxy for swap competition
const HOT_ACCOUNT = new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

// Solana "gas": base fee + priority fee (micro-lamports per compute unit)
async function getGasInfo() {
  const [slot, recentFees, solPrice] = await Promise.all([
    connection.getSlot(),
    // Fees paid by recent swaps on a busy pool (unfiltered results are almost always 0)
    connection.getRecentPrioritizationFees({ lockedWritableAccounts: [HOT_ACCOUNT] }),
    getSolPriceUsd(),
  ]);

  const fees = recentFees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
  const levels = { low: percentile(fees, 25), medium: percentile(fees, 50), high: percentile(fees, 75) };

  const swapCost = (microLamportsPerCu) =>
    BASE_TX_FEE_LAMPORTS + BigInt(Math.ceil((microLamportsPerCu * ESTIMATED_SWAP_COMPUTE_UNITS) / 1_000_000));
  const swapCostLamports = swapCost(levels.high);
  const swapCostSol = Number(lamportsToSol(swapCostLamports));

  return {
    slot,
    levels,
    swapCostLamports,
    swapCostSol,
    swapCostUsd: solPrice ? swapCostSol * solPrice : null,
    solPrice,
  };
}

module.exports = { getGasInfo };
