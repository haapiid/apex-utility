const { InlineKeyboard } = require('grammy');
const transparencyService = require('../../services/transparencyService');
const { respond } = require('../helpers');
const { formatUsd, formatNumber, formatNative, shortAddress, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');
const { getChain, evmChains, addressLink } = require('../../config/chains');
const logger = require('../../utils/logger');

// /transparency: where the fees went, from ApeX's own books (same numbers as ApeX Pro's Fees & pools page).
// Totals only, nothing about any single user.

function countdown(at) {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

const link = (chain, address) => `<a href="${addressLink(chain, address)}">${shortAddress(address, 5)}</a>`;

function render(d) {
  const fee = (c, v) => (c.feeUnit === 'SOL' ? `${formatNumber(v, 4)} SOL` : formatUsd(v));
  const active = d.chains.filter((c) => c.all.trades > 0 || c.pool > 0n || c.referral > 0n || c.distributed > 0n);
  const idle = d.chains.filter((c) => !active.includes(c)).map((c) => getChain(c.chain).name);

  const lines = [
    '🔎 <b>ApeX Fees &amp; Pools</b> — open books',
    '',
    `💸 Fee: ${bpsToPercent(d.fees.manualBps)} trades • ${bpsToPercent(d.fees.snipeBps)} snipes • ${bpsToPercent(d.fees.autoBps)} limit/DCA/copy`,
    `🔀 Split: ${bpsToPercent(d.split.referralBps)} to the referrer → ${bpsToPercent(d.split.holderBps)} of the rest to $APEX holders → the rest runs ApeX`,
    d.apexLive
      ? `⏳ Next holder distribution in <b>${countdown(d.nextEpochAt)}</b> (every ${d.epochHours}h)`
      : '⏳ Holder distributions start when $APEX launches. Until then the pools keep filling.',
  ];

  for (const c of active) {
    const chain = getChain(c.chain);
    lines.push(
      '',
      `⛓ <b>${chain.name}</b>`,
      `   Fees: 24h ${fee(c, c.day.fees)} • 30d ${fee(c, c.month.fees)} • all ${fee(c, c.all.fees)} (${formatNumber(c.all.trades, 0)} trades)`,
      `   Referral ${formatNative(c.referral, chain, 6)} • Holder pool <b>${formatNative(c.pool, chain, 6)}</b>`,
      `   Paid to holders ${formatNative(c.distributed, chain, 6)} • Claimed ${formatNative(c.claimed, chain, 6)}`,
    );
  }
  if (!active.length) lines.push('', '<i>No trades yet.</i>');
  else if (idle.length) lines.push('', `<i>No activity yet on ${idle.join(', ')}.</i>`);
  lines.push('', `🎁 Cashback in $APEX: ${formatUsd(d.cashback.earnedUsd)} earned • ${formatUsd(d.cashback.claimedUsd)} claimed`);

  // Wallets anyone can check on an explorer (the EVM treasury is the same address on every EVM chain)
  const sol = d.chains.find((c) => c.chain === 'sol');
  const evm = d.chains.find((c) => getChain(c.chain).kind === 'evm');
  const evmChain = evmChains()[0];
  const wallets = [];
  if (sol?.treasury) wallets.push(`🏦 Treasury (Solana): ${link(getChain('sol'), sol.treasury)}${sol.treasuryBalance != null ? ` • ${formatNative(sol.treasuryBalance, getChain('sol'), 4)}` : ''}`);
  if (evm?.treasury) wallets.push(`🏦 Treasury (EVM, all chains): ${link(evmChain, evm.treasury)}`);
  if (sol?.rewardsWallet) wallets.push(`💰 Rewards wallet (Solana): ${link(getChain('sol'), sol.rewardsWallet)}${sol.rewardsBalance != null ? ` • ${formatNative(sol.rewardsBalance, getChain('sol'), 4)}` : ''}`);
  if (evm?.rewardsWallet) wallets.push(`💰 Rewards wallet (EVM): ${link(evmChain, evm.rewardsWallet)}`);
  lines.push('', ...(wallets.length ? wallets : ['🏦 Treasury and rewards wallets are not set up yet.']));

  lines.push('', `<i>Totals only. Updated every minute. Solana fees in SOL, EVM fees in USD at trade time.</i>`);
  return lines.join('\n');
}

function menu() {
  const kb = new InlineKeyboard().text('🔄 Refresh', 'menu:transparency');
  // Telegram only accepts public https links on buttons
  if (config.web.publicUrl.startsWith('https://')) kb.url('🌐 Full dashboard', `${config.web.publicUrl}/#/transparency`);
  return kb.row().text('⬅️ Back', 'menu:main');
}

async function show(ctx) {
  try {
    return await respond(ctx, render(await transparencyService.overview()), menu());
  } catch (err) {
    logger.error({ err: err.message }, '/transparency failed');
    return respond(ctx, '❌ Could not load the numbers. Try again in a minute.', menu());
  }
}

function register(bot) {
  bot.command(['transparency', 'pools'], show);
  bot.callbackQuery('menu:transparency', show);
}

module.exports = { register };
