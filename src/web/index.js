const { createWebServer } = require('./server');
const { buildRoutes } = require('./routes');
const { config } = require('../config');
const logger = require('../utils/logger');

// Starts ApeX Pro inside the bot process. `app` carries runtime facts the API needs (bot username for
// login and referral links). Returns a function that stops the server.
function startWeb(app = {}) {
  const server = createWebServer(buildRoutes(app));
  server.listen(config.web.port, config.web.host, () => logger.info({ port: config.web.port, url: config.web.publicUrl }, '🌐 ApeX Pro is running'));
  server.on('error', (err) => logger.error({ err: err.message, port: config.web.port }, 'ApeX Pro could not start'));
  return () => server.close();
}

module.exports = { startWeb };
