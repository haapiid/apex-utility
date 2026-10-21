const { JsonRpcProvider, Network } = require('ethers');

// One JSON-RPC provider per EVM chain. staticNetwork skips chain-id detection on every request.
const providers = new Map();

function getProvider(chain) {
  if (!providers.has(chain.key)) {
    const network = Network.from(chain.chainId);
    providers.set(chain.key, new JsonRpcProvider(chain.rpcUrl, network, { staticNetwork: network }));
  }
  return providers.get(chain.key);
}

module.exports = { getProvider };
