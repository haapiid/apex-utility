import { h, api, state, on, loggedIn, native, copyButton, panel, loginRequired, toast, errorToast } from '../lib.js';

// ApeX trading wallets (custodial, shared with the bot): balances, switch the active one, create, export
const KIND = { sol: '◎ Solana', evm: '⟠ EVM (all EVM chains)' };

export default function wallets(container) {
  if (!loggedIn()) return loginRequired(container, 'your wallets');
  const body = h('div', { class: 'grid' });
  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Wallets'), h('p', { class: 'fine' }, 'Deposit to the active (✅) wallet to trade. The same wallets work in the ApeX Telegram bot.')),
    body,
  );

  async function exportKey(w) {
    const typed = prompt(`Export the private key of ${w.label} (${w.address}).\nAnyone with this key can take the funds. Type EXPORT to continue.`);
    if (typed !== 'EXPORT') return;
    try {
      const { privateKey } = await api(`/api/wallets/${w.id}/export`, { method: 'POST', body: { confirm: 'EXPORT' } });
      const box = h('div', { class: 'secret' }, privateKey);
      const holder = document.getElementById(`wallet-${w.id}`);
      holder.append(h('div', { class: 'stack' }, h('p', { class: 'form-error' }, 'Copy it somewhere safe and offline. It hides in 60 seconds.'), box, copyButton(privateKey, 'Copy key')));
      setTimeout(() => box.parentElement?.remove(), 60_000);
    } catch (err) {
      errorToast(err);
    }
  }

  async function load() {
    const balances = await api('/api/balances').catch(() => ({}));
    const me = state.me;
    const chains = state.config.chains;
    body.replaceChildren(
      ...['sol', 'evm'].map((kind) => {
        const list = me.wallets.filter((w) => w.kind === kind);
        const rows = list.map((w) =>
          h(
            'div',
            { class: 'wallet-item', id: `wallet-${w.id}` },
            h(
              'div',
              { class: 'row' },
              h('b', { class: 'grow' }, `${w.active ? '✅' : '▫️'} ${w.label}`),
              !w.active
                ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/wallets/${w.id}/active`, { method: 'POST' }).catch(errorToast), document.dispatchEvent(new Event('apex:refresh'))) }, 'Use for trading')
                : null,
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => exportKey(w) }, 'Export key'),
            ),
            h('div', { class: 'row' }, h('span', { class: 'mono fine grow break' }, w.address), copyButton(w.address, 'Copy address')),
            w.active
              ? h(
                  'div',
                  { class: 'chips' },
                  chains.filter((c) => c.kind === kind).map((c) => h('span', { class: 'chip' }, `${c.name}: ${balances[c.key] != null ? native(balances[c.key], c, 5) : '–'}`)),
                )
              : null,
          ),
        );
        const canAdd = list.length < me.walletLimit;
        return panel(
          KIND[kind],
          h('div', { class: 'panel-body' }, rows.length ? rows : h('p', { class: 'muted' }, 'No wallet yet.')),
          canAdd
            ? h(
                'button',
                {
                  class: 'btn btn-sm',
                  type: 'button',
                  onclick: async () => {
                    try {
                      await api('/api/wallets', { method: 'POST', body: { kind } });
                      toast('New wallet created and set as active');
                      document.dispatchEvent(new Event('apex:refresh'));
                    } catch (err) {
                      errorToast(err);
                    }
                  },
                },
                '+ New',
              )
            : null,
        );
      }),
    );
  }
  load();
  // Fresh account data (after switching or creating a wallet) re-renders the list
  return on((event) => event === 'me' && load());
}
