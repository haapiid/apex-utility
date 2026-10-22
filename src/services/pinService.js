const crypto = require('crypto');
const { db } = require('../db');
const { UserError } = require('./tradeCommon');

// ApeX Pro security PIN (4–8 digits). Once set, the web asks for it before exporting or importing a
// private key, removing a wallet and changing the PIN. Stored as scrypt(pin, per-user salt); five wrong
// tries lock it for 15 minutes. The bot doesn't use it: Telegram's own account security covers the bot.

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60_000;

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
const row = (userId) => db.prepare('SELECT * FROM security_pins WHERE user_id = ?').get(userId) || null;
const hasPin = (userId) => Boolean(row(userId));

function validFormat(pin) {
  if (!/^\d{4,8}$/.test(String(pin ?? ''))) throw new UserError('The PIN must be 4 to 8 digits.');
  return String(pin);
}

/** Throws unless the PIN matches. With no PIN set it always passes. */
function verify(userId, pin) {
  const r = row(userId);
  if (!r) return;
  if (r.locked_until > Date.now()) {
    throw new UserError(`Too many wrong PINs. Try again in ${Math.ceil((r.locked_until - Date.now()) / 60_000)} minutes.`);
  }
  if (pin == null || pin === '') throw Object.assign(new UserError('Enter your security PIN.'), { code: 'pin_required' });
  const given = Buffer.from(hashPin(String(pin ?? ''), r.salt), 'hex');
  if (crypto.timingSafeEqual(given, Buffer.from(r.pin_hash, 'hex'))) {
    if (r.failed) db.prepare('UPDATE security_pins SET failed = 0 WHERE user_id = ?').run(userId);
    return;
  }
  const failed = r.failed + 1;
  const locked = failed >= MAX_FAILED;
  db.prepare('UPDATE security_pins SET failed = ?, locked_until = ? WHERE user_id = ?').run(locked ? 0 : failed, locked ? Date.now() + LOCK_MS : 0, userId);
  throw new UserError(locked ? 'Too many wrong PINs. Locked for 15 minutes.' : `Wrong PIN (${MAX_FAILED - failed} tries left).`);
}

/** Sets or changes the PIN; changing needs the current one */
function setPin(userId, pin, currentPin) {
  const next = validFormat(pin);
  verify(userId, currentPin);
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO security_pins (user_id, pin_hash, salt, failed, locked_until, updated_at) VALUES (?, ?, ?, 0, 0, ?)
     ON CONFLICT (user_id) DO UPDATE SET pin_hash = excluded.pin_hash, salt = excluded.salt, failed = 0, locked_until = 0, updated_at = excluded.updated_at`,
  ).run(userId, hashPin(next, salt), salt, Date.now());
}

function removePin(userId, currentPin) {
  verify(userId, currentPin);
  db.prepare('DELETE FROM security_pins WHERE user_id = ?').run(userId);
}

module.exports = { hasPin, verify, setPin, removePin };
