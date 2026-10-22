const { Keypair, PublicKey } = require('@solana/web3.js');
const { Wallet } = require('ethers');
const bs58 = require('bs58').default;
const { db, transaction } = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');
const connection = require('./connection');
const logger = require('../utils/logger');

// Two wallet kinds, several wallets each per Telegram user:
//   sol → Solana keypair, key stored as base58 (Phantom format)
//   evm → EVM key, the same address on every EVM chain (MetaMask format, 0x hex)
// One wallet per kind is "active": that's the one that trades.
const KINDS = ['sol', 'evm'];
const KIND_LABEL = { sol: 'Solana', evm: 'EVM' };
const MAX_WALLETS_PER_KIND = 5;

class WalletError extends Error {
  constructor(code, message, kind) {
    super(message);
    this.code = code; // 'duplicate' | 'limit'
    this.kind = kind;
  }
}

const toWallet = (row) =>
  row && { id: row.id, kind: row.kind, address: row.address, label: row.label, active: Boolean(row.active), createdAt: row.created_at };

function ensureUser(userId) {
  db.prepare('INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)').run(userId, Date.now());
}

// Wallets allowed per kind: the free limit plus slots bought with burn credits
function walletLimit(userId) {
  const extra = db.prepare('SELECT extra_wallet_slots FROM users WHERE id = ?').get(userId)?.extra_wallet_slots || 0;
  return MAX_WALLETS_PER_KIND + extra;
}

// Which kind of private key the user pasted: EVM hex, or Solana base58 / JSON byte array (solana-keygen)
function parseSecretKey(input) {
  const text = input.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(text)) {
    const wallet = new Wallet(text.startsWith('0x') ? text : `0x${text}`);
    return { kind: 'evm', address: wallet.address, secret: wallet.privateKey };
  }
  const bytes = text.startsWith('[') ? Uint8Array.from(JSON.parse(text)) : bs58.decode(text);
  if (bytes.length !== 64) throw new Error('Invalid secret key length');
  const keypair = Keypair.fromSecretKey(bytes); // throws if the key pair is inconsistent
  return { kind: 'sol', address: keypair.publicKey.toBase58(), secret: bs58.encode(keypair.secretKey) };
}

function listWallets(userId, kind) {
  const rows = kind
    ? db.prepare('SELECT * FROM wallets WHERE user_id = ? AND kind = ? ORDER BY id').all(userId, kind)
    : db.prepare('SELECT * FROM wallets WHERE user_id = ? ORDER BY kind DESC, id').all(userId);
  return rows.map(toWallet);
}

// The active (trading) wallet of a kind
function getWallet(userId, kind = 'sol') {
  return toWallet(db.prepare('SELECT * FROM wallets WHERE user_id = ? AND kind = ? AND active = 1').get(userId, kind)) || null;
}

const getWallets = (userId) => ({ sol: getWallet(userId, 'sol'), evm: getWallet(userId, 'evm') });

function getWalletById(userId, walletId) {
  return toWallet(db.prepare('SELECT * FROM wallets WHERE id = ? AND user_id = ?').get(walletId, userId)) || null;
}

function persist(userId, kind, address, secret) {
  return transaction(() => {
    ensureUser(userId);
    const existing = listWallets(userId, kind);
    if (existing.some((w) => w.address === address)) throw new WalletError('duplicate', 'Wallet already added', kind);
    if (existing.length >= walletLimit(userId)) throw new WalletError('limit', 'Too many wallets', kind);
    // Labels W1..W5: reuse the lowest free number
    const used = new Set(existing.map((w) => w.label));
    let n = 1;
    while (used.has(`W${n}`)) n++;
    db.prepare('UPDATE wallets SET active = 0 WHERE user_id = ? AND kind = ?').run(userId, kind);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO wallets (user_id, kind, address, encrypted_key, label, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(userId, kind, address, encrypt(secret), `W${n}`, Date.now());
    logger.info({ userId, kind, address }, 'Wallet saved');
    return getWalletById(userId, Number(lastInsertRowid));
  });
}

// New wallets become the active one of their kind
function createWallet(userId, kind) {
  if (kind === 'evm') {
    const wallet = Wallet.createRandom();
    return persist(userId, 'evm', wallet.address, wallet.privateKey);
  }
  const keypair = Keypair.generate();
  return persist(userId, 'sol', keypair.publicKey.toBase58(), bs58.encode(keypair.secretKey));
}

// Create whichever kinds the user has no wallet for; returns the wallets created
function createMissingWallets(userId) {
  return KINDS.filter((kind) => !listWallets(userId, kind).length).map((kind) => createWallet(userId, kind));
}

// Throws on an invalid key or WalletError; the kind is detected from the key format
function importWallet(userId, secretKey) {
  const { kind, address, secret } = parseSecretKey(secretKey);
  return persist(userId, kind, address, secret);
}

function setActive(userId, walletId) {
  const wallet = getWalletById(userId, walletId);
  if (!wallet) return null;
  transaction(() => {
    db.prepare('UPDATE wallets SET active = 0 WHERE user_id = ? AND kind = ?').run(userId, wallet.kind);
    db.prepare('UPDATE wallets SET active = 1 WHERE id = ?').run(walletId);
  });
  return getWalletById(userId, walletId);
}

function exportPrivateKey(userId, walletId) {
  const row = db.prepare('SELECT encrypted_key FROM wallets WHERE id = ? AND user_id = ?').get(walletId, userId);
  return row ? decrypt(row.encrypted_key) : null;
}

// If the active wallet is removed, the oldest remaining wallet of that kind becomes active
function removeWallet(userId, walletId) {
  const wallet = getWalletById(userId, walletId);
  if (!wallet) return false;
  transaction(() => {
    db.prepare('DELETE FROM wallets WHERE id = ?').run(walletId);
    if (wallet.active) {
      db.prepare(
        'UPDATE wallets SET active = 1 WHERE id = (SELECT id FROM wallets WHERE user_id = ? AND kind = ? ORDER BY id LIMIT 1)',
      ).run(userId, wallet.kind);
    }
  });
  logger.info({ userId, walletId, kind: wallet.kind }, 'Wallet removed');
  return true;
}

// Solana wallet with its keypair, for signing: the active one, or a given wallet id (multi-wallet trades)
function getActiveKeypair(userId, walletId) {
  const wallet = walletId != null ? getWalletById(userId, walletId) : getWallet(userId, 'sol');
  if (!wallet || wallet.kind !== 'sol') return null;
  return { wallet, keypair: Keypair.fromSecretKey(bs58.decode(exportPrivateKey(userId, wallet.id))) };
}

// EVM wallet with a signer connected to a chain's provider: the active one, or a given wallet id
function getActiveEvmSigner(userId, provider, walletId) {
  const wallet = walletId != null ? getWalletById(userId, walletId) : getWallet(userId, 'evm');
  if (!wallet || wallet.kind !== 'evm') return null;
  return { wallet, signer: new Wallet(exportPrivateKey(userId, wallet.id), provider) };
}

// Solana balance in lamports (bigint)
async function getBalance(address) {
  return BigInt(await connection.getBalance(new PublicKey(address)));
}

module.exports = {
  KINDS,
  KIND_LABEL,
  MAX_WALLETS_PER_KIND,
  WalletError,
  ensureUser,
  walletLimit,
  parseSecretKey,
  listWallets,
  getWallet,
  getWallets,
  getWalletById,
  createWallet,
  createMissingWallets,
  importWallet,
  setActive,
  exportPrivateKey,
  removeWallet,
  getActiveKeypair,
  getActiveEvmSigner,
  getBalance,
};
