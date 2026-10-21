const { config } = require('./index');

// KyberSwap's placeholder for the chain's native coin (ETH, BNB, HYPE, ...)
const EVM_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ETH_PRESETS = ['0.01', '0.025', '0.05', '0.1', '0.25'];

function evm({ rpcEnv, rpc, protectRpc = null, buyPresets = ETH_PRESETS, aliases = [], l1FeeBuffer = 0n, claimMin = '0.001', ...chain }) {
  return {
    ...chain,
    kind: 'evm',
    decimals: 18,
    rpcUrl: process.env[rpcEnv] || rpc,
    // Private RPC that keeps transactions out of the public mempool (MEV protection), when the chain has one.
    // L2s here (Base, MegaETH, Robinhood, HyperEVM) order transactions through a sequencer without a public mempool.
    protectRpcUrl: process.env[`${rpcEnv.replace('_RPC_URL', '')}_PROTECT_RPC_URL`] || protectRpc,
    buyPresets,
    aliases,
    claimMin, // smallest reward claim, in native coin (the rewards wallet pays the gas)
    // Extra native kept aside on OP-stack L2s, whose L1 data fee is charged on top of gas
    l1FeeBuffer,
    tradable: Boolean(chain.kyber),
  };
}

const L1_FEE_BUFFER = 20_000_000_000_000n; // 0.00002 ETH

// Order here is the order shown in the bot. `dexscreener` / `gecko` are the chain ids of the market
// data APIs used by ApeX Pro (DexScreener chainId, GeckoTerminal network).
const CHAINS = {
  sol: {
    key: 'sol',
    dexscreener: 'solana',
    gecko: 'solana',
    name: 'Solana',
    kind: 'sol',
    native: 'SOL',
    decimals: 9,
    explorer: config.chain.explorerUrl,
    buyPresets: ['0.1', '0.25', '0.5', '1', '2'],
    aliases: ['solana'],
    claimMin: '0.01',
    tradable: true,
  },
  eth: evm({
    key: 'eth',
    dexscreener: 'ethereum',
    gecko: 'eth',
    name: 'Ethereum',
    chainId: 1,
    kyber: 'ethereum',
    native: 'ETH',
    rpcEnv: 'ETH_RPC_URL',
    rpc: 'https://ethereum-rpc.publicnode.com',
    protectRpc: 'https://rpc.flashbots.net/fast', // Flashbots Protect: reverted txs are never included
    explorer: 'https://etherscan.io',
    aliases: ['ethereum'],
  }),
  bsc: evm({
    key: 'bsc',
    dexscreener: 'bsc',
    gecko: 'bsc',
    name: 'BSC',
    chainId: 56,
    kyber: 'bsc',
    native: 'BNB',
    rpcEnv: 'BSC_RPC_URL',
    rpc: 'https://bsc-rpc.publicnode.com',
    protectRpc: 'https://bscrpc.pancakeswap.finance', // PancakeSwap MEV Guard (bloXroute)
    explorer: 'https://bscscan.com',
    buyPresets: ['0.05', '0.1', '0.25', '0.5', '1'],
    aliases: ['bnb'],
    claimMin: '0.005',
  }),
  base: evm({
    key: 'base',
    dexscreener: 'base',
    gecko: 'base',
    name: 'Base',
    chainId: 8453,
    kyber: 'base',
    native: 'ETH',
    rpcEnv: 'BASE_RPC_URL',
    rpc: 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    l1FeeBuffer: L1_FEE_BUFFER,
  }),
  hyper: evm({
    key: 'hyper',
    dexscreener: 'hyperevm',
    gecko: 'hyperevm',
    name: 'HyperEVM',
    chainId: 999,
    kyber: 'hyperevm',
    native: 'HYPE',
    rpcEnv: 'HYPEREVM_RPC_URL',
    rpc: 'https://rpc.hyperliquid.xyz/evm',
    explorer: 'https://hyperevmscan.io',
    buyPresets: ['1', '2.5', '5', '10', '25'],
    aliases: ['hyperevm', 'hype'],
    claimMin: '0.1',
  }),
  mega: evm({
    key: 'mega',
    dexscreener: 'megaeth',
    gecko: 'megaeth',
    name: 'MegaETH',
    chainId: 4326,
    kyber: 'megaeth',
    native: 'ETH',
    rpcEnv: 'MEGAETH_RPC_URL',
    rpc: 'https://mainnet.megaeth.com/rpc',
    explorer: 'https://mega.etherscan.io',
    aliases: ['megaeth'],
    l1FeeBuffer: L1_FEE_BUFFER,
  }),
  hood: evm({
    key: 'hood',
    dexscreener: 'robinhood',
    gecko: 'robinhood',
    name: 'Robinhood',
    chainId: 4663,
    kyber: 'robinhood',
    native: 'ETH',
    rpcEnv: 'ROBINHOOD_RPC_URL',
    rpc: 'https://robinhood.drpc.org',
    explorer: 'https://robinhoodchain.blockscout.com',
    aliases: ['robinhood'],
  }),
  // No swap aggregator supports Stable yet: listed, but trading stays off until one does
  stable: evm({
    key: 'stable',
    dexscreener: 'stable',
    gecko: null,
    name: 'Stable',
    chainId: 988,
    kyber: null,
    native: 'USDT0',
    rpcEnv: 'STABLE_RPC_URL',
    rpc: 'https://rpc.stable.xyz',
    explorer: 'https://stablescan.xyz',
  }),
};

const allChains = () => Object.values(CHAINS);
const getChain = (key) => CHAINS[key] || null;
const evmChains = () => allChains().filter((c) => c.kind === 'evm' && c.tradable);

// Accepts a key ("base") or an alias ("ethereum", "bnb", ...)
function findChain(name) {
  const n = String(name || '').toLowerCase();
  return allChains().find((c) => c.key === n || c.aliases.includes(n)) || null;
}

const isEvmAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(String(value));
const txLink = (chain, hash) => `${chain.explorer}/tx/${hash}`;
const addressLink = (chain, address) => `${chain.explorer}/${chain.kind === 'sol' ? 'account' : 'address'}/${address}`;

module.exports = { CHAINS, EVM_NATIVE, allChains, getChain, evmChains, findChain, isEvmAddress, txLink, addressLink };
