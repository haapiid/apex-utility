const { Contract, JsonRpcProvider, Network, getAddress } = require('ethers');
const { getProvider } = require('./provider');
const kyber = require('./kyberService');
const walletService = require('../walletService');
const statsService = require('../statsService');
const positionService = require('../positionService');
const settingsService = require('../settingsService');
const { UserError, withUserLock, withTimeout, friendlyError } = require('../tradeCommon');
const { config, feeBpsFor } = require('../../config');
const { EVM_NATIVE, isEvmAddress } = require('../../config/chains');
const { toUnits, fromUnits, shortAddress, formatNative } = require('../../utils/format');
const logger = require('../../utils/logger');

const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const READ_TIMEOUT_MS = 8_000;
const CONFIRM_TIMEOUT_MS = 120_000;
const SWAP_FAILED = 'The swap failed on-chain (price moved beyond slippage or the token blocks trading).';

const normalize = (address) => getAddress(address.toLowerCase()); // checksum without rejecting odd casing

// Same interface as the Solana tradeService, bound to one EVM chain
function createEvmTrader(chain) {
  const provider = getProvider(chain);
  // Sends only: keeps swaps out of the public mempool on chains that have one (Ethereum, BSC)
  const protectProvider = chain.protectRpcUrl
    ? new JsonRpcProvider(chain.protectRpcUrl, Network.from(chain.chainId), { staticNetwork: Network.from(chain.chainId) })
    : null;
  const read = (promise) => withTimeout(promise, READ_TIMEOUT_MS, `${chain.name} RPC request timed out`);

  const defaultOptions = (opts) => ({
    feeBps: feeBpsFor('evm', 'manual'),
    slippageBps: config.evm.slippageBps,
    mevProtect: true,
    gasBoostPct: 0,
    ...opts,
  });

  function requireSigner(userId, walletId) {
    const active = walletService.getActiveEvmSigner(userId, provider, walletId);
    if (!active) throw new UserError('You don’t have an EVM wallet yet. Open 🐒 Wallet to create or import one.');
    return active;
  }

  function parseNative(amount) {
    try {
      const wei = toUnits(amount, chain.decimals);
      if (wei <= 0n) throw new Error();
      return wei;
    } catch {
      throw new UserError(`Invalid ${chain.native} amount.`);
    }
  }

  const feeParams = (chargeBy, feeBps) => (feeBps > 0 ? { bps: feeBps, chargeBy, receiver: config.evm.treasury } : null);
  const afterSlippage = (amount, slippageBps) => (amount * BigInt(10_000 - slippageBps)) / 10_000n;

  // KyberSwap only reports USD values: impact = value lost beyond our own fee
  function priceImpact(summary, feeBps) {
    const inUsd = Number(summary.amountInUsd);
    const outUsd = Number(summary.amountOutUsd);
    if (!(inUsd > 0 && outUsd > 0)) return null;
    return Math.max(0, (1 - outUsd / inUsd) * 100 - feeBps / 100);
  }

  async function route(params) {
    try {
      return await kyber.getRoute(chain, params);
    } catch (err) {
      if (err instanceof kyber.NoRouteError) throw new UserError('No trading route found for this token (no liquidity yet?).');
      throw err;
    }
  }

  // Encoded swap from KyberSwap, checked against what we quoted before we sign it
  async function build(quote, sender) {
    const built = await kyber.buildRoute(chain, { routeSummary: quote.routeSummary, sender, slippageBps: quote.slippageBps });
    if (built.routerAddress.toLowerCase() !== quote.routerAddress.toLowerCase()) {
      throw new Error(`Unexpected router ${built.routerAddress}`);
    }
    const value = BigInt(built.transactionValue || 0);
    if (value !== (quote.side === 'buy' ? quote.amountIn : 0n)) throw new Error(`Unexpected transaction value ${value}`);
    return { to: built.routerAddress, data: built.data, value };
  }

  // ---------- Token info ----------

  async function getTokenInfo(address, owner) {
    if (!isEvmAddress(address)) throw new UserError('That is not a valid token address.');
    const tokenAddress = normalize(address);
    const code = await read(provider.getCode(tokenAddress));
    if (code === '0x') throw new UserError(`This address is not a token contract on ${chain.name}.`);

    const erc20 = new Contract(tokenAddress, ERC20_ABI, provider);
    let decimals;
    try {
      decimals = Number(await read(erc20.decimals()));
    } catch {
      throw new UserError(`This contract is not a token on ${chain.name}.`);
    }
    const [name, symbol, balance] = await Promise.all([
      read(erc20.name()).catch(() => 'Unknown token'),
      read(erc20.symbol()).catch(() => shortAddress(tokenAddress)),
      owner ? read(erc20.balanceOf(owner)) : 0n,
    ]);
    return { address: tokenAddress, name, symbol, decimals, usdPrice: null, mcap: null, balance };
  }

  const tokenBalance = (token, owner) => read(new Contract(token, ERC20_ABI, provider).balanceOf(owner));

  // How much of the token 1 native coin buys right now, plus the USD price it implies
  async function previewRate(token) {
    const { routeSummary } = await route({ tokenIn: EVM_NATIVE, tokenOut: token.address, amountIn: 10n ** 18n });
    const amountOut = BigInt(routeSummary.amountOut);
    const tokens = Number(fromUnits(amountOut, token.decimals));
    const outUsd = Number(routeSummary.amountOutUsd);
    return { amountOut, usdPrice: tokens > 0 && outUsd > 0 ? outUsd / tokens : null };
  }

  // How many raw tokens `wei` of the native coin buys right now (no fee)
  async function quoteTokensFor(token, wei) {
    const { routeSummary } = await route({ tokenIn: EVM_NATIVE, tokenOut: token.address, amountIn: wei });
    return BigInt(routeSummary.amountOut);
  }

  // What `amount` of the token is worth in native wei if sold now (no fee)
  async function quoteValue(token, amount = token.balance) {
    if (amount <= 0n) return 0n;
    const { routeSummary } = await route({ tokenIn: token.address, tokenOut: EVM_NATIVE, amountIn: amount });
    return BigInt(routeSummary.amountOut);
  }

  const getNativeBalance = (address) => read(provider.getBalance(address));

  // ---------- Sending transactions ----------

  // Suggested fees, with the user's gas boost added to the priority fee
  async function feeOverrides(gasBoostPct) {
    const feeData = await read(provider.getFeeData());
    const boost = (v) => (v * BigInt(100 + gasBoostPct)) / 100n;
    if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
      const priority = boost(feeData.maxPriorityFeePerGas);
      return { maxPriorityFeePerGas: priority, maxFeePerGas: feeData.maxFeePerGas + (priority - feeData.maxPriorityFeePerGas) };
    }
    return { gasPrice: boost(feeData.gasPrice ?? 0n) };
  }

  async function sendTx(signer, tx, { onSubmitted, failMessage, gasLimit, checkBalance = true, opts }) {
    const from = signer.address;
    const value = tx.value ?? 0n;
    const [balance, fees] = await Promise.all([read(provider.getBalance(from)), feeOverrides(opts.gasBoostPct)]);
    if (checkBalance && balance < value) {
      throw new UserError(`Not enough ${chain.native}. Balance: ${formatNative(balance, chain)}.`);
    }

    if (!gasLimit) {
      let gas;
      try {
        gas = await read(provider.estimateGas({ ...tx, from }));
      } catch (err) {
        if (/timed out/i.test(err.message)) throw err;
        logger.warn({ chain: chain.key, err: err.shortMessage || err.message }, 'Gas estimation failed');
        throw new UserError('The transaction would fail (price moved, or the token blocks trading). Try again or use a smaller amount.');
      }
      gasLimit = (gas * 12n) / 10n;
    }

    const needed = value + gasLimit * (fees.maxFeePerGas ?? fees.gasPrice) + chain.l1FeeBuffer;
    if (checkBalance && balance < needed) {
      throw new UserError(
        `Not enough ${chain.native} for this amount plus gas. Balance: ${formatNative(balance, chain)}, needed: ~${formatNative(needed, chain)}.`,
      );
    }

    const request = { ...tx, ...fees, gasLimit };
    let hash;
    if (opts.mevProtect && protectProvider) {
      // Sign locally, broadcast privately, then watch for it on the regular RPC
      const signed = await signer.signTransaction(await signer.populateTransaction(request));
      hash = (await protectProvider.broadcastTransaction(signed)).hash;
    } else {
      hash = (await signer.sendTransaction(request)).hash;
    }
    await onSubmitted?.(hash);
    let receipt;
    try {
      receipt = await provider.waitForTransaction(hash, 1, CONFIRM_TIMEOUT_MS);
    } catch (err) {
      if (err.code === 'CALL_EXCEPTION') throw new UserError(failMessage);
      throw err;
    }
    if (!receipt || receipt.status !== 1) throw new UserError(failMessage);
    return { hash, receipt };
  }

  // Lets the router spend exactly `amount` of the token. Returns true if an approval was sent.
  async function ensureAllowance(signer, token, spender, amount, opts, onApproving) {
    const erc20 = new Contract(token.address, ERC20_ABI, signer);
    const allowance = await read(erc20.allowance(signer.address, spender));
    if (allowance >= amount) return false;
    await onApproving?.();
    const data = erc20.interface.encodeFunctionData('approve', [spender, amount]);
    await sendTx(signer, { to: token.address, data }, { failMessage: `Approving ${token.symbol} failed on-chain.`, opts });
    return true;
  }

  function record({ userId, walletId, side, source, token, nativeVolume, feeBps, feeRaw, volumeUsd, signature }) {
    const usd = Number(volumeUsd) || 0;
    // Lazy require: rewardsService needs markets, which needs this module
    require('../rewardsService').onTradeFee({ userId, chain: chain.key, feeRaw, feeUsd: (usd * feeBps) / 10_000, ref: signature });
    statsService.recordTrade({
      userId,
      walletId,
      chain: chain.key,
      side,
      source,
      token,
      nativeVolume: Number(fromUnits(nativeVolume, chain.decimals)),
      volumeUsd: usd,
      feeUsd: (usd * feeBps) / 10_000,
      signature,
    });
  }

  // ---------- Buy (native → token) ----------

  async function quoteBuy(address, amount, owner, options = {}) {
    const opts = defaultOptions(options);
    const amountIn = parseNative(amount);
    const token = await getTokenInfo(address, owner);
    const fee = (amountIn * BigInt(opts.feeBps)) / 10_000n;
    const { routeSummary, routerAddress } = await route({
      tokenIn: EVM_NATIVE,
      tokenOut: token.address,
      amountIn, // the fee is taken out of this inside the swap
      fee: feeParams('currency_in', opts.feeBps),
      origin: owner,
    });
    const amountOut = BigInt(routeSummary.amountOut);
    return {
      side: 'buy',
      chain,
      token,
      amountIn,
      fee,
      feeBps: opts.feeBps,
      slippageBps: opts.slippageBps,
      amountOut,
      minOut: afterSlippage(amountOut, opts.slippageBps),
      priceImpactPct: priceImpact(routeSummary, opts.feeBps),
      routeSummary,
      routerAddress,
    };
  }

  async function executeBuy(userId, address, amount, { onSubmitted, source = 'manual', walletId } = {}) {
    return withUserLock(userId, async () => {
      const { wallet, signer } = requireSigner(userId, walletId);
      const opts = settingsService.tradeOptions(userId, chain, source, 'buy');
      const quote = await quoteBuy(address, amount, signer.address, opts);
      settingsService.checkImpact(quote, opts);
      const tx = await build(quote, signer.address);
      const { hash } = await sendTx(signer, tx, { onSubmitted, failMessage: SWAP_FAILED, opts });

      const after = await tokenBalance(quote.token.address, signer.address).catch(() => null);
      positionService.recordBuy({
        walletId: wallet.id,
        chain: chain.key,
        token: quote.token.address,
        symbol: quote.token.symbol,
        decimals: quote.token.decimals,
        tokenAmount: after != null ? after - quote.token.balance : quote.amountOut,
        nativeSpent: quote.amountIn,
      });
      record({
        userId,
        walletId: wallet.id,
        side: 'buy',
        source,
        token: quote.token.address,
        nativeVolume: quote.amountIn,
        feeBps: quote.feeBps,
        feeRaw: quote.fee,
        volumeUsd: quote.routeSummary.amountInUsd,
        signature: hash,
      });
      logger.info({ userId, chain: chain.key, hash, token: quote.token.address, amount, source, mev: opts.mevProtect }, 'Buy confirmed');
      return { signature: hash, quote, wallet: { id: wallet.id, label: wallet.label } };
    });
  }

  // ---------- Sell (token → native) ----------

  async function quoteSell(address, percent, owner, options = {}) {
    const opts = defaultOptions(options);
    const token = await getTokenInfo(address, owner);
    // opts.amountRaw sells an exact amount (DCA); otherwise a percentage of the balance
    const wanted = opts.amountRaw != null ? BigInt(opts.amountRaw) : (token.balance * BigInt(percent)) / 100n;
    const amountIn = wanted > token.balance ? token.balance : wanted;
    if (amountIn <= 0n) throw new UserError(`You don’t hold any ${token.symbol} on ${chain.name}.`);
    const { routeSummary, routerAddress } = await route({
      tokenIn: token.address,
      tokenOut: EVM_NATIVE,
      amountIn,
      fee: feeParams('currency_out', opts.feeBps),
      origin: owner,
    });
    // amountOut is already net of the fee; show gross + fee like on Solana
    const net = BigInt(routeSummary.amountOut);
    const fee = opts.feeBps > 0 ? (net * BigInt(opts.feeBps)) / BigInt(10_000 - opts.feeBps) : 0n;
    const nativeOut = net + fee;
    return {
      side: 'sell',
      chain,
      token,
      percent,
      amountIn,
      nativeOut,
      fee,
      feeBps: opts.feeBps,
      slippageBps: opts.slippageBps,
      minOut: afterSlippage(nativeOut, opts.slippageBps),
      priceImpactPct: priceImpact(routeSummary, opts.feeBps),
      routeSummary,
      routerAddress,
    };
  }

  async function executeSell(userId, address, percent, { onSubmitted, onApproving, source = 'manual', amountRaw, walletId } = {}) {
    return withUserLock(userId, async () => {
      const { wallet, signer } = requireSigner(userId, walletId);
      const owner = signer.address;
      const opts = { ...settingsService.tradeOptions(userId, chain, source, 'sell'), amountRaw };
      let quote = await quoteSell(address, percent, owner, opts);
      settingsService.checkImpact(quote, opts);
      // Routes go stale quickly: fetch a fresh one if we had to wait for an approval first
      if (await ensureAllowance(signer, quote.token, quote.routerAddress, quote.amountIn, opts, onApproving)) {
        quote = await quoteSell(address, percent, owner, opts);
      }
      const tx = await build(quote, owner);

      const before = await read(provider.getBalance(owner));
      const { hash, receipt } = await sendTx(signer, tx, { onSubmitted, failMessage: SWAP_FAILED, opts });
      const after = await read(provider.getBalance(owner)).catch(() => null);
      // Net native received: balance change plus the gas we paid for this transaction
      let received = after != null ? after - before + receipt.fee : quote.nativeOut - quote.fee;
      if (received < 0n) received = 0n;

      positionService.recordSell({
        walletId: wallet.id,
        chain: chain.key,
        token: quote.token.address,
        symbol: quote.token.symbol,
        decimals: quote.token.decimals,
        tokenAmount: quote.amountIn,
        nativeReceived: received,
      });
      record({
        userId,
        walletId: wallet.id,
        side: 'sell',
        source,
        token: quote.token.address,
        nativeVolume: received,
        feeBps: quote.feeBps,
        feeRaw: quote.fee,
        volumeUsd: quote.routeSummary.amountOutUsd,
        signature: hash,
      });
      logger.info({ userId, chain: chain.key, hash, token: quote.token.address, percent, source, mev: opts.mevProtect }, 'Sell confirmed');
      return { signature: hash, quote, received, wallet: { id: wallet.id, label: wallet.label } };
    });
  }

  // ---------- Withdraw native ----------

  async function quoteWithdraw(userId, to, amount) {
    if (!isEvmAddress(to)) throw new UserError('Destination is not a valid EVM address.');
    const toAddress = normalize(to);
    const { signer } = requireSigner(userId);
    const [balance, feeData] = await Promise.all([read(provider.getBalance(signer.address)), read(provider.getFeeData())]);
    if (balance === 0n) throw new UserError(`Your ${chain.name} balance is empty.`);

    const gas = await read(provider.estimateGas({ from: signer.address, to: toAddress, value: 1n }));
    const gasLimit = (gas * 12n) / 10n;
    const reserve = gasLimit * (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) + chain.l1FeeBuffer;

    if (amount === 'all') {
      const value = balance - reserve;
      if (value <= 0n) throw new UserError('Balance is too low to cover the gas fee.');
      return { to: toAddress, value, sweep: true, gasLimit };
    }
    const value = parseNative(amount);
    if (balance < value + reserve) {
      throw new UserError(
        `Not enough ${chain.native}. Your balance is ${formatNative(balance, chain)} (keep ~${formatNative(reserve, chain, 8)} for gas).`,
      );
    }
    return { to: toAddress, value, sweep: false, gasLimit };
  }

  async function executeWithdraw(userId, to, amount, { onSubmitted } = {}) {
    return withUserLock(userId, async () => {
      const { signer } = requireSigner(userId);
      const quote = await quoteWithdraw(userId, to, amount);
      const { hash } = await sendTx(
        signer,
        { to: quote.to, value: quote.value },
        {
          onSubmitted,
          gasLimit: quote.gasLimit,
          checkBalance: !quote.sweep,
          failMessage: 'The transfer failed on-chain.',
          // Plain transfers can't be sandwiched; no gas boost so a sweep's reserve still covers gas
          opts: { mevProtect: false, gasBoostPct: 0 },
        },
      );
      logger.info({ userId, chain: chain.key, hash, to: quote.to }, 'Withdraw confirmed');
      return { signature: hash, quote };
    });
  }

  return {
    chain,
    getTokenInfo,
    previewRate,
    quoteTokensFor,
    quoteValue,
    getNativeBalance,
    quoteBuy,
    executeBuy,
    quoteSell,
    executeSell,
    quoteWithdraw,
    executeWithdraw,
    friendlyError,
  };
}

const traders = new Map();
function forChain(chain) {
  if (!traders.has(chain.key)) traders.set(chain.key, createEvmTrader(chain));
  return traders.get(chain.key);
}

module.exports = { forChain };
