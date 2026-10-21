const rewardsService = require('../../services/rewardsService');
const walletService = require('../../services/walletService');
const { friendlyError } = require('../../services/tradeCommon');
const { rewardsMenu, confirmMenu, backOnly } = require('../keyboards');
const { respond, editProgress, setPending } = require('../helpers');
const { formatNative, formatNumber, formatUsd, fromUnits, toUnits, escapeHtml, bpsToPercent } = require('../../utils/format');
const { config } = require('../../config');
const { allChains, getChain, txLink } = require('../../config/chains');
const logger = require('../../utils/logger');

const tradable = () => allChains().filter((c) => c.tradable);

function countdown(at) {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

async function apexLine(userId) {
  const apex = rewardsService.apexToken();
  if (!apex) return `🍌 <b>$${config.revenue.tokenSymbol}</b> launches soon. Revenue share and cashback start counting now.`;
  const wallets = walletService.listWallets(userId, apex.chain.kind);
  let held = 0n;
  let decimals = 0;
  for (const w of wallets) {
    const info = await rewardsService.apexInfo(w.address).catch(() => null);
    if (info) {
      held += info.token.balance;
      decimals = info.token.decimals;
    }
  }
  const whole = Number(fromUnits(held, decimals));
  const eligible = whole >= config.apex.minHold;
  return (
    `🍌 You hold <b>${formatNumber(whole, 2)} $${config.revenue.tokenSymbol}</b> in your ApeX wallets ` +
    (eligible ? '✅ eligible for revenue share' : `(hold ${config.apex.minHold}+ to earn revenue share)`)
  );
}

async function showRewards(ctx) {
  const userId = ctx.from.id;
  const balances = rewardsService.nativeBalances(userId);
  const cashback = rewardsService.cashbackBalance(userId);
  const { credits, extra_wallet_slots: slots } = rewardsService.credits(userId);
  const apexLive = Boolean(rewardsService.apexToken());

  const lines = ['💰 <b>Rewards</b>', '', '<b>Claimable</b> (sent by ApeX, you pay no gas)'];
  const claimable = [];
  for (const chain of tradable()) {
    const b = balances[chain.key];
    if (!b || (b.available === 0n && b.claimed === 0n)) continue;
    lines.push(
      `${chain.kind === 'sol' ? '◎' : '⟠'} ${chain.name}: <b>${formatNative(b.available, chain, 8)}</b>` +
        ` <i>(referral ${formatNative(b.referral, chain, 6)} • revenue ${formatNative(b.revenue, chain, 6)})</i>`,
    );
    if (b.available > 0n) claimable.push(chain);
  }
  if (!claimable.length && lines.length === 3) lines.push('<i>Nothing yet. Invite friends or hold $APEX to earn.</i>');
  lines.push(
    '',
    `🎁 <b>Cashback:</b> ${formatUsd(cashback.availableUsd)} in $${config.revenue.tokenSymbol}` +
      ` <i>(${Math.round(config.apex.cashbackMultiplier * 100)}% of the fees you pay)</i>`,
    '',
    await apexLine(userId),
    `⏳ Next revenue distribution in ${countdown(rewardsService.nextEpochAt())} (every ${config.revenue.epochHours}h)`,
    '',
    `🔥 <b>Credits:</b> ${credits} • extra wallet slots: ${slots}/${rewardsService.MAX_EXTRA_WALLET_SLOTS}`,
    `<i>Burn $${config.revenue.tokenSymbol} for credits (${config.apex.creditsPerToken} per token); a wallet slot costs ${config.apex.walletSlotCredits}.</i>`,
  );
  return respond(
    ctx,
    lines.join('\n'),
    rewardsMenu({ claimable, cashback: cashback.availableUsd > 0 && apexLive, apexLive, slotCost: config.apex.walletSlotCredits }),
  );
}

async function showReferral(ctx) {
  const userId = ctx.from.id;
  const code = rewardsService.refCode(userId);
  const { invited, earned } = rewardsService.referralStats(userId);
  const link = `https://t.me/${ctx.me.username}?start=ref_${code}`;
  const earnedLines = Object.entries(earned).map(([chain, amount]) => `   ${formatNative(amount, getChain(chain), 8)}`);
  return respond(
    ctx,
    [
      '🎁 <b>Referral</b>',
      '',
      `Your link:\n<code>${link}</code>`,
      '',
      `Earn <b>${bpsToPercent(config.referral.shareBps)}</b> of the trading fees of everyone you invite, forever,`,
      'paid in the coin they trade with. Claim it in 💰 Rewards.',
      '',
      `👥 Invited: <b>${invited}</b>`,
      `💸 Earned:${earnedLines.length ? `\n${earnedLines.join('\n')}` : ' nothing yet'}`,
    ].join('\n'),
    backOnly('menu:rewards'),
  );
}

async function handleClaim(ctx, chainKey) {
  await ctx.answerCallbackQuery().catch(() => {});
  const message = ctx.callbackQuery.message;
  await editProgress(ctx, message, '💸 Sending your rewards…');
  try {
    const { chain, amount, signature } = await rewardsService.claimNative(ctx.from.id, chainKey);
    await editProgress(
      ctx,
      message,
      `✅ <b>Claimed ${formatNative(amount, chain, 8)}</b> to your active ${chain.name} wallet.\n🔗 <a href="${txLink(chain, signature)}">View transaction</a>`,
      backOnly('menu:rewards'),
    );
  } catch (err) {
    logger.warn({ userId: ctx.from.id, chain: chainKey, err: err.message }, 'Claim refused');
    await editProgress(ctx, message, `❌ ${escapeHtml(friendlyError(err))}`, backOnly('menu:rewards'));
  }
}

async function handleCashback(ctx) {
  await ctx.answerCallbackQuery().catch(() => {});
  const message = ctx.callbackQuery.message;
  await editProgress(ctx, message, '🎁 Sending your cashback…');
  try {
    const r = await rewardsService.claimCashback(ctx.from.id);
    await editProgress(
      ctx,
      message,
      `✅ <b>Claimed ${formatNumber(fromUnits(r.amount, r.decimals), 4)} $${config.revenue.tokenSymbol}</b> (${formatUsd(r.usd)}).\n` +
        `🔗 <a href="${txLink(r.chain, r.signature)}">View transaction</a>`,
      backOnly('menu:rewards'),
    );
  } catch (err) {
    await editProgress(ctx, message, `❌ ${escapeHtml(friendlyError(err))}`, backOnly('menu:rewards'));
  }
}

// Typed burn amount (routed from commands/text.js)
async function handleBurnInput(ctx) {
  const amount = ctx.message.text.trim();
  try {
    toUnits(amount, 18);
  } catch {
    setPending(ctx.from.id, 'burn');
    return ctx.reply('❌ Send a number, e.g. 100 (or /cancel)');
  }
  return respond(
    ctx,
    `🔥 Burn <b>${escapeHtml(amount)} $${config.revenue.tokenSymbol}</b> for ${Math.floor(Number(amount) * config.apex.creditsPerToken)} credits?\n` +
      'Burned tokens are gone forever.',
    confirmMenu(`rw:burn:${amount}`, 'Burn', 'menu:rewards'),
  );
}

async function handleBurnConfirm(ctx, amount) {
  await ctx.answerCallbackQuery().catch(() => {});
  const message = ctx.callbackQuery.message;
  await editProgress(ctx, message, '🔥 Burning…');
  try {
    const r = await rewardsService.burnApex(ctx.from.id, amount);
    await editProgress(
      ctx,
      message,
      `🔥 <b>Burned ${formatNumber(fromUnits(r.amount, r.decimals), 4)} $${config.revenue.tokenSymbol}</b> → +${r.credits} credits.\n` +
        `🔗 <a href="${txLink(r.chain, r.signature)}">View transaction</a>`,
      backOnly('menu:rewards'),
    );
  } catch (err) {
    await editProgress(ctx, message, `❌ ${escapeHtml(friendlyError(err))}`, backOnly('menu:rewards'));
  }
}

function register(bot) {
  bot.command(['rewards', 'claim'], showRewards);
  bot.callbackQuery('menu:rewards', showRewards);
  bot.command(['referral', 'invite'], showReferral);
  bot.callbackQuery('menu:referral', showReferral);

  bot.callbackQuery(/^rw:c:([a-z]+)$/, (ctx) => handleClaim(ctx, ctx.match[1]));
  bot.callbackQuery('rw:cb', handleCashback);
  bot.callbackQuery('rw:burn', async (ctx) => {
    setPending(ctx.from.id, 'burn');
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`🔥 How many $${config.revenue.tokenSymbol} do you want to burn from your active wallet?\n\nType /cancel to abort.`);
  });
  bot.callbackQuery(/^rw:burn:([\d.]+):confirm$/, (ctx) => handleBurnConfirm(ctx, ctx.match[1]));
  bot.callbackQuery('rw:slot', async (ctx) => {
    try {
      rewardsService.buyWalletSlot(ctx.from.id);
      await ctx.answerCallbackQuery('➕ Extra wallet slot unlocked').catch(() => {});
    } catch (err) {
      await ctx.answerCallbackQuery({ text: friendlyError(err), show_alert: true }).catch(() => {});
    }
    return showRewards(ctx);
  });
}

module.exports = { register, handleBurnInput };
