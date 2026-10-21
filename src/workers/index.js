const logger = require('../utils/logger');

// Background jobs. Each runs on its own interval and never overlaps with itself.
const JOBS = [
  { name: 'sniper', everyMs: 4_000, module: require('./sniper') },
  { name: 'copy', everyMs: 10_000, module: require('./copy') },
  { name: 'orders', everyMs: 15_000, module: require('./orders') },
  { name: 'antiRug', everyMs: 20_000, module: require('./antiRug') },
  { name: 'dca', everyMs: 30_000, module: require('./dca') },
  { name: 'revenue', everyMs: 10 * 60_000, module: require('./revenue') },
];

/** notify(userId, html, replyMarkup?) sends a Telegram message; failures are logged, never thrown */
function startWorkers(notify) {
  const timers = JOBS.map(({ name, everyMs, module }) => {
    let running = false;
    return setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await module.run(notify);
      } catch (err) {
        logger.error({ job: name, err: err.message, stack: err.stack }, 'Worker failed');
      } finally {
        running = false;
      }
    }, everyMs);
  });
  logger.info({ jobs: JOBS.map((j) => j.name) }, 'Workers started');
  return () => timers.forEach(clearInterval);
}

module.exports = { startWorkers };
