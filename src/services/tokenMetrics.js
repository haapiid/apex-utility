const axios = require('axios');
const { PublicKey } = require('@solana/web3.js');
const { db } = require('../db');
const jupiter = require('./jupiterService');
const solanaRpc = require('./solanaRpc');
const logger = require('../utils/logger');

// Token card metrics for ApeX Pro: holders, top 10 %, dev %, bundled %, snipers.
//   Solana: Jupiter Tokens API (holders, top holders %, dev balance %, dev, organic score; 100 per call)
//           + our own launch analysis from the first transactions (bundles, snipers), stored in token_launch
//   EVM:    GoPlus (holder count, top 10 holders, creator %). Its free tier answers one token per call,
//           so EVM tokens are queued and cached; cards show "–" until a value arrives.
// metrics(): { holders, top10Pct, devPct, dev, bundledPct, bundlers, snipers, sniperPct, organicScore,
//              launchpad, mintDisabled, freezeDisabled } — any of them may be null (unknown)

const goplus = axios.create({ baseURL: 'https://api.gopluslabs.io/api/v1', timeout: 8_000 });
// Jupiter's data API behind jup.ag (not documented, may change): top 100 holders with tags and the
// wallet that first funded each holder, which lets the bubble map group wallets run by one person.
// Falls back to the RPC's top 20 accounts when it fails.
const JUP_DATA = 'https://datapi.jup.ag/v1';

async function jupDataGet(path) {
  const res = await fetch(`${JUP_DATA}${path}`, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Jupiter data API ${res.status}`);
  return res.json();
}
const GOPLUS_CHAIN = { eth: '1', bsc: '56', base: '8453', hood: '4663' };

const JUP_TTL_MS = 60_000;
const GOPLUS_TTL_MS = 10 * 60_000;
const GOPLUS_GAP_MS = 1_500;
const LAUNCH_MAX_AGE_MS = 3 * 24 * 60 * 60_000; // older tokens: too many transactions to reach the start
const LAUNCH_MAX_PAGES = 5; // × 1000 signatures
const LAUNCH_SLOTS = 3; // snipers = first buys in the 3 slots after the launch slot (~1.2 s)
const LAUNCH_MAX_TXS = 40;

const jupCache = new Map(); // mint → { at, value }
const goplusCache = new Map(); // `${chain}:${address}` → { at, value }
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ---------- Solana: Jupiter Tokens API ----------

function fromJupiter(t) {
  return {
    name: t.name,
    symbol: t.symbol,
    image: t.icon || null,
    holders: num(t.holderCount),
    top10Pct: num(t.audit?.topHoldersPercentage),
    devPct: num(t.audit?.devBalancePercentage),
    dev: t.dev || null,
    devMints: num(t.audit?.devMints),
    organicScore: num(t.organicScore),
    launchpad: t.launchpad || null,
    graduated: Boolean(t.graduatedPool),
    mintDisabled: t.audit?.mintAuthorityDisabled ?? null,
    freezeDisabled: t.audit?.freezeAuthorityDisabled ?? null,
    createdAt: Date.parse(t.firstPool?.createdAt || t.createdAt || '') || null,
    socials: { twitter: t.twitter || null, telegram: t.telegram || null, website: t.website || null },
    priceUsd: num(t.usdPrice),
    mcap: num(t.mcap),
    liquidity: num(t.liquidity),
    change1h: num(t.stats1h?.priceChange),
    totalSupply: num(t.totalSupply),
    decimals: num(t.decimals),
  };
}

async function jupiterTokens(mints) {
  const now = Date.now();
  const missing = mints.filter((m) => !(jupCache.get(m)?.at > now - JUP_TTL_MS));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    try {
      const { data } = await jupiter.api.get('/tokens/v2/search', { params: { query: batch.join(',') } });
      const found = new Map((Array.isArray(data) ? data : []).map((t) => [t.id, t]));
      for (const m of batch) jupCache.set(m, { at: now, value: found.has(m) ? fromJupiter(found.get(m)) : null });
    } catch (err) {
      logger.debug({ err: err.message }, 'Jupiter token metrics failed');
    }
  }
  return new Map(mints.map((m) => [m, jupCache.get(m)?.value ?? null]));
}

// Trending Solana tokens for the ticker (Jupiter's own ranking)
let trendingCache = { at: 0, value: [] };
async function solanaTrending() {
  if (Date.now() - trendingCache.at < 60_000) return trendingCache.value;
  const { data } = await jupiter.api.get('/tokens/v2/toptrending/1h', { params: { limit: 20 } });
  const value = (Array.isArray(data) ? data : []).map((t) => ({ address: t.id, ...fromJupiter(t) }));
  value.forEach((t) => jupCache.set(t.address, { at: Date.now(), value: t }));
  trendingCache = { at: Date.now(), value };
  return value;
}

// ---------- Solana: launch analysis (bundles, snipers) ----------

const onCurve = (address) => {
  try {
    return PublicKey.isOnCurve(new PublicKey(address).toBytes());
  } catch {
    return false;
  }
};

const getLaunch = (chain, token) => db.prepare('SELECT * FROM token_launch WHERE chain = ? AND token = ?').get(chain, token) || null;

function saveLaunch(token, fields) {
  db.prepare(
    `INSERT INTO token_launch (chain, token, status, first_slot, bundled_pct, bundlers, snipers, sniper_pct, computed_at)
     VALUES ('sol', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain, token) DO UPDATE SET status = excluded.status, first_slot = excluded.first_slot,
       bundled_pct = excluded.bundled_pct, bundlers = excluded.bundlers, snipers = excluded.snipers,
       sniper_pct = excluded.sniper_pct, computed_at = excluded.computed_at`,
  ).run(token, fields.status, fields.firstSlot ?? null, fields.bundledPct ?? null, fields.bundlers ?? null, fields.snipers ?? null, fields.sniperPct ?? null, Date.now());
}

// Walks back to the token's first transactions and sums what wallets (not programs/pools) bought:
// in the launch slot itself ("bundled") and in the next few slots ("snipers")
async function analyseLaunch(mint) {
  const sigs = [];
  let before;
  for (let page = 0; page < LAUNCH_MAX_PAGES; page++) {
    const batch = await solanaRpc.getSignatures(mint, before ? { before } : {});
    sigs.push(...batch);
    if (batch.length < 1000) break;
    before = batch.at(-1).signature;
    if (page === LAUNCH_MAX_PAGES - 1) return saveLaunch(mint, { status: 'unknown' });
  }
  const ok = sigs.filter((s) => !s.err);
  if (!ok.length) return saveLaunch(mint, { status: 'unknown' });
  const firstSlot = Math.min(...ok.map((s) => s.slot));
  const early = ok.filter((s) => s.slot <= firstSlot + LAUNCH_SLOTS).sort((a, b) => a.slot - b.slot).slice(0, LAUNCH_MAX_TXS);

  const supply = BigInt((await solanaRpc.call('getTokenSupply', [mint])).value.amount);
  if (supply === 0n) return saveLaunch(mint, { status: 'unknown' });
  const buyers = new Map(); // owner → { amount, slot }
  for (const s of early) {
    const tx = await solanaRpc.getTransaction(s.signature);
    if (!tx?.meta || tx.meta.err) continue;
    const pre = new Map();
    for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint) pre.set(b.owner, (pre.get(b.owner) || 0n) + BigInt(b.uiTokenAmount.amount));
    const post = new Map();
    for (const b of tx.meta.postTokenBalances || []) if (b.mint === mint) post.set(b.owner, (post.get(b.owner) || 0n) + BigInt(b.uiTokenAmount.amount));
    for (const [owner, after] of post) {
      const gained = after - (pre.get(owner) || 0n);
      // Bonding curves and pools are program accounts (off the ed25519 curve): not buyers
      if (gained <= 0n || !onCurve(owner)) continue;
      const entry = buyers.get(owner) || { amount: 0n, slot: s.slot };
      entry.amount += gained;
      buyers.set(owner, entry);
    }
  }
  let bundled = 0n;
  let sniped = 0n;
  let bundlers = 0;
  let snipers = 0;
  for (const { amount, slot } of buyers.values()) {
    if (slot === firstSlot) {
      bundled += amount;
      bundlers++;
    } else {
      sniped += amount;
      snipers++;
    }
  }
  const pct = (x) => Number((x * 1_000_000n) / supply) / 10_000;
  saveLaunch(mint, { status: 'ok', firstSlot, bundledPct: pct(bundled), bundlers, snipers, sniperPct: pct(sniped) });
}

// One analysis at a time in the background; the newest requests go first (they're what people look at)
const launchQueue = [];
const queued = new Set();
let launchBusy = false;

function queueLaunch(mint) {
  if (queued.has(mint)) return;
  queued.add(mint);
  launchQueue.unshift(mint);
  if (launchQueue.length > 200) queued.delete(launchQueue.pop());
  drainLaunch();
}

async function drainLaunch() {
  if (launchBusy) return;
  launchBusy = true;
  while (launchQueue.length) {
    const mint = launchQueue.shift();
    try {
      await analyseLaunch(mint);
    } catch (err) {
      logger.debug({ mint, err: err.message }, 'Launch analysis failed');
    } finally {
      queued.delete(mint);
    }
  }
  launchBusy = false;
}

// ---------- EVM: GoPlus ----------

function fromGoplus(r) {
  const holders = (r.holders || []).map((x) => ({
    address: x.address,
    pct: Number(x.percent) * 100,
    tags: [x.is_contract === 1 && 'contract', x.is_locked === 1 && 'locked', x.tag].filter(Boolean),
  }));
  const creator = String(r.creator_address || '').toLowerCase();
  holders.forEach((x) => x.address.toLowerCase() === creator && x.tags.push('dev'));
  return {
    holders: num(r.holder_count),
    top10Pct: holders.filter((x) => !x.tags.includes('contract')).slice(0, 10).reduce((sum, x) => sum + x.pct, 0),
    devPct: r.creator_percent != null ? Number(r.creator_percent) * 100 : null,
    dev: r.creator_address || null,
    holderList: holders,
  };
}

const goplusQueue = [];
const goplusQueued = new Set();
let goplusBusy = false;

async function fetchGoplus(chain, address) {
  const id = GOPLUS_CHAIN[chain.key];
  if (!id) return null;
  const { data } = await goplus.get(`/token_security/${id}`, { params: { contract_addresses: address } });
  const r = data.result?.[address.toLowerCase()];
  return r && Object.keys(r).length ? fromGoplus(r) : null;
}

function queueGoplus(chain, address) {
  const key = `${chain.key}:${address.toLowerCase()}`;
  if (goplusQueued.has(key) || !GOPLUS_CHAIN[chain.key]) return;
  goplusQueued.add(key);
  goplusQueue.push({ chain, address, key });
  if (goplusQueue.length > 150) goplusQueued.delete(goplusQueue.shift().key);
  drainGoplus();
}

async function drainGoplus() {
  if (goplusBusy) return;
  goplusBusy = true;
  while (goplusQueue.length) {
    const { chain, address, key } = goplusQueue.shift();
    try {
      goplusCache.set(key, { at: Date.now(), value: await fetchGoplus(chain, address) });
    } catch (err) {
      logger.debug({ key, err: err.message }, 'GoPlus metrics failed');
    } finally {
      goplusQueued.delete(key);
    }
    await new Promise((r) => setTimeout(r, GOPLUS_GAP_MS));
  }
  goplusBusy = false;
}

async function goplusNow(chain, address) {
  const key = `${chain.key}:${address.toLowerCase()}`;
  const hit = goplusCache.get(key);
  if (hit && Date.now() - hit.at < GOPLUS_TTL_MS) return hit.value;
  const value = await fetchGoplus(chain, address).catch(() => hit?.value ?? null);
  goplusCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------- public ----------

const EMPTY = { holders: null, top10Pct: null, devPct: null, dev: null, bundledPct: null, bundlers: null, snipers: null, sniperPct: null };

function launchFields(mint, createdAt) {
  const launch = getLaunch('sol', mint);
  if (launch) return launch.status === 'ok' ? { bundledPct: launch.bundled_pct, bundlers: launch.bundlers, snipers: launch.snipers, sniperPct: launch.sniper_pct } : {};
  if (createdAt && Date.now() - createdAt < LAUNCH_MAX_AGE_MS) queueLaunch(mint);
  return {};
}

/** { [address]: metrics } for up to 100 tokens of one chain; missing values are null, never throws */
async function metrics(chain, addresses) {
  const list = [...new Set(addresses.filter(Boolean))].slice(0, 100);
  const out = {};
  if (chain.kind === 'sol') {
    const jup = await jupiterTokens(list);
    for (const mint of list) {
      const j = jup.get(mint);
      out[mint] = { ...EMPTY, ...(j && { ...j }), ...launchFields(mint, j?.createdAt) };
    }
    return out;
  }
  for (const address of list) {
    const hit = goplusCache.get(`${chain.key}:${address.toLowerCase()}`);
    if (!hit || Date.now() - hit.at > GOPLUS_TTL_MS) queueGoplus(chain, address);
    const { holderList, ...g } = hit?.value || {};
    out[address] = { ...EMPTY, ...g };
  }
  return out;
}

async function jupiterHolders(mint) {
  const [data, jup] = await Promise.all([jupDataGet(`/holders/${mint}`), jupiterTokens([mint])]);
  const info = jup.get(mint);
  const supply = info?.totalSupply;
  if (!Array.isArray(data?.holders) || !supply) throw new Error('No holder data');
  const list = data.holders.map((x) => ({
    address: x.address,
    pct: (Number(x.amount) / supply) * 100,
    funder: x.addressInfo?.fundingAddress || null,
    tags: [
      ...(x.tags || []).map((t) => (t.id === 'Pool' ? 'pool' : t.name || t.id)),
      ...(x.holderTags || []).map((t) => t.name || t.id || t),
      x.address === info.dev && 'dev',
    ].filter((t) => typeof t === 'string' && t),
  }));
  return { count: info.holders ?? data.count ?? null, list, source: 'Jupiter (top 100)' };
}

/** Biggest holders: [{ address, pct, tags, funder? }] plus the holder count */
async function holders(chain, address) {
  if (chain.kind === 'evm') {
    const g = await goplusNow(chain, address);
    return { count: g?.holders ?? null, list: g?.holderList || [], source: 'GoPlus (top 10)' };
  }
  try {
    return await jupiterHolders(address);
  } catch (err) {
    logger.debug({ mint: address, err: err.message }, 'Jupiter holders failed, using the RPC');
  }
  const [largest, supplyRes, jup] = await Promise.all([
    solanaRpc.call('getTokenLargestAccounts', [address, { commitment: 'confirmed' }]),
    solanaRpc.call('getTokenSupply', [address]),
    jupiterTokens([address]),
  ]);
  const supply = Number(supplyRes.value.amount);
  const accounts = largest.value || [];
  const infos = accounts.length
    ? (await solanaRpc.call('getMultipleAccounts', [accounts.map((a) => a.address), { encoding: 'jsonParsed' }])).value
    : [];
  const dev = jup.get(address)?.dev;
  const byOwner = new Map();
  accounts.forEach((a, i) => {
    const owner = infos[i]?.data?.parsed?.info?.owner || a.address;
    byOwner.set(owner, (byOwner.get(owner) || 0) + Number(a.amount));
  });
  const list = [...byOwner]
    .map(([owner, amount]) => ({
      address: owner,
      pct: supply > 0 ? (amount / supply) * 100 : 0,
      tags: [!onCurve(owner) && 'pool / program', owner === dev && 'dev'].filter(Boolean),
    }))
    .sort((a, b) => b.pct - a.pct);
  return { count: jup.get(address)?.holders ?? null, list, source: 'Solana RPC (top 20 accounts)' };
}

/** Launch stats of one Solana token, computed now if needed (token page) */
async function launch(mint) {
  if (!getLaunch('sol', mint)) await analyseLaunch(mint).catch((err) => logger.debug({ mint, err: err.message }, 'Launch analysis failed'));
  const row = getLaunch('sol', mint);
  return row?.status === 'ok' ? { bundledPct: row.bundled_pct, bundlers: row.bundlers, snipers: row.snipers, sniperPct: row.sniper_pct } : null;
}

module.exports = { metrics, holders, launch, solanaTrending, jupiterTokens };
