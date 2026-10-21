const axios = require('axios');
const { config } = require('../config');

// Jupiter aggregator: best route across Solana DEXs (Raydium, Orca, Meteora, pump.fun AMMs, ...)
const api = axios.create({ baseURL: config.jupiter.apiUrl, timeout: 10_000 });

// The free tier rate-limits bursts (HTTP 429): retry a couple of times with backoff
const MAX_RETRIES = 2;
api.interceptors.response.use(null, async (err) => {
  const cfg = err.config;
  if (err.response?.status !== 429 || !cfg || (cfg.retryCount ?? 0) >= MAX_RETRIES) throw err;
  cfg.retryCount = (cfg.retryCount ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 1000 * cfg.retryCount));
  return api.request(cfg);
});

class NoRouteError extends Error {}

// platformFeeBps > 0 makes Jupiter take our fee inside the swap (needs a feeAccount when building it)
async function getQuote({ inputMint, outputMint, amount, slippageBps = config.jupiter.slippageBps, platformFeeBps = 0 }) {
  try {
    const params = { inputMint, outputMint, amount: amount.toString(), slippageBps };
    if (platformFeeBps > 0) params.platformFeeBps = platformFeeBps;
    const { data } = await api.get('/swap/v1/quote', { params });
    return data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 404) throw new NoRouteError(err.response?.data?.error || 'No route');
    throw err;
  }
}

/**
 * Returns a base64 serialized VersionedTransaction, ready to sign.
 *   feeAccount       token account receiving the platform fee (input or output mint of the swap)
 *   jitoTipLamports  adds a tip to a Jito tip account (for sending through Jito); otherwise a priority fee
 */
async function buildSwapTransaction(quoteResponse, userPublicKey, { feeAccount, jitoTipLamports, priorityMaxLamports } = {}) {
  const { data } = await api.post('/swap/v1/swap', {
    quoteResponse,
    userPublicKey,
    ...(feeAccount && { feeAccount }),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: jitoTipLamports
      ? { jitoTipLamports }
      : {
          priorityLevelWithMaxLamports: {
            maxLamports: priorityMaxLamports ?? config.jupiter.priorityFeeMaxLamports,
            priorityLevel: 'veryHigh',
          },
        },
  });
  return data;
}

async function searchToken(mint) {
  const { data } = await api.get('/tokens/v2/search', { params: { query: mint } });
  return Array.isArray(data) ? data.find((t) => t.id === mint) || null : null;
}

module.exports = { api, getQuote, buildSwapTransaction, searchToken, NoRouteError };
