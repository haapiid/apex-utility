const { PublicKey } = require('@solana/web3.js');
const { Contract, id: keccakId, zeroPadValue } = require('ethers');
const automation = require('../services/automationService');
const markets = require('../services/markets');
const connection = require('../services/connection');
const { getProvider } = require('../services/evm/provider');
const { withTimeout } = require('../services/tradeCommon');
const { SOL_MINT } = require('../config/solana');
const { getChain, txLink } = require('../config/chains');
const { shortAddress } = require('../utils/format');
const { attempt, esc } = require('./common');
const logger = require('../utils/logger');

// Copy trading: watch each followed wallet and mirror its trades from the user's active wallet.
//   buy  → the target spent the native coin and received a token → buy it for the user's fixed amount
//   sell → the target sent a token away → sell the same share of the user's bag (if copy_sells is on)
// Only transactions the target signed count, so airdrops and incoming transfers are ignored.

const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');
const EVM_MAX_BLOCKS = 200; // per tick, keeps eth_getLogs ranges small for public RPCs
const SOL_MAX_SIGNATURES = 15;
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

// ---------- Solana ----------

async function solanaEvents(target) {
  const owner = target.address;
  const signatures = await connection.getSignaturesForAddress(new PublicKey(owner), {
    limit: SOL_MAX_SIGNATURES,
    ...(target.cursor && { until: target.cursor }),
  });
  if (!signatures.length) return { events: [], cursor: target.cursor };
  // First look at this wallet: start from now, don't copy its history
  if (!target.cursor) return { events: [], cursor: signatures[0].signature };

  const events = [];
  for (const s of [...signatures].reverse()) {
    if (s.err) continue;
    const tx = await connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys;
    const index = keys.findIndex((k) => k.pubkey.toBase58() === owner);
    if (index < 0 || !keys[index].signer) continue;
    const solDelta = tx.meta.postBalances[index] - tx.meta.preBalances[index];

    const amounts = new Map(); // mint → { pre, post }
    for (const [list, field] of [[tx.meta.preTokenBalances, 'pre'], [tx.meta.postTokenBalances, 'post']]) {
      for (const b of list || []) {
        if (b.owner !== owner || b.mint === SOL_MINT) continue;
        const entry = amounts.get(b.mint) || { pre: 0n, post: 0n };
        entry[field] += BigInt(b.uiTokenAmount.amount);
        amounts.set(b.mint, entry);
      }
    }
    for (const [mint, { pre, post }] of amounts) {
      if (post > pre && solDelta < 0) events.push({ side: 'buy', token: mint, ref: s.signature });
      if (post < pre && pre > 0n) events.push({ side: 'sell', token: mint, percent: Number(((pre - post) * 100n) / pre) || 1, ref: s.signature });
    }
  }
  return { events, cursor: signatures[0].signature };
}

// ---------- EVM ----------

async function evmEvents(target, chain) {
  const provider = getProvider(chain);
  const latest = await withTimeout(provider.getBlockNumber(), 8_000);
  if (!target.cursor) return { events: [], cursor: latest };
  const fromBlock = Number(target.cursor) + 1;
  if (fromBlock > latest) return { events: [], cursor: target.cursor };
  const toBlock = Math.min(latest, fromBlock + EVM_MAX_BLOCKS - 1);

  const padded = zeroPadValue(target.address, 32);
  const [incoming, outgoing] = await Promise.all([
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, padded] }),
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, padded] }),
  ]);

  const events = [];
  const txCache = new Map();
  const sentByTarget = async (hash) => {
    if (!txCache.has(hash)) txCache.set(hash, await provider.getTransaction(hash));
    const tx = txCache.get(hash);
    return tx && tx.from.toLowerCase() === target.address ? tx : null;
  };
  const seen = new Set();
  for (const log of incoming) {
    const key = `buy:${log.transactionHash}:${log.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tx = await sentByTarget(log.transactionHash);
    // Paid with the native coin: a buy we can mirror with our native amount
    if (tx && tx.value > 0n) events.push({ side: 'buy', token: log.address, ref: log.transactionHash });
  }
  for (const log of outgoing) {
    const key = `sell:${log.transactionHash}:${log.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await sentByTarget(log.transactionHash))) continue;
    const sent = BigInt(log.data);
    const left = await new Contract(log.address, ERC20_BALANCE_ABI, provider).balanceOf(target.address).catch(() => 0n);
    const before = left + sent;
    const percent = before > 0n ? Number((sent * 100n) / before) || 1 : 100;
    events.push({ side: 'sell', token: log.address, percent, ref: log.transactionHash });
  }
  return { events, cursor: toBlock };
}

// ---------- Mirroring ----------

async function mirror(target, chain, event, notify) {
  const svc = markets.serviceFor(chain);
  const who = `👥 Copy <code>${esc(target.label)}</code> • ⛓ ${chain.name}`;
  const outcome = await attempt(() =>
    event.side === 'buy'
      ? svc.executeBuy(target.user_id, event.token, target.buy_amount, { source: 'copy' })
      : svc.executeSell(target.user_id, event.token, Math.min(100, event.percent), { source: 'copy' }),
  );
  if (outcome.status === 'ok') {
    const what = event.side === 'buy' ? `bought for ${esc(target.buy_amount)} ${chain.native}` : `sold ${Math.min(100, event.percent)}% of your bag`;
    await notify(
      target.user_id,
      `${who}: ${what} — $${esc(outcome.result.quote.token.symbol)}\n🔗 <a href="${txLink(chain, outcome.result.signature)}">View transaction</a>`,
    );
    return;
  }
  // Selling something we never bought isn't worth a message
  if (event.side === 'sell' && /don’t hold/.test(outcome.message || '')) return;
  if (outcome.status === 'error') logger.warn({ target: target.id, err: outcome.err.message }, 'Copy trade error');
  await notify(
    target.user_id,
    `⚠️ ${who}: couldn’t copy a ${event.side} of <code>${shortAddress(event.token, 6)}</code>: ${esc(outcome.message || 'busy, skipped')}`,
  );
}

async function run(notify) {
  for (const target of automation.activeCopyTargets()) {
    const chain = getChain(target.chain);
    try {
      const { events, cursor } = chain.kind === 'sol' ? await solanaEvents(target) : await evmEvents(target, chain);
      // Save the cursor first: a crash mid-way must not replay (and double-buy) the same trades
      if (cursor != null && String(cursor) !== String(target.cursor)) automation.setCopyCursor(target.id, cursor);
      for (const event of events) {
        if (event.side === 'sell' && !target.copy_sells) continue;
        await mirror(target, chain, event, notify);
      }
    } catch (err) {
      logger.debug({ target: target.id, err: err.message }, 'Copy watch failed');
    }
  }
}

module.exports = { run };
