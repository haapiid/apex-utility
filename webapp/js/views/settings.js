import { h, api, state, loggedIn, fmtNum, panel, loginRequired, toast, errorToast } from '../lib.js';

// The same per-user settings as /settings in the bot
const GAS_STEPS = [0, 10, 25, 50, 100];

export default function settings(container) {
  if (!loggedIn()) return loginRequired(container, 'your settings');
  const s = state.me.settings;
  const toggle = (checked) => h('input', { type: 'checkbox', checked });
  const num = (value) => h('input', { class: 'input mono', inputmode: 'decimal', value: String(value) });

  const f = {
    mevProtect: toggle(s.mevProtect),
    confirmTrades: toggle(s.confirmTrades),
    antiRug: toggle(s.antiRug),
    slipSol: num(s.slippageBps.sol / 100),
    slipEvm: num(s.slippageBps.evm / 100),
    jito: num(s.jitoTipLamports / 1e9),
    priority: num(s.priorityMaxLamports / 1e9),
    rugPct: num(s.antiRugDropPct),
    gas: h('select', { class: 'input' }, GAS_STEPS.map((g) => h('option', { value: g, selected: g === s.gasBoostPct }, `+${g}%`))),
    sell: h('input', { class: 'input mono', value: s.sellPresets.join(', ') }),
    buy: Object.fromEntries(state.config.chains.map((c) => [c.key, h('input', { class: 'input mono', value: s.buyPresetsResolved[c.key].join(', ') })])),
  };
  const list = (text) => text.split(/[\s,]+/).filter(Boolean);

  async function save(e) {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          mevProtect: f.mevProtect.checked,
          confirmTrades: f.confirmTrades.checked,
          antiRug: f.antiRug.checked,
          slippagePct: { sol: Number(f.slipSol.value), evm: Number(f.slipEvm.value) },
          jitoTipSol: Number(f.jito.value),
          priorityMaxSol: Number(f.priority.value),
          antiRugDropPct: Number(f.rugPct.value),
          gasBoostPct: Number(f.gas.value),
          sellPresets: list(f.sell.value).map(Number),
          buyPresets: Object.fromEntries(Object.entries(f.buy).map(([k, input]) => [k, list(input.value)])),
        },
      });
      toast('Settings saved');
      document.dispatchEvent(new Event('apex:refresh'));
    } catch (err) {
      errorToast(err);
    }
  }

  const check = (input, label, hint) => h('label', { class: 'row top' }, input, h('span', {}, h('b', {}, label), h('div', { class: 'fine' }, hint)));

  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings'), h('p', { class: 'fine' }, 'Shared with the Telegram bot.')),
    h(
      'form',
      { onsubmit: save, class: 'grid' },
      panel(
        'Protection',
        h(
          'div',
          { class: 'panel-body stack' },
          check(f.mevProtect, 'MEV protection', 'Solana via Jito, Ethereum via Flashbots Protect, BSC via PancakeSwap MEV Guard.'),
          check(f.antiRug, 'Anti-rug', 'Sell a position automatically when its value collapses between two checks (~20 s).'),
          h('label', { class: 'field' }, 'Anti-rug trigger (% drop)', f.rugPct),
          check(f.confirmTrades, 'Review before trading', 'Off: buy and sell buttons trade instantly.'),
        ),
      ),
      panel(
        'Execution',
        h(
          'div',
          { class: 'panel-body stack' },
          h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Slippage Solana (%)', f.slipSol), h('label', { class: 'field grow' }, 'Slippage EVM (%)', f.slipEvm)),
          h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Jito tip (SOL, MEV on)', f.jito), h('label', { class: 'field grow' }, 'Max priority fee (SOL, MEV off)', f.priority)),
          h('label', { class: 'field' }, 'EVM gas boost', f.gas),
        ),
      ),
      panel(
        'Buttons',
        h(
          'div',
          { class: 'panel-body stack' },
          ...state.config.chains.map((c) => h('label', { class: 'field' }, `Buy buttons · ${c.name} (${c.native})`, f.buy[c.key])),
          h('label', { class: 'field' }, 'Sell buttons (%)', f.sell),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn btn-yellow', type: 'submit' }, 'Save settings'),
        h(
          'button',
          {
            class: 'btn btn-ghost',
            type: 'button',
            onclick: async () => {
              if (!confirm('Reset all settings to the defaults?')) return;
              await api('/api/settings', { method: 'POST', body: { reset: true } }).catch(errorToast);
              toast('Settings reset');
              document.dispatchEvent(new Event('apex:refresh'));
              setTimeout(() => location.reload(), 400);
            },
          },
          'Reset',
        ),
        h('span', { class: 'fine' }, `Fees: ${fmtNum(state.config.fees.manualBps / 100, 2)}% trades · ${fmtNum(state.config.fees.snipeBps / 100, 2)}% snipes`),
      ),
    ),
  );
  return null;
}
