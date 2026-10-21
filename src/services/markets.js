const solanaTrade = require('./tradeService');
const evmTrade = require('./evm/evmTradeService');
const { getProvider } = require('./evm/provider');
const { withTimeout } = require('./tradeCommon');
const { evmChains } = require('../config/chains');

// The trade service for a chain. Both kinds share one interface (see tradeService.js).
const serviceFor = (chain) => (chain.kind === 'sol' ? solanaTrade : evmTrade.forChain(chain));

const routerName = (chain) => (chain.kind === 'sol' ? 'Jupiter' : 'KyberSwap');

// How MEV protection works on this chain (shown to users)
function mevLabel(chain) {
  if (chain.kind === 'sol') return 'Jito';
  return chain.protectRpcUrl ? 'private RPC' : 'sequencer, no public mempool';
}

// A 0x address can be a contract on several chains: find every tradable chain where it has code
const DETECT_TIMEOUT_MS = 5_000;
const DETECT_CACHE_MS = 10 * 60_000;
const detectCache = new Map();

async function detectEvmChains(address) {
  const key = address.toLowerCase();
  const cached = detectCache.get(key);
  if (cached && Date.now() - cached.at < DETECT_CACHE_MS) return cached.chains;

  const chains = evmChains();
  const codes = await Promise.all(
    chains.map((c) => withTimeout(getProvider(c).getCode(address), DETECT_TIMEOUT_MS).catch(() => '0x')),
  );
  const found = chains.filter((_, i) => codes[i] !== '0x');
  if (found.length) detectCache.set(key, { chains: found, at: Date.now() });
  return found;
}

module.exports = { serviceFor, routerName, mevLabel, detectEvmChains };
