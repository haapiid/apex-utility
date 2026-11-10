import { h, api, state, on, loggedIn, short, panel, loginRequired, toast, errorToast } from '../lib.js';
import { logout } from '../auth.js';

// Account: the ways to log in (wallets, Google, Telegram), linking more, logging out
const LABEL = { sol: '◎ Solana wallet', evm: '⟠ EVM wallet', google: 'G Google' };

export default function account(container) {
  // Re-render when account data changes (linking or removing a login)
  render(container);
  return on((event) => event === 'me' && (container.replaceChildren(), render(container)));
}

function render(container) {
  if (!loggedIn()) return loginRequired(container, 'your account');
  const me = state.me;
  const methods = [
    h(
      'div',
      { class: 'line-item' },
      h('div', {}, h('b', {}, '✈ Telegram'), h('div', { class: 'fine' }, me.user.telegram ? 'Linked: the bot and ApeX Pro share this account.' : 'Not linked. Link it to trade from the bot too.')),
      me.user.telegram ? h('span', { class: 'chip ok' }, 'Linked') : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => document.dispatchEvent(new Event('apex:link')) }, 'Link'),
    ),
    ...me.identities.map((i) =>
      h(
        'div',
        { class: 'line-item' },
        h('div', {}, h('b', {}, LABEL[i.provider] || i.provider), h('div', { class: 'fine mono' }, i.label || short(i.subject, 6))),
        h(
          'button',
          {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            onclick: async () => {
              if (!confirm('Remove this way to log in?')) return;
              try {
                await api('/api/account/unlink', { method: 'POST', body: { provider: i.provider, subject: i.subject } });
                toast('Removed');
                document.dispatchEvent(new Event('apex:refresh'));
              } catch (err) {
                errorToast(err);
              }
            },
          },
          'Remove',
        ),
      ),
    ),
  ];

  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Account'), h('div', { class: 'row' }, h('a', { class: 'btn btn-sm', href: '#/wallets' }, 'Wallets'), h('a', { class: 'btn btn-sm', href: '#/settings' }, 'Settings'))),
    h(
      'div',
      { class: 'grid' },
      panel('Ways to log in', h('div', { class: 'panel-body' }, methods), h('button', { class: 'btn btn-sm btn-yellow', type: 'button', onclick: () => document.dispatchEvent(new Event('apex:link')) }, '+ Link')),
      panel(
        'Session',
        h(
          'div',
          { class: 'panel-body stack' },
          h('p', { class: 'muted' }, 'Any linked login opens this same account, with the same wallets, positions and rewards.'),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                await logout().catch(errorToast);
                document.dispatchEvent(new Event('apex:logout'));
                location.hash = '#/';
              },
            },
            'Log out',
          ),
        ),
      ),
      me.admin ? officialTokenPanel() : '',
    ),
  );
}

// Admin only: the official $APEX address shown on the landing page and in Fees & pools (display only)
function officialTokenPanel() {
  const chains = state.config?.chains || [];
  const select = h('select', { class: 'chain-select', 'aria-label': 'Chain' }, ...chains.map((c) => h('option', { value: c.key }, c.name)));
  const input = h('input', { class: 'input mono', type: 'text', placeholder: 'Token contract address (CA)', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Token contract address' });
  const current = h('div', { class: 'stack' });
  const removeBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', hidden: true, onclick: () => save(null) }, 'Remove');

  function show(t) {
    removeBtn.hidden = !t;
    current.replaceChildren(
      t
        ? h('div', { class: 'line-item' }, h('div', {}, h('b', {}, `$${t.symbol || '?'} · ${t.chainName}`), h('div', { class: 'fine mono' }, t.address)), h('span', { class: 'chip ok' }, 'Live'))
        : h('p', { class: 'muted' }, 'Nothing set yet: the landing page shows no contract address.'),
    );
  }

  async function save(address) {
    if (address === null && !confirm('Hide the official $APEX address on the site?')) return;
    if (address !== null) {
      if (!address) return toast('Paste the contract address first.', { kind: 'err' });
      const chainName = select.selectedOptions[0]?.textContent;
      if (!confirm(`Show ${address} on ${chainName} as the official $APEX on the site?`)) return;
    }
    try {
      const r = await api('/api/admin/official-token', { method: 'POST', body: address === null ? { address: null } : { chain: select.value, address } });
      show(r.token);
      input.value = '';
      toast(r.token ? `Live on the site: $${r.token.symbol}. Check the name and symbol.` : 'Removed from the site.');
    } catch (err) {
      errorToast(err);
    }
  }

  api('/api/official-token').then((r) => show(r.token), () => show(null));
  return panel(
    'Official $APEX (admin)',
    h(
      'div',
      { class: 'panel-body stack' },
      h('p', { class: 'muted' }, 'After the launch, paste the token contract address. It is checked on-chain, then shown on apexutility.fun and in Fees & pools. Revenue share and cashback stay off until APEX_TOKEN_ADDRESS is set on the server.'),
      current,
      h('div', { class: 'row' }, select, input),
      h('div', { class: 'row' }, h('button', { class: 'btn btn-sm btn-yellow', type: 'button', onclick: () => save(input.value.trim()) }, 'Publish on site'), removeBtn),
    ),
  );
}
