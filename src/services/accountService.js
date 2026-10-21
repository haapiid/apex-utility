const crypto = require('crypto');
const axios = require('axios');
const bs58 = require('bs58').default;
const { verifyMessage, getAddress } = require('ethers');
const { db, transaction } = require('../db');
const walletService = require('./walletService');
const { UserError } = require('./tradeCommon');
const { config, isSolanaAddress } = require('../config');
const { isEvmAddress } = require('../config/chains');
const logger = require('../utils/logger');

/**
 * ApeX accounts. A user id is either a Telegram id (positive, the bot works for it) or a web-only id
 * (negative, made by ApeX Pro). Extra ways to log in are identities attached to a user:
 *   sol / evm  — a Phantom / MetaMask address, proven by signing a one-time message
 *   google     — a Google account id
 * Linking Telegram to a web-only account merges the web account into the Telegram one.
 * Wallets used to sign in only prove identity: trading always uses ApeX's own custodial wallets.
 */

const NONCE_TTL_MS = 5 * 60_000;
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const PROVIDERS = ['sol', 'evm', 'google'];

// ---------- users & identities ----------

function createWebUser() {
  return transaction(() => {
    const { lowest } = db.prepare('SELECT MIN(id) AS lowest FROM users WHERE id < 0').get();
    const id = (lowest ?? 0) - 1;
    db.prepare('INSERT INTO users (id, created_at) VALUES (?, ?)').run(id, Date.now());
    return id;
  });
}

const findIdentity = (provider, subject) => db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?').get(provider, subject) || null;

function identities(userId) {
  const rows = db.prepare('SELECT provider, subject, label, created_at FROM identities WHERE user_id = ? ORDER BY created_at').all(userId);
  return { telegram: userId > 0, list: rows };
}

function attachIdentity(userId, provider, subject, label = null) {
  db.prepare('INSERT INTO identities (provider, subject, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)').run(provider, subject, userId, label, Date.now());
}

// Ways the user can still log in, so unlinking never locks them out
const loginMethods = (userId) => identities(userId).list.length + (userId > 0 ? 1 : 0);

function unlinkIdentity(userId, provider, subject) {
  if (loginMethods(userId) <= 1) throw new UserError('Keep at least one way to log in.');
  return db.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ? AND subject = ?').run(userId, provider, subject).changes > 0;
}

/**
 * Moves everything of `fromId` into `toId` and deletes `fromId`. Used when a web-only account links
 * Telegram (the Telegram id stays, so the bot keeps working) or a sign-in method of another web-only account.
 */
function mergeUsers(fromId, toId) {
  if (fromId === toId) return;
  if (fromId > 0) throw new UserError('That login already belongs to another Telegram account.');
  transaction(() => {
    walletService.ensureUser(toId);
    // Wallets: drop exact duplicates, keep the destination's active wallet per kind
    db.prepare('DELETE FROM wallets WHERE user_id = ? AND (kind, address) IN (SELECT kind, address FROM wallets WHERE user_id = ?)').run(fromId, toId);
    for (const kind of walletService.KINDS) {
      if (walletService.getWallet(toId, kind)) db.prepare('UPDATE wallets SET active = 0 WHERE user_id = ? AND kind = ?').run(fromId, kind);
    }
    db.prepare('DELETE FROM copy_targets WHERE user_id = ? AND (chain, address) IN (SELECT chain, address FROM copy_targets WHERE user_id = ?)').run(fromId, toId);
    for (const table of ['wallets', 'trades', 'orders', 'dca_plans', 'snipes', 'copy_targets', 'rewards', 'claims', 'burns', 'web_sessions', 'web_login_codes', 'identities', 'notifications']) {
      db.prepare(`UPDATE ${table} SET user_id = ? WHERE user_id = ?`).run(toId, fromId);
    }
    const from = db.prepare('SELECT * FROM users WHERE id = ?').get(fromId);
    const to = db.prepare('SELECT * FROM users WHERE id = ?').get(toId);
    if (from) {
      const keepSettings = to.settings && to.settings !== '{}' ? to.settings : from.settings;
      const referrer = to.referrer_id || (from.referrer_id !== toId ? from.referrer_id : null);
      db.prepare('UPDATE users SET credits = credits + ?, extra_wallet_slots = MAX(extra_wallet_slots, ?), settings = ?, referrer_id = ? WHERE id = ?').run(
        from.credits || 0,
        from.extra_wallet_slots || 0,
        keepSettings,
        referrer,
        toId,
      );
      db.prepare('UPDATE users SET referrer_id = ? WHERE referrer_id = ?').run(toId, fromId);
      db.prepare('DELETE FROM users WHERE id = ?').run(fromId);
    }
  });
  logger.info({ fromId, toId }, 'Accounts merged');
}

/**
 * Resolves who a login belongs to. `currentUserId` = the session making the request (linking).
 * Returns { userId, created }.
 */
function resolveLogin(provider, subject, label, currentUserId, ref) {
  const existing = findIdentity(provider, subject);
  if (currentUserId) {
    if (!existing) {
      attachIdentity(currentUserId, provider, subject, label);
      return { userId: currentUserId, created: false };
    }
    if (existing.user_id === currentUserId) return { userId: currentUserId, created: false };
    // The login belongs to another account: fold the web-only one into the other
    if (existing.user_id < 0) {
      mergeUsers(existing.user_id, currentUserId);
      return { userId: currentUserId, created: false };
    }
    if (currentUserId < 0) {
      mergeUsers(currentUserId, existing.user_id);
      return { userId: existing.user_id, created: false };
    }
    throw new UserError('That login is already linked to a different Telegram account.');
  }
  if (existing) return { userId: existing.user_id, created: false };
  const userId = createWebUser();
  attachIdentity(userId, provider, subject, label);
  walletService.createMissingWallets(userId); // ready to deposit right away, like the bot
  if (ref) require('./rewardsService').bindReferrer(userId, ref);
  return { userId, created: true };
}

// ---------- Sign in with a wallet (Phantom / MetaMask) ----------

function walletMessage(kind, address, nonce) {
  const host = new URL(config.web.publicUrl).host;
  return [
    `${host} wants you to sign in to ApeX Pro with your ${kind === 'sol' ? 'Solana' : 'Ethereum'} account:`,
    address,
    '',
    'Signing proves you own this wallet. It is free and does not send a transaction or give access to your funds.',
    '',
    `URI: ${config.web.publicUrl}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
}

function normalizeAddress(kind, address) {
  const a = String(address || '').trim();
  if (kind === 'sol' && isSolanaAddress(a)) return a;
  if (kind === 'evm' && isEvmAddress(a)) return getAddress(a.toLowerCase());
  throw new UserError('Invalid wallet address.');
}

function walletChallenge(kind, address) {
  if (!['sol', 'evm'].includes(kind)) throw new UserError('Unknown wallet type.');
  const addr = normalizeAddress(kind, address);
  const nonce = crypto.randomBytes(16).toString('hex');
  const message = walletMessage(kind, addr, nonce);
  db.prepare('DELETE FROM auth_nonces WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO auth_nonces (nonce_hash, payload, expires_at) VALUES (?, ?, ?)').run(
    hash(nonce),
    JSON.stringify({ kind, address: addr, message }),
    Date.now() + NONCE_TTL_MS,
  );
  return { message };
}

// One-time: the nonce is deleted whether or not the signature checks out
function takeNonce(nonce) {
  return transaction(() => {
    const row = db.prepare('SELECT * FROM auth_nonces WHERE nonce_hash = ?').get(hash(nonce));
    if (row) db.prepare('DELETE FROM auth_nonces WHERE nonce_hash = ?').run(row.nonce_hash);
    return row && row.expires_at > Date.now() ? JSON.parse(row.payload) : null;
  });
}

function verifySolana(address, message, signatureB64) {
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bs58.decode(address)).toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(String(signatureB64), 'base64'));
}

function verifyEvm(address, message, signature) {
  try {
    return getAddress(verifyMessage(message, signature).toLowerCase()) === address;
  } catch {
    return false;
  }
}

// The address is taken from the stored challenge, never from the request
function walletLogin({ kind, message, signature, currentUserId, ref }) {
  const nonce = /\nNonce: ([0-9a-f]{32})\n/.exec(String(message))?.[1];
  const challenge = nonce && takeNonce(nonce);
  if (!challenge || challenge.message !== message || challenge.kind !== kind) {
    throw new UserError('This sign-in request expired. Try again.');
  }
  const ok = kind === 'sol' ? verifySolana(challenge.address, message, signature) : verifyEvm(challenge.address, message, signature);
  if (!ok) throw new UserError('The signature does not match this wallet.');
  return resolveLogin(kind, challenge.address, null, currentUserId, ref);
}

// ---------- Sign in with Google (OAuth 2.0 code flow + PKCE) ----------

const googleEnabled = () => Boolean(config.google.clientId && config.google.clientSecret);
const googleRedirect = () => `${config.web.publicUrl}/api/auth/google/callback`;

// Returns the Google URL to send the browser to. The state remembers who is linking (cookies are
// SameSite=Strict, so the callback coming back from Google can't see the session).
function googleStart({ currentUserId, ref }) {
  if (!googleEnabled()) throw new UserError('Google login is not configured.');
  const state = crypto.randomBytes(24).toString('base64url');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  db.prepare('INSERT INTO auth_nonces (nonce_hash, payload, expires_at) VALUES (?, ?, ?)').run(
    hash(state),
    JSON.stringify({ google: true, verifier, currentUserId: currentUserId || null, ref: ref || null }),
    Date.now() + NONCE_TTL_MS,
  );
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: googleRedirect(),
    response_type: 'code',
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function googleCallback({ code, state }) {
  const saved = state && takeNonce(state);
  if (!saved?.google) throw new UserError('This Google sign-in expired. Try again.');
  const { data: token } = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      code,
      code_verifier: saved.verifier,
      grant_type: 'authorization_code',
      redirect_uri: googleRedirect(),
    }),
    { timeout: 10_000 },
  );
  // Google validates the ID token's signature and expiry here; we check it was issued for us
  const { data: info } = await axios.get('https://oauth2.googleapis.com/tokeninfo', { params: { id_token: token.id_token }, timeout: 10_000 });
  if (info.aud !== config.google.clientId || !['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) {
    throw new UserError('Google sign-in could not be verified.');
  }
  if (info.email_verified !== 'true' && info.email_verified !== true) throw new UserError('Verify your Google email first.');
  return resolveLogin('google', info.sub, info.email, saved.currentUserId, saved.ref);
}

module.exports = {
  PROVIDERS,
  identities,
  unlinkIdentity,
  mergeUsers,
  resolveLogin,
  walletChallenge,
  walletLogin,
  googleEnabled,
  googleStart,
  googleCallback,
};
