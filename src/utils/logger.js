const pino = require('pino');
const { config } = require('../config');

const logger = pino({
  name: 'apex-utility',
  level: config.logLevel,
  // Never log private keys or secrets
  redact: ['privateKey', '*.privateKey', 'encryptedKey', '*.encryptedKey'],
});

module.exports = logger;
