import { h, api, state, chainInfo, fmtCompact, fmtPrice, pct, ago, short, avatar, panel, empty, metricChips } from '../lib.js';

// Discover: three live columns for the selected chain, like a trading terminal's "trenches".
// Each card carries holder metrics (/api/metrics, one call for every token on screen), and each column
// has its own filters, remembered in this browser.
const COLUMNS = [
  { key: 'new', title: '🆕 New pairs', path: 'new', hint: 'Pools created most recently' },
  { key: 'trending', title: '🔥 Trending 1h', path: 'trending?duration=1h', hint: 'Most active pools in the last hour' },
  { key: 'boosted', title: '🚀 Boosted', path: 'boosted', hint: 'Promoted on DexScreener right now' },
];
const REFRESH_MS = 30_000;

// A token without a value for a filter stays visible (metrics arrive later for new or EVM tokens)
const FILTERS = [
  { key: 'minLiq', label: 'Min liquidity ($)', value: (p) => p.liquidity, min: true },
  { key: 'minMcap', label: 'Min market cap ($)', value: (p) => p.mcap, min: true },
  { key: 'maxMcap', label: 'Max market cap ($)', value: (p) => p.mcap },
  { key: 'minVol', label: 'Min 24h volume ($)', value: (p) => p.volume?.h24, min: true },
  { key: 'maxAge', label: 'Max age (hours)', value: (p) => (p.createdAt ? (Date.now() - p.createdAt) / 3_600_000 : null) },
  { key: 'minHolders', label: 'Min holders', value: (p, m) => m?.holders, min: true },
  { key: 'maxTop10', label: 'Max top 10 (%)', value: (p, m) => m?.top10Pct },
  { key: 'maxDev', label: 'Max dev (%)', value: (p, m) => m?.devPct },
  { key: 'maxBundled', label: 'Max bundled (%)', value: (p, m) => m?.bundledPct },
];
const FILTER_STORE = 'apex.discover.filters';

function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_STORE) || '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}
function saveFilters(all) {
  try {
    localStorage.setItem(FILTER_STORE, JSON.stringify(all));
  } catch {}
}

function passes(p, m, filters) {
  return FILTERS.every((f) => {
    const limit = filters[f.key];
    if (limit == null || limit === '') return true;
    const v = f.value(p, m);
    if (v == null || !Number.isFinite(Number(v))) return true;
    return f.min ? Number(v) >= Number(limit) : Number(v) <= Number(limit);
  });
}

export function tokenCard(p, m) {
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
        p.createdAt ? h('span', { title: 'Pair age' }, `⏱ ${ago(p.createdAt)}`) : '',
        p.txns ? h('span', { title: '24h buys / sells' }, `🟢 ${p.txns.buys} 🔴 ${p.txns.sells}`) : '',
        h('span', {}, '1h ', pct(p.change?.h1)),
      ),
      m ? h('div', { class: 'metrics card-metrics' }, metricChips(m, { compact: true })) : '',
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
  const allFilters = loadFilters();
  const cols = {};

  const grid = h(
    'div',
    { class: 'columns' },
    COLUMNS.map((c) => {
      const col = (cols[c.key] = { rows: null, filters: { ...(allFilters[c.key] || {}) } });
      col.list = h('div', { class: 'list' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton spaced' })));
      col.count = h('span', { class: 'fine', title: c.hint }, 'live');
      col.toggle = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', 'aria-expanded': 'false', onclick: () => openFilters(c.key) });
      col.form = filterForm(c.key);
      labelToggle(c.key);
      return panel(c.title, h('div', { class: 'col-body' }, col.form, col.list), h('div', { class: 'row' }, col.count, col.toggle));
    }),
  );
  const head = h(
    'div',
    { class: 'page-head' },
    h('h1', {}, `Discover on ${chainInfo()?.name || ''}`),
    h('p', { class: 'fine' }, 'Tap a token to open its chart and trade. Lists refresh every 30 seconds.'),
  );
  container.append(head, grid);

  function activeCount(key) {
    return Object.values(cols[key].filters).filter((v) => v !== '' && v != null).length;
  }
  function labelToggle(key) {
    const n = activeCount(key);
    cols[key].toggle.textContent = n ? `Filters (${n})` : 'Filters';
    cols[key].toggle.classList.toggle('on', n > 0);
  }
  function openFilters(key) {
    const { form, toggle } = cols[key];
    form.hidden = !form.hidden;
    toggle.setAttribute('aria-expanded', String(!form.hidden));
    if (!form.hidden) form.querySelector('input')?.focus();
  }

  function filterForm(key) {
    const inputs = FILTERS.map((f) =>
      h('label', { class: 'field' }, f.label, h('input', { class: 'input mono', inputmode: 'decimal', name: f.key, placeholder: 'Any', value: cols[key].filters[f.key] ?? '' })),
    );
    const form = h(
      'form',
      { class: 'filters', hidden: true, 'aria-label': 'Filters for this column' },
      h('div', { class: 'filter-grid' }, inputs),
      h(
        'div',
        { class: 'row' },
        h('p', { class: 'fine grow' }, 'Tokens without data for a filter stay in the list.'),
        h('button', { type: 'reset', class: 'btn btn-sm' }, 'Reset'),
      ),
    );
    const apply = () => {
      const next = {};
      for (const f of FILTERS) {
        const raw = form.elements[f.key].value.trim().replace(/[$,%\s]/g, '');
        if (raw !== '' && Number.isFinite(Number(raw))) next[f.key] = raw;
      }
      cols[key].filters = next;
      allFilters[key] = next;
      saveFilters(allFilters);
      labelToggle(key);
      render(key);
    };
    form.addEventListener('input', apply);
    form.addEventListener('reset', () => setTimeout(apply));
    form.addEventListener('submit', (e) => e.preventDefault());
    return form;
  }

  let metrics = {};
  function render(key) {
    const col = cols[key];
    if (!col.rows) return;
    const shown = col.rows.filter((p) => passes(p, metrics[p.token.address], col.filters));
    col.count.textContent = activeCount(key) ? `${shown.length} of ${col.rows.length}` : 'live';
    if (!col.rows.length) return col.list.replaceChildren(empty('Nothing here yet on this chain.'));
    if (!shown.length) return col.list.replaceChildren(empty('No token matches these filters.'));
    col.list.replaceChildren(...shown.map((p) => tokenCard(p, metrics[p.token.address])));
  }

  let alive = true;
  async function load() {
    const chain = state.chain;
    await Promise.all(
      COLUMNS.map(async (c) => {
        try {
          const rows = await api(`/api/market/${c.path}${c.path.includes('?') ? '&' : '?'}chain=${chain}`);
          if (!alive || chain !== state.chain) return;
          cols[c.key].rows = rows;
          render(c.key);
        } catch (err) {
          if (alive) cols[c.key].list.replaceChildren(empty(err.status === 429 ? 'Market data is busy, retrying…' : 'Could not load this list.'));
        }
      }),
    );
    // One metrics call for every token on screen; values that aren't ready yet fill in on the next refresh
    const tokens = [...new Set(COLUMNS.flatMap((c) => (cols[c.key].rows || []).map((p) => p.token.address)))].slice(0, 100);
    if (!tokens.length || !alive) return;
    try {
      const got = await api(`/api/metrics?chain=${chain}&tokens=${tokens.join(',')}`);
      if (!alive || chain !== state.chain) return;
      metrics = got || {};
      COLUMNS.forEach((c) => render(c.key));
    } catch {
      /* metrics are optional */
    }
  }
  load();
  const timer = setInterval(load, REFRESH_MS);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
