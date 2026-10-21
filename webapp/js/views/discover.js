import { h, api, state, chainInfo, fmtCompact, fmtPrice, pct, ago, short, avatar, panel, empty } from '../lib.js';

// Discover: three live columns for the selected chain, like a trading terminal's "trenches"
const COLUMNS = [
  { key: 'new', title: '🆕 New pairs', path: 'new', hint: 'Pools created most recently' },
  { key: 'trending', title: '🔥 Trending 1h', path: 'trending?duration=1h', hint: 'Most active pools in the last hour' },
  { key: 'boosted', title: '🚀 Boosted', path: 'boosted', hint: 'Promoted on DexScreener right now' },
];
const REFRESH_MS = 30_000;

export function tokenCard(p) {
  return h(
    'a',
    { class: 'card', href: `#/token/${p.chain}/${p.token.address}` },
    avatar(p.token),
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'name' }, p.token.symbol || short(p.token.address), h('small', {}, p.token.name && p.token.name !== p.token.symbol ? p.token.name : '')),
      h(
        'div',
        { class: 'meta' },
        p.createdAt ? h('span', { title: 'Pair age' }, `⏱ ${ago(p.createdAt)}`) : null,
        p.txns ? h('span', { title: '24h buys / sells' }, `🟢 ${p.txns.buys} 🔴 ${p.txns.sells}`) : null,
        h('span', {}, '1h ', pct(p.change?.h1)),
      ),
    ),
    h(
      'div',
      { class: 'stats' },
      h('span', {}, 'MC ', h('b', {}, fmtCompact(p.mcap))),
      h('span', {}, 'VOL ', h('b', {}, fmtCompact(p.volume?.h24))),
      h('span', {}, 'LIQ ', h('b', {}, fmtCompact(p.liquidity))),
      h('span', { class: 'muted' }, fmtPrice(p.priceUsd)),
    ),
  );
}

export default function discover(container) {
  const lists = {};
  const grid = h(
    'div',
    { class: 'columns' },
    COLUMNS.map((c) => {
      lists[c.key] = h('div', { class: 'list' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton spaced' })));
      return panel(c.title, lists[c.key], h('span', { class: 'fine', title: c.hint }, 'live'));
    }),
  );
  const head = h('div', { class: 'page-head' }, h('h1', {}, `Discover on ${chainInfo()?.name || ''}`), h('p', { class: 'fine' }, 'Tap a token to open its chart and trade. Lists refresh every 30 seconds.'));
  container.append(head, grid);

  let alive = true;
  async function load() {
    const chain = state.chain;
    await Promise.all(
      COLUMNS.map(async (c) => {
        try {
          const rows = await api(`/api/market/${c.path}${c.path.includes('?') ? '&' : '?'}chain=${chain}`);
          if (!alive || chain !== state.chain) return;
          lists[c.key].replaceChildren(...(rows.length ? rows.map(tokenCard) : [empty('Nothing here yet on this chain.')]));
        } catch (err) {
          if (alive) lists[c.key].replaceChildren(empty(err.status === 429 ? 'Market data is busy, retrying…' : 'Could not load this list.'));
        }
      }),
    );
  }
  load();
  const timer = setInterval(load, REFRESH_MS);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
