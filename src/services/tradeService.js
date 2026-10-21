const { PublicKey, SystemProgram, Transaction, VersionedTransaction } = require('@solana/web3.js');
const connection = require('./connection');
const jupiter = require('./jupiterService');
const walletService = require('./walletService');
const statsService = require('./statsService');
const { config } = require('../config');
const { SOL_MINT, BASE_TX_FEE_LAMPORTS, TOKEN_PROGRAMS } = require('../config/solana');
const { solToLamports, lamportsToSol, shortAddress } = require('../utils/format');
const logger = require('../utils/logger');

// Errors with a message that is safe to show to the user as-is
class UserError extends Error {}

// Lamports a system account must keep (rent-exempt minimum for 0 bytes of data)
const RENT_EXEMPT_MIN = 890_880n;
// SOL kept aside on buys for network fees + creating the token account (rent)
const BUY_RESERVE_LAMPORTS = 5_000_000n; // 0.005 SOL

// One transaction at a time per user: prevents double-clicks and racing balances
const locks = new Set();
async function withUserLock(userId, fn) {
  if (locks.has(userId)) throw new UserError('Another transaction is still in progress. Please wait for it to finish.');
  locks.add(userId);
  try {
    return await fn();
  } finally {
    locks.delete(userId);
  }
}

function requireKeypair(userId) {
  const keypair = walletService.getKeypair(userId);
  if (!keypair) throw new UserError('You don’t have a wallet yet. Open 🐒 Wallet to create or import one.');
  return keypair;
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

function feeOf(lamports) {
  if (!config.revenue.feesEnabled) return 0n;
  return (lamports * BigInt(config.revenue.botFeeBps)) / 10_000n;
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
  };
}

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

async function sendSwap(keypair, quoteResponse, onSubmitted) {
  const { swapTransaction, lastValidBlockHeight } = await jupiter.buildSwapTransaction(
    quoteResponse,
    keypair.publicKey.toBase58(),
  );
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
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

async function collectFee(keypair, lamports) {
  if (lamports <= 0n) return null;
  try {
    return await sendTransfer(keypair, config.revenue.treasury, lamports);
  } catch (err) {
    logger.error({ err: err.message, user: keypair.publicKey.toBase58() }, 'Fee collection failed');
    return null;
  }
}

// ---------- Buy (SOL → token) ----------

async function quoteBuy(mint, solAmount, owner) {
  const amountIn = parseSol(solAmount);
  const fee = feeOf(amountIn);
  const swapIn = amountIn - fee;
  const token = await getTokenInfo(mint, owner);
  const jupQuote = await getQuote({ inputMint: SOL_MINT, outputMint: mint, amount: swapIn });
  return {
    side: 'buy',
    token,
    amountIn,
    fee,
    swapIn,
    amountOut: BigInt(jupQuote.outAmount),
    minOut: BigInt(jupQuote.otherAmountThreshold),
    priceImpactPct: Number(jupQuote.priceImpactPct) * 100,
    jupQuote,
  };
}

async function executeBuy(userId, mint, solAmount, { onSubmitted } = {}) {
  return withUserLock(userId, async () => {
    const keypair = requireKeypair(userId);
    const owner = keypair.publicKey.toBase58();
    const quote = await quoteBuy(mint, solAmount, owner);

    const balance = await walletService.getBalance(owner);
    if (balance < quote.amountIn + BUY_RESERVE_LAMPORTS) {
      throw new UserError(
        `Not enough SOL. Balance: ${lamportsToSol(balance)} SOL. Keep ~0.005 SOL extra for network fees and token account rent.`,
      );
    }

    const signature = await sendSwap(keypair, quote.jupQuote, onSubmitted);
    const feeSig = await collectFee(keypair, quote.fee);
    statsService.recordTrade({
      userId,
      side: 'buy',
      token: mint,
      solVolume: Number(lamportsToSol(quote.amountIn)),
      feeSol: feeSig ? Number(lamportsToSol(quote.fee)) : 0,
      signature,
    });
    logger.info({ userId, signature, mint, sol: solAmount }, 'Buy confirmed');
    return { signature, quote };
  });
}

// ---------- Sell (token → SOL) ----------

async function quoteSell(mint, percent, owner) {
  const token = await getTokenInfo(mint, owner);
  const amountIn = (token.balance * BigInt(percent)) / 100n;
  if (amountIn <= 0n) throw new UserError(`You don’t hold any ${token.symbol}.`);
  const jupQuote = await getQuote({ inputMint: mint, outputMint: SOL_MINT, amount: amountIn });
  const solOut = BigInt(jupQuote.outAmount);
  return {
    side: 'sell',
    token,
    percent,
    amountIn,
    solOut,
    fee: feeOf(solOut),
    minOut: BigInt(jupQuote.otherAmountThreshold),
    priceImpactPct: Number(jupQuote.priceImpactPct) * 100,
    jupQuote,
  };
}

async function executeSell(userId, mint, percent, { onSubmitted } = {}) {
  return withUserLock(userId, async () => {
    const keypair = requireKeypair(userId);
    const owner = keypair.publicKey.toBase58();
    const quote = await quoteSell(mint, percent, owner);

    const before = await walletService.getBalance(owner);
    const signature = await sendSwap(keypair, quote.jupQuote, onSubmitted);
    const after = await walletService.getBalance(owner);

    // Net SOL received (already minus network fees)
    const received = after > before ? after - before : 0n;
    const fee = feeOf(received);
    const feeSig = await collectFee(keypair, fee);

    statsService.recordTrade({
      userId,
      side: 'sell',
      token: mint,
      solVolume: Number(lamportsToSol(received)),
      feeSol: feeSig ? Number(lamportsToSol(fee)) : 0,
      signature,
    });
    logger.info({ userId, signature, mint, percent }, 'Sell confirmed');
    return { signature, quote, received: feeSig ? received - fee : received };
  });
}

// ---------- Withdraw SOL ----------

async function quoteWithdraw(userId, to, amount) {
  const toKey = toPublicKey(to, 'Destination is not a valid Solana address.');
  const keypair = requireKeypair(userId);
  const balance = await walletService.getBalance(keypair.publicKey.toBase58());

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
    const keypair = requireKeypair(userId);
    const quote = await quoteWithdraw(userId, to, amount);
    const signature = await sendTransfer(keypair, quote.to, quote.value, onSubmitted);
    logger.info({ userId, signature, to: quote.to }, 'Withdraw confirmed');
    return { signature, quote };
  });
}

// Turn any error into a short, user-friendly message
function friendlyError(err) {
  if (err instanceof UserError) return err.message;
  const msg = String(err?.message || '');
  if (err?.response?.status === 429 || msg.includes('429') || msg.includes('Too Many Requests')) {
    return 'Too many requests right now (rate limited). Please try again in a few seconds.';
  }
  if (err?.isAxiosError) return 'The swap service (Jupiter) is not responding. Please try again in a moment.';
  if (/insufficient funds for rent/i.test(msg)) return 'The receiving wallet needs at least 0.00089 SOL. Send a larger amount.';
  if (/insufficient (funds|lamports)/i.test(msg)) return 'Not enough SOL to cover the amount plus network fees.';
  if (/block height exceeded|expired/i.test(msg)) return 'The transaction expired before it was confirmed. Please try again.';
  if (/simulation failed/i.test(msg)) return 'Transaction simulation failed (the price moved or the token restricts trading). Try again or use a smaller amount.';
  return 'Something went wrong. Please try again.';
}

const txLink = (signature) => `${config.chain.explorerUrl}/tx/${signature}`;
const accountLink = (address) => `${config.chain.explorerUrl}/account/${address}`;

module.exports = {
  UserError,
  getTokenInfo,
  getQuote,
  quoteBuy,
  executeBuy,
  quoteSell,
  executeSell,
  quoteWithdraw,
  executeWithdraw,
  friendlyError,
  txLink,
  accountLink,
};
