const { config, validateConfig } = require('./src/config');
const logger = require('./src/utils/logger');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

async function main() {
  validateConfig();

  const connection = require('./src/services/connection');

  // Fail fast if the RPC is unreachable; Jupiter swaps only exist on mainnet
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    logger.warn('SOLANA_RPC_URL is not Solana mainnet: Jupiter trading will not work on this cluster');
  }
  if (!config.revenue.feesEnabled) {
    logger.warn('TREASURY_ADDRESS is not set: Solana trading fees are disabled');
  } else if (await require('./src/services/tradeService').getFeeAccount()) {
    logger.info('Solana fees are taken inside the swap (treasury wSOL account found)');
  }
  if (!config.evm.feesEnabled) {
    logger.warn('EVM_TREASURY_ADDRESS is not set: EVM trading fees are disabled');
  }
  if (!config.rewardsWallet.solKey && !config.rewardsWallet.evmKey) {
    logger.warn('No rewards wallet (REWARDS_SOL_PRIVATE_KEY / REWARDS_EVM_PRIVATE_KEY): rewards accrue but claims are closed');
  }
  if (!config.apex.address) logger.info('APEX_TOKEN_ADDRESS not set: revenue pools keep filling, distribution waits for $APEX');
  await checkEvmChains();

  const { startWorkers } = require('./src/workers');
  const { createNotifier } = require('./src/services/notificationService');
  let stopWorkers = () => {};
  let stopWeb = () => {};
  let stopBot = () => {};
  const shutdown = (signal) => {
    logger.info({ signal }, '🐒 Shutting down ApeX Utility...');
    stopWorkers();
    stopWeb();
    stopBot();
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // ApeX is not only a Telegram bot: without BOT_TOKEN it runs as ApeX Pro alone (wallet / Google login,
  // notifications only in the web app)
  if (!config.bot.token) {
    logger.warn('BOT_TOKEN is not set: running ApeX Pro only (no Telegram bot, Telegram login off)');
    stopWorkers = startWorkers(createNotifier(null));
    stopWeb = require('./src/web').startWeb({ botUsername: null });
    return;
  }

  const { createBot, setupProfile } = require('./src/bot');
  const bot = createBot();
  stopBot = () => bot.stop();
  await setupProfile(bot).catch((err) => logger.warn({ err: err.message }, 'Failed to set bot profile'));

  // Background jobs (limit orders, DCA, sniper, copy trading, anti-rug) report back in ApeX Pro and,
  // for users with Telegram linked, in the bot
  const notify = createNotifier(bot.api);

  await bot.start({
    drop_pending_updates: true,
    onStart: (me) => {
      stopWorkers = startWorkers(notify);
      // ApeX Pro web app shares this process: one per-user trade lock across bot and web
      if (config.web.enabled) stopWeb = require('./src/web').startWeb({ botUsername: me.username });
      logger.info(
        { username: me.username, feesEnabled: config.revenue.feesEnabled, evmFeesEnabled: config.evm.feesEnabled },
        '🍌 ApeX Utility is running',
      );
    },
  });
}

// Warn (don't fail) when an EVM RPC is down or points at the wrong chain
async function checkEvmChains() {
  const { evmChains } = require('./src/config/chains');
  const { getProvider } = require('./src/services/evm/provider');
  const { withTimeout } = require('./src/services/tradeCommon');
  await Promise.all(
    evmChains().map(async (chain) => {
      try {
        const id = await withTimeout(getProvider(chain).send('eth_chainId', []), 8_000);
        if (Number(id) !== chain.chainId) logger.warn({ chain: chain.key, id: Number(id) }, 'RPC is on the wrong chain');
        else logger.info({ chain: chain.key }, `${chain.name} RPC ok`);
      } catch (err) {
        logger.warn({ chain: chain.key, err: err.message }, `${chain.name} RPC is not reachable: trading there will fail`);
      }
    }),
  );
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Failed to start the bot');
  process.exit(1);
});
