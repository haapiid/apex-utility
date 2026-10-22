import { h, api, state, on, loggedIn, native, copyButton, panel, loginRequired, toast, errorToast, askPin } from '../lib.js';

// ApeX trading wallets (custodial, shared with the bot): balances, switch the active one, create, import,
// export, remove, and the security PIN that guards export / import / remove
const KIND = { sol: '◎ Solana', evm: '⟠ EVM (all EVM chains)' };
const refresh = () => document.dispatchEvent(new Event('apex:refresh'));

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
    const pin = await askPin('Enter your PIN to show this private key.');
    if (pin == null) return;
    try {
      const { privateKey } = await api(`/api/wallets/${w.id}/export`, { method: 'POST', body: { confirm: 'EXPORT', pin } });
      const box = h('div', { class: 'secret' }, privateKey);
      const holder = document.getElementById(`wallet-${w.id}`);
      holder.append(h('div', { class: 'stack' }, h('p', { class: 'form-error' }, 'Copy it somewhere safe and offline. It hides in 60 seconds.'), box, copyButton(privateKey, 'Copy key')));
      setTimeout(() => box.parentElement?.remove(), 60_000);
    } catch (err) {
      errorToast(err);
    }
  }

  async function removeWallet(w) {
    const typed = prompt(`Remove ${w.label} (${w.address}) from ApeX?\nExport its key first if it holds funds: ApeX can't recover it afterwards. Type REMOVE to continue.`);
    if (typed !== 'REMOVE') return;
    const pin = await askPin('Enter your PIN to remove this wallet.');
    if (pin == null) return;
    try {
      await api(`/api/wallets/${w.id}/remove`, { method: 'POST', body: { confirm: 'REMOVE', pin } });
      toast(`${w.label} removed`);
      refresh();
    } catch (err) {
      errorToast(err);
    }
  }

  // ---------- import ----------
  const secret = h('textarea', { class: 'input mono secret-input', rows: '3', placeholder: 'Solana: base58 or [1,2,…] · EVM: 0x…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Private key' });
  const importPanel = panel(
    'Import a wallet',
    h(
      'form',
      {
        class: 'panel-body stack',
        onsubmit: async (e) => {
          e.preventDefault();
          const value = secret.value.trim();
          if (!value) return secret.focus();
          const pin = await askPin('Enter your PIN to import a wallet.');
          if (pin == null) return;
          try {
            const w = await api('/api/wallets/import', { method: 'POST', body: { secret: value, pin } });
            toast(`Imported as ${w.label} and set as active`);
            refresh();
          } catch (err) {
            errorToast(err);
          } finally {
            secret.value = ''; // never leave a key sitting in the page
          }
        },
      },
      secret,
      h('button', { class: 'btn btn-yellow', type: 'submit' }, 'Import'),
      h('p', { class: 'fine' }, 'The key is encrypted on the server (AES-256-GCM) and the field is cleared right away. Use a dedicated trading wallet, never your main one.'),
    ),
  );

  // ---------- security PIN ----------
  function pinPanel() {
    const has = state.me.hasPin;
    const current = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', placeholder: 'Current PIN' });
    const next = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', placeholder: '4–8 digits' });
    const again = h('input', { class: 'input mono', type: 'password', inputmode: 'numeric', maxlength: '8', autocomplete: 'off', placeholder: 'Repeat it' });
    const send = async (payload, done) => {
      try {
        await api('/api/pin', { method: 'POST', body: payload });
        toast(done);
        refresh();
      } catch (err) {
        errorToast(err);
      }
    };
    return panel(
      '🔒 Security PIN',
      h(
        'form',
        {
          class: 'panel-body stack',
          onsubmit: (e) => {
            e.preventDefault();
            if (next.value !== again.value) return toast('The two PINs don’t match.', { kind: 'err' });
            send({ pin: next.value, current: current.value }, has ? 'PIN changed' : 'PIN set: ApeX Pro asks for it before export, import and remove');
          },
        },
        h('p', { class: 'fine' }, has ? 'Your PIN is on. It is asked before exporting or importing a key and removing a wallet.' : 'Add a PIN so a stolen session can’t export your keys. 5 wrong tries lock it for 15 minutes.'),
        has ? h('label', { class: 'field' }, 'Current PIN', current) : null,
        h('div', { class: 'row' }, h('label', { class: 'field grow' }, has ? 'New PIN' : 'PIN', next), h('label', { class: 'field grow' }, 'Repeat', again)),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn btn-yellow', type: 'submit' }, has ? 'Change PIN' : 'Set PIN'),
          has ? h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => send({ remove: true, current: current.value }, 'PIN removed') }, 'Remove PIN') : null,
        ),
      ),
    );
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
              { class: 'row wrap' },
              h('b', { class: 'grow' }, `${w.active ? '✅' : '▫️'} ${w.label}`),
              !w.active ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/wallets/${w.id}/active`, { method: 'POST' }).catch(errorToast), refresh()) }, 'Use for trading') : null,
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => exportKey(w) }, 'Export key'),
              h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => removeWallet(w) }, 'Remove'),
            ),
            h('div', { class: 'row' }, h('span', { class: 'mono fine grow break' }, w.address), copyButton(w.address, 'Copy address')),
            w.active
              ? h('div', { class: 'chips' }, chains.filter((c) => c.kind === kind).map((c) => h('span', { class: 'chip' }, `${c.name}: ${balances[c.key] != null ? native(balances[c.key], c, 5) : '–'}`)))
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
                      refresh();
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
      importPanel,
      pinPanel(),
    );
  }
  load();
  // Fresh account data (after switching, creating, importing or the PIN changing) re-renders the list
  return on((event) => event === 'me' && load());
}
