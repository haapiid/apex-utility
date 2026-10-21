const crypto = require('crypto');
const { Keypair, PublicKey, SystemProgram, Transaction } = require('@solana/web3.js');
const { Contract, Wallet } = require('ethers');
const bs58 = require('bs58').default;
const { db, transaction, getMeta, setMeta } = require('../db');
const connection = require('./connection');
const markets = require('./markets');
const walletService = require('./walletService');
const solanaToken = require('./solanaToken');
const { getProvider } = require('./evm/provider');
const { UserError, withUserLock } = require('./tradeCommon');
const { config } = require('../config');
const { getChain, allChains } = require('../config/chains');
const { toUnits, fromUnits } = require('../utils/format');
const logger = require('../utils/logger');

/**
 * Money flow per trade fee (in the trade chain's native coin):
 *   referral cut   = fee × REFERRAL_SHARE_BPS            → the referrer (if any)
 *   holder share   = (fee − referral) × REVENUE_SHARE_BPS → revenue_pool, distributed every epoch
 *   rest           → stays in the treasury
 *   cashback       = fee in USD × CASHBACK_MULTIPLIER     → paid in $APEX when claimed
 * Holders = ApeX users holding ≥ APEX_MIN_HOLD $APEX across their wallets on the token's chain,
 * paid pro-rata to their holdings. Claims are sent from the rewards wallet (users pay no gas).
 */

const DEAD = '0x000000000000000000000000000000000000dEaD';
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const MIN_CASHBACK_CLAIM_USD = 1;
const MAX_EXTRA_WALLET_SLOTS = 5;
const big = (v) => BigInt(v || 0);

// ---------- $APEX ----------

// { chain, address } when the token is configured, else null
function apexToken() {
  if (!config.apex.address) return null;
  const chain = getChain(config.apex.chain);
  if (!chain?.tradable) {
    logger.warn({ chain: config.apex.chain }, 'APEX_TOKEN_CHAIN is not a tradable chain');
    return null;
  }
  return { chain, address: config.apex.address };
}

async function apexInfo(owner) {
  const apex = apexToken();
  if (!apex) return null;
  const token = await markets.serviceFor(apex.chain).getTokenInfo(apex.address, owner);
  return { ...apex, token };
}

async function apexPriceUsd() {
  const info = await apexInfo();
  if (!info) return null;
  if (info.token.usdPrice) return info.token.usdPrice;
  return (await markets.serviceFor(info.chain).previewRate(info.token)).usdPrice;
}

// ---------- Referral ----------

function refCode(userId) {
  walletService.ensureUser(userId);
  const row = db.prepare('SELECT ref_code FROM users WHERE id = ?').get(userId);
  if (row.ref_code) return row.ref_code;
  for (;;) {
    const code = crypto.randomBytes(5).toString('base64url').replace(/[-_]/g, '').slice(0, 7).toLowerCase();
    if (code.length < 6) continue;
    try {
      db.prepare('UPDATE users SET ref_code = ? WHERE id = ?').run(code, userId);
      return code;
    } catch (err) {
      if (!/UNIQUE/.test(err.message)) throw err;
    }
  }
}

// Links a new user to whoever invited them. Only before their first trade, never to themselves.
function bindReferrer(userId, code) {
  walletService.ensureUser(userId);
  const user = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(userId);
  if (user.referrer_id) return { ok: false, reason: 'already' };
  const referrer = db.prepare('SELECT id FROM users WHERE ref_code = ?').get(String(code).toLowerCase());
  if (!referrer || referrer.id === userId) return { ok: false, reason: 'invalid' };
  const traded = db.prepare('SELECT 1 FROM trades WHERE user_id = ? LIMIT 1').get(userId);
  if (traded) return { ok: false, reason: 'existing' };
  db.prepare('UPDATE users SET referrer_id = ? WHERE id = ?').run(referrer.id, userId);
  return { ok: true, referrerId: referrer.id };
}

function referralStats(userId) {
  const invited = db.prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?').get(userId).n;
  const rows = db.prepare("SELECT chain, amount FROM rewards WHERE user_id = ? AND kind = 'referral'").all(userId);
  const earned = {};
  for (const r of rows) earned[r.chain] = (earned[r.chain] || 0n) + big(r.amount);
  return { invited, earned };
}

// ---------- Fee split (called after every trade that charged a fee) ----------

function poolAdd(chain, amount) {
  if (amount <= 0n) return;
  const current = big(db.prepare('SELECT amount FROM revenue_pool WHERE chain = ?').get(chain)?.amount);
  db.prepare('INSERT INTO revenue_pool (chain, amount) VALUES (?, ?) ON CONFLICT (chain) DO UPDATE SET amount = excluded.amount').run(
    chain,
    (current + amount).toString(),
  );
}

function onTradeFee({ userId, chain, feeRaw, feeUsd = 0, ref = null }) {
  if (!(feeRaw > 0n)) return;
  try {
    transaction(() => {
      const now = Date.now();
      const referrer = db.prepare('SELECT referrer_id FROM users WHERE id = ?').get(userId)?.referrer_id;
      let rest = feeRaw;
      if (referrer && config.referral.shareBps > 0) {
        const cut = (feeRaw * BigInt(config.referral.shareBps)) / 10_000n;
        db.prepare("INSERT INTO rewards (user_id, chain, kind, amount, usd, ref, created_at) VALUES (?, ?, 'referral', ?, ?, ?, ?)").run(
          referrer,
          chain,
          cut.toString(),
          (feeUsd * config.referral.shareBps) / 10_000,
          ref,
          now,
        );
        rest -= cut;
      }
      poolAdd(chain, (rest * BigInt(config.revenue.revenueShareBps)) / 10_000n);
      if (config.apex.cashbackMultiplier > 0 && feeUsd > 0) {
        db.prepare("INSERT INTO rewards (user_id, chain, kind, usd, ref, created_at) VALUES (?, 'apex', 'cashback', ?, ?, ?)").run(
          userId,
          feeUsd * config.apex.cashbackMultiplier,
          ref,
          now,
        );
      }
    });
  } catch (err) {
    // Never fail a confirmed trade because of bookkeeping
    logger.error({ err: err.message, userId, chain, fee: String(feeRaw) }, 'Fee split failed');
  }
}

// ---------- Balances ----------

// Native rewards per chain: { [chain]: { referral, revenue, claimed, available } } (raw bigints)
function nativeBalances(userId) {
  const out = {};
  const get = (c) => (out[c] ||= { referral: 0n, revenue: 0n, claimed: 0n, available: 0n });
  for (const r of db.prepare("SELECT chain, kind, amount FROM rewards WHERE user_id = ? AND kind IN ('referral', 'revenue')").all(userId)) {
    get(r.chain)[r.kind] += big(r.amount);
  }
  for (const c of db.prepare("SELECT chain, amount FROM claims WHERE user_id = ? AND kind = 'native' AND status != 'failed'").all(userId)) {
    get(c.chain).claimed += big(c.amount);
  }
  for (const b of Object.values(out)) b.available = b.referral + b.revenue - b.claimed;
  return out;
}

function cashbackBalance(userId) {
  const earned = db.prepare("SELECT COALESCE(SUM(usd), 0) AS v FROM rewards WHERE user_id = ? AND kind = 'cashback'").get(userId).v;
  const claimed = db.prepare("SELECT COALESCE(SUM(usd), 0) AS v FROM claims WHERE user_id = ? AND kind = 'cashback' AND status != 'failed'").get(userId).v;
  return { earnedUsd: earned, claimedUsd: claimed, availableUsd: Math.max(0, earned - claimed) };
}

const pools = () =>
  Object.fromEntries(db.prepare('SELECT chain, amount FROM revenue_pool').all().map((r) => [r.chain, big(r.amount)]));

function nextEpochAt() {
  let last = Number(getMeta('last_epoch_at') || 0);
  if (!last) {
    // First run: the first epoch starts now
    last = Date.now();
    setMeta('last_epoch_at', last);
  }
  return last + config.revenue.epochHours * 3_600_000;
}

const lastEpochs = (limit = 10) => db.prepare('SELECT * FROM epochs ORDER BY id DESC LIMIT ?').all(limit);

// ---------- Distribution ----------

const minHoldRaw = (decimals) => BigInt(config.apex.minHold) * 10n ** BigInt(decimals);

// $APEX held by each ApeX user across all their wallets on the token's chain
async function snapshotHolders() {
  const apex = apexToken();
  if (!apex) return null;
  const svc = markets.serviceFor(apex.chain);
  const wallets = db.prepare('SELECT user_id, address FROM wallets WHERE kind = ?').all(apex.chain.kind);
  const byUser = new Map();
  let decimals = null;
  for (const w of wallets) {
    try {
      const token = await svc.getTokenInfo(apex.address, w.address);
      decimals = token.decimals;
      if (token.balance > 0n) byUser.set(w.user_id, (byUser.get(w.user_id) || 0n) + token.balance);
    } catch (err) {
      logger.warn({ wallet: w.address, err: err.message }, 'Holder snapshot: balance read failed');
    }
  }
  if (decimals == null) return { holders: new Map(), total: 0n };
  const holders = new Map([...byUser].filter(([, held]) => held >= minHoldRaw(decimals)));
  const total = [...holders.values()].reduce((a, b) => a + b, 0n);
  return { holders, total, decimals };
}

// Splits every pool among eligible holders. Rounding dust stays in the pool for next time.
async function distribute() {
  const snap = await snapshotHolders();
  const now = Date.now();
  setMeta('last_epoch_at', now);
  if (!snap) return { ok: false, reason: '$APEX is not configured yet' };
  if (snap.total === 0n) return { ok: false, reason: 'No eligible holders yet' };

  const results = [];
  const perUser = new Map(); // userId → { [chain]: amount }
  transaction(() => {
    for (const [chain, amount] of Object.entries(pools())) {
      if (amount <= 0n) continue;
      let paid = 0n;
      const insert = db.prepare("INSERT INTO rewards (user_id, chain, kind, amount, ref, created_at) VALUES (?, ?, 'revenue', ?, ?, ?)");
      for (const [userId, held] of snap.holders) {
        const share = (amount * held) / snap.total;
        if (share <= 0n) continue;
        insert.run(userId, chain, share.toString(), `epoch:${now}`, now);
        paid += share;
        perUser.set(userId, { ...perUser.get(userId), [chain]: share });
      }
      db.prepare('UPDATE revenue_pool SET amount = ? WHERE chain = ?').run((amount - paid).toString(), chain);
      db.prepare('INSERT INTO epochs (chain, amount, holders, total_held, at) VALUES (?, ?, ?, ?, ?)').run(
        chain,
        paid.toString(),
        snap.holders.size,
        snap.total.toString(),
        now,
      );
      results.push({ chain, paid, holders: snap.holders.size });
    }
  });
  logger.info({ results: results.map((r) => ({ ...r, paid: String(r.paid) })) }, 'Revenue distributed');
  return { ok: true, results, perUser, holders: snap.holders.size };
}

// ---------- Rewards wallet ----------

function rewardsKeypair() {
  return config.rewardsWallet.solKey ? Keypair.fromSecretKey(bs58.decode(config.rewardsWallet.solKey.trim())) : null;
}

function rewardsSigner(chain) {
  const key = config.rewardsWallet.evmKey.trim();
  return key ? new Wallet(key.startsWith('0x') ? key : `0x${key}`, getProvider(chain)) : null;
}

function rewardsAddress(kind) {
  if (kind === 'sol') return rewardsKeypair()?.publicKey.toBase58() || null;
  return config.rewardsWallet.evmKey ? new Wallet(config.rewardsWallet.evmKey.trim().replace(/^(?!0x)/, '0x')).address : null;
}

async function sendSolana(keypair, instructions) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
  tx.sign(keypair);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) throw new Error('Transaction failed on-chain');
  return signature;
}

// Reserves the claim first (so a double tap can't pay twice), sends, then marks it sent or failed
async function payClaim({ userId, chain, kind, amount, usd = 0, send }) {
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO claims (user_id, chain, kind, amount, usd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(userId, chain, kind, amount.toString(), usd, 'pending', now, now);
  const id = Number(lastInsertRowid);
  try {
    const signature = await send();
    db.prepare("UPDATE claims SET status = 'sent', signature = ?, updated_at = ? WHERE id = ?").run(signature, Date.now(), id);
    logger.info({ userId, chain, kind, amount: String(amount), signature }, 'Claim paid');
    return signature;
  } catch (err) {
    db.prepare("UPDATE claims SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(String(err.message).slice(0, 300), Date.now(), id);
    logger.error({ userId, chain, kind, err: err.message }, 'Claim failed');
    throw new UserError('The rewards wallet couldn’t send your claim right now. Nothing was deducted; please try again later.');
  }
}

// ---------- Claims ----------

async function claimNative(userId, chainKey) {
  const chain = getChain(chainKey);
  if (!chain?.tradable) throw new UserError('Unknown chain.');
  return withUserLock(userId, async () => {
    const available = nativeBalances(userId)[chain.key]?.available || 0n;
    const min = toUnits(chain.claimMin, chain.decimals);
    if (available < min) throw new UserError(`You can claim from ${chain.claimMin} ${chain.native}.`);
    const dest = walletService.getWallet(userId, chain.kind);
    if (!dest) throw new UserError(`Create a ${walletService.KIND_LABEL[chain.kind]} wallet first to receive your rewards.`);

    if (chain.kind === 'sol') {
      const keypair = rewardsKeypair();
      if (!keypair) throw new UserError('Claims are not open yet.');
      const signature = await payClaim({
        userId,
        chain: chain.key,
        kind: 'native',
        amount: available,
        send: () =>
          sendSolana(keypair, [SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(dest.address), lamports: available })]),
      });
      return { chain, amount: available, signature, to: dest };
    }
    const signer = rewardsSigner(chain);
    if (!signer) throw new UserError('Claims are not open yet.');
    const signature = await payClaim({
      userId,
      chain: chain.key,
      kind: 'native',
      amount: available,
      send: async () => {
        const sent = await signer.sendTransaction({ to: dest.address, value: available });
        const receipt = await sent.wait(1, 120_000);
        if (receipt?.status !== 1) throw new Error('Transfer reverted');
        return sent.hash;
      },
    });
    return { chain, amount: available, signature, to: dest };
  });
}

// Pays the cashback balance in $APEX at the current price
async function claimCashback(userId) {
  const apex = apexToken();
  if (!apex) throw new UserError('Cashback is paid in $APEX, which hasn’t launched yet. Your cashback keeps adding up until then.');
  return withUserLock(userId, async () => {
    const { availableUsd } = cashbackBalance(userId);
    if (availableUsd < MIN_CASHBACK_CLAIM_USD) throw new UserError(`You can claim cashback from $${MIN_CASHBACK_CLAIM_USD}.`);
    const dest = walletService.getWallet(userId, apex.chain.kind);
    if (!dest) throw new UserError(`Create a ${walletService.KIND_LABEL[apex.chain.kind]} wallet first to receive $APEX.`);
    const price = await apexPriceUsd();
    if (!price) throw new UserError('$APEX has no price yet. Try again once it trades.');
    const { token } = await apexInfo();
    const amount = toUnits((availableUsd / price).toFixed(token.decimals), token.decimals);
    if (amount <= 0n) throw new UserError('Nothing to claim yet.');

    let send;
    if (apex.chain.kind === 'sol') {
      const keypair = rewardsKeypair();
      if (!keypair) throw new UserError('Claims are not open yet.');
      const program = await solanaToken.tokenProgramOf(apex.address);
      const from = keypair.publicKey.toBase58();
      send = () =>
        sendSolana(keypair, [
          solanaToken.createAtaIdempotentIx(from, dest.address, apex.address, program),
          solanaToken.transferCheckedIx({ from, to: dest.address, mint: apex.address, amount, decimals: token.decimals, program }),
        ]);
    } else {
      const signer = rewardsSigner(apex.chain);
      if (!signer) throw new UserError('Claims are not open yet.');
      send = async () => {
        const sent = await new Contract(apex.address, ERC20_ABI, signer).transfer(dest.address, amount);
        const receipt = await sent.wait(1, 120_000);
        if (receipt?.status !== 1) throw new Error('Transfer reverted');
        return sent.hash;
      };
    }
    const signature = await payClaim({ userId, chain: 'apex', kind: 'cashback', amount, usd: availableUsd, send });
    return { chain: apex.chain, amount, decimals: token.decimals, usd: availableUsd, signature };
  });
}

// ---------- Burn → credits ----------

function credits(userId) {
  walletService.ensureUser(userId);
  return db.prepare('SELECT credits, extra_wallet_slots FROM users WHERE id = ?').get(userId);
}

async function burnApex(userId, amountText) {
  const apex = apexToken();
  if (!apex) throw new UserError('Burning needs $APEX, which hasn’t launched yet.');
  const whole = Number(amountText);
  if (!(whole > 0)) throw new UserError('Send a positive $APEX amount.');
  return withUserLock(userId, async () => {
    const wallet = walletService.getWallet(userId, apex.chain.kind);
    if (!wallet) throw new UserError('You need a wallet holding $APEX.');
    const { token } = await apexInfo(wallet.address);
    const amount = toUnits(String(amountText).trim(), token.decimals);
    if (amount > token.balance) throw new UserError(`Your active wallet holds ${fromUnits(token.balance, token.decimals)} $APEX.`);
    const earned = Math.floor(whole * config.apex.creditsPerToken);
    if (earned < 1) throw new UserError('That burn is too small to earn a credit.');

    let signature;
    if (apex.chain.kind === 'sol') {
      const { keypair } = walletService.getActiveKeypair(userId);
      const program = await solanaToken.tokenProgramOf(apex.address);
      signature = await sendSolana(keypair, [
        solanaToken.burnCheckedIx({ owner: wallet.address, mint: apex.address, amount, decimals: token.decimals, program }),
      ]);
    } else {
      // ERC-20s rarely allow burning to address(0): send to the dead address instead
      const { signer } = walletService.getActiveEvmSigner(userId, getProvider(apex.chain));
      const sent = await new Contract(apex.address, ERC20_ABI, signer).transfer(DEAD, amount);
      const receipt = await sent.wait(1, 120_000);
      if (receipt?.status !== 1) throw new UserError('The burn transaction failed.');
      signature = sent.hash;
    }
    transaction(() => {
      db.prepare('INSERT INTO burns (user_id, amount, credits, signature, created_at) VALUES (?, ?, ?, ?, ?)').run(
        userId,
        amount.toString(),
        earned,
        signature,
        Date.now(),
      );
      db.prepare('UPDATE users SET credits = credits + ? WHERE id = ?').run(earned, userId);
    });
    logger.info({ userId, amount: String(amount), credits: earned, signature }, 'APEX burned');
    return { chain: apex.chain, amount, decimals: token.decimals, credits: earned, signature };
  });
}

// Spends credits on one more wallet slot per kind
function buyWalletSlot(userId) {
  return transaction(() => {
    const { credits: have, extra_wallet_slots: slots } = credits(userId);
    if (slots >= MAX_EXTRA_WALLET_SLOTS) throw new UserError(`You already have the maximum of ${MAX_EXTRA_WALLET_SLOTS} extra slots.`);
    if (have < config.apex.walletSlotCredits) throw new UserError(`An extra wallet slot costs ${config.apex.walletSlotCredits} credits.`);
    db.prepare('UPDATE users SET credits = credits - ?, extra_wallet_slots = extra_wallet_slots + 1 WHERE id = ?').run(
      config.apex.walletSlotCredits,
      userId,
    );
    return credits(userId);
  });
}

// ---------- Admin overview ----------

// What users are owed per chain vs. what the rewards wallet holds
async function liabilities() {
  const owed = {};
  for (const r of db.prepare("SELECT chain, amount FROM rewards WHERE kind IN ('referral', 'revenue')").all()) {
    owed[r.chain] = (owed[r.chain] || 0n) + big(r.amount);
  }
  for (const c of db.prepare("SELECT chain, amount FROM claims WHERE kind = 'native' AND status != 'failed'").all()) {
    owed[c.chain] = (owed[c.chain] || 0n) - big(c.amount);
  }
  const rows = [];
  for (const chain of allChains().filter((c) => c.tradable)) {
    const address = rewardsAddress(chain.kind);
    let balance = null;
    if (address) balance = await markets.serviceFor(chain).getNativeBalance(address).catch(() => null);
    rows.push({ chain, owed: owed[chain.key] || 0n, pool: pools()[chain.key] || 0n, balance, address });
  }
  const cashbackUsd = db.prepare("SELECT COALESCE(SUM(usd), 0) AS v FROM rewards WHERE kind = 'cashback'").get().v -
    db.prepare("SELECT COALESCE(SUM(usd), 0) AS v FROM claims WHERE kind = 'cashback' AND status != 'failed'").get().v;
  return { rows, cashbackUsd };
}

module.exports = {
  apexToken,
  apexInfo,
  apexPriceUsd,
  refCode,
  bindReferrer,
  referralStats,
  onTradeFee,
  nativeBalances,
  cashbackBalance,
  pools,
  nextEpochAt,
  lastEpochs,
  snapshotHolders,
  distribute,
  rewardsAddress,
  claimNative,
  claimCashback,
  credits,
  burnApex,
  buyWalletSlot,
  liabilities,
  MAX_EXTRA_WALLET_SLOTS,
};
