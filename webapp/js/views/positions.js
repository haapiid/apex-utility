import { h, api, chainInfo, loggedIn, fromUnits, fmtNum, native, short, empty, loginRequired, errorToast } from '../lib.js';

// Open positions of the active wallets, valued at the current sell price, with average-cost PnL
export default function positions(container) {
  if (!loggedIn()) return loginRequired(container, 'your positions');
  const body = h('div', { class: 'table-wrap' }, h('div', { class: 'skeleton spaced' }));
  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Positions'), h('p', { class: 'fine' }, 'Active wallets · value = what you would get selling everything now')),
    h('section', { class: 'panel' }, body),
  );
  let alive = true;
  async function load() {
    try {
      const { rows, truncated } = await api('/api/positions');
      if (!alive) return;
      if (!rows.length) return body.replaceChildren(empty('No open positions yet. Find a token in Discover and make your first trade.'));
      body.replaceChildren(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Token'), h('th', {}, 'Chain'), h('th', { class: 'num' }, 'Holding'), h('th', { class: 'num' }, 'Value'), h('th', { class: 'num' }, 'Cost'), h('th', { class: 'num' }, 'PnL'), h('th', { class: 'num' }, 'Realized'))),
          h(
            'tbody',
            {},
            rows.map((r) => {
              const chain = chainInfo(r.chain);
              const pnlUp = r.pnl != null && BigInt(r.pnl) >= 0n;
              return h(
                'tr',
                { class: 'link', onclick: () => (location.hash = `#/token/${r.chain}/${r.token}`) },
                h('td', {}, h('b', {}, r.symbol || short(r.token))),
                h('td', { class: 'muted' }, chain?.name || r.chain),
                h('td', { class: 'num' }, fmtNum(fromUnits(r.balance, r.decimals), 4)),
                h('td', { class: 'num' }, r.value != null ? native(r.value, chain) : 'n/a'),
                h('td', { class: 'num muted' }, r.cost != null ? native(r.cost, chain) : '–'),
                h('td', { class: `num ${r.pnl == null ? 'muted' : pnlUp ? 'up' : 'down'}` }, r.pnl != null ? `${native(r.pnl, chain)} (${fmtNum(r.pnlPct, 1)}%)` : 'no cost data'),
                h('td', { class: 'num muted' }, r.realized && r.realized !== '0' ? native(r.realized, chain) : '–'),
              );
            }),
          ),
        ),
        truncated ? h('p', { class: 'fine panel-body' }, 'Showing the 10 most recent positions.') : null,
      );
    } catch (err) {
      if (alive) errorToast(err);
    }
  }
  load();
  const timer = setInterval(load, 45_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
