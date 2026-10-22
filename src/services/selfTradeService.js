const { getAddress } = require('ethers');
const markets = require('./markets');
const jupiter = require('./jupiterService');
const solanaRpc = require('./solanaRpc');
const settingsService = require('./settingsService');
const accountService = require('./accountService');
const statsService = require('./statsService');
const { db } = require('../db');
const { config, isSolanaAddress } = require('../config');
const { SOL_MINT } = require('../config/solana');
const { isEvmAddress } = require('../config/chains');
const { fromUnits } = require('../utils/format');
const { UserError } = require('./tradeCommon');
const { getSolPriceUsd } = require('./priceService');
const logger = require('../utils/logger');

// Trading from the user's own browser wallet (Phantom, MetaMask, …). ApeX never holds that key:
//   prepare()  quotes and builds the swap (same routers and fee as ApeX wallets) for the wallet to sign;
//   confirm()  reads the signed transaction back from the chain and only then records the trade and its
//              fee, so referral / holder pool / cashback are credited on what the treasury really received.
// Only wallets the user proved they own (signed in or linked with them) can be used, so nobody can claim
// someone else's transaction.

const BUILD_TTL_MS = 3 * 60_000;
const CONFIRM_WAIT_MS = 90_000;
const POLL_MS = 3_000;
const builds = new Map(); // id → what we built, until confirmed or expired

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const big = (v) => BigInt(v ?? 0);

function prune() {
  const now = Date.now();
  for (const [id, b] of builds) if (b.expires < now) builds.delete(id);
}

// The user's proven wallets of one kind (identities from wallet sign-in / linking)
function ownWallets(userId, kind) {
  return accountService
    .identities(userId)
    .list.filter((i) => i.provider === kind)
    .map((i) => i.subject);
}

function checkOwner(userId, chain, owner) {
  const valid = chain.kind === 'sol' ? isSolanaAddress(owner) : isEvmAddress(owner);
  if (!valid) throw new UserError('That wallet address is not valid for this chain.');
  const mine = ownWallets(userId, chain.kind).some((a) => (chain.kind === 'sol' ? a === owner : a.toLowerCase() === owner.toLowerCase()));
  if (!mine) throw new UserError('Link this wallet to your account first: sign in with it once from the account menu.');
  return chain.kind === 'sol' ? owner : getAddress(owner.toLowerCase());
}

const alreadyRecorded = (signature) => Boolean(db.prepare('SELECT 1 FROM trades WHERE signature = ?').get(signature));

// ---------- prepare ----------

async function prepare({ userId, chain, address, side, amount, owner }) {
  prune();
  owner = checkOwner(userId, chain, owner);
  const svc = markets.serviceFor(chain);
  // Fee as for a manual trade; MEV tips are skipped because the wallet sends through its own RPC
  const opts = { ...settingsService.tradeOptions(userId, chain, 'manual', side), mevProtect: false };
  const quote = side === 'buy' ? await svc.quoteBuy(address, amount, owner, opts) : await svc.quoteSell(address, amount, owner, opts);
  settingsService.checkImpact(quote, opts);

  const id = require('node:crypto').randomBytes(12).toString('hex');
  const base = { id, userId, chain, side, owner, quote, feeBps: opts.feeBps, expires: Date.now() + BUILD_TTL_MS };
  let payload;

  if (chain.kind === 'sol') {
    // Only in-swap fees work here: the fallback (a second transfer) would need a second signature
    if (quote.feeMode === 'transfer') throw new UserError('Trading from your own wallet opens once ApeX’s fee account is set up.');
    const { swapTransaction } = await jupiter.buildSwapTransaction(quote.jupQuote, owner, {
      feeAccount: quote.feeMode === 'swap' ? quote.feeAccount : undefined,
      priorityMaxLamports: opts.priorityMaxLamports,
    });
    payload = { kind: 'sol', transaction: swapTransaction };
  } else {
    if (side === 'sell') {
      const approve = await svc.approvalFor(quote.token, owner, quote.routerAddress, quote.amountIn);
      // Approve first; the client asks again afterwards, so the swap gets a fresh route
      if (approve) return { id: null, approve: { ...approve, chainId: chain.chainId }, token: quote.token };
    }
    const tx = await svc.build(quote, owner);
    payload = { kind: 'evm', tx: { to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}`, chainId: chain.chainId } };
    base.router = tx.to.toLowerCase();
  }
  builds.set(id, base);
  return { id, ...payload, quote };
}

// ---------- confirm ----------

async function waitFor(fn) {
  const until = Date.now() + CONFIRM_WAIT_MS;
  for (;;) {
    const result = await fn().catch(() => null);
    if (result) return result;
    if (Date.now() > until) throw new UserError('The transaction was not confirmed in time. If it lands later, it shows in your wallet but not in ApeX stats.');
    await sleep(POLL_MS);
  }
}

// Solana: fee payer is the owner, it succeeded, it moved the token for the owner, and the treasury's
// wSOL fee account grew. The credited fee is what arrived (capped at what we quoted).
async function verifySolana(build, signature) {
  const tx = await waitFor(() => solanaRpc.getTransaction(signature));
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  if (keys[0] !== build.owner) throw new UserError('This transaction was not sent from your wallet.');
  if (tx.meta?.err) throw new UserError('The swap failed on-chain (price moved beyond slippage or the token blocks trading).');
  const mint = build.quote.token.address;
  const touched = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])].some((b) => b.mint === mint && b.owner === build.owner);
  if (!touched) throw new UserError('This transaction did not trade that token.');

  let feeCharged = 0n;
  if (build.quote.feeMode === 'swap') {
    const amountOf = (list) => big(list?.find((b) => b.mint === SOL_MINT && b.owner === config.revenue.treasury)?.uiTokenAmount?.amount);
    const delta = amountOf(tx.meta.postTokenBalances) - amountOf(tx.meta.preTokenBalances);
    feeCharged = delta > 0n ? (delta < build.quote.fee ? delta : build.quote.fee) : 0n;
  }
  return { feeCharged };
}

// EVM: mined, succeeded, from the owner to the router we built for. KyberSwap pays the fee in native coin
// inside the swap (no event), so it is credited when the treasury's balance grew by it in that block.
async function verifyEvm(build, hash) {
  const svc = markets.serviceFor(build.chain);
  const receipt = await waitFor(() => svc.provider.getTransactionReceipt(hash));
  if (receipt.from.toLowerCase() !== build.owner.toLowerCase()) throw new UserError('This transaction was not sent from your wallet.');
  if (receipt.status !== 1) throw new UserError('The swap failed on-chain (price moved beyond slippage or the token blocks trading).');
  if (receipt.to?.toLowerCase() !== build.router) throw new UserError('This transaction did not go through the swap we prepared.');

  let feeCharged = 0n;
  const fee = build.quote.fee;
  if (fee > 0n && config.evm.treasury) {
    try {
      const [before, after] = await Promise.all([
        svc.provider.getBalance(config.evm.treasury, receipt.blockNumber - 1),
        svc.provider.getBalance(config.evm.treasury, receipt.blockNumber),
      ]);
      if (after - before >= fee) feeCharged = fee;
    } catch (err) {
      logger.warn({ hash, err: err.message }, 'Could not check the fee of a self-custody trade');
    }
  }
  return { feeCharged };
}

async function confirm({ userId, id, signature }) {
  const build = builds.get(String(id || ''));
  if (!build || build.userId !== userId) throw new UserError('This trade expired. Review it again.');
  signature = String(signature || '').trim();
  if (!/^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/.test(signature)) throw new UserError('Invalid transaction id.');
  if (alreadyRecorded(signature)) throw new UserError('This transaction is already recorded.');

  const { chain, side, quote } = build;
  const { feeCharged } = chain.kind === 'sol' ? await verifySolana(build, signature) : await verifyEvm(build, signature);
  // Checked again after the wait; from here to recordTrade nothing awaits, so a double submit can't slip in
  if (alreadyRecorded(signature) || !builds.has(build.id)) throw new UserError('This transaction is already recorded.');
  builds.delete(build.id);

  const token = quote.token.address;
  if (chain.kind === 'sol') {
    const lamports = side === 'buy' ? quote.amountIn : quote.nativeOut;
    statsService.recordTrade({
      userId,
      chain: chain.key,
      side,
      source: 'wallet',
      token,
      solVolume: Number(fromUnits(lamports, 9)),
      feeSol: Number(fromUnits(feeCharged, 9)),
      signature,
    });
    if (feeCharged > 0n) {
      const solPrice = await getSolPriceUsd().catch(() => null);
      require('./rewardsService').onTradeFee({ userId, chain: chain.key, feeRaw: feeCharged, feeUsd: solPrice ? Number(fromUnits(feeCharged, 9)) * solPrice : 0, ref: signature });
    }
  } else {
    const usd = Number(side === 'buy' ? quote.routeSummary.amountInUsd : quote.routeSummary.amountOutUsd) || 0;
    const feeUsd = feeCharged > 0n ? (usd * build.feeBps) / 10_000 : 0;
    statsService.recordTrade({
      userId,
      chain: chain.key,
      side,
      source: 'wallet',
      token,
      nativeVolume: Number(fromUnits(side === 'buy' ? quote.amountIn : quote.nativeOut, chain.decimals)),
      volumeUsd: usd,
      feeUsd,
      signature,
    });
    if (feeCharged > 0n) require('./rewardsService').onTradeFee({ userId, chain: chain.key, feeRaw: feeCharged, feeUsd, ref: signature });
  }
  logger.info({ userId, chain: chain.key, side, signature, owner: build.owner, fee: String(feeCharged) }, 'Self-custody trade recorded');
  return { signature, feeCharged };
}

module.exports = { prepare, confirm, ownWallets };
