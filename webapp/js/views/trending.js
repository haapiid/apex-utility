import { h, api, state, chainInfo, fmtCompact, fmtPrice, pct, short, avatar, empty } from '../lib.js';

// Trending table with 5m / 1h / 6h / 24h windows
export default function trending(container) {
  let duration = sessionStorage.getItem('apex.trending') || '1h';
  const durations = state.config.trendingDurations;
  const tbody = h('tbody');
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    durations.map((d) =>
      h(
        'button',
        {
          type: 'button',
          class: d === duration ? 'active' : '',
          onclick: (e) => {
            duration = d;
            sessionStorage.setItem('apex.trending', d);
            tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
            load();
          },
        },
        d.toUpperCase(),
      ),
    ),
  );
  const changeKey = { '5m': 'm5', '1h': 'h1', '6h': 'h6', '24h': 'h24' };
  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, `Trending on ${chainInfo()?.name || ''}`), tabs),
    h(
      'section',
      { class: 'panel table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, '#'), h('th', {}, 'Token'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, 'Change'), h('th', { class: 'num' }, 'MC'), h('th', { class: 'num' }, 'Liq'), h('th', { class: 'num' }, 'Vol 24h'), h('th', { class: 'num' }, 'Txns 24h')),
        ),
        tbody,
      ),
    ),
  );

  let alive = true;
  async function load() {
    tbody.replaceChildren(h('tr', {}, h('td', { colspan: 8 }, h('div', { class: 'skeleton' }))));
    try {
      const rows = await api(`/api/market/trending?chain=${state.chain}&duration=${duration}`);
      if (!alive) return;
      if (!rows.length) return tbody.replaceChildren(h('tr', {}, h('td', { colspan: 8 }, empty('No trending pools on this chain right now.'))));
      tbody.replaceChildren(
        ...rows.map((p, i) =>
          h(
            'tr',
            { class: 'link', onclick: () => (location.hash = `#/token/${p.chain}/${p.token.address}`) },
            h('td', { class: 'muted' }, i + 1),
            h('td', {}, h('div', { class: 'tok' }, avatar(p.token), h('div', {}, h('b', {}, p.token.symbol || short(p.token.address)), h('div', { class: 'fine' }, p.token.name || '')))),
            h('td', { class: 'num' }, fmtPrice(p.priceUsd)),
            h('td', { class: 'num' }, pct(p.change?.[changeKey[duration]])),
            h('td', { class: 'num' }, fmtCompact(p.mcap)),
            h('td', { class: 'num' }, fmtCompact(p.liquidity)),
            h('td', { class: 'num' }, fmtCompact(p.volume?.h24)),
            h('td', { class: 'num' }, p.txns ? `${p.txns.buys} / ${p.txns.sells}` : '–'),
          ),
        ),
      );
    } catch (err) {
      if (alive) tbody.replaceChildren(h('tr', {}, h('td', { colspan: 8 }, empty(err.status === 429 ? 'Market data is busy, try again in a moment.' : 'Could not load trending.'))));
    }
  }
  load();
  const timer = setInterval(load, 60_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
