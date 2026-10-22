import { h, api, state, loggedIn, fmtNum, panel, loginRequired, toast, errorToast } from '../lib.js';

// The same per-user settings as /settings in the bot. Buys and sells have their own execution settings:
// the bot edits the buy side, and sells follow it until "Same as buy" is turned off here.
const GAS_STEPS = [0, 10, 25, 50, 100];

export default function settings(container) {
  if (!loggedIn()) return loginRequired(container, 'your settings');
  const s = state.me.settings;
  const toggle = (checked) => h('input', { type: 'checkbox', checked });
  const num = (value) => h('input', { class: 'input mono', inputmode: 'decimal', value: String(value) });

  // One set of execution fields per side, filled from what that side trades with now
  function sideFields(v) {
    return {
      mevProtect: toggle(v.mevProtect),
      slipSol: num(v.slippageBps.sol / 100),
      slipEvm: num(v.slippageBps.evm / 100),
      jito: num(v.jitoTipLamports / 1e9),
      priority: num(v.priorityMaxLamports / 1e9),
      gas: h('select', { class: 'input' }, GAS_STEPS.map((g) => h('option', { value: g, selected: g === v.gasBoostPct }, `+${g}%`))),
      impact: num(v.maxImpactPct || 0),
    };
  }
  const buy = sideFields(s);
  const sell = sideFields(s.sellResolved);
  const sameAsBuy = toggle(!Object.keys(s.sell || {}).length);

  const f = {
    confirmTrades: toggle(s.confirmTrades),
    antiRug: toggle(s.antiRug),
    rugPct: num(s.antiRugDropPct),
    sell: h('input', { class: 'input mono', value: s.sellPresets.join(', ') }),
    buy: Object.fromEntries(state.config.chains.map((c) => [c.key, h('input', { class: 'input mono', value: s.buyPresetsResolved[c.key].join(', ') })])),
  };
  const list = (text) => text.split(/[\s,]+/).filter(Boolean);
  const sideBody = (x) => ({
    mevProtect: x.mevProtect.checked,
    slippagePct: { sol: Number(x.slipSol.value), evm: Number(x.slipEvm.value) },
    jitoTipSol: Number(x.jito.value),
    priorityMaxSol: Number(x.priority.value),
    gasBoostPct: Number(x.gas.value),
    maxImpactPct: Number(x.impact.value || 0),
  });

  async function save(e) {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          ...sideBody(buy),
          sell: sameAsBuy.checked ? null : sideBody(sell),
          confirmTrades: f.confirmTrades.checked,
          antiRug: f.antiRug.checked,
          antiRugDropPct: Number(f.rugPct.value),
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

  function executionPanel(title, x, extra) {
    const fields = h(
      'div',
      { class: 'stack' },
      check(x.mevProtect, 'MEV protection', 'Solana via Jito, Ethereum via Flashbots Protect, BSC via PancakeSwap MEV Guard.'),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Slippage Solana (%)', x.slipSol), h('label', { class: 'field grow' }, 'Slippage EVM (%)', x.slipEvm)),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'Jito tip (SOL, MEV on)', x.jito), h('label', { class: 'field grow' }, 'Max priority fee (SOL, MEV off)', x.priority)),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, 'EVM gas boost', x.gas), h('label', { class: 'field grow' }, 'Max price impact (%, 0 = off)', x.impact)),
    );
    return panel(title, h('div', { class: 'panel-body stack' }, extra || null, fields));
  }

  const sellPanel = executionPanel('Sell execution', sell, check(sameAsBuy, 'Same as buy', 'On: sells use the buy settings. Off: set sells apart, e.g. more slippage to get out fast.'));
  const sellFields = sellPanel.querySelector('.stack .stack');
  const syncSell = () => sellFields.classList.toggle('disabled', sameAsBuy.checked);
  sameAsBuy.addEventListener('change', syncSell);
  syncSell();

  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings'), h('p', { class: 'fine' }, 'Shared with the Telegram bot. The bot edits the buy side.')),
    h(
      'form',
      { onsubmit: save, class: 'grid' },
      executionPanel('Buy execution', buy),
      sellPanel,
      panel(
        'Protection',
        h(
          'div',
          { class: 'panel-body stack' },
          check(f.antiRug, 'Anti-rug', 'Sell a position automatically when its value collapses between two checks (~20 s).'),
          h('label', { class: 'field' }, 'Anti-rug trigger (% drop)', f.rugPct),
          check(f.confirmTrades, 'Review before trading', 'Off: buy and sell buttons trade instantly.'),
          h('p', { class: 'fine' }, 'The price impact limit stops manual trades and automated buys. Stop loss, anti-rug, DCA and copy sells still go through so you never get stuck in a falling token.'),
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
