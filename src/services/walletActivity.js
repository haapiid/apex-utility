const { Contract, id: keccakId, zeroPadValue } = require('ethers');
const solanaRpc = require('./solanaRpc');
const { getProvider } = require('./evm/provider');
const { withTimeout } = require('./tradeCommon');
const { SOL_MINT } = require('../config/solana');

// New trades of a watched wallet since its cursor (used by copy trading and the wallet tracker).
//   buy  → the wallet spent the native coin and received a token
//   sell → the wallet sent a token away (percent = share of what it held before)
// Only transactions the wallet signed count, so airdrops and incoming transfers are ignored.
// Event: { side, token, percent?, tokenAmount (raw string), decimals?, native (raw string | null), ref, at }

const TRANSFER_TOPIC = keccakId('Transfer(address,address,uint256)');
const EVM_MAX_BLOCKS = 200; // per tick, keeps eth_getLogs ranges small for public RPCs
const SOL_MAX_SIGNATURES = 15;
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

async function solanaEvents(target) {
  const owner = target.address;
  const signatures = await solanaRpc.getSignatures(owner, { limit: SOL_MAX_SIGNATURES, ...(target.cursor && { until: target.cursor }) });
  if (!signatures.length) return { events: [], cursor: target.cursor };
  // First look at this wallet: start from now, don't replay its history
  if (!target.cursor) return { events: [], cursor: signatures[0].signature };

  const events = [];
  for (const s of [...signatures].reverse()) {
    if (s.err) continue;
    const tx = await solanaRpc.getTransaction(s.signature);
    if (!tx?.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.accountKeys;
    const index = keys.findIndex((k) => k.pubkey === owner);
    if (index < 0 || !keys[index].signer) continue;
    const solDelta = BigInt(tx.meta.postBalances[index] - tx.meta.preBalances[index]);

    const amounts = new Map(); // mint → { pre, post, decimals }
    for (const [list, field] of [[tx.meta.preTokenBalances, 'pre'], [tx.meta.postTokenBalances, 'post']]) {
      for (const b of list || []) {
        if (b.owner !== owner || b.mint === SOL_MINT) continue;
        const entry = amounts.get(b.mint) || { pre: 0n, post: 0n, decimals: b.uiTokenAmount.decimals };
        entry[field] += BigInt(b.uiTokenAmount.amount);
        amounts.set(b.mint, entry);
      }
    }
    const at = (s.blockTime || tx.blockTime || 0) * 1000 || Date.now();
    const native = (solDelta < 0n ? -solDelta : solDelta).toString();
    for (const [mint, { pre, post, decimals }] of amounts) {
      if (post > pre && solDelta < 0n) events.push({ side: 'buy', token: mint, tokenAmount: (post - pre).toString(), decimals, native, ref: s.signature, at });
      if (post < pre && pre > 0n) {
        events.push({
          side: 'sell',
          token: mint,
          percent: Number(((pre - post) * 100n) / pre) || 1,
          tokenAmount: (pre - post).toString(),
          decimals,
          native: solDelta > 0n ? native : null,
          ref: s.signature,
          at,
        });
      }
    }
  }
  return { events, cursor: signatures[0].signature };
}

async function evmEvents(target, chain) {
  const provider = getProvider(chain);
  const latest = await withTimeout(provider.getBlockNumber(), 8_000);
  if (!target.cursor) return { events: [], cursor: latest };
  const fromBlock = Number(target.cursor) + 1;
  if (fromBlock > latest) return { events: [], cursor: target.cursor };
  const toBlock = Math.min(latest, fromBlock + EVM_MAX_BLOCKS - 1);

  const address = target.address.toLowerCase();
  const padded = zeroPadValue(address, 32);
  const [incoming, outgoing] = await Promise.all([
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, null, padded] }),
    provider.getLogs({ fromBlock, toBlock, topics: [TRANSFER_TOPIC, padded] }),
  ]);

  const events = [];
  const txCache = new Map();
  const sentByTarget = async (hash) => {
    if (!txCache.has(hash)) txCache.set(hash, await provider.getTransaction(hash));
    const tx = txCache.get(hash);
    return tx && tx.from.toLowerCase() === address ? tx : null;
  };
  const seen = new Set();
  for (const log of incoming) {
    const key = `buy:${log.transactionHash}:${log.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tx = await sentByTarget(log.transactionHash);
    // Paid with the native coin: a buy
    if (tx && tx.value > 0n) {
      events.push({ side: 'buy', token: log.address, tokenAmount: BigInt(log.data).toString(), native: tx.value.toString(), ref: log.transactionHash, at: Date.now() });
    }
  }
  for (const log of outgoing) {
    const key = `sell:${log.transactionHash}:${log.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!(await sentByTarget(log.transactionHash))) continue;
    const sent = BigInt(log.data);
    const left = await new Contract(log.address, ERC20_BALANCE_ABI, provider).balanceOf(address).catch(() => 0n);
    const before = left + sent;
    const percent = before > 0n ? Number((sent * 100n) / before) || 1 : 100;
    events.push({ side: 'sell', token: log.address, percent, tokenAmount: sent.toString(), native: null, ref: log.transactionHash, at: Date.now() });
  }
  return { events, cursor: toBlock };
}

const eventsFor = (target, chain) => (chain.kind === 'sol' ? solanaEvents(target) : evmEvents(target, chain));

module.exports = { eventsFor };
