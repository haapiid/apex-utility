const axios = require('axios');
const { config } = require('../config');

// Raw Solana JSON-RPC for reads that @solana/web3.js v1 can't decode: it rejects version-1
// transactions ("Transaction version (1) is not supported"), which are common now. jsonParsed
// keeps the shape the callers expect (accountKeys with pubkey/signer, token balances with owner).
// Heavy calls are paced and retried on 429, public RPCs limit them per method.

const api = axios.create({ timeout: 15_000 });
const HEAVY = new Set(['getTransaction', 'getTokenLargestAccounts', 'getSignaturesForAddress']);
const HEAVY_GAP_MS = 250;
let heavyChain = Promise.resolve();
let heavyLast = 0;

class RpcError extends Error {}

async function send(method, params, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const { data } = await api.post(config.chain.rpcUrl, { jsonrpc: '2.0', id: 1, method, params });
      if (data.error) {
        if (data.error.code === 429 && i < tries) throw Object.assign(new Error('429'), { retry: true });
        throw new RpcError(`${method}: ${data.error.message}`);
      }
      return data.result;
    } catch (err) {
      const limited = err.retry || err.response?.status === 429;
      if (!limited || i >= tries) throw limited ? new RpcError(`${method}: rate limited by the Solana RPC`) : err;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

function call(method, params) {
  if (!HEAVY.has(method)) return send(method, params);
  const run = async () => {
    const wait = heavyLast + HEAVY_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    heavyLast = Date.now();
    return send(method, params);
  };
  const result = heavyChain.then(run, run);
  heavyChain = result.catch(() => {});
  return result;
}

const getTransaction = (signature) =>
  call('getTransaction', [signature, { maxSupportedTransactionVersion: 1, encoding: 'jsonParsed', commitment: 'confirmed' }]);

const getSignatures = (address, opts = {}) => call('getSignaturesForAddress', [address, { limit: 1000, ...opts }]);

module.exports = { call, getTransaction, getSignatures, RpcError };
