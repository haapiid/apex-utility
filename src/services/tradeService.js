const { PublicKey, SystemProgram, Transaction, VersionedTransaction } = require('@solana/web3.js');
const connection = require('./connection');
const jupiter = require('./jupiterService');
const jito = require('./jitoService');
const walletService = require('./walletService');
const statsService = require('./statsService');
const positionService = require('./positionService');
const settingsService = require('./settingsService');
const { config, feeBpsFor } = require('../config');
const {
  SOL_MINT,
  BASE_TX_FEE_LAMPORTS,
  TOKEN_PROGRAMS,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  LAMPORTS_PER_SOL,
  associatedTokenAddress,
} = require('../config/solana');
const { solToLamports, lamportsToSol, shortAddress } = require('../utils/format');
const logger = require('../utils/logger');
const { UserError, withUserLock, friendlyError } = require('./tradeCommon');
const { getSolPriceUsd } = require('./priceService');
const { CHAINS } = require('../config/chains');

// Solana trading via Jupiter. EVM chains live in evm/evmTradeService.js with the same interface.
const chain = CHAINS.sol;

// Lamports a system account must keep (rent-exempt minimum for 0 bytes of data)
const RENT_EXEMPT_MIN = 890_880n;
// SOL kept aside on buys for network fees + creating the token account (rent)
const BUY_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

function requireKeypair(userId) {
  const active = walletService.getActiveKeypair(userId);
  if (!active) throw new UserError('You don’t have a Solana wallet yet. Open 🐒 Wallet to create or import one.');
  return active;
}

function toPublicKey(address, message = 'That is not a valid Solana address.') {
  try {
    return new PublicKey(address);
  } catch {
    throw new UserError(message);
  }
}

function parseSol(amount) {
  try {
    const lamports = solToLamports(amount);
    if (lamports <= 0n) throw new Error();
    return lamports;
  } catch {
    throw new UserError('Invalid SOL amount.');
  }
}

const defaultOptions = (opts) => ({
  feeBps: feeBpsFor('sol', 'manual'),
  slippageBps: config.jupiter.slippageBps,
  ...opts,
});

// ---------- Fee account ----------
// Fees are taken inside the Jupiter swap into the treasury's wrapped-SOL token account (works for buys and
// sells, since one side is always SOL). If that account doesn't exist yet, fees fall back to a separate
// SOL transfer after the swap. Create it once with `npm run setup:fee-account`.

const FEE_ACCOUNT_RECHECK_MS = 10 * 60_000;
const feeAccountState = { ready: false, checkedAt: 0 };
const feeAccountAddress = () => associatedTokenAddress(config.revenue.treasury, SOL_MINT).toBase58();

async function getFeeAccount() {
  if (!config.revenue.treasury) return null;
  if (feeAccountState.ready) return feeAccountAddress();
  if (Date.now() - feeAccountState.checkedAt < FEE_ACCOUNT_RECHECK_MS) return null;
  feeAccountState.checkedAt = Date.now();
  const info = await connection.getAccountInfo(new PublicKey(feeAccountAddress())).catch(() => null);
  feeAccountState.ready = Boolean(info);
  if (!info) logger.warn('Treasury wSOL account missing (npm run setup:fee-account): fees are sent as a second transfer');
  return info ? feeAccountAddress() : null;
}

// ---------- Token info ----------

async function getTokenBalance(owner, mint) {
  const { value } = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  return value.reduce((acc, a) => acc + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}

async function getTokenInfo(mint, owner) {
  if (mint === SOL_MINT) throw new UserError('That’s SOL itself. Paste the address of the token you want to trade.');
  const mintKey = toPublicKey(mint);

  const account = await connection.getParsedAccountInfo(mintKey);
  const parsed = account.value?.data?.parsed;
  if (!account.value || !TOKEN_PROGRAMS.has(account.value.owner.toBase58()) || parsed?.type !== 'mint') {
    throw new UserError('This address is not a token mint on Solana.');
  }

  const [meta, balance] = await Promise.all([
    jupiter.searchToken(mint).catch(() => null),
    owner ? getTokenBalance(owner, mint) : 0n,
  ]);

  return {
    address: mint,
    name: meta?.name || 'Unknown token',
    symbol: meta?.symbol || shortAddress(mint),
    decimals: parsed.info.decimals,
    usdPrice: meta?.usdPrice ?? null,
    mcap: meta?.mcap ?? null,
    balance,
    // Used by the safety scan: an active freeze authority can lock holders' tokens
    mintAuthority: parsed.info.mintAuthority || null,
    freezeAuthority: parsed.info.freezeAuthority || null,
  };
}

// Every token the wallet holds (mint, raw amount, decimals), for the portfolio view
async function listHoldings(owner) {
  const results = await Promise.all(
    [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((programId) =>
      connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { programId: new PublicKey(programId) }),
    ),
  );
  const byMint = new Map();
  for (const { value } of results) {
    for (const a of value) {
      const info = a.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      if (amount === 0n || info.mint === SOL_MINT) continue;
      const prev = byMint.get(info.mint);
      byMint.set(info.mint, { address: info.mint, amount: (prev?.amount || 0n) + amount, decimals: info.tokenAmount.decimals });
    }
  }
  return [...byMint.values()];
}

// How much of the token 1 SOL buys right now (shown on the token card)
async function previewRate(token) {
  const q = await getQuote({ inputMint: SOL_MINT, outputMint: token.address, amount: LAMPORTS_PER_SOL });
  return { amountOut: BigInt(q.outAmount), usdPrice: null };
}

// How many raw tokens `lamports` buys right now (no fee)
async function quoteTokensFor(token, lamports) {
  const q = await getQuote({ inputMint: SOL_MINT, outputMint: token.address, amount: lamports });
  return BigInt(q.outAmount);
}

// What `amount` of the token is worth in lamports if sold now (no fee)
async function quoteValue(token, amount = token.balance) {
  if (amount <= 0n) return 0n;
  const q = await getQuote({ inputMint: token.address, outputMint: SOL_MINT, amount });
  return BigInt(q.outAmount);
}

const getNativeBalance = (address) => walletService.getBalance(address);

async function getQuote(params) {
  try {
    return await jupiter.getQuote(params);
  } catch (err) {
    if (err instanceof jupiter.NoRouteError) {
      throw new UserError('No trading route found for this token (no liquidity yet?).');
    }
    throw err;
  }
}

// ---------- Sending transactions ----------

async function confirmOrThrow(signature, blockhash, lastValidBlockHeight, failMessage) {
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
  if (result.value.err) {
    logger.warn({ signature, err: result.value.err }, 'Transaction failed on-chain');
    throw new UserError(failMessage);
  }
}

// With MEV protection the swap pays a Jito tip and goes through Jito's block engine
async function sendSwap(keypair, quote, opts, onSubmitted) {
  const { swapTransaction, lastValidBlockHeight } = await jupiter.buildSwapTransaction(quote.jupQuote, keypair.publicKey.toBase58(), {
    feeAccount: quote.feeMode === 'swap' ? quote.feeAccount : undefined,
    jitoTipLamports: opts.mevProtect ? opts.jitoTipLamports : undefined,
    priorityMaxLamports: opts.priorityMaxLamports,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);
  const raw = tx.serialize();

  let signature;
  if (opts.mevProtect) {
    try {
      signature = await jito.sendTransaction(raw);
    } catch (err) {
      // Keep trading if Jito is down or rate-limits us; the tip is still paid, but the tx goes via RPC
      logger.warn({ err: err.message }, 'Jito send failed, falling back to RPC');
      signature = await connection.sendRawTransaction(raw, { maxRetries: 3 });
    }
  } else {
    signature = await connection.sendRawTransaction(raw, { maxRetries: 3 });
  }
  await onSubmitted?.(signature);
  await confirmOrThrow(
    signature,
    tx.message.recentBlockhash,
    lastValidBlockHeight,
    'The swap failed on-chain (price moved beyond slippage or the token blocks trading).',
  );
  return signature;
}

async function sendTransfer(keypair, to, lamports, onSubmitted) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: keypair.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(to), lamports }),
  );
  tx.sign(keypair);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
  await onSubmitted?.(signature);
  await confirmOrThrow(signature, blockhash, lastValidBlockHeight, 'The transfer failed on-chain.');
  return signature;
}

// Fallback fee collection (separate transfer) when the treasury fee account isn't set up
async function collectFee(keypair, lamports) {
  if (lamports <= 0n) return null;
  try {
    return await sendTransfer(keypair, config.revenue.treasury, lamports);
  } catch (err) {
    logger.error({ err: err.message, user: keypair.publicKey.toBase58() }, 'Fee collection failed');
    return null;
  }
}

// Splits a charged fee into referral / holder pool / cashback (lazy require: rewardsService needs markets,
// which needs this module)
async function recordFee(userId, lamports, signature) {
  if (lamports <= 0n) return;
  const solPrice = await getSolPriceUsd().catch(() => null);
  require('./rewardsService').onTradeFee({
    userId,
    chain: chain.key,
    feeRaw: lamports,
    feeUsd: solPrice ? Number(lamportsToSol(lamports)) * solPrice : 0,
    ref: signature,
  });
}

// Cost the user pays on top of the swap amount for landing it (Jito tip or max priority fee)
const landingCost = (opts) => BigInt(opts.mevProtect ? opts.jitoTipLamports : opts.priorityMaxLamports);

// ---------- Buy (SOL → token) ----------

async function quoteBuy(mint, solAmount, owner, options = {}) {
  const opts = defaultOptions(options);
  const amountIn = parseSol(solAmount);
  const fee = (amountIn * BigInt(opts.feeBps)) / 10_000n;
  const feeAccount = fee > 0n ? await getFeeAccount() : null;
  const feeMode = fee === 0n ? 'none' : feeAccount ? 'swap' : 'transfer';
  // In-swap fees come out of amountIn; transfer fees are kept aside before swapping
  const swapIn = feeMode === 'transfer' ? amountIn - fee : amountIn;
  const token = await getTokenInfo(mint, owner);
  const jupQuote = await getQuote({
    inputMint: SOL_MINT,
    outputMint: mint,
    amount: swapIn,
    slippageBps: opts.slippageBps,
    platformFeeBps: feeMode === 'swap' ? opts.feeBps : 0,
  });
  return {
    side: 'buy',
    token,
    amountIn,
    fee,
    feeMode,
    feeAccount,
    swapIn,
    amountOut: BigInt(jupQuote.outAmount),
    minOut: BigInt(jupQuote.otherAmountThreshold),
    priceImpactPct: Number(jupQuote.priceImpactPct) * 100,
    jupQuote,
  };
}

async function executeBuy(userId, mint, solAmount, { onSubmitted, source = 'manual' } = {}) {
  return withUserLock(userId, async () => {
    const { wallet, keypair } = requireKeypair(userId);
    const opts = settingsService.tradeOptions(userId, chain, source);
    const quote = await quoteBuy(mint, solAmount, wallet.address, opts);

    const balance = await walletService.getBalance(wallet.address);
    if (balance < quote.amountIn + BUY_RESERVE_LAMPORTS + landingCost(opts)) {
      throw new UserError(
        `Not enough SOL. Balance: ${lamportsToSol(balance)} SOL. Keep ~0.005 SOL extra for network fees and token account rent.`,
      );
    }

    const signature = await sendSwap(keypair, quote, opts, onSubmitted);
    const feeSig = quote.feeMode === 'transfer' ? await collectFee(keypair, quote.fee) : null;
    const feeCharged = quote.feeMode === 'swap' || feeSig ? quote.fee : 0n;

    const after = await getTokenBalance(wallet.address, mint).catch(() => null);
    positionService.recordBuy({
      walletId: wallet.id,
      chain: chain.key,
      token: mint,
      symbol: quote.token.symbol,
      decimals: quote.token.decimals,
      tokenAmount: after != null ? after - quote.token.balance : quote.amountOut,
      nativeSpent: quote.amountIn,
    });
    statsService.recordTrade({
      userId,
      walletId: wallet.id,
      chain: chain.key,
      side: 'buy',
      source,
      token: mint,
      solVolume: Number(lamportsToSol(quote.amountIn)),
      feeSol: Number(lamportsToSol(feeCharged)),
      signature,
    });
    await recordFee(userId, feeCharged, signature);
    logger.info({ userId, signature, mint, sol: solAmount, source, mev: opts.mevProtect }, 'Buy confirmed');
    return { signature, quote };
  });
}

// ---------- Sell (token → SOL) ----------

async function quoteSell(mint, percent, owner, options = {}) {
  const opts = defaultOptions(options);
  const token = await getTokenInfo(mint, owner);
  // opts.amountRaw sells an exact amount (DCA); otherwise a percentage of the balance
  const wanted = opts.amountRaw != null ? BigInt(opts.amountRaw) : (token.balance * BigInt(percent)) / 100n;
  const amountIn = wanted > token.balance ? token.balance : wanted;
  if (amountIn <= 0n) throw new UserError(`You don’t hold any ${token.symbol}.`);
  const feeAccount = opts.feeBps > 0 ? await getFeeAccount() : null;
  const feeMode = opts.feeBps === 0 ? 'none' : feeAccount ? 'swap' : 'transfer';
  const jupQuote = await getQuote({
    inputMint: mint,
    outputMint: SOL_MINT,
    amount: amountIn,
    slippageBps: opts.slippageBps,
    platformFeeBps: feeMode === 'swap' ? opts.feeBps : 0,
  });
  // In-swap: outAmount is already net of the platform fee. Show gross + fee either way.
  const out = BigInt(jupQuote.outAmount);
  const inSwapFee = feeMode === 'swap' ? BigInt(jupQuote.platformFee?.amount || 0) : 0n;
  const nativeOut = out + inSwapFee;
  return {
    side: 'sell',
    token,
    percent,
    amountIn,
    nativeOut,
    fee: feeMode === 'swap' ? inSwapFee : (nativeOut * BigInt(opts.feeBps)) / 10_000n,
    feeMode,
    feeAccount,
    minOut: BigInt(jupQuote.otherAmountThreshold) + inSwapFee,
    priceImpactPct: Number(jupQuote.priceImpactPct) * 100,
    jupQuote,
  };
}

async function executeSell(userId, mint, percent, { onSubmitted, source = 'manual', amountRaw } = {}) {
  return withUserLock(userId, async () => {
    const { wallet, keypair } = requireKeypair(userId);
    const opts = { ...settingsService.tradeOptions(userId, chain, source), amountRaw };
    const quote = await quoteSell(mint, percent, wallet.address, opts);

    const before = await walletService.getBalance(wallet.address);
    const signature = await sendSwap(keypair, quote, opts, onSubmitted);
    const after = await walletService.getBalance(wallet.address);

    // Net SOL received (already minus network fees and any in-swap fee)
    let received = after > before ? after - before : 0n;
    let feeCharged = quote.feeMode === 'swap' ? quote.fee : 0n;
    if (quote.feeMode === 'transfer') {
      const fee = (received * BigInt(opts.feeBps)) / 10_000n;
      if (await collectFee(keypair, fee)) {
        feeCharged = fee;
        received -= fee;
      }
    }

    positionService.recordSell({
      walletId: wallet.id,
      chain: chain.key,
      token: mint,
      symbol: quote.token.symbol,
      decimals: quote.token.decimals,
      tokenAmount: quote.amountIn,
      nativeReceived: received,
    });
    statsService.recordTrade({
      userId,
      walletId: wallet.id,
      chain: chain.key,
      side: 'sell',
      source,
      token: mint,
      solVolume: Number(lamportsToSol(received + feeCharged)),
      feeSol: Number(lamportsToSol(feeCharged)),
      signature,
    });
    await recordFee(userId, feeCharged, signature);
    logger.info({ userId, signature, mint, percent, source, mev: opts.mevProtect }, 'Sell confirmed');
    return { signature, quote, received };
  });
}

// ---------- Withdraw SOL ----------

async function quoteWithdraw(userId, to, amount) {
  const toKey = toPublicKey(to, 'Destination is not a valid Solana address.');
  const { wallet } = requireKeypair(userId);
  const balance = await walletService.getBalance(wallet.address);

  if (amount === 'all') {
    const value = balance - BASE_TX_FEE_LAMPORTS;
    if (value <= 0n) throw new UserError('Balance is too low to cover the network fee.');
    return { to: toKey.toBase58(), value, sweep: true };
  }

  const value = parseSol(amount);
  const remaining = balance - value - BASE_TX_FEE_LAMPORTS;
  if (remaining < 0n) throw new UserError(`Not enough SOL. Your balance is ${lamportsToSol(balance)} SOL.`);
  if (remaining > 0n && remaining < RENT_EXEMPT_MIN) {
    throw new UserError('Solana requires at least 0.00089 SOL to stay in the wallet. Send a bit less, or use "all".');
  }
  return { to: toKey.toBase58(), value, sweep: false };
}

async function executeWithdraw(userId, to, amount, { onSubmitted } = {}) {
  return withUserLock(userId, async () => {
    const { keypair } = requireKeypair(userId);
    const quote = await quoteWithdraw(userId, to, amount);
    const signature = await sendTransfer(keypair, quote.to, quote.value, onSubmitted);
    logger.info({ userId, signature, to: quote.to }, 'Withdraw confirmed');
    return { signature, quote };
  });
}

module.exports = {
  chain,
  UserError,
  getFeeAccount,
  feeAccountAddress,
  getTokenInfo,
  listHoldings,
  previewRate,
  quoteTokensFor,
  quoteValue,
  getNativeBalance,
  getQuote,
  quoteBuy,
  executeBuy,
  quoteSell,
  executeSell,
  quoteWithdraw,
  executeWithdraw,
  friendlyError,
};
