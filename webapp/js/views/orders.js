import { h, api, state, chainInfo, loggedIn, fmtNum, short, ago, panel, empty, loginRequired, toast, errorToast } from '../lib.js';

// Automation: limit / TP / SL orders, DCA plans, snipes and copy trading
const TYPE_LABEL = { limit_buy: '🟢 Limit buy', take_profit: '📈 Take profit', stop_loss: '📉 Stop loss' };

const chainOptions = () => state.config.chains.map((c) => h('option', { value: c.key, selected: c.key === state.chain }, c.name));

export default function orders(container) {
  if (!loggedIn()) return loginRequired(container, 'your orders');
  const lists = { orders: h('div', { class: 'panel-body' }), dca: h('div', { class: 'panel-body' }), snipes: h('div', { class: 'panel-body' }), copy: h('div', { class: 'panel-body' }) };

  // --- snipe form ---
  const sChain = h('select', { class: 'input' }, chainOptions());
  const sAddr = h('input', { class: 'input mono', placeholder: 'Token address (it may not exist yet)', spellcheck: 'false' });
  const sAmount = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Amount', value: '0.1' });
  const sSafe = h('input', { type: 'checkbox', checked: true });
  const sMigration = h('input', { type: 'checkbox' });
  const snipeForm = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/snipes', { method: 'POST', body: { chain: sChain.value, address: sAddr.value.trim(), amount: sAmount.value, safety: sSafe.checked, trigger: sMigration.checked ? 'migration' : 'tradable' } });
          toast(sMigration.checked ? 'Snipe armed 🎓 It buys the moment the token migrates to PumpSwap.' : 'Snipe armed 🎯 It buys as soon as the token is tradable.');
          sAddr.value = '';
          load();
        } catch (err) {
          errorToast(err);
        }
      },
    },
    h('div', { class: 'row wrap' }, h('label', { class: 'field' }, 'Chain', sChain), h('label', { class: 'field grow' }, 'Amount', sAmount)),
    h('label', { class: 'field' }, 'Token', sAddr),
    h('label', { class: 'row fine' }, sSafe, 'Safety filter: skip honeypots, high taxes and freeze authority'),
    h('label', { class: 'row fine' }, sMigration, 'pump.fun (Solana): wait until it migrates to PumpSwap'),
    h('p', { class: 'fine' }, h('a', { href: '#/pump', class: 'up' }, '💊 Auto-snipe every pump.fun launch or migration →')),
    h('button', { class: 'btn btn-yellow', type: 'submit' }, `Arm snipe (fee ${fmtNum(state.config.fees.snipeBps / 100, 2)}%)`),
  );

  // --- copy form ---
  const cChain = h('select', { class: 'input' }, chainOptions());
  const cAddr = h('input', { class: 'input mono', placeholder: 'Wallet to follow', spellcheck: 'false' });
  const cAmount = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'Amount per buy', value: '0.1' });
  const copyForm = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/copy', { method: 'POST', body: { chain: cChain.value, address: cAddr.value.trim(), amount: cAmount.value } });
          toast('Now following this wallet 👥 New trades from now on are copied.');
          cAddr.value = '';
          load();
        } catch (err) {
          errorToast(err);
        }
      },
    },
    h('div', { class: 'row wrap' }, h('label', { class: 'field' }, 'Chain', cChain), h('label', { class: 'field grow' }, 'Amount per buy', cAmount)),
    h('label', { class: 'field' }, 'Wallet', cAddr),
    h('button', { class: 'btn btn-yellow', type: 'submit' }, 'Follow wallet'),
  );

  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Orders & automation'), h('p', { class: 'fine' }, 'Everything runs from your active wallet, even while this page is closed.')),
    h(
      'div',
      { class: 'grid' },
      panel('Limit · TP · SL', lists.orders),
      panel('DCA plans', lists.dca),
      panel('Snipes', h('div', {}, lists.snipes, h('div', { class: 'panel-body divided' }, snipeForm))),
      panel('Copy trading', h('div', {}, lists.copy, h('div', { class: 'panel-body divided' }, copyForm))),
    ),
  );

  const cancelBtn = (kind, id, label = 'Cancel') =>
    h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/cancel/${kind}/${id}`, { method: 'POST' }).catch(errorToast), load()) }, label);
  const tokenLink = (chain, token, text) => h('a', { href: `#/token/${chain}/${token}`, class: 'up' }, text);

  async function load() {
    try {
      const data = await api('/api/orders');
      lists.orders.replaceChildren(
        ...(data.orders.length
          ? data.orders.map((o) => {
              const c = chainInfo(o.chain);
              return h(
                'div',
                { class: 'line-item' },
                h('div', {}, h('b', {}, `${TYPE_LABEL[o.type]} `), tokenLink(o.chain, o.token, `$${o.symbol}`), h('div', { class: 'fine' }, `${c?.name} · ${o.type === 'limit_buy' ? `${o.amount} ${c?.native}` : `${o.amount}%`} at ${fmtNum(o.trigger_price, 10)} · now ${fmtNum(o.last_price, 10)}`)),
                cancelBtn('order', o.id),
              );
            })
          : [empty('No open orders. Open a token and use Limit in the trade box.')]),
      );
      lists.dca.replaceChildren(
        ...(data.dca.length
          ? data.dca.map((p) =>
              h('div', { class: 'line-item' }, h('div', {}, h('b', {}, `🔁 ${p.side} `), tokenLink(p.chain, p.token, `$${p.symbol}`), h('div', { class: 'fine' }, `${chainInfo(p.chain)?.name} · ${p.runs_done}/${p.runs_total} runs`)), cancelBtn('dca', p.id)),
            )
          : [empty('No DCA plans. Open a token and use DCA in the trade box.')]),
      );
      lists.snipes.replaceChildren(
        ...(data.snipes.length
          ? data.snipes.map((s) =>
              h('div', { class: 'line-item' }, h('div', {}, h('b', { class: 'mono' }, `🎯 ${short(s.token, 6)}`), h('div', { class: 'fine' }, `${chainInfo(s.chain)?.name} · ${s.amount} ${chainInfo(s.chain)?.native} · ${s.trigger === 'migration' ? 'waiting for migration' : 'waiting'} ${ago(s.created_at)} · safety ${s.safety ? 'on' : 'off'}`)), cancelBtn('snipe', s.id)),
            )
          : [empty('No active snipes.')]),
      );
      lists.copy.replaceChildren(
        ...(data.copy.length
          ? data.copy.map((t) =>
              h(
                'div',
                { class: 'line-item' },
                h('div', {}, h('b', { class: 'mono' }, `${t.active ? '🟢' : '⏸'} ${t.label}`), h('div', { class: 'fine' }, `${chainInfo(t.chain)?.name} · ${t.buy_amount} ${chainInfo(t.chain)?.native} per buy · sells ${t.copy_sells ? 'copied' : 'not copied'}`)),
                h(
                  'div',
                  { class: 'row' },
                  h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/copy/${t.id}`, { method: 'POST', body: { active: !t.active } }).catch(errorToast), load()) }, t.active ? 'Pause' : 'Resume'),
                  h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/copy/${t.id}`, { method: 'POST', body: { copySells: !t.copy_sells } }).catch(errorToast), load()) }, t.copy_sells ? 'Ignore sells' : 'Copy sells'),
                  cancelBtn('copy', t.id, 'Unfollow'),
                ),
              ),
            )
          : [empty('Not following anyone yet.')]),
      );
    } catch (err) {
      errorToast(err);
    }
  }
  load();
  const timer = setInterval(load, 30_000);
  return () => clearInterval(timer);
}
