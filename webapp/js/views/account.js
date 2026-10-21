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
    ),
  );
}
