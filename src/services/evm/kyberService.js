const axios = require('axios');
const { config } = require('../../config');

// KyberSwap aggregator: best route across the DEXs of each EVM chain (Uniswap, PancakeSwap, Aerodrome, ...)
const api = axios.create({
  baseURL: config.evm.kyberApiUrl,
  timeout: 10_000,
  headers: { 'x-client-id': config.evm.kyberClientId },
});

// Bursts get rate-limited (HTTP 429): retry a couple of times with backoff
const MAX_RETRIES = 2;
api.interceptors.response.use(null, async (err) => {
  const cfg = err.config;
  if (err.response?.status !== 429 || !cfg || (cfg.retryCount ?? 0) >= MAX_RETRIES) throw err;
  cfg.retryCount = (cfg.retryCount ?? 0) + 1;
  await new Promise((r) => setTimeout(r, 1000 * cfg.retryCount));
  return api.request(cfg);
});

class NoRouteError extends Error {}

// KyberSwap error codes meaning "this pair can't be swapped right now"
const NO_ROUTE_CODES = new Set([4008, 4010, 4011]);

/**
 * fee: { bps, chargeBy: 'currency_in' | 'currency_out', receiver } or null.
 * The fee is taken inside the swap: with currency_in the user still sends amountIn
 * (the fee comes out of it); with currency_out the returned amountOut is already net of it.
 */
async function getRoute(chain, { tokenIn, tokenOut, amountIn, fee, origin }) {
  const params = { tokenIn, tokenOut, amountIn: amountIn.toString() };
  if (origin) params.origin = origin;
  if (fee) Object.assign(params, { feeAmount: fee.bps, isInBps: true, chargeFeeBy: fee.chargeBy, feeReceiver: fee.receiver });
  try {
    const { data } = await api.get(`/${chain.kyber}/api/v1/routes`, { params });
    return data.data; // { routeSummary, routerAddress }
  } catch (err) {
    if (NO_ROUTE_CODES.has(err.response?.data?.code)) throw new NoRouteError(err.response.data.message || 'No route');
    throw err;
  }
}

// Encodes the route into calldata for the router: { data, routerAddress, transactionValue, amountOut, ... }
async function buildRoute(chain, { routeSummary, sender, slippageBps }) {
  const { data } = await api.post(`/${chain.kyber}/api/v1/route/build`, {
    routeSummary,
    sender,
    recipient: sender,
    origin: sender,
    slippageTolerance: slippageBps,
    source: config.evm.kyberClientId,
  });
  return data.data;
}

module.exports = { getRoute, buildRoute, NoRouteError };
