require('dotenv').config();

const path = require('path');
const { PublicKey } = require('@solana/web3.js');
const { isAddress } = require('ethers');

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
  // MEV protection on Solana: swaps go to Jito's block engine as single-transaction bundles
  jito: {
    url: (process.env.JITO_URL || 'https://mainnet.block-engine.jito.wtf').replace(/\/$/, ''),
    tipLamports: int('JITO_TIP_LAMPORTS', 100_000), // 0.0001 SOL default, users can change it
  },
  pump: {
    // PumpPortal's free data feed: new pump.fun tokens and migrations (only connected while someone needs it)
    feedUrl: process.env.PUMP_FEED_URL || 'wss://pumpportal.fun/api/data',
  },
  db: {
    path: process.env.DB_PATH || path.join(dataDir, 'apex.db'),
  },
  // Trading fee per trade source, in bps (50 = 0.5%)
  fees: {
    manualBps: int('FEE_MANUAL_BPS', 50),
    snipeBps: int('FEE_SNIPE_BPS', 100),
    // Limit orders, DCA and copy trades
    autoBps: int('FEE_AUTO_BPS', 50),
  },
  evm: {
    // KyberSwap aggregator: routes swaps on every EVM chain in src/config/chains.js
    kyberApiUrl: (process.env.KYBER_API_URL || 'https://aggregator-api.kyberswap.com').replace(/\/$/, ''),
    kyberClientId: process.env.KYBER_CLIENT_ID || 'apex-utility',
    slippageBps: int('EVM_SLIPPAGE_BPS', int('SLIPPAGE_BPS', 500)),
    treasury: process.env.EVM_TREASURY_ADDRESS || '',
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
    // Headline fee shown in the bot and used by the revenue calculator (= manual trade fee)
    botFeeBps: int('FEE_MANUAL_BPS', 50),
    // Share of fees (after the referral cut) paid to $APEX holders
    revenueShareBps: int('REVENUE_SHARE_BPS', 4000),
    epochHours: int('REVENUE_EPOCH_HOURS', 24),
    tokenSymbol: process.env.TOKEN_SYMBOL || 'APEX',
    totalSupply: int('TOKEN_TOTAL_SUPPLY', 1_000_000),
  },
  // $APEX: not launched yet. Everything token-based stays off until APEX_TOKEN_ADDRESS is set.
  apex: {
    chain: process.env.APEX_TOKEN_CHAIN || 'sol',
    address: process.env.APEX_TOKEN_ADDRESS || '',
    minHold: int('APEX_MIN_HOLD', 50), // whole tokens needed to earn revenue share
    cashbackMultiplier: Number(process.env.CASHBACK_MULTIPLIER ?? 0.1), // cashback $ = fees paid $ × this
    creditsPerToken: Number(process.env.BURN_CREDITS_PER_TOKEN ?? 1),
    walletSlotCredits: int('EXTRA_WALLET_SLOT_CREDITS', 100),
  },
  referral: {
    shareBps: int('REFERRAL_SHARE_BPS', 2500), // of the fees paid by referred users
  },
  // Pays claims (gasless for users). Keep it separate from the treasury and lightly funded.
  rewardsWallet: {
    solKey: process.env.REWARDS_SOL_PRIVATE_KEY || '',
    evmKey: process.env.REWARDS_EVM_PRIVATE_KEY || '',
  },
  // ApeX Pro web app, served by the bot process (shares wallets, locks and workers with the bot)
  web: {
    enabled: process.env.WEB_ENABLED !== 'false',
    port: int('WEB_PORT', 8080),
    publicUrl: (process.env.WEB_PUBLIC_URL || `http://localhost:${int('WEB_PORT', 8080)}`).replace(/\/$/, ''),
    // Behind a reverse proxy (Nginx): listen on 127.0.0.1 only, and take the visitor's IP from X-Real-IP
    host: process.env.WEB_HOST || undefined,
    trustProxy: process.env.WEB_TRUST_PROXY === '1',
  },
  // Optional "Log in with Google" on ApeX Pro (OAuth client from Google Cloud; redirect URI =
  // WEB_PUBLIC_URL + /api/auth/google/callback). Hidden when unset.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Fees are only charged when a treasury wallet is configured
config.revenue.feesEnabled = Boolean(config.revenue.treasury);
config.evm.feesEnabled = Boolean(config.evm.treasury);

const FEE_BPS_BY_SOURCE = { manual: 'manualBps', snipe: 'snipeBps', limit: 'autoBps', dca: 'autoBps', copy: 'autoBps', antirug: 'manualBps' };

// Fee in bps for a trade on a chain kind ('sol' | 'evm') from a source (manual, snipe, limit, dca, copy)
function feeBpsFor(kind, source = 'manual') {
  const enabled = kind === 'sol' ? config.revenue.feesEnabled : config.evm.feesEnabled;
  return enabled ? config.fees[FEE_BPS_BY_SOURCE[source] || 'manualBps'] : 0;
}

function validateConfig() {
  const errors = [];
  // BOT_TOKEN is optional: without it ApeX runs as the ApeX Pro web app only (see index.js)
  if (!config.bot.token && !config.web.enabled) errors.push('Set BOT_TOKEN, or keep WEB_ENABLED on to run ApeX Pro alone');
  if (!config.wallet.secret || config.wallet.secret.length < 32) {
    errors.push('WALLET_SECRET is required (at least 32 characters)');
  }
  if (config.revenue.treasury && !isSolanaAddress(config.revenue.treasury)) {
    errors.push('TREASURY_ADDRESS is not a valid Solana address');
  }
  if (config.evm.treasury && !isAddress(config.evm.treasury)) {
    errors.push('EVM_TREASURY_ADDRESS is not a valid EVM address');
  }
  if (config.evm.slippageBps < 0 || config.evm.slippageBps > 2000) {
    errors.push('EVM_SLIPPAGE_BPS must be between 0 and 2000');
  }
  if (config.apex.address && !(isSolanaAddress(config.apex.address) || isAddress(config.apex.address))) {
    errors.push('APEX_TOKEN_ADDRESS is not a valid token address');
  }
  const { solKey, evmKey } = config.rewardsWallet;
  if (solKey) {
    try {
      if (require('bs58').default.decode(solKey.trim()).length !== 64) throw new Error();
    } catch {
      errors.push('REWARDS_SOL_PRIVATE_KEY must be a base58 Solana secret key');
    }
  }
  if (evmKey && !/^(0x)?[0-9a-fA-F]{64}$/.test(evmKey.trim())) errors.push('REWARDS_EVM_PRIVATE_KEY must be a 0x hex private key');
  if (!(config.apex.cashbackMultiplier >= 0 && config.apex.cashbackMultiplier <= 1)) {
    errors.push('CASHBACK_MULTIPLIER must be between 0 and 1');
  }
  if (config.referral.shareBps < 0 || config.referral.shareBps > 5000) errors.push('REFERRAL_SHARE_BPS must be between 0 and 5000');
  if (config.revenue.revenueShareBps < 0 || config.revenue.revenueShareBps > 10_000) errors.push('REVENUE_SHARE_BPS must be between 0 and 10000');
  if (config.revenue.epochHours < 1) errors.push('REVENUE_EPOCH_HOURS must be at least 1');
  for (const [key, bps] of Object.entries(config.fees)) {
    if (bps < 0 || bps > 1000) errors.push(`Fee ${key} must be between 0 and 1000 bps`);
  }
  if (errors.length) {
    throw new Error(`Invalid .env configuration:\n - ${errors.join('\n - ')}`);
  }
}

module.exports = { config, validateConfig, isSolanaAddress, feeBpsFor };
