import { h, api, state, chainInfo, fmtCompact, fmtPrice, pct, short, avatar, empty, toast } from '../lib.js';
import { createPriceChart } from '../chart.js';

// Workspace: up to four charts side by side, each with its own token and timeframe. The layout lives in
// this browser. Market data comes from free tiers (GeckoTerminal is queued), so charts load one after
// another and refresh every minute.

const STORE = 'apex.workspace';
const LAYOUTS = [1, 2, 4];
const REFRESH_MS = 60_000;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && LAYOUTS.includes(saved.layout) && Array.isArray(saved.slots)) return saved;
  } catch {}
  return { layout: 4, slots: [] };
}
function save(ws) {
  try {
    localStorage.setItem(STORE, JSON.stringify(ws));
  } catch {}
}

/** Puts a token in the first free slot (or the last one), used by the token page */
export function addToWorkspace(chain, address) {
  const ws = load();
  if (ws.slots.some((s) => s && s.chain === chain && s.address === address)) return toast('Already in your workspace.');
  const free = Array.from({ length: 4 }, (_, i) => i).find((i) => !ws.slots[i]);
  const at = free ?? 3;
  ws.slots[at] = { chain, address, tf: '15m' };
  if (at >= ws.layout) ws.layout = at < 2 ? 2 : 4;
  save(ws);
  toast('Added to your workspace. Open it from Workspace in the menu.');
}

const validAddress = (kind, a) => (kind === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) : /^0x[0-9a-fA-F]{40}$/.test(a));

export default function workspace(container) {
  const ws = load();
  let alive = true;
  const slots = []; // mounted slot controllers

  const layoutTabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'Charts on screen' });
  const grid = h('div', { class: 'ws-grid' });
  container.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', {}, 'Workspace'),
      h('div', { class: 'row' }, h('p', { class: 'fine' }, 'Charts refresh every minute.'), layoutTabs),
    ),
    grid,
  );

  function drawTabs() {
    layoutTabs.replaceChildren(
      ...LAYOUTS.map((n) =>
        h('button', { type: 'button', class: ws.layout === n ? 'active' : '', 'aria-pressed': String(ws.layout === n), onclick: () => ((ws.layout = n), save(ws), mount()) }, n === 1 ? '1 chart' : `${n} charts`),
      ),
    );
  }

  function mount() {
    slots.splice(0).forEach((s) => s.destroy());
    drawTabs();
    grid.className = `ws-grid l${ws.layout}`;
    grid.replaceChildren();
    for (let i = 0; i < ws.layout; i++) {
      const slot = createSlot(i);
      slots.push(slot);
      grid.append(slot.el);
    }
  }

  function setSlot(i, value) {
    ws.slots[i] = value;
    save(ws);
    const fresh = createSlot(i);
    slots[i].destroy();
    slots[i].el.replaceWith(fresh.el);
    slots[i] = fresh;
  }

  // ---------- one slot ----------
  function createSlot(i) {
    const s = ws.slots[i];
    const el = h('section', { class: 'panel ws-slot' });
    if (!s) return emptySlot(i, el);

    const chain = chainInfo(s.chain);
    const head = h('div', { class: 'ws-head' }, h('a', { class: 'tok', href: `#/token/${s.chain}/${s.address}` }, avatar({ symbol: '?' }), h('b', {}, short(s.address))));
    const stats = h('div', { class: 'ws-stats' });
    const tfSelect = h(
      'select',
      { class: 'input auto ws-tf', 'aria-label': 'Timeframe' },
      state.config.timeframes.map((t) => h('option', { value: t, selected: t === (s.tf || '15m') }, t)),
    );
    tfSelect.onchange = () => {
      s.tf = tfSelect.value;
      save(ws);
      chart?.reset();
      loadCandles();
    };
    const remove = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: 'Remove from workspace', 'aria-label': 'Remove from workspace', onclick: () => setSlot(i, null) }, '✕');
    const chartEl = h('div', { class: 'ws-chart' });
    el.append(h('div', { class: 'panel-head' }, head, h('div', { class: 'row' }, stats, tfSelect, remove)), chartEl);
    const chart = createPriceChart(chartEl);
    let pool = null;

    async function loadOverview() {
      const o = await api(`/api/token/${s.chain}/${s.address}/overview`).catch(() => null);
      if (!alive || !o) return;
      pool = o.pool || pool;
      head.replaceChildren(
        h('a', { class: 'tok', href: `#/token/${s.chain}/${s.address}` }, avatar(o.token), h('div', {}, h('b', {}, o.token?.symbol || short(s.address)), h('div', { class: 'fine' }, chain?.name || s.chain))),
      );
      stats.replaceChildren(h('b', { class: 'mono' }, fmtPrice(o.priceUsd)), h('span', {}, '1h ', pct(o.change?.h1)), h('span', { class: 'muted' }, 'MC ', fmtCompact(o.mcap)));
    }
    async function loadCandles() {
      const rows = await api(`/api/token/${s.chain}/${s.address}/candles?tf=${s.tf || '15m'}${pool ? `&pool=${pool}` : ''}`).catch(() => null);
      if (!alive || !chart) return;
      if (rows?.length) chart.set(rows);
      else if (rows && !chartEl.querySelector('.empty')) chartEl.append(empty('No chart data for this token yet.'));
    }
    async function refresh() {
      await loadOverview();
      await loadCandles();
    }
    // Stagger the slots so the queued market data API isn't hit all at once
    const start = setTimeout(refresh, i * 1500);
    const timer = setInterval(refresh, REFRESH_MS + i * 1500);
    return {
      el,
      destroy() {
        clearTimeout(start);
        clearInterval(timer);
        chart?.destroy();
      },
    };
  }

  function emptySlot(i, el) {
    const select = h(
      'select',
      { class: 'input auto', 'aria-label': 'Chain' },
      state.config.chains.map((c) => h('option', { value: c.key, selected: c.key === state.chain }, c.name)),
    );
    const input = h('input', { class: 'input mono', placeholder: 'Paste a token address', 'aria-label': 'Token address', autocomplete: 'off' });
    const error = h('p', { class: 'fine' }, 'Or tap ⊞ on any token page.');
    const form = h(
      'form',
      { class: 'ws-empty stack' },
      h('b', {}, `Chart ${i + 1}`),
      h('div', { class: 'row' }, select, input),
      h('button', { class: 'btn btn-yellow', type: 'submit' }, 'Show chart'),
      error,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const chain = chainInfo(select.value);
      const address = input.value.trim();
      if (!validAddress(chain.kind, address)) {
        error.textContent = `That isn’t a ${chain.kind === 'sol' ? 'Solana' : 'EVM'} token address.`;
        return input.focus();
      }
      setSlot(i, { chain: chain.key, address, tf: '15m' });
    });
    el.append(form);
    return { el, destroy() {} };
  }

  mount();
  return () => {
    alive = false;
    slots.forEach((s) => s.destroy());
  };
}
