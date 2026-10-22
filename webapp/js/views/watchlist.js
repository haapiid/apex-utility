import { h, api, chainInfo, loggedIn, fmtCompact, fmtPrice, pct, short, avatar, empty, loginRequired, errorToast } from '../lib.js';

// Starred tokens with live price, market cap, liquidity and change. Star tokens on their token page.
export function watchlistTable(rows, { onRemove } = {}) {
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Token'), h('th', { class: 'num' }, 'Price'), h('th', { class: 'num' }, '1h'), h('th', { class: 'num' }, '24h'), h('th', { class: 'num' }, 'MC'), h('th', { class: 'num' }, 'Liq'), onRemove ? h('th', {}, '') : null)),
    h(
      'tbody',
      {},
      rows.map((w) => {
        const p = w.pair;
        return h(
          'tr',
          { class: 'link', onclick: () => (location.hash = `#/token/${w.chain}/${w.token}`) },
          h('td', {}, h('div', { class: 'tok' }, avatar(p?.token), h('div', {}, h('b', {}, p?.token.symbol || short(w.token)), h('div', { class: 'fine' }, chainInfo(w.chain)?.name || w.chain)))),
          h('td', { class: 'num' }, fmtPrice(p?.priceUsd)),
          h('td', { class: 'num' }, pct(p?.change?.h1)),
          h('td', { class: 'num' }, pct(p?.change?.h24)),
          h('td', { class: 'num' }, fmtCompact(p?.mcap)),
          h('td', { class: 'num' }, fmtCompact(p?.liquidity)),
          onRemove
            ? h('td', {}, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Remove from watchlist', onclick: (e) => (e.stopPropagation(), onRemove(w)) }, '★'))
            : null,
        );
      }),
    ),
  );
}

export default function watchlist(container) {
  if (!loggedIn()) return loginRequired(container, 'your watchlist');
  const body = h('div', { class: 'table-wrap' }, h('div', { class: 'skeleton spaced' }));
  container.append(h('div', { class: 'page-head' }, h('h1', {}, 'Watchlist'), h('p', { class: 'fine' }, 'Tap ☆ on a token page to add it. Prices refresh every 30 seconds.')), h('section', { class: 'panel' }, body));
  let alive = true;

  async function remove(w) {
    await api('/api/watchlist', { method: 'POST', body: { chain: w.chain, token: w.token, remove: true } }).catch(errorToast);
    load();
  }

  async function load() {
    try {
      const rows = await api('/api/watchlist/overview');
      if (!alive) return;
      body.replaceChildren(rows.length ? watchlistTable(rows, { onRemove: remove }) : empty('Your watchlist is empty. Open a token and tap ☆ next to its name.'));
    } catch (err) {
      if (alive) errorToast(err);
    }
  }
  load();
  const timer = setInterval(load, 30_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
