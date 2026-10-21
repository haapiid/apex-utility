const { db } = require('../db');
const logger = require('../utils/logger');

// Every notification is kept for ApeX Pro; users with Telegram linked (positive id) also get it in the bot.
const KEEP = 200; // per user

function push(userId, html) {
  db.prepare('INSERT INTO notifications (user_id, text, created_at) VALUES (?, ?, ?)').run(userId, html, Date.now());
  db.prepare(
    'DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?)',
  ).run(userId, userId, KEEP);
}

const list = (userId, limit = 30) =>
  db.prepare('SELECT id, text, created_at, read FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
const unread = (userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0').get(userId).n;
const markRead = (userId) => db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(userId);

/** notify(userId, html, replyMarkup?) for workers and admin tools. Never throws. */
function createNotifier(botApi) {
  return async (userId, html, replyMarkup) => {
    try {
      push(userId, html);
    } catch (err) {
      logger.warn({ userId, err: err.message }, 'Could not store notification');
    }
    if (!botApi || userId < 0) return;
    await botApi
      .sendMessage(userId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: replyMarkup })
      .catch((err) => logger.warn({ userId, err: err.message }, 'Telegram notification failed'));
  };
}

module.exports = { push, list, unread, markRead, createNotifier };
