import { h, api, state, chainInfo, loggedIn, fromUnits, fmtNum, native, toast, errorToast } from './lib.js';

// Buy / sell box of the token page: Market (quote → confirm), Limit (limit buy, take profit, stop loss)
// and DCA. Uses the user's bot settings (buttons, slippage, MEV, confirm trades).
const DCA_INTERVALS = ['15m', '30m', '1h', '4h', '1d'];

export function tradePanel({ chainKey, address, getInfo, onTraded }) {
  const chain = chainInfo(chainKey);
  const root = h('section', { class: 'panel' });
  let side = 'buy';
  let mode = 'market';

  if (!loggedIn()) {
    root.append(
      h('div', { class: 'panel-head' }, h('h2', {}, 'Trade')),
      h(
        'div',
        { class: 'panel-body stack' },
        h('p', { class: 'muted' }, 'Log in to buy and sell. A wallet login creates your ApeX trading wallets in one step.'),
        h('button', { class: 'btn btn-yellow btn-block', type: 'button', onclick: () => document.dispatchEvent(new Event('apex:login')) }, 'Log in'),
      ),
    );
    return root;
  }

  const settings = state.me.settings;
  const body = h('div', { class: 'panel-body stack' });
  const sideTabs = h('div', { class: 'side-tabs' });
  const modeTabs = h('div', { class: 'tabs' });
  root.append(h('div', { class: 'panel-head' }, h('h2', {}, 'Trade'), modeTabs), h('div', { class: 'panel-body' }, sideTabs), body);

  function renderTabs() {
    sideTabs.replaceChildren(
      ...['buy', 'sell'].map((s) => h('button', { type: 'button', class: `${s} ${side === s ? 'active' : ''}`, onclick: () => ((side = s), render()) }, s === 'buy' ? 'Buy' : 'Sell')),
    );
    modeTabs.replaceChildren(...['market', 'limit', 'dca'].map((m) => h('button', { type: 'button', class: mode === m ? 'active' : '', onclick: () => ((mode = m), render()) }, m === 'dca' ? 'DCA' : m[0].toUpperCase() + m.slice(1))));
  }

  const footer = () =>
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip' }, `Slippage ${fmtNum(settings.slippageBps[chain.kind] / 100, 2)}%`),
      h('span', { class: `chip ${settings.mevProtect ? 'ok' : 'warn'}` }, settings.mevProtect ? 'MEV protection on' : 'MEV protection off'),
      h('a', { class: 'chip', href: '#/settings' }, '⚙ Settings'),
    );

  // ---------- wallets to trade from ----------
  // Market trades can run from several of the user's wallets of this chain's kind at once. The pick is
  // remembered per kind; the active wallet alone is the default (and the only one with a live quote).
  const kindWallets = () => (state.me.wallets || []).filter((w) => w.kind === chain.kind);
  const pickKey = `apex.wallets.${chain.kind}`;
  let picked = loadPicked();

  function loadPicked() {
    const ws = kindWallets();
    let ids = [];
    try {
      ids = JSON.parse(localStorage.getItem(pickKey) || '[]');
    } catch {}
    ids = Array.isArray(ids) ? ids.filter((id) => ws.some((w) => w.id === id)) : [];
    if (!ids.length) {
      const active = ws.find((w) => w.active) || ws[0];
      if (active) ids = [active.id];
    }
    return new Set(ids);
  }
  function savePicked() {
    try {
      localStorage.setItem(pickKey, JSON.stringify([...picked]));
    } catch {}
  }
  const pickedWallets = () => kindWallets().filter((w) => picked.has(w.id));
  // Only the active wallet on its own goes through the quoted single-trade flow
  const singleActive = () => picked.size === 1 && Boolean(pickedWallets()[0]?.active);

  function walletPicker(onChange) {
    const ws = kindWallets();
    if (ws.length < 2) return '';
    const row = h('div', { class: 'wallet-pick', role: 'group', 'aria-label': 'Trade from these wallets' });
    const toggle = (w) => {
      if (picked.has(w.id)) {
        if (picked.size > 1) picked.delete(w.id);
      } else picked.add(w.id);
      changed();
    };
    const all = () => {
      const active = ws.find((w) => w.active) || ws[0];
      picked = new Set(picked.size === ws.length ? [active.id] : ws.map((w) => w.id));
      changed();
    };
    function changed() {
      savePicked();
      draw();
      onChange();
    }
    function draw() {
      row.replaceChildren(
        ...ws.map((w) =>
          h(
            'button',
            { type: 'button', class: `wpick${picked.has(w.id) ? ' on' : ''}`, 'aria-pressed': String(picked.has(w.id)), title: w.address, onclick: () => toggle(w) },
            w.label,
            w.active ? h('small', {}, 'active') : '',
          ),
        ),
        h('button', { type: 'button', class: 'wpick all', onclick: all }, picked.size === ws.length ? 'Active only' : 'All'),
      );
    }
    draw();
    return h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Trade from'), row);
  }

  // ---------- market ----------
  function marketView() {
    const presets = side === 'buy' ? settings.buyPresetsResolved[chain.key] : settings.sellPresets.map(String);
    const input = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: side === 'buy' ? `Amount in ${chain.native}` : 'Percent of your bag', 'aria-label': 'Amount' });
    const quoteBox = h('div');
    const presetRow = h(
      'div',
      { class: 'presets' },
      presets.map((p) =>
        h('button', { type: 'button', onclick: () => ((input.value = p), review()) }, side === 'buy' ? `${p}` : `${p}%`),
      ),
    );
    const info = getInfo();
    const holding = info ? `${fmtNum(fromUnits(info.balance, info.decimals), 4)} ${info.symbol}` : '–';
    const reviewBtn = h('button', { class: `btn btn-block ${side === 'buy' ? 'btn-up' : 'btn-down'}`, type: 'button', onclick: () => review() });
    const reviewLabel = () => {
      const verb = side === 'buy' ? 'Buy' : 'Sell';
      const n = picked.size > 1 ? ` from ${picked.size} wallets` : '';
      reviewBtn.textContent = settings.confirmTrades ? `Review ${side}${n}` : `${verb} now${n}`;
    };
    reviewLabel();
    const picker = walletPicker(() => {
      quoteBox.replaceChildren();
      reviewLabel();
    });

    async function review() {
      const amount = input.value.trim().replace('%', '');
      if (!amount) return input.focus();
      if (!singleActive()) {
        if (!settings.confirmTrades) return executeMulti(amount);
        return quoteBox.replaceChildren(multiView(amount));
      }
      if (!settings.confirmTrades) return execute(amount);
      reviewBtn.disabled = true;
      try {
        const q = await api('/api/quote', { method: 'POST', body: { chain: chain.key, address, side, amount } });
        quoteBox.replaceChildren(quoteView(q, amount));
      } catch (err) {
        errorToast(err);
      } finally {
        reviewBtn.disabled = false;
      }
    }

    function quoteView(q, amount) {
      const dec = q.token.decimals;
      const rows =
        side === 'buy'
          ? [
              ['You pay', native(q.amountIn, chain)],
              [`Fee`, native(q.fee, chain, 8)],
              ['You get (est.)', `${fmtNum(fromUnits(q.amountOut, dec), 4)} ${q.token.symbol}`],
              ['Minimum', `${fmtNum(fromUnits(q.minOut, dec), 4)} ${q.token.symbol}`],
            ]
          : [
              ['You sell', `${fmtNum(fromUnits(q.amountIn, dec), 4)} ${q.token.symbol} (${amount}%)`],
              ['You get (est.)', native(q.received, chain)],
              ['Fee', native(q.fee, chain, 8)],
              ['Minimum before fee', native(q.minOut, chain)],
            ];
      rows.push(['Price impact', q.priceImpactPct == null ? 'n/a' : `${fmtNum(q.priceImpactPct, 2)}%`], ['MEV protection', q.mevProtect ? q.mev : 'off'], ['Wallet', q.wallet.label]);
      const confirm = h('button', { class: `btn btn-block ${side === 'buy' ? 'btn-up' : 'btn-down'}`, type: 'button', onclick: () => execute(amount, confirm) }, `Confirm ${side}`);
      return h('div', { class: 'stack' }, h('div', { class: 'quote' }, rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v)))), confirm, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => quoteBox.replaceChildren() }, 'Cancel'));
    }

    async function execute(amount, btn) {
      if (btn) btn.disabled = true;
      toast(`Sending ${side}…`, { timeout: 4000 });
      try {
        const res = await api('/api/trade', { method: 'POST', body: { chain: chain.key, address, side, amount } });
        toast(side === 'buy' ? 'Buy confirmed ✅' : 'Sell confirmed ✅', { link: res.txUrl });
        quoteBox.replaceChildren();
        onTraded?.();
      } catch (err) {
        errorToast(err);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    // Several wallets (or one that isn't active): no single quote fits them all, so confirm the plan instead
    function multiView(amount) {
      const ws = pickedWallets();
      const each = side === 'buy' ? `${amount} ${chain.native}` : `${amount}% of its bag`;
      const rows = [
        ['Wallets', ws.map((w) => w.label).join(', ')],
        [side === 'buy' ? 'Each wallet pays' : 'Each wallet sells', each],
      ];
      if (side === 'buy') rows.push(['Total', `${fmtNum(Number(amount) * ws.length, 6)} ${chain.native}`]);
      rows.push(['Fee', `${fmtNum(state.config.fees.manualBps / 100, 2)}% of each trade`], ['MEV protection', settings.mevProtect ? 'on' : 'off']);
      const confirm = h('button', { class: `btn btn-block ${side === 'buy' ? 'btn-up' : 'btn-down'}`, type: 'button', onclick: () => executeMulti(amount, confirm) }, `Confirm ${ws.length > 1 ? `${ws.length} ${side}s` : side}`);
      return h(
        'div',
        { class: 'stack' },
        h('div', { class: 'quote' }, rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('b', {}, v)))),
        h('p', { class: 'fine' }, 'Trades go out one wallet after another. A wallet that can’t trade, for example without enough balance, is skipped and listed below.'),
        confirm,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => quoteBox.replaceChildren() }, 'Cancel'),
      );
    }

    async function executeMulti(amount, btn) {
      const ws = pickedWallets();
      if (btn) btn.disabled = true;
      reviewBtn.disabled = true;
      toast(`Sending ${ws.length > 1 ? `${ws.length} ${side}s` : side}…`, { timeout: 4000 });
      try {
        const res = await api('/api/trade', { method: 'POST', body: { chain: chain.key, address, side, amount, walletIds: ws.map((w) => w.id) } });
        const results = res.multi ? res.results : [{ ok: true, ...res }];
        const ok = results.filter((r) => r.ok).length;
        if (ok === results.length) toast(`${ok > 1 ? `${ok} ${side}s` : side === 'buy' ? 'Buy' : 'Sell'} confirmed ✅`);
        else toast(`${ok} of ${results.length} ${side}s confirmed`, { kind: ok ? 'ok' : 'err' });
        quoteBox.replaceChildren(resultsView(results));
        if (ok) onTraded?.();
      } catch (err) {
        errorToast(err);
      } finally {
        if (btn) btn.disabled = false;
        reviewBtn.disabled = false;
      }
    }

    function resultsView(results) {
      const label = (r) => r.wallet?.label || 'Wallet';
      return h(
        'div',
        { class: 'quote results' },
        results.map((r) =>
          h(
            'div',
            {},
            h('span', {}, `${r.ok ? '✅' : '❌'} ${label(r)}`),
            r.ok ? (r.txUrl ? h('a', { href: r.txUrl, target: '_blank', rel: 'noopener' }, 'View transaction') : h('b', {}, 'Confirmed')) : h('b', { class: 'down' }, r.error || 'Failed'),
          ),
        ),
      );
    }

    return [
      picker,
      h('div', { class: 'row fine' }, h('span', { class: 'grow' }, side === 'buy' ? `Buy with ${chain.native}` : 'Sell a share of your bag'), h('span', { title: 'In your active wallet' }, `Holding ${holding}`)),
      presetRow,
      input,
      reviewBtn,
      quoteBox,
    ];
  }

  // ---------- limit / TP / SL ----------
  function limitView() {
    const type = h(
      'select',
      { class: 'input', 'aria-label': 'Order type' },
      side === 'buy'
        ? [h('option', { value: 'limit_buy' }, 'Limit buy: when the price drops')]
        : [h('option', { value: 'take_profit' }, 'Take profit: when the price rises'), h('option', { value: 'stop_loss' }, 'Stop loss: when the price drops')],
    );
    const amount = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: side === 'buy' ? `Amount in ${chain.native}` : '% of your bag', value: side === 'buy' ? settings.buyPresetsResolved[chain.key][1] : '100' });
    const move = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Price move in %', value: side === 'buy' ? '20' : '50' });
    const submit = h('button', { class: 'btn btn-yellow btn-block', type: 'button' }, 'Place order');
    submit.onclick = async () => {
      submit.disabled = true;
      try {
        const order = await api('/api/orders', { method: 'POST', body: { chain: chain.key, address, type: type.value, amount: amount.value, move: move.value } });
        toast(`Order placed: triggers at ${fmtNum(order.trigger_price, 10)} ${chain.native}/token`);
      } catch (err) {
        errorToast(err);
      } finally {
        submit.disabled = false;
      }
    };
    return [
      h('label', { class: 'field' }, 'Order', type),
      h('label', { class: 'field' }, side === 'buy' ? `Spend (${chain.native})` : 'Sell (% of bag)', amount),
      h('label', { class: 'field' }, 'Price move from now (%)', move),
      submit,
      h('p', { class: 'fine' }, `Checked every ~15 s from your active wallet, valid 7 days. Fee ${fmtNum(state.config.fees.autoBps / 100, 2)}%.`),
    ];
  }

  // ---------- DCA ----------
  function dcaView() {
    const amount = h('input', { class: 'input mono', inputmode: 'decimal', value: side === 'buy' ? settings.buyPresetsResolved[chain.key][0] : '100' });
    const runs = h('input', { class: 'input mono', inputmode: 'numeric', value: '5' });
    const interval = h('select', { class: 'input' }, DCA_INTERVALS.map((i) => h('option', { value: i, selected: i === '1h' }, `every ${i}`)));
    const submit = h('button', { class: 'btn btn-yellow btn-block', type: 'button' }, `Start DCA ${side}`);
    submit.onclick = async () => {
      submit.disabled = true;
      try {
        await api('/api/dca', { method: 'POST', body: { chain: chain.key, address, side, amount: amount.value, runs: Number(runs.value), interval: interval.value } });
        toast('DCA plan started. First run within a minute.');
      } catch (err) {
        errorToast(err);
      } finally {
        submit.disabled = false;
      }
    };
    return [
      h('label', { class: 'field' }, side === 'buy' ? `${chain.native} per buy` : '% of your bag in total', amount),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Number of runs', runs), h('label', { class: 'field grow' }, 'Interval', interval)),
      submit,
    ];
  }

  function render() {
    renderTabs();
    body.replaceChildren(...(mode === 'market' ? marketView() : mode === 'limit' ? limitView() : dcaView()), footer());
  }
  render();
  return Object.assign(root, { refresh: render });
}
