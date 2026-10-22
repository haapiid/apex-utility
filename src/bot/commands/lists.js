const { InlineKeyboard } = require('grammy');
const historyService = require('../../services/historyService');
const watchlistService = require('../../services/watchlistService');
const trackerService = require('../../services/trackerService');
const tokenMetrics = require('../../services/tokenMetrics');
const { friendlyError, UserError } = require('../../services/tradeCommon');
const { respond, setPending } = require('../helpers');
const { isSolanaAddress } = require('../../config');
const { getChain, findChain, isEvmAddress, txLink, addressLink, evmChains } = require('../../config/chains');
const { formatNumber, formatPrice, formatCompactUsd, fromUnits, shortAddress, escapeHtml } = require('../../utils/format');

// /history (your trades), /watchlist (starred tokens) and /tracker (watch any wallet's trades).
// Same data as ApeX Pro: whatever is added in one shows up in the other.

const back = (kb) => kb.row().text('⬅️ Back', 'menu:main');
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};
const SOURCE = { manual: '', snipe: ' • snipe', limit: ' • limit', dca: ' • DCA', copy: ' • copy', antirug: ' • anti-rug' };
const pctText = (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${formatNumber(v, 2)}%`);

// ---------- /history ----------

const HISTORY_PAGE = 10;

function showHistory(ctx, before) {
  const { rows, next } = historyService.list(ctx.from.id, { limit: HISTORY_PAGE, before });
  const lines = ['📜 <b>Your trades</b>', ''];
  if (!rows.length) lines.push(before ? '<i>No older trades.</i>' : '<i>No trades yet. Paste a token address to make your first one.</i>');
  for (const t of rows) {
    const chain = getChain(t.chain);
    const amount = t.native ? `${formatNumber(t.native, 6)} ${chain?.native || ''}` : t.usd ? `$${formatNumber(t.usd, 2)}` : '';
    const name = t.symbol ? `$${escapeHtml(t.symbol)}` : `<code>${shortAddress(t.token, 4)}</code>`;
    const link = t.txUrl ? ` • <a href="${t.txUrl}">tx</a>` : '';
    lines.push(`${t.side === 'buy' ? '🟢' : '🔴'} ${ago(t.at)} ago • ${name} • ${amount} • ${chain?.name || t.chain}${SOURCE[t.source] ?? ''}${link}`);
  }
  const kb = new InlineKeyboard();
  if (before) kb.text('⏮ Newest', 'hist:0');
  if (next) kb.text('Older ⏭', `hist:${next}`);
  return respond(ctx, lines.join('\n'), back(kb));
}

// ---------- /watchlist ----------

async function showWatchlist(ctx) {
  const rows = await watchlistService.overview(ctx.from.id);
  const lines = ['⭐ <b>Watchlist</b>', ''];
  const kb = new InlineKeyboard();
  if (!rows.length) lines.push('<i>Empty. Open a token card and tap ⭐ Watch to add it.</i>');
  rows.slice(0, 20).forEach((w, i) => {
    const chain = getChain(w.chain);
    const p = w.pair;
    const name = p?.token.symbol ? `$${escapeHtml(p.token.symbol)}` : `<code>${shortAddress(w.token, 4)}</code>`;
    lines.push(
      p
        ? `${i + 1}. ${name} (${chain?.name}) ${formatPrice(p.priceUsd)} • 1h ${pctText(p.change?.h1)} • 24h ${pctText(p.change?.h24)} • MC ${formatCompactUsd(p.mcap)}`
        : `${i + 1}. ${name} (${chain?.name}) • no market data`,
    );
    if (i < 10) {
      kb.text(`${i + 1}. ${(p?.token.symbol || shortAddress(w.token, 3)).slice(0, 12)}`, `tok:${w.chain}:${w.token}`);
      if (i % 2 === 1) kb.row();
    }
  });
  if (rows.length > 20) lines.push(`<i>…and ${rows.length - 20} more in ApeX Pro.</i>`);
  lines.push('', '<i>Tap a token to open it. Remove one with ⭐ on its card.</i>');
  return respond(ctx, lines.join('\n'), back(kb.row().text('🔄 Refresh', 'menu:watchlist')));
}

// ---------- /tracker ----------

const TRACK_HELP = [
  '👁 <b>Track a wallet</b>',
  'Send: <code>[chain] &lt;wallet address&gt; [name]</code>',
  'Examples:',
  '<code>&lt;solana wallet&gt; Whale</code>',
  '<code>base 0x… Smart money</code> (chain needed for EVM wallets)',
].join('\n');

async function trackerText(userId) {
  const wallets = trackerService.list(userId);
  const events = trackerService.events(userId, { limit: 10 });
  const solMints = [...new Set(events.filter((e) => getChain(e.chain)?.kind === 'sol').map((e) => e.token))];
  const names = solMints.length ? await tokenMetrics.jupiterTokens(solMints).catch(() => new Map()) : new Map();

  const lines = ['👁 <b>Wallet tracker</b>', '', 'Watch any wallet’s buys and sells (nothing is copied; use /copy for that). Checked every ~15 s.', ''];
  lines.push(`<b>Tracked wallets</b> (${wallets.length}/${trackerService.MAX_TRACKED})`);
  if (!wallets.length) lines.push('<i>None yet.</i>');
  wallets.forEach((w, i) => {
    const chain = getChain(w.chain);
    lines.push(`${i + 1}. ${w.notify ? '🔔' : '🔕'} <a href="${addressLink(chain, w.address)}">${escapeHtml(w.label)}</a> • ${chain?.name}`);
  });
  lines.push('', '<b>Latest trades</b>');
  if (!events.length) lines.push('<i>No trades seen yet.</i>');
  for (const e of events) {
    const chain = getChain(e.chain);
    const symbol = names.get(e.token)?.symbol;
    const name = symbol ? `$${escapeHtml(symbol)}` : `<code>${shortAddress(e.token, 4)}</code>`;
    const value = e.native != null ? ` for ${formatNumber(fromUnits(e.native, chain?.decimals ?? 18), 4)} ${chain?.native}` : '';
    lines.push(`${e.side === 'buy' ? '🟢' : '🔴'} ${escapeHtml(e.label)} ${e.side === 'buy' ? 'bought' : 'sold'} ${name}${value} • ${ago(e.at)} ago • <a href="${txLink(chain, e.ref)}">tx</a>`);
  }
  return { text: lines.join('\n'), wallets };
}

async function showTracker(ctx) {
  const { text, wallets } = await trackerText(ctx.from.id);
  const kb = new InlineKeyboard();
  wallets.forEach((w, i) => {
    kb.text(`${w.notify ? '🔔' : '🔕'} ${i + 1}. ${w.label.slice(0, 14)}`, `trk:n:${w.id}`).text('🗑', `trk:x:${w.id}`).row();
  });
  kb.text('➕ Track a wallet', 'trk:add').text('🔄 Refresh', 'menu:tracker');
  return respond(ctx, text, back(kb));
}

// "[chain] <address> [name]"
async function handleTrackInput(ctx, state) {
  const parts = ctx.message.text.trim().split(/\s+/);
  let chain = findChain(parts[0]);
  if (chain) parts.shift();
  const [address, ...name] = parts;
  try {
    if (!address) throw new UserError('Send: [chain] <wallet address> [name]');
    if (!chain) {
      if (isEvmAddress(address)) throw new UserError(`Add the chain for EVM wallets, e.g. base 0x… (${evmChains().map((c) => c.key).join(', ')})`);
      if (!isSolanaAddress(address)) throw new UserError('That is not a wallet address.');
      chain = getChain('sol');
    }
    if (!chain.tradable) throw new UserError(`${chain.name} is coming soon.`);
    const w = trackerService.add(ctx.from.id, chain, address, name.join(' '));
    await ctx.reply(`✅ Tracking <b>${escapeHtml(w.label)}</b> on ${chain.name}. New trades from now on show up in /tracker and as messages.`, { parse_mode: 'HTML' });
    return showTracker(ctx);
  } catch (err) {
    setPending(ctx.from.id, 'track_add', state.data);
    return ctx.reply(`❌ ${friendlyError(err)}\n\nTry again or /cancel.`);
  }
}

function register(bot) {
  bot.command('history', (ctx) => showHistory(ctx));
  bot.callbackQuery('menu:history', (ctx) => showHistory(ctx));
  bot.callbackQuery(/^hist:(\d+)$/, (ctx) => showHistory(ctx, Number(ctx.match[1]) || undefined));

  bot.command('watchlist', showWatchlist);
  bot.callbackQuery('menu:watchlist', showWatchlist);
  // ⭐ on a token card: add or remove
  bot.callbackQuery(/^wl:t:([a-z]+):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async (ctx) => {
    const chain = getChain(ctx.match[1]);
    if (!chain?.tradable) return ctx.answerCallbackQuery('This chain is not available.');
    try {
      const on = watchlistService.toggle(ctx.from.id, chain, ctx.match[2]);
      return ctx.answerCallbackQuery(on ? '⭐ Added to your watchlist' : 'Removed from your watchlist');
    } catch (err) {
      return ctx.answerCallbackQuery({ text: friendlyError(err), show_alert: true });
    }
  });

  bot.command('tracker', showTracker);
  bot.callbackQuery('menu:tracker', showTracker);
  bot.callbackQuery('trk:add', async (ctx) => {
    setPending(ctx.from.id, 'track_add');
    await ctx.answerCallbackQuery().catch(() => {});
    return ctx.reply(`${TRACK_HELP}\n\nType /cancel to abort.`, { parse_mode: 'HTML' });
  });
  bot.callbackQuery(/^trk:n:(\d+)$/, async (ctx) => {
    const w = trackerService.get(ctx.from.id, Number(ctx.match[1]));
    if (w) trackerService.update(ctx.from.id, w.id, { notify: !w.notify });
    return showTracker(ctx);
  });
  bot.callbackQuery(/^trk:x:(\d+)$/, async (ctx) => {
    const ok = trackerService.remove(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery(ok ? 'Stopped tracking' : 'Already removed').catch(() => {});
    return showTracker(ctx);
  });
}

module.exports = { register, handleTrackInput };
