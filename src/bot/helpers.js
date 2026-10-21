const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * From an inline button → edit the existing message.
 * From a command → send a new message.
 */
async function respond(ctx, text, keyboard) {
  const options = { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      return await ctx.editMessageText(text, options);
    } catch (err) {
      if (String(err.description || err.message).includes('message is not modified')) return null;
      logger.debug({ err: err.message }, 'Edit failed, sending a new message');
    }
  }
  return ctx.reply(text, options);
}

// Edit a specific message (used for multi-step transaction progress)
function editProgress(ctx, message, text, keyboard) {
  return ctx.api
    .editMessageText(message.chat.id, message.message_id, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    })
    .catch((err) => logger.debug({ err: err.message }, 'Progress edit failed'));
}

// ----- Conversation state: waiting for the user to type something (private key, amount) -----
const pending = new Map();
const PENDING_TTL_MS = 2 * 60_000;

function setPending(userId, action, data = {}) {
  pending.set(userId, { action, data, expiresAt: Date.now() + PENDING_TTL_MS });
}

function takePending(userId) {
  const entry = pending.get(userId);
  pending.delete(userId);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry;
}

function clearPending(userId) {
  pending.delete(userId);
}

// ----- Pending confirmations (trade / withdraw), referenced by a short id in callback data -----
const confirmations = new Map();
const CONFIRM_TTL_MS = 2 * 60_000;

function createConfirmation(userId, payload) {
  const id = crypto.randomBytes(6).toString('hex');
  confirmations.set(id, { userId, payload, expiresAt: Date.now() + CONFIRM_TTL_MS });
  return id;
}

function takeConfirmation(id, userId) {
  const entry = confirmations.get(id);
  confirmations.delete(id);
  if (!entry || entry.userId !== userId || entry.expiresAt < Date.now()) return null;
  return entry.payload;
}

// Periodically drop expired entries so memory doesn't grow
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k);
  for (const [k, v] of confirmations) if (v.expiresAt < now) confirmations.delete(k);
}, 60_000).unref();

module.exports = {
  respond,
  editProgress,
  setPending,
  takePending,
  clearPending,
  createConfirmation,
  takeConfirmation,
};
