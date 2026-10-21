const crypto = require('crypto');
const { db, transaction } = require('../db');

// ApeX Pro sessions, plus the Telegram login: the user asks the bot for a one-time code (/web) and types
// it on the site. Typing a code (instead of clicking a link) means a stranger can't send you a link that
// logs *them* in as you. Wallet and Google logins live in accountService and end in createSession().
// Codes and session tokens are stored only as SHA-256 hashes.

const CODE_TTL_MS = 3 * 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const hash = (v) => crypto.createHash('sha256').update(v).digest('hex');
const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// 8 characters ≈ 31^8 ≈ 8.5e11 combinations, shown as XXXX-XXXX
function issueLoginCode(userId) {
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  transaction(() => {
    db.prepare('DELETE FROM web_login_codes WHERE user_id = ? OR expires_at < ?').run(userId, Date.now());
    db.prepare('INSERT INTO web_login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hash(code), userId, Date.now() + CODE_TTL_MS);
  });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, ttlMs: CODE_TTL_MS };
}

// One use only. Returns the Telegram user id the code was issued to, or null.
function redeemLoginCode(code) {
  const clean = normalize(code);
  if (clean.length !== 8) return null;
  return transaction(() => {
    const row = db.prepare('SELECT * FROM web_login_codes WHERE code_hash = ?').get(hash(clean));
    if (!row || row.used || row.expires_at < Date.now()) return null;
    db.prepare('UPDATE web_login_codes SET used = 1 WHERE code_hash = ?').run(row.code_hash);
    return row.user_id;
  });
}

// New web session for any login method. Returns { token, expiresAt }.
function createSession(userId, userAgent = '') {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO web_sessions (token_hash, user_id, user_agent, created_at, expires_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)').run(
    hash(token),
    userId,
    String(userAgent).slice(0, 200),
    now,
    now + SESSION_TTL_MS,
    now,
  );
  return { token, expiresAt: now + SESSION_TTL_MS };
}

// User id for a session token, or null. Refreshes last_seen at most once a minute.
function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM web_sessions WHERE token_hash = ?').get(hash(token));
  if (!row || row.expires_at < Date.now()) return null;
  if (Date.now() - row.last_seen > 60_000) db.prepare('UPDATE web_sessions SET last_seen = ? WHERE token_hash = ?').run(Date.now(), row.token_hash);
  return row.user_id;
}

const revokeSession = (token) => db.prepare('DELETE FROM web_sessions WHERE token_hash = ?').run(hash(token || '')).changes > 0;
const revokeAllSessions = (userId) => db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(userId).changes;
const countSessions = (userId) =>
  db.prepare('SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND expires_at > ?').get(userId, Date.now()).n;

module.exports = { issueLoginCode, redeemLoginCode, createSession, sessionUser, revokeSession, revokeAllSessions, countSessions, CODE_TTL_MS };
