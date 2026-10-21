require('dotenv').config();

const path = require('path');
const { PublicKey } = require('@solana/web3.js');

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isNaN(value) ? fallback : value;
}

function isSolanaAddress(value) {
  try {
    new PublicKey(value); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

const dataDir = path.join(__dirname, '..', '..', 'data');

const config = {
  bot: {
    token: process.env.BOT_TOKEN,
    name: 'ApeX Utility',
  },
  chain: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    explorerUrl: (process.env.EXPLORER_URL || 'https://solscan.io').replace(/\/$/, ''),
    nativeSymbol: 'SOL',
  },
  jupiter: {
    apiUrl: (process.env.JUPITER_API_URL || 'https://lite-api.jup.ag').replace(/\/$/, ''),
    slippageBps: int('SLIPPAGE_BPS', 500),
    priorityFeeMaxLamports: int('PRIORITY_FEE_MAX_LAMPORTS', 1_000_000),
  },
  wallet: {
    secret: process.env.WALLET_SECRET,
    storePath: path.join(dataDir, 'wallets.json'),
  },
  stats: {
    storePath: path.join(dataDir, 'stats.json'),
  },
  revenue: {
    treasury: process.env.TREASURY_ADDRESS || '',
    botFeeBps: int('BOT_FEE_BPS', 100),
    revenueShareBps: int('REVENUE_SHARE_BPS', 4000),
    holderSplitBps: int('HOLDER_SPLIT_BPS', 7000),
    tokenSymbol: process.env.TOKEN_SYMBOL || 'APEX',
    totalSupply: int('TOKEN_TOTAL_SUPPLY', 1_000_000),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Fees are only charged when a treasury wallet is configured
config.revenue.feesEnabled = Boolean(config.revenue.treasury) && config.revenue.botFeeBps > 0;

function validateConfig() {
  const errors = [];
  if (!config.bot.token) errors.push('BOT_TOKEN is required');
  if (!config.wallet.secret || config.wallet.secret.length < 32) {
    errors.push('WALLET_SECRET is required (at least 32 characters)');
  }
  if (config.revenue.treasury && !isSolanaAddress(config.revenue.treasury)) {
    errors.push('TREASURY_ADDRESS is not a valid Solana address');
  }
  if (config.revenue.botFeeBps < 0 || config.revenue.botFeeBps > 1000) {
    errors.push('BOT_FEE_BPS must be between 0 and 1000');
  }
  if (errors.length) {
    throw new Error(`Invalid .env configuration:\n - ${errors.join('\n - ')}`);
  }
}

module.exports = { config, validateConfig, isSolanaAddress };
