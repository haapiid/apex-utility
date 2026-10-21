const { config, validateConfig } = require('./src/config');
const logger = require('./src/utils/logger');

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

async function main() {
  validateConfig();

  const { createBot, setupProfile } = require('./src/bot');
  const connection = require('./src/services/connection');

  // Fail fast if the RPC is unreachable; Jupiter swaps only exist on mainnet
  const genesis = await connection.getGenesisHash();
  if (genesis !== MAINNET_GENESIS) {
    logger.warn('SOLANA_RPC_URL is not Solana mainnet: Jupiter trading will not work on this cluster');
  }
  if (!config.revenue.feesEnabled) {
    logger.warn('TREASURY_ADDRESS is not set: trading fees are disabled');
  }

  const bot = createBot();
  await setupProfile(bot).catch((err) => logger.warn({ err: err.message }, 'Failed to set bot profile'));

  const shutdown = (signal) => {
    logger.info({ signal }, '🐒 Shutting down ApeX Utility...');
    bot.stop();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await bot.start({
    drop_pending_updates: true,
    onStart: (me) =>
      logger.info({ username: me.username, feesEnabled: config.revenue.feesEnabled }, '🍌 ApeX Utility is running on Solana'),
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Failed to start the bot');
  process.exit(1);
});
