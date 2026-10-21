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
    const reviewBtn = h('button', { class: `btn btn-block ${side === 'buy' ? 'btn-up' : 'btn-down'}`, type: 'button', onclick: () => review() }, settings.confirmTrades ? `Review ${side}` : `${side === 'buy' ? 'Buy' : 'Sell'} now`);

    async function review() {
      const amount = input.value.trim().replace('%', '');
      if (!amount) return input.focus();
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

    return [
      h('div', { class: 'row fine' }, h('span', { class: 'grow' }, side === 'buy' ? `Buy with ${chain.native}` : 'Sell a share of your bag'), h('span', {}, `Holding ${holding}`)),
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
