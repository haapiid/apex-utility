const crypto = require('crypto');
const { config } = require('../config');

// AES-256-GCM: user private keys are never stored in plaintext
const SALT = 'apex-utility-wallet-store';
let cachedKey;

function getKey() {
  if (!cachedKey) cachedKey = crypto.scryptSync(config.wallet.secret, SALT, 32);
  return cachedKey;
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((b) => b.toString('hex')).join(':');
}

function decrypt(payload) {
  const [iv, tag, encrypted] = payload.split(':').map((h) => Buffer.from(h, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
