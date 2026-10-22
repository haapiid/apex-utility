import { h, api, state, chainInfo, loggedIn, fromUnits, fmtNum, native, short, empty, loginRequired, errorToast } from '../lib.js';
import { historyTable } from '../history.js';

// Positions (open bags of the active wallets, valued at the current sell price, with average-cost PnL)
// and History (every trade made with ApeX: bot, web and automation)
export default function positions(container, _params, query) {
  if (!loggedIn()) return loginRequired(container, 'your positions');
  let tab = query?.get('tab') === 'history' ? 'history' : 'positions';
  const body = h('div', { class: 'table-wrap' }, h('div', { class: 'skeleton spaced' }));
  const tabs = h('div', { class: 'tabs' });
  const filters = h('div', { class: 'row wrap panel-body flush-bottom' });
  const hint = h('p', { class: 'fine' });
  container.append(h('div', { class: 'page-head' }, h('h1', {}, 'Positions'), hint, tabs), h('section', { class: 'panel' }, filters, body));
  let alive = true;

  function renderTabs() {
    tabs.replaceChildren(...[['positions', 'Open positions'], ['history', 'History']].map(([k, label]) => h('button', { type: 'button', class: k === tab ? 'active' : '', onclick: () => ((tab = k), renderTabs(), refresh()) }, label)));
    hint.textContent = tab === 'positions' ? 'Active wallets · value = what you would get selling everything now' : 'Every trade you made with ApeX: bot, ApeX Pro and automation';
    filters.hidden = tab !== 'history';
  }

  // ---------- history ----------
  const select = (options) => h('select', { class: 'input auto', onchange: () => loadHistory() }, options.map(([v, label]) => h('option', { value: v }, label)));
  const fChain = select([['', 'All chains'], ...state.config.chains.map((c) => [c.key, c.name])]);
  const fSide = select([['', 'Buys & sells'], ['buy', 'Buys'], ['sell', 'Sells']]);
  const fSource = select([['', 'Any source'], ['manual', 'Manual'], ['snipe', 'Snipe'], ['limit', 'Limit / TP / SL'], ['dca', 'DCA'], ['copy', 'Copy trade'], ['antirug', 'Anti-rug']]);
  filters.append(fChain, fSide, fSource);
  let rows = [];
  let next = null;

  async function loadHistory(more = false) {
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (fChain.value) q.set('chain', fChain.value);
      if (fSide.value) q.set('side', fSide.value);
      if (fSource.value) q.set('source', fSource.value);
      if (more && next) q.set('before', next);
      const res = await api(`/api/history?${q}`);
      if (!alive || tab !== 'history') return;
      rows = more ? [...rows, ...res.rows] : res.rows;
      next = res.next;
      // replaceChildren() would print a null child as the text "null"
      body.replaceChildren(
        ...[
          rows.length ? historyTable(rows) : empty('No trades match. Your trades from the bot and ApeX Pro show up here.'),
          next ? h('div', { class: 'panel-body' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => loadHistory(true) }, 'Load more')) : null,
        ].filter(Boolean),
      );
    } catch (err) {
      if (alive) errorToast(err);
    }
  }

  const refresh = () => (tab === 'positions' ? load() : loadHistory());

  async function load() {
    try {
      const { rows, truncated } = await api('/api/positions');
      if (!alive || tab !== 'positions') return;
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
        truncated ? h('p', { class: 'fine panel-body' }, 'Showing the 10 most recent positions.') : '',
      );
    } catch (err) {
      if (alive) errorToast(err);
    }
  }
  renderTabs();
  refresh();
  const timer = setInterval(() => tab === 'positions' && load(), 45_000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
