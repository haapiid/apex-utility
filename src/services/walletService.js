const { Keypair, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default;
const { config } = require('../config');
const { encrypt, decrypt } = require('../utils/crypto');
const { createJsonStore } = require('../utils/jsonStore');
const connection = require('./connection');
const logger = require('../utils/logger');

// { [telegramUserId]: { address, encryptedKey, createdAt } } — key stored as base58 (Phantom format)
const store = createJsonStore(config.wallet.storePath, {});

function persist(userId, keypair) {
  const address = keypair.publicKey.toBase58();
  store.load()[userId] = {
    address,
    encryptedKey: encrypt(bs58.encode(keypair.secretKey)),
    createdAt: new Date().toISOString(),
  };
  store.save();
  return address;
}

// Accepts a base58 secret key (Phantom/Solflare export) or a JSON byte array (solana-keygen)
function parseSecretKey(input) {
  const text = input.trim();
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
  if (bytes.length !== 64) throw new Error('Invalid secret key length');
  return Keypair.fromSecretKey(bytes); // throws if the key pair is inconsistent
}

function getWallet(userId) {
  const entry = store.load()[userId];
  return entry ? { address: entry.address, createdAt: entry.createdAt } : null;
}

function createWallet(userId) {
  const keypair = Keypair.generate();
  logger.info({ userId, address: keypair.publicKey.toBase58() }, 'Wallet created');
  return persist(userId, keypair);
}

function importWallet(userId, secretKey) {
  const keypair = parseSecretKey(secretKey);
  logger.info({ userId, address: keypair.publicKey.toBase58() }, 'Wallet imported');
  return persist(userId, keypair);
}

function exportPrivateKey(userId) {
  const entry = store.load()[userId];
  return entry ? decrypt(entry.encryptedKey) : null;
}

function removeWallet(userId) {
  const data = store.load();
  if (!data[userId]) return false;
  delete data[userId];
  store.save();
  logger.info({ userId }, 'Wallet removed');
  return true;
}

function getKeypair(userId) {
  const key = exportPrivateKey(userId);
  return key ? Keypair.fromSecretKey(bs58.decode(key)) : null;
}

// Balance in lamports (bigint)
async function getBalance(address) {
  return BigInt(await connection.getBalance(new PublicKey(address)));
}

module.exports = {
  getWallet,
  createWallet,
  importWallet,
  exportPrivateKey,
  removeWallet,
  getKeypair,
  getBalance,
};
