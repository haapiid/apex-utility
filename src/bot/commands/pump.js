const pumpService = require('../../services/pumpService');
const { friendlyError, UserError } = require('../../services/tradeCommon');
const { pumpMenu, backOnly } = require('../keyboards');
const { respond } = require('../helpers');
const { escapeHtml, shortAddress, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');

// /pump: standing pump.fun sniper rules (new launches, or migrations to PumpSwap)

const STATUS_ICON = { bought: '✅', skipped: '⏭️', failed: '❌' };

function ruleLine(r, i) {
  const filters = [];
  if (r.keyword) filters.push(`name has “${escapeHtml(r.keyword)}”`);
  if (r.max_dev_pct != null) filters.push(`dev buy ≤ ${r.max_dev_pct}%`);
  if (!r.safety) filters.push('safety off');
  const what = r.mode === 'launch' ? '🚀 New launches' : '🎓 Migrations';
  return `${i + 1}. ${what}: ${escapeHtml(r.amount)} SOL each, ${r.buys_done}/${r.max_buys} bought${filters.length ? ` • ${filters.join(', ')}` : ''}`;
}

function pumpText(userId) {
  const rules = pumpService.listRules(userId);
  const recent = pumpService.recentBuys(userId, 5);
  const lines = [
    '💊 <b>pump.fun sniper</b>',
    '',
    'Rules buy automatically from your active Solana wallet:',
    '🚀 <b>launch</b> — every new pump.fun token that passes your filters, seconds after it’s created',
    '🎓 <b>migration</b> — every token the moment it graduates from the bonding curve to PumpSwap',
    '',
    '<code>/pump launch &lt;SOL&gt; [max=5] [kw=word] [dev=10] [unsafe]</code>',
    '<code>/pump migration &lt;SOL&gt; [max=5] [unsafe]</code>',
    'Examples: <code>/pump launch 0.05 max=3 kw=cat dev=5</code> • <code>/pump migration 0.2 max=2</code>',
    '',
    '• <code>max</code> = how many tokens the rule buys before it stops (budget = SOL × max)',
    '• <code>kw</code> = name or symbol must contain this word • <code>dev</code> = skip if the creator bought more than this % of supply',
    '• Safety filter on by default (freeze authority, transfer fees). Most new launches go to zero: keep amounts small.',
    '• One token per migration snipe: <code>/snipe &lt;mint&gt; 0.5 migration</code>',
    '',
    `<b>Active rules</b> (${rules.length})`,
    ...(rules.length ? rules.map(ruleLine) : ['<i>None yet.</i>']),
  ];
  if (recent.length) {
    lines.push('', '<b>Recent</b>');
    for (const b of recent) {
      const name = b.symbol ? `$${escapeHtml(b.symbol)}` : `<code>${shortAddress(b.mint, 4)}</code>`;
      lines.push(`${STATUS_ICON[b.status] || '•'} ${name}${b.status === 'bought' ? '' : ` — ${escapeHtml(b.error || b.status)}`}`);
    }
  }
  lines.push('', `<i>Fee ${bpsToPercent(config.fees.snipeBps)} per buy. Your slippage, Jito tip and MEV settings apply.</i>`);
  return { text: lines.join('\n'), rules };
}

function showPump(ctx) {
  const { text, rules } = pumpText(ctx.from.id);
  return respond(ctx, text, pumpMenu(rules));
}

// "/pump launch 0.05 max=3 kw=cat dev=5 unsafe"
function parseArgs(args) {
  const [mode, amount, ...rest] = args;
  const opts = { safety: true };
  for (const part of rest) {
    const [key, ...value] = part.split('=');
    const v = value.join('=');
    if (key.toLowerCase() === 'unsafe' && !v) opts.safety = false;
    else if (key === 'max') opts.maxBuys = Number(v);
    else if (key === 'kw') opts.keyword = v;
    else if (key === 'dev') opts.maxDevPct = v;
    else throw new UserError(`Unknown option “${part}”.`);
  }
  return { mode: (mode || '').toLowerCase().replace(/^migrate$/, 'migration'), amount, opts };
}

async function handlePump(ctx) {
  const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
  if (!args.length) return showPump(ctx);
  try {
    const { mode, amount, opts } = parseArgs(args);
    if (!amount) return showPump(ctx);
    const rule = pumpService.createRule(ctx.from.id, mode, amount, opts);
    const what = rule.mode === 'launch' ? 'new pump.fun launches' : 'pump.fun migrations';
    return respond(
      ctx,
      `💊 <b>Rule armed</b>\n\n${ruleLine(rule, 0).replace(/^1\. /, '')}\n\n` +
        `Buys ${what} for ${escapeHtml(rule.amount)} SOL each until ${rule.max_buys} are bought. You get a message for every buy.`,
      backOnly('menu:pump'),
    );
  } catch (err) {
    return respond(ctx, `❌ ${escapeHtml(friendlyError(err))}`, backOnly('menu:pump'));
  }
}

function register(bot) {
  bot.command('pump', handlePump);
  bot.callbackQuery('menu:pump', showPump);
  bot.callbackQuery(/^pr:x:(\d+)$/, async (ctx) => {
    const ok = pumpService.stopRule(ctx.from.id, Number(ctx.match[1]));
    await ctx.answerCallbackQuery(ok ? 'Rule stopped' : 'Already stopped').catch(() => {});
    return showPump(ctx);
  });
}

module.exports = { register };
