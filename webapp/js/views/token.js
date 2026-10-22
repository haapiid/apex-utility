import { h, api, state, chainInfo, loggedIn, fromUnits, fmtNum, fmtCompact, fmtPrice, pct, ago, short, avatar, copyButton, panel, empty, native, toast, errorToast, metricChips, explorerAddress } from '../lib.js';
import { bubbleMap } from '../bubbleMap.js';
import { historyTable } from '../history.js';
import { createPriceChart } from '../chart.js';
import { tradePanel } from '../tradePanel.js';

const CHANGE_LABELS = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };

// Token page: header stats, chart, trades / position / orders tabs, and the trade box
export default function token(container, [chainKey, address], query) {
  const chain = chainInfo(chainKey);
  if (!chain) {
    container.append(empty('Unknown chain.'));
    return null;
  }
  let alive = true;
  let data = null;
  let tf = localStorage.getItem('apex.tf') || '15m';
  // ?tab=holders etc. opens a tab directly (shareable links)
  let tab = ['trades', 'traders', 'holders', 'bubbles'].includes(query?.get('tab')) ? query.get('tab') : 'trades';
  let metrics = null;
  let watched = false;
  const timers = [];

  const head = h('section', { class: 'panel' }, h('div', { class: 'token-head' }, h('div', { class: 'skeleton grow' })));
  const chartBox = h('div', { class: 'chart' });
  const tfTabs = h('div', { class: 'tabs' });
  const chartPanel = h('section', { class: 'panel chart-panel' }, h('div', { class: 'panel-head' }, h('h2', {}, 'Chart · USD'), tfTabs), chartBox);
  const tabBody = h('div', { class: 'table-wrap' });
  const tabHead = h('div', { class: 'tabs' });
  const lower = h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, tabHead, h('span', { class: 'fine' }, 'Market data: DexScreener · GeckoTerminal')), tabBody);
  const side = h('div', { class: 'token-side' });
  container.append(h('div', { class: 'token-grid' }, h('div', { class: 'token-main' }, head, chartPanel, lower), side));

  const chart = createPriceChart(chartBox);
  const getInfo = () => data?.info;

  // ---------- header ----------
  function renderHead() {
    const ov = data.overview;
    const info = data.info;
    const tokenMeta = { symbol: info.symbol, image: ov?.token.image };
    const links = ov?.links || { websites: [], socials: [] };
    const safety = data.safety;
    const chips = [];
    if (safety) {
      safety.issues.forEach((i) => chips.push(h('span', { class: 'chip bad' }, `⚠ ${i}`)));
      safety.warnings.forEach((w) => chips.push(h('span', { class: 'chip warn' }, w)));
      if (!safety.issues.length) chips.unshift(h('span', { class: 'chip ok' }, safety.unknown ? '🛡 No scanner data yet' : '🛡 Safety scan: no red flags'));
    }
    head.replaceChildren(
      h(
        'div',
        { class: 'token-head' },
        avatar(tokenMeta),
        h(
          'div',
          { class: 'token-title' },
          h(
            'h1',
            {},
            info.symbol,
            h('small', {}, info.name),
            h('span', { class: 'chip' }, chain.name),
            h('button', { class: `star${watched ? ' on' : ''}`, type: 'button', title: watched ? 'Remove from watchlist' : 'Add to watchlist', 'aria-pressed': String(watched), onclick: toggleWatch }, watched ? '★' : '☆'),
          ),
          h(
            'div',
            { class: 'addr' },
            h('span', { class: 'mono' }, short(info.address, 6)),
            copyButton(info.address, 'Copy address'),
            ...links.websites.slice(0, 1).map((u) => h('a', { href: u, target: '_blank', rel: 'noopener nofollow', class: 'copy' }, '🌐')),
            ...links.socials.slice(0, 3).map((s) => h('a', { href: s.url, target: '_blank', rel: 'noopener nofollow', class: 'copy', title: s.type }, s.type === 'twitter' ? '𝕏' : s.type === 'telegram' ? '✈' : '↗')),
          ),
        ),
        h(
          'div',
          { class: 'kpis' },
          h('div', { class: 'kpi big' }, h('span', {}, 'Price'), h('b', {}, fmtPrice(ov?.priceUsd ?? info.usdPrice))),
          h('div', { class: 'kpi' }, h('span', {}, 'MC'), h('b', {}, fmtCompact(ov?.mcap))),
          h('div', { class: 'kpi' }, h('span', {}, 'Liq'), h('b', {}, fmtCompact(ov?.liquidity))),
          h('div', { class: 'kpi' }, h('span', {}, 'Vol 24h'), h('b', {}, fmtCompact(ov?.volume?.h24))),
          ...Object.entries(CHANGE_LABELS).map(([k, label]) => h('div', { class: 'kpi' }, h('span', {}, label), h('b', {}, pct(ov?.change?.[k])))),
        ),
      ),
      // '' not null: replaceChildren() prints null as text
      metrics ? h('div', { class: 'panel-body metrics flush-top' }, metricChips(metrics)) : '',
      chips.length ? h('div', { class: 'panel-body chips flush-top' }, chips) : '',
    );
  }

  async function toggleWatch() {
    if (!loggedIn()) return document.dispatchEvent(new Event('apex:login'));
    try {
      await api('/api/watchlist', { method: 'POST', body: { chain: chain.key, token: address, remove: watched } });
      watched = !watched;
      toast(watched ? 'Added to your watchlist ★' : 'Removed from your watchlist');
      renderHead();
    } catch (err) {
      errorToast(err);
    }
  }

  async function loadMetrics() {
    try {
      metrics = await api(`/api/token/${chain.key}/${address}/metrics`);
      if (alive && data) renderHead();
    } catch {
      /* metrics are optional */
    }
  }

  async function loadWatched() {
    if (!loggedIn()) return;
    const list = await api('/api/watchlist').catch(() => []);
    watched = list.some((w) => w.chain === chain.key && w.token.toLowerCase() === address.toLowerCase());
    if (alive && data) renderHead();
  }

  // ---------- chart ----------
  function renderTf() {
    tfTabs.replaceChildren(
      ...state.config.timeframes.map((t) =>
        h(
          'button',
          {
            type: 'button',
            class: t === tf ? 'active' : '',
            onclick: () => {
              tf = t;
              localStorage.setItem('apex.tf', t);
              chart?.reset();
              renderTf();
              loadCandles();
            },
          },
          t,
        ),
      ),
    );
  }

  async function loadCandles() {
    if (!chart || !data?.overview?.pool) return;
    try {
      const rows = await api(`/api/token/${chain.key}/${address}/candles?tf=${tf}&pool=${data.overview.pool}`);
      if (alive) chart.set(rows);
    } catch {
      /* keep the last chart; market data may be rate-limited */
    }
  }

  // ---------- lower tabs ----------
  function renderTabs() {
    const tabs = [
      ['trades', 'Trades'],
      ['traders', 'Top traders'],
      ['holders', 'Holders'],
      ['bubbles', 'Bubble map'],
      ...(loggedIn() ? [['position', 'My position'], ['mine', 'My trades'], ['orders', 'Orders']] : []),
    ];
    tabHead.replaceChildren(...tabs.map(([k, label]) => h('button', { type: 'button', class: k === tab ? 'active' : '', onclick: () => ((tab = k), renderTabs(), loadTab()) }, label)));
  }

  async function loadTab() {
    if (tab === 'trades') return loadTrades();
    if (tab === 'traders') return loadTraders();
    if (tab === 'holders' || tab === 'bubbles') return loadHolders();
    if (tab === 'position') return loadPosition();
    if (tab === 'mine') return loadMine();
    return loadOrders();
  }

  const usd = (v) => `${v < 0 ? '-' : ''}$${fmtNum(Math.abs(v), 2)}`;
  const walletLink = (a) => h('a', { href: explorerAddress(chain.key, a), target: '_blank', rel: 'noopener', class: 'mono muted' }, short(a));

  async function loadTraders() {
    if (!data?.overview?.pool) return tabBody.replaceChildren(empty('No pool data for this token yet.'));
    tabBody.replaceChildren(h('div', { class: 'skeleton spaced' }));
    try {
      const res = await api(`/api/token/${chain.key}/${address}/traders?pool=${data.overview.pool}`);
      if (!alive || tab !== 'traders') return;
      if (!res.rows.length) return tabBody.replaceChildren(empty('No trades yet.'));
      tabBody.replaceChildren(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Wallet'), h('th', { class: 'num' }, 'Bought'), h('th', { class: 'num' }, 'Sold'), h('th', { class: 'num' }, 'PnL'), h('th', { class: 'num' }, 'Txns'))),
          h(
            'tbody',
            {},
            res.rows.map((r, i) =>
              h(
                'tr',
                {},
                h('td', { class: 'muted' }, i + 1),
                h('td', {}, walletLink(r.maker)),
                h('td', { class: 'num' }, usd(r.boughtUsd)),
                h('td', { class: 'num' }, usd(r.soldUsd)),
                h('td', { class: `num ${r.pnlUsd >= 0 ? 'up' : 'down'}` }, usd(r.pnlUsd)),
                h('td', { class: 'num muted' }, `${r.buys} / ${r.sells}`),
              ),
            ),
          ),
        ),
        h('p', { class: 'fine panel-body' }, `Realized PnL (sold − bought) over the last ${res.window} trades${res.since ? `, since ${ago(res.since)} ago` : ''}. Tokens still held aren't counted.`),
      );
    } catch {
      if (alive && tab === 'traders') tabBody.replaceChildren(empty('Top traders are loading, market data is busy.'));
    }
  }

  let holderData = null;
  async function loadHolders() {
    if (!holderData) tabBody.replaceChildren(h('div', { class: 'skeleton spaced' }));
    try {
      holderData = holderData || (await api(`/api/token/${chain.key}/${address}/holders`));
      if (!alive || (tab !== 'holders' && tab !== 'bubbles')) return;
      if (tab === 'bubbles') return tabBody.replaceChildren(bubbleMap(chain.key, holderData));
      if (!holderData.list.length) return tabBody.replaceChildren(empty('No holder data for this token.'));
      tabBody.replaceChildren(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Wallet'), h('th', { class: 'num' }, 'Share'), h('th', {}, 'Tags'))),
          h(
            'tbody',
            {},
            holderData.list.slice(0, 50).map((x, i) =>
              h(
                'tr',
                {},
                h('td', { class: 'muted' }, i + 1),
                h('td', {}, walletLink(x.address), ' ', copyButton(x.address, 'Copy address')),
                h('td', { class: 'num' }, `${fmtNum(x.pct, 2)}%`),
                h('td', {}, x.tags.map((t) => h('span', { class: `chip${t === 'dev' ? ' bad' : ''}` }, t))),
              ),
            ),
          ),
        ),
        h('p', { class: 'fine panel-body' }, `${holderData.count != null ? `${fmtNum(holderData.count, 0)} holders · ` : ''}${holderData.source}`),
      );
    } catch (err) {
      if (alive) tabBody.replaceChildren(empty(err.message));
    }
  }

  async function loadMine() {
    try {
      const res = await api(`/api/history?token=${encodeURIComponent(address)}&chain=${chain.key}&limit=50`);
      if (!alive || tab !== 'mine') return;
      tabBody.replaceChildren(res.rows.length ? historyTable(res.rows) : empty('You haven’t traded this token with ApeX yet.'));
    } catch (err) {
      errorToast(err);
    }
  }

  async function loadTrades() {
    if (!data?.overview?.pool) return tabBody.replaceChildren(empty('No pool data for this token yet.'));
    try {
      const rows = await api(`/api/token/${chain.key}/${address}/trades?pool=${data.overview.pool}`);
      if (!alive || tab !== 'trades') return;
      if (!rows.length) return tabBody.replaceChildren(empty('No trades recently. Quiet tokens can go days without one.'));
      tabBody.replaceChildren(
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'Age'), h('th', {}, 'Type'), h('th', { class: 'num' }, 'USD'), h('th', { class: 'num' }, 'Tokens'), h('th', { class: 'num' }, 'Price'), h('th', {}, 'Maker'))),
          h(
            'tbody',
            {},
            rows.map((t) =>
              h(
                'tr',
                {},
                h('td', { class: 'muted' }, ago(t.time)),
                h('td', { class: t.side === 'buy' ? 'up' : 'down' }, t.side.toUpperCase()),
                h('td', { class: 'num' }, `$${fmtNum(t.usd, 2)}`),
                h('td', { class: 'num' }, fmtNum(t.tokenAmount, 2)),
                h('td', { class: 'num' }, fmtPrice(t.priceUsd)),
                h('td', { class: 'mono muted' }, short(t.maker)),
              ),
            ),
          ),
        ),
      );
    } catch {
      if (alive && tab === 'trades' && !tabBody.firstChild) tabBody.replaceChildren(empty('Trades are loading, market data is busy.'));
    }
  }

  async function loadPosition() {
    try {
      const { rows } = await api('/api/positions');
      const row = rows.find((r) => r.chain === chain.key && r.token.toLowerCase() === address.toLowerCase());
      if (!alive || tab !== 'position') return;
      if (!row) return tabBody.replaceChildren(empty("You don't hold this token in your active wallet."));
      tabBody.replaceChildren(
        h(
          'div',
          { class: 'panel-body grid' },
          h('div', { class: 'stat' }, h('span', {}, 'Holding'), h('b', {}, `${fmtNum(fromUnits(row.balance, row.decimals), 4)} ${row.symbol}`)),
          h('div', { class: 'stat' }, h('span', {}, 'Value now'), h('b', {}, row.value != null ? native(row.value, chain) : 'n/a')),
          h('div', { class: 'stat' }, h('span', {}, 'Cost'), h('b', {}, row.cost != null ? native(row.cost, chain) : 'not bought via ApeX')),
          h('div', { class: 'stat' }, h('span', {}, 'PnL'), h('b', { class: row.pnl == null ? 'muted' : BigInt(row.pnl) >= 0n ? 'up' : 'down' }, row.pnl != null ? `${native(row.pnl, chain)} (${fmtNum(row.pnlPct, 1)}%)` : '–')),
        ),
      );
    } catch (err) {
      errorToast(err);
    }
  }

  async function loadOrders() {
    try {
      const all = await api('/api/orders');
      if (!alive || tab !== 'orders') return;
      const mine = (list) => list.filter((o) => o.chain === chain.key && o.token.toLowerCase() === address.toLowerCase());
      const items = [
        ...mine(all.orders).map((o) => [`${o.type.replace('_', ' ')} · ${o.type === 'limit_buy' ? `${o.amount} ${chain.native}` : `${o.amount}%`} at ${fmtNum(o.trigger_price, 10)}`, 'order', o.id]),
        ...mine(all.dca).map((p) => [`DCA ${p.side} · ${p.runs_done}/${p.runs_total} runs`, 'dca', p.id]),
      ];
      tabBody.replaceChildren(
        items.length
          ? h(
              'div',
              { class: 'panel-body' },
              items.map(([label, kind, id]) =>
                h(
                  'div',
                  { class: 'line-item' },
                  h('span', {}, label),
                  h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/cancel/${kind}/${id}`, { method: 'POST' }).catch(errorToast), loadOrders()) }, 'Cancel'),
                ),
              ),
            )
          : empty('No open orders for this token. Use Limit or DCA in the trade box.'),
      );
    } catch (err) {
      errorToast(err);
    }
  }

  // ---------- data ----------
  let trade = null;
  async function loadToken(first = false) {
    try {
      data = await api(`/api/token/${chain.key}/${address}`);
      if (!alive) return;
      renderHead();
      document.title = `${data.info.symbol} · ApeX Pro`;
      // The periodic reload only updates the header: re-rendering the trade box would wipe what the user typed
      if (first) {
        trade = tradePanel({ chainKey: chain.key, address, getInfo, onTraded: afterTrade });
        side.replaceChildren(trade);
        renderTf();
        renderTabs();
        loadCandles();
        loadTab();
        loadMetrics();
        loadWatched();
      }
    } catch (err) {
      if (first) head.replaceChildren(h('div', { class: 'panel-body' }, h('p', { class: 'form-error' }, err.message)));
    }
  }

  async function afterTrade() {
    await loadToken();
    trade?.refresh();
    loadTab();
    document.dispatchEvent(new Event('apex:refresh'));
  }

  loadToken(true);
  timers.push(setInterval(loadMetrics, 60_000), setInterval(() => loadToken(), 20_000), setInterval(() => tab === 'trades' && loadTrades(), 20_000), setInterval(loadCandles, 60_000));
  return () => {
    alive = false;
    timers.forEach(clearInterval);
    chart?.destroy();
    document.title = 'ApeX Pro';
  };
}
