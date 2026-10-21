const webAuthService = require('../../services/webAuthService');
const { InlineKeyboard } = require('grammy');
const { respond } = require('../helpers');
const { config } = require('../../config');

// ApeX Pro login: the bot hands out a one-time code that the user types on the website

async function sendLoginCode(ctx) {
  const { code, ttlMs } = webAuthService.issueLoginCode(ctx.from.id);
  const sessions = webAuthService.countSessions(ctx.from.id);
  const kb = new InlineKeyboard().url('🌐 Open ApeX Pro', config.web.publicUrl).row();
  if (sessions) kb.text(`🚪 Log out all web sessions (${sessions})`, 'web:logout');
  const msg = await ctx.reply(
    `🌐 <b>ApeX Pro login code</b>\n\n<code>${code}</code>\n\n` +
      `Type it on ${config.web.publicUrl} within ${Math.round(ttlMs / 60_000)} minutes. It works once.\n\n` +
      '⚠️ <b>Never share this code.</b> Anyone who enters it can trade from your wallets. ApeX staff will never ask for it.',
    { parse_mode: 'HTML', reply_markup: kb, link_preview_options: { is_disabled: true } },
  );
  // The code is useless after it expires: remove it from the chat too
  setTimeout(() => ctx.api.deleteMessage(msg.chat.id, msg.message_id).catch(() => {}), ttlMs);
}

function register(bot) {
  bot.command(['web', 'pro'], sendLoginCode);
  bot.callbackQuery('menu:web', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    return sendLoginCode(ctx);
  });
  bot.callbackQuery('web:logout', (ctx) => {
    const n = webAuthService.revokeAllSessions(ctx.from.id);
    return respond(ctx, `🚪 Logged out of ${n} web session${n === 1 ? '' : 's'}.`);
  });
}

module.exports = { register, sendLoginCode };
