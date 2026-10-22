const { JsonRpcProvider, Network } = require('ethers');

// One JSON-RPC provider per EVM chain. staticNetwork skips chain-id detection on every request.
// ethers batches parallel calls (up to 100 per request by default); free RPC tiers reject big batches
// (dRPC, used for Robinhood: "Batch of more than 3 requests are not allowed on free plan").
const BATCH_MAX = 3;
const providers = new Map();

function getProvider(chain) {
  if (!providers.has(chain.key)) {
    const network = Network.from(chain.chainId);
    providers.set(chain.key, new JsonRpcProvider(chain.rpcUrl, network, { staticNetwork: network, batchMaxCount: BATCH_MAX }));
  }
  return providers.get(chain.key);
}

module.exports = { getProvider };
