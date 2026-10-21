const { PublicKey } = require('@solana/web3.js');
const { formatUnits } = require('ethers');
const connection = require('./connection');
const { getProvider } = require('./evm/provider');
const { withTimeout } = require('./tradeCommon');
const { evmChains } = require('../config/chains');
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

// Current gas price per EVM chain in gwei (null when the RPC doesn't answer)
async function getEvmGasPrices() {
  return Promise.all(
    evmChains().map(async (chain) => {
      try {
        const fee = await withTimeout(getProvider(chain).getFeeData(), 5_000);
        return { chain, gwei: Number(formatUnits(fee.gasPrice ?? 0n, 'gwei')) };
      } catch {
        return { chain, gwei: null };
      }
    }),
  );
}

module.exports = { getGasInfo, getEvmGasPrices };
