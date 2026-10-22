import { h, $, api, state, setChain, on, emit, chainInfo, loggedIn, fmtCompact, fmtPrice, pct, native, short, avatar, toast, errorToast, plainText, ago } from './lib.js';
import { signInWithWallet, telegramLogin, googleUrl } from './auth.js';
import discover from './views/discover.js';
import trending from './views/trending.js';
import token from './views/token.js';
import positions from './views/positions.js';
import orders from './views/orders.js';
import pump from './views/pump.js';
import watchlist from './views/watchlist.js';
import tracker from './views/tracker.js';
import rewards from './views/rewards.js';
import wallets from './views/wallets.js';
import settings from './views/settings.js';
import account from './views/account.js';

// ApeX Pro single-page app: hash routes, each view returns a cleanup function.
const ROUTES = [
  [/^\/?$/, 'discover', discover],
  [/^\/trending$/, 'trending', trending],
  [/^\/token\/([a-z]+)\/([A-Za-z0-9]+)$/, null, token],
  [/^\/positions$/, 'positions', positions],
  [/^\/orders$/, 'orders', orders],
  [/^\/pump$/, 'pump', pump],
  [/^\/watchlist$/, 'watchlist', watchlist],
  [/^\/tracker$/, 'tracker', tracker],
  [/^\/rewards$/, 'rewards', rewards],
  [/^\/wallets$/, null, wallets],
  [/^\/settings$/, null, settings],
  [/^\/account$/, null, account],
  [/^\/login$/, null, discover],
];

let cleanup = null;

async function refreshMe() {
  state.me = await api('/api/me').catch(() => ({ user: null }));
  renderAccount();
  emit('me');
}

// ---------- top bar ----------

function renderChains() {
  const select = $('#chain');
  select.replaceChildren(...state.config.chains.map((c) => h('option', { value: c.key, selected: c.key === state.chain }, c.name)));
  if (!chainInfo()) setChain('sol');
  select.onchange = () => setChain(select.value);
}

let balances = {};
async function loadBalances() {
  if (!loggedIn()) return;
  balances = await api('/api/balances').catch(() => balances);
  renderAccount();
}

function renderAccount() {
  const box = $('#account');
  if (!loggedIn()) {
    box.replaceChildren(h('button', { class: 'btn btn-yellow', type: 'button', onclick: openLogin }, 'Log in'));
    return;
  }
  const chain = chainInfo();
  const bal = balances[state.chain];
  const unread = state.me.unread || 0;
  box.replaceChildren(
    h('a', { class: 'bal', href: '#/wallets', title: 'Wallets' }, bal != null ? native(bal, chain, 4) : chain?.native || ''),
    h(
      'div',
      { class: 'notif' },
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': 'Notifications', onclick: toggleNotifications }, '🔔'),
      unread ? h('span', { class: 'notif-badge' }, unread > 99 ? '99+' : unread) : null,
    ),
    h('a', { class: 'btn btn-sm', href: '#/account' }, '🐒 Account'),
  );
}

async function toggleNotifications(e) {
  const holder = e.currentTarget.parentElement;
  const open = holder.querySelector('.notif-panel');
  if (open) return open.remove();
  const list = await api('/api/notifications').catch(() => []);
  const items = list.length
    ? list.map((n) => {
        const { text, link } = plainText(n.text);
        return h('div', { class: 'notif-item' }, text, link ? [' ', h('a', { href: link, target: '_blank', rel: 'noopener', class: 'up' }, '↗')] : null, h('time', {}, `${ago(n.created_at)} ago`));
      })
    : [h('div', { class: 'empty' }, 'No notifications yet. Orders, snipes, copy trades and rewards report here.')];
  holder.append(h('div', { class: 'notif-panel' }, items));
  if (state.me.unread) {
    await api('/api/notifications/read', { method: 'POST' }).catch(() => {});
    state.me.unread = 0;
    renderAccount();
  }
}

// ---------- trending ticker ----------

let tickerSeq = 0;
async function loadTicker() {
  const box = $('#ticker');
  const mine = ++tickerSeq;
  const rows = await api(`/api/market/ticker?chain=${state.chain}`).catch(() => null);
  if (mine !== tickerSeq || !rows) return;
  if (!rows.length) return box.replaceChildren();
  const item = (t) =>
    h('a', { class: 'tick', href: `#/token/${t.chain}/${t.token.address}` }, avatar(t.token), h('b', {}, t.token.symbol || short(t.token.address)), h('span', { class: 'mono' }, fmtPrice(t.priceUsd)), pct(t.change1h));
  // Two copies of the list scroll as one seamless loop; the copy is hidden from screen readers
  box.replaceChildren(h('div', { class: 'ticker-track' }, h('div', { class: 'ticker-group' }, rows.map(item)), h('div', { class: 'ticker-group', 'aria-hidden': 'true' }, rows.map(item))));
}

// ---------- search ----------

function setupSearch() {
  const input = $('#search');
  const results = $('#search-results');
  let timer;
  let seq = 0;
  const close = () => (results.hidden = true);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) return close();
    timer = setTimeout(async () => {
      const mine = ++seq;
      const rows = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => []);
      if (mine !== seq) return;
      results.replaceChildren(
        ...(rows.length
          ? rows.map((p) =>
              h(
                'a',
                { class: 'card', href: `#/token/${p.chain}/${p.token.address}`, onclick: () => ((input.value = ''), close()) },
                avatar(p.token),
                h('div', {}, h('div', { class: 'name' }, p.token.symbol || short(p.token.address), h('small', {}, p.token.name || '')), h('div', { class: 'meta' }, h('span', {}, chainInfo(p.chain)?.name || p.chain), p.liquidity ? h('span', {}, `Liq ${fmtCompact(p.liquidity)}`) : null)),
                h('div', { class: 'stats' }, p.priceUsd ? h('b', {}, fmtPrice(p.priceUsd)) : null, p.mcap ? h('span', {}, `MC ${fmtCompact(p.mcap)}`) : null),
              ),
            )
          : [h('div', { class: 'empty' }, 'No tokens found on our chains.')]),
      );
      results.hidden = false;
    }, 350);
  });
  input.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.addEventListener('click', (e) => !e.target.closest('.search') && close());
}

// ---------- login dialog ----------

const dialog = () => $('#login');

function openLogin({ link = false } = {}) {
  $('#login-title').textContent = link ? 'Link another login' : 'Log in to ApeX Pro';
  $('#login-lede').textContent = link
    ? 'Add a wallet, Google or Telegram to this account. Any of them will open the same account.'
    : 'No Telegram needed. New here? Logging in creates your account and your ApeX trading wallets.';
  $('#login-error').hidden = true;
  $('#login-bot').href = state.config.loginLink || '#';
  // No bot configured (ApeX Pro running alone): no Telegram login
  document.querySelector('.login-telegram').hidden = !state.config.loginLink;
  const google = $('#login-google');
  google.hidden = !state.config.googleEnabled;
  google.href = googleUrl();
  dialog().showModal();
}

async function finishLogin(promise) {
  const err = $('#login-error');
  err.hidden = true;
  try {
    const res = await promise;
    dialog().close();
    await refreshMe();
    loadBalances();
    toast(res?.created ? 'Welcome! Your ApeX wallets are ready: deposit to start trading.' : 'Logged in');
    route();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

function setupLogin() {
  for (const btn of document.querySelectorAll('[data-login]')) {
    btn.addEventListener('click', () => finishLogin(signInWithWallet(btn.dataset.login)));
  }
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault();
    finishLogin(telegramLogin($('#login-code').value));
  });
  document.addEventListener('apex:login', () => openLogin());
  document.addEventListener('apex:link', () => openLogin({ link: true }));
  // Views ask for fresh account data after trades, wallet changes or settings changes
  document.addEventListener('apex:refresh', () => refreshMe().then(loadBalances));
  document.addEventListener('apex:logout', () => refreshMe().then(route));
}

// ---------- router ----------

function route() {
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const found = ROUTES.find(([re]) => re.test(path)) || ROUTES[0];
  const [re, nav, view] = found;
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === nav);
  cleanup?.();
  const container = $('#view');
  container.replaceChildren();
  cleanup = view(container, path.match(re).slice(1), query) || null;
  if (path === '/login') {
    if (query.get('error')) toast(query.get('error') === 'google' ? 'Google sign-in was cancelled.' : query.get('error'), { kind: 'err' });
    if (!loggedIn()) openLogin();
  }
}

async function boot() {
  // Referral links to the web app: ?ref=<code>
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref) {
    try {
      localStorage.setItem('apex.ref', ref);
    } catch {}
  }
  state.config = await api('/api/config');
  renderChains();
  setupSearch();
  setupLogin();
  await refreshMe();
  loadBalances();
  setInterval(loadBalances, 30_000);
  setInterval(() => loggedIn() && api('/api/me').then((me) => ((state.me.unread = me.unread), renderAccount())).catch(() => {}), 45_000);
  loadTicker();
  setInterval(loadTicker, 60_000);
  on((event) => event === 'chain' && (renderAccount(), loadTicker(), route()));
  window.addEventListener('hashchange', route);
  route();
}

boot().catch((err) => {
  errorToast(err);
  $('#view').replaceChildren(h('div', { class: 'panel empty' }, 'ApeX Pro could not load. Is the server running?'));
});
