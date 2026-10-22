const axios = require('axios');
const logger = require('../utils/logger');

// Market data for ApeX Pro (free public APIs, no keys):
//   DexScreener   token pairs, prices, liquidity, search, boosted tokens (generous limits)
//   GeckoTerminal trending / new pools, OHLCV candles, trade tape (strict free limit: we queue calls)
// Every call goes through a stale-while-revalidate cache, so users never wait on the Gecko queue when
// an older answer exists, and many viewers of the same token cost one upstream call.

const dex = axios.create({ baseURL: 'https://api.dexscreener.com', timeout: 10_000 });
const gecko = axios.create({
  baseURL: 'https://api.geckoterminal.com/api/v2',
  timeout: 15_000,
  headers: { accept: 'application/json;version=20230302' },
});

// ---------- cache ----------

const cache = new Map(); // key → { value, at, pending }

async function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  const fresh = hit && Date.now() - hit.at < ttlMs;
  if (fresh) return hit.value;
  if (!hit?.pending) {
    const pending = load()
      .then((value) => {
        cache.set(key, { value, at: Date.now() });
        return value;
      })
      .catch((err) => {
        logger.debug({ key, err: err.message }, 'Market data fetch failed');
        if (hit) cache.set(key, { ...hit, pending: null });
        else cache.delete(key);
        throw err;
      });
    cache.set(key, { ...(hit || { value: undefined, at: 0 }), pending });
  }
  // Serve the stale value right away when we have one; otherwise wait for the load
  if (hit && hit.value !== undefined) return hit.value;
  return cache.get(key).pending;
}

// Drop old entries now and then
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, entry] of cache) if (entry.at && entry.at < cutoff && !entry.pending) cache.delete(key);
}, 10 * 60_000).unref();

// ---------- GeckoTerminal queue ----------

const GECKO_GAP_MS = 6_500; // ≈ 9 calls/min stays under the free limit
let geckoChain = Promise.resolve();
let geckoLast = 0;

function geckoGet(path, params) {
  const run = async () => {
    const wait = geckoLast + GECKO_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geckoLast = Date.now();
    const { data } = await gecko.get(path, { params });
    return data;
  };
  const result = geckoChain.then(run, run);
  geckoChain = result.catch(() => {});
  return result;
}

// ---------- normalizing ----------

const num = (v) => (v == null || v === '' ? null : Number(v));

function fromGeckoPool(pool, included, chain) {
  const a = pool.attributes;
  const tokenId = pool.relationships?.base_token?.data?.id;
  const token = included?.find((t) => t.id === tokenId)?.attributes;
  const [baseSymbol] = String(a.name || '').split(' / ');
  return {
    chain: chain.key,
    pool: a.address,
    dex: pool.relationships?.dex?.data?.id || null,
    token: {
      address: token?.address || tokenId?.slice(tokenId.indexOf('_') + 1) || null,
      symbol: token?.symbol || baseSymbol,
      name: token?.name || baseSymbol,
      image: token?.image_url && token.image_url !== 'missing.png' ? token.image_url : null,
    },
    priceUsd: num(a.base_token_price_usd),
    mcap: num(a.market_cap_usd) ?? num(a.fdv_usd),
    liquidity: num(a.reserve_in_usd),
    volume: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h6: num(a.volume_usd?.h6), h24: num(a.volume_usd?.h24) },
    change: {
      m5: num(a.price_change_percentage?.m5),
      h1: num(a.price_change_percentage?.h1),
      h6: num(a.price_change_percentage?.h6),
      h24: num(a.price_change_percentage?.h24),
    },
    txns: a.transactions?.h24 ? { buys: a.transactions.h24.buys, sells: a.transactions.h24.sells } : null,
    txnsH1: a.transactions?.h1 ? { buys: a.transactions.h1.buys, sells: a.transactions.h1.sells } : null,
    createdAt: a.pool_created_at ? Date.parse(a.pool_created_at) : null,
  };
}

function fromDexPair(p, chain) {
  return {
    chain: chain.key,
    pool: p.pairAddress,
    dex: p.dexId,
    token: {
      address: p.baseToken?.address,
      symbol: p.baseToken?.symbol,
      name: p.baseToken?.name,
      image: p.info?.imageUrl || null,
    },
    quote: { address: p.quoteToken?.address, symbol: p.quoteToken?.symbol },
    priceUsd: num(p.priceUsd),
    priceNative: num(p.priceNative),
    mcap: num(p.marketCap) ?? num(p.fdv),
    fdv: num(p.fdv),
    liquidity: num(p.liquidity?.usd),
    volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
    change: { m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1), h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24) },
    txns: p.txns?.h24 ? { buys: p.txns.h24.buys, sells: p.txns.h24.sells } : null,
    txnsH1: p.txns?.h1 ? { buys: p.txns.h1.buys, sells: p.txns.h1.sells } : null,
    createdAt: p.pairCreatedAt || null,
    links: {
      websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean),
      socials: (p.info?.socials || []).map((s) => ({ type: s.type, url: s.url })).filter((s) => s.url),
    },
    url: p.url,
  };
}

const sameAddress = (chain, a, b) => (chain.kind === 'evm' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

// ---------- public API ----------

const TRENDING_DURATIONS = ['5m', '1h', '6h', '24h'];

async function trending(chain, duration = '1h') {
  if (!chain.gecko) return [];
  const d = TRENDING_DURATIONS.includes(duration) ? duration : '1h';
  return cached(`trending:${chain.key}:${d}`, 90_000, async () => {
    const data = await geckoGet(`/networks/${chain.gecko}/trending_pools`, { duration: d, include: 'base_token' });
    return (data.data || []).map((p) => fromGeckoPool(p, data.included, chain));
  });
}

async function newPairs(chain) {
  if (!chain.gecko) return [];
  return cached(`new:${chain.key}`, 60_000, async () => {
    const data = await geckoGet(`/networks/${chain.gecko}/new_pools`, { include: 'base_token' });
    return (data.data || []).map((p) => fromGeckoPool(p, data.included, chain));
  });
}

// Tokens promoted on DexScreener right now, with their best pair's stats
async function boosted(chain) {
  return cached(`boosted:${chain.key}`, 120_000, async () => {
    const { data } = await dex.get('/token-boosts/top/v1');
    const addresses = [...new Set((data || []).filter((b) => b.chainId === chain.dexscreener).map((b) => b.tokenAddress))].slice(0, 30);
    if (!addresses.length) return [];
    const pairs = await tokenPairs(chain, addresses);
    return addresses.map((a) => bestPair(chain, a, pairs)).filter(Boolean);
  });
}

// All pairs of up to 30 tokens (one call)
async function tokenPairs(chain, addresses) {
  const list = [].concat(addresses);
  return cached(`pairs:${chain.key}:${list.join(',')}`, 20_000, async () => {
    const { data } = await dex.get(`/tokens/v1/${chain.dexscreener}/${list.join(',')}`);
    return (Array.isArray(data) ? data : []).map((p) => fromDexPair(p, chain));
  });
}

function bestPair(chain, address, pairs) {
  return (
    pairs
      .filter((p) => sameAddress(chain, p.token.address, address))
      .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))[0] || null
  );
}

// Pools of one token on GeckoTerminal, most liquid first, where the token is the pool's base token
async function geckoTokenPools(chain, address) {
  if (!chain.gecko) return [];
  return cached(`gpools:${chain.key}:${address.toLowerCase()}`, 120_000, async () => {
    const data = await geckoGet(`/networks/${chain.gecko}/tokens/${address}/pools`, { include: 'base_token' });
    return (data.data || [])
      .map((p) => fromGeckoPool(p, data.included, chain))
      .filter((p) => sameAddress(chain, p.token.address, address))
      .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
  });
}

// Token header for the token page: its most liquid pair. DexScreener first; tokens it hasn't listed yet
// (young chains like Robinhood, HyperEVM, MegaETH) fall back to GeckoTerminal so they still get a price,
// a chart and trades.
async function tokenOverview(chain, address) {
  const fromDex = bestPair(chain, address, await tokenPairs(chain, address).catch(() => []));
  if (fromDex) return fromDex;
  const [pool] = await geckoTokenPools(chain, address).catch(() => []);
  return pool ? { ...pool, links: { websites: [], socials: [] }, source: 'GeckoTerminal' } : null;
}

// GeckoTerminal timeframes: label → [timeframe, aggregate]
const TIMEFRAMES = {
  '1m': ['minute', 1],
  '5m': ['minute', 5],
  '15m': ['minute', 15],
  '1h': ['hour', 1],
  '4h': ['hour', 4],
  '1d': ['day', 1],
};

// Candles for a pool: [{ time (s), open, high, low, close, volume }] oldest first, prices in USD
async function candles(chain, pool, tf = '15m') {
  if (!chain.gecko) return [];
  const [timeframe, aggregate] = TIMEFRAMES[tf] || TIMEFRAMES['15m'];
  return cached(`ohlcv:${chain.key}:${pool}:${tf}`, tf === '1m' ? 30_000 : 60_000, async () => {
    const data = await geckoGet(`/networks/${chain.gecko}/pools/${pool}/ohlcv/${timeframe}`, { aggregate, limit: 300, currency: 'usd' });
    return (data.data?.attributes?.ohlcv_list || [])
      .map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }))
      .sort((a, b) => a.time - b.time);
  });
}

// Recent trades of a pool (GeckoTerminal keeps the last 300): [{ time (ms), side, usd, tokenAmount, priceUsd, maker, tx }]
async function allTrades(chain, pool, tokenAddress) {
  if (!chain.gecko) return [];
  return cached(`trades:${chain.key}:${pool}`, 20_000, async () => {
    const data = await geckoGet(`/networks/${chain.gecko}/pools/${pool}/trades`);
    return (data.data || []).map(({ attributes: t }) => {
      const side = t.kind === 'sell' ? 'sell' : 'buy';
      const tokenIsFrom = tokenAddress && sameAddress(chain, t.from_token_address, tokenAddress);
      return {
        time: Date.parse(t.block_timestamp),
        side,
        usd: num(t.volume_in_usd),
        tokenAmount: num(tokenIsFrom ? t.from_token_amount : t.to_token_amount),
        priceUsd: num(tokenIsFrom ? t.price_from_in_usd : t.price_to_in_usd),
        maker: t.tx_from_address,
        tx: t.tx_hash,
      };
    });
  });
}

const trades = async (chain, pool, tokenAddress) => (await allTrades(chain, pool, tokenAddress)).slice(0, 60);

// Wallets ranked by realized PnL over the pool's last 300 trades (sold USD − bought USD)
async function topTraders(chain, pool, tokenAddress) {
  const rows = await allTrades(chain, pool, tokenAddress);
  const byMaker = new Map();
  for (const t of rows) {
    if (!t.maker) continue;
    const m = byMaker.get(t.maker) || { maker: t.maker, buys: 0, sells: 0, boughtUsd: 0, soldUsd: 0, boughtTokens: 0, soldTokens: 0 };
    if (t.side === 'buy') {
      m.buys++;
      m.boughtUsd += t.usd || 0;
      m.boughtTokens += t.tokenAmount || 0;
    } else {
      m.sells++;
      m.soldUsd += t.usd || 0;
      m.soldTokens += t.tokenAmount || 0;
    }
    byMaker.set(t.maker, m);
  }
  return {
    window: rows.length,
    since: rows.length ? Math.min(...rows.map((t) => t.time)) : null,
    rows: [...byMaker.values()]
      .map((m) => ({ ...m, pnlUsd: m.soldUsd - m.boughtUsd, volumeUsd: m.boughtUsd + m.soldUsd }))
      .sort((a, b) => b.pnlUsd - a.pnlUsd || b.volumeUsd - a.volumeUsd)
      .slice(0, 30),
  };
}

// Free-text search across our chains
async function search(query, chains) {
  const ids = new Map(chains.map((c) => [c.dexscreener, c]));
  return cached(`search:${query.toLowerCase()}`, 60_000, async () => {
    const { data } = await dex.get('/latest/dex/search', { params: { q: query } });
    const seen = new Set();
    return (data.pairs || [])
      .filter((p) => ids.has(p.chainId))
      .map((p) => fromDexPair(p, ids.get(p.chainId)))
      .sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0))
      .filter((p) => {
        const key = `${p.chain}:${p.token.address}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 20);
  });
}

// Top bar ticker: [{ chain, token: { address, symbol, image }, priceUsd, change1h, mcap }]
async function ticker(chain) {
  if (chain.kind === 'sol') {
    const list = await require('./tokenMetrics').solanaTrending();
    return list.slice(0, 20).map((t) => ({ chain: chain.key, token: { address: t.address, symbol: t.symbol, image: t.image }, priceUsd: t.priceUsd, change1h: t.change1h, mcap: t.mcap }));
  }
  const rows = await trending(chain, '1h');
  return rows.slice(0, 20).map((p) => ({ chain: p.chain, token: p.token, priceUsd: p.priceUsd, change1h: p.change?.h1 ?? null, mcap: p.mcap }));
}

module.exports = { trending, newPairs, boosted, tokenPairs, tokenOverview, candles, trades, topTraders, ticker, search, TIMEFRAMES, TRENDING_DURATIONS };
