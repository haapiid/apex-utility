// Shared helpers for ApeX Pro. Everything is built with h(), which only ever sets text (never HTML), so
// token names and other data from third-party APIs can't inject markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

// ---------- API ----------

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-apex': '1' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  return data;
}

// ---------- shared state ----------

export const state = {
  config: null,
  me: null, // { user, wallets, settings, ... } or { user: null }
  chain: localStorage.getItem('apex.chain') || 'sol',
  listeners: new Set(),
};

export function setChain(key) {
  state.chain = key;
  try {
    localStorage.setItem('apex.chain', key);
  } catch {}
  emit('chain');
}

export const on = (fn) => (state.listeners.add(fn), () => state.listeners.delete(fn));
export const emit = (event) => state.listeners.forEach((fn) => fn(event));
export const chainInfo = (key = state.chain) => state.config?.chains.find((c) => c.key === key);
export const loggedIn = () => Boolean(state.me?.user);

// ---------- formatting ----------

// Raw integer string → decimal string (exact, via BigInt)
export function fromUnits(raw, decimals) {
  if (raw == null) return '0';
  const value = BigInt(raw);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

export function fmtNum(n, max = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '–';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(v);
}

export function fmtCompact(n, prefix = '$') {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return v === 0 ? `${prefix}0` : '–';
  return prefix + new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v);
}

// Prices of memecoins can be tiny: keep ~4 significant digits
export function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '–';
  if (v >= 1) return `$${fmtNum(v, 4)}`;
  const decimals = Math.min(14, 3 - Math.floor(Math.log10(v)));
  return `$${v.toFixed(decimals)}`;
}

export function pct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return h('span', { class: 'muted' }, '–');
  return h('span', { class: v >= 0 ? 'up' : 'down' }, `${v >= 0 ? '+' : ''}${fmtNum(v, 2)}%`);
}

export function ago(ms) {
  if (!ms) return '–';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '–');
export const native = (raw, chain, max = 6) => `${fmtNum(fromUnits(raw, chain.decimals), max)} ${chain.native}`;

// ---------- UI bits ----------

export function toast(message, { kind = 'ok', link, linkText = 'View transaction', timeout = 7000 } = {}) {
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, message, link ? [' ', h('a', { href: link, target: '_blank', rel: 'noopener' }, linkText)] : null);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

export const errorToast = (err) => toast(err.message || 'Something went wrong', { kind: 'err' });

export function avatar(token) {
  const letter = (token?.symbol || '?').slice(0, 1).toUpperCase();
  if (!token?.image) return h('span', { class: 'avatar' }, letter);
  const img = h('img', { src: token.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const box = h('span', { class: 'avatar' }, img);
  img.addEventListener('error', () => box.replaceChildren(letter));
  return box;
}

export function copyButton(text, label = 'Copy') {
  return h(
    'button',
    {
      class: 'copy',
      type: 'button',
      title: label,
      'aria-label': label,
      onclick: async (e) => {
        e.stopPropagation();
        await navigator.clipboard?.writeText(text);
        toast('Copied', { timeout: 1500 });
      },
    },
    '⧉',
  );
}

export const panel = (title, body, actions) =>
  h('section', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', {}, title), actions || null), body);

export const empty = (text) => h('div', { class: 'empty' }, text);

// Plain text of the bot's HTML notifications (rendered as text, never as HTML)
export function plainText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const link = doc.querySelector('a[href^="https://"]')?.getAttribute('href') || null;
  return { text: doc.body.textContent.trim(), link };
}

export function loginRequired(container, what = 'this') {
  container.replaceChildren(
    h(
      'div',
      { class: 'panel empty' },
      h('p', {}, `Log in to see ${what}.`),
      h('button', { class: 'btn btn-yellow', type: 'button', onclick: () => document.dispatchEvent(new Event('apex:login')) }, 'Log in'),
    ),
  );
}

// SVG elements (bubble map). Same rule as h(): attributes and text only, never markup.
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const explorerAddress = (chainKey, address) => `${chainInfo(chainKey)?.explorer || ''}${address}`;

// Asks for the security PIN when the account has one: resolves to the PIN, '' without a PIN, or null if cancelled
export function askPin(reason = 'Enter your security PIN') {
  if (!state.me?.hasPin) return Promise.resolve('');
  return new Promise((resolve) => {
    const input = h('input', { class: 'input mono pin-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', 'aria-label': 'Security PIN' });
    const dialog = h(
      'dialog',
      { class: 'modal' },
      h(
        'form',
        // method=dialog closes with the submit button's value as returnValue
        { method: 'dialog', class: 'stack' },
        h('h2', {}, '🔒 Security PIN'),
        h('p', {}, reason),
        input,
        h('div', { class: 'row' }, h('button', { class: 'btn btn-yellow grow', type: 'submit', value: 'ok' }, 'Continue'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close('cancel') }, 'Cancel')),
      ),
    );
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'ok' ? input.value.trim() : null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}

// Holders · top 10 · dev · bundled · snipers, flagged when they look risky
const RISK = { top10Pct: 30, devPct: 5, bundledPct: 20, sniperPct: 10 };
const pctText = (v) => (v == null ? '–' : `${fmtNum(v, v < 1 ? 2 : 1)}%`);
export function metricChips(m, { compact = false } = {}) {
  if (!m) return [];
  // Full: "Top 10 78.3%" with a label; compact: "T10 78.3%"
  const chip = (label, tag, value, title, risky) => h('span', { class: `metric${risky ? ' risky' : ''}`, title }, h('i', {}, compact ? tag : label), value);
  return [
    chip('Holders', '👥', m.holders == null ? '–' : fmtCompact(m.holders, ''), 'Holders'),
    chip('Top 10', 'T10', pctText(m.top10Pct), 'Share held by the 10 biggest holders (pools excluded)', m.top10Pct > RISK.top10Pct),
    chip('Dev', 'DEV', pctText(m.devPct), 'Share the creator still holds', m.devPct > RISK.devPct),
    chip('Bundled', 'BND', pctText(m.bundledPct), 'Bought by wallets in the launch block, dev included (Solana)', m.bundledPct > RISK.bundledPct),
    chip('Snipers', '🎯', m.snipers == null ? '–' : m.snipers, `Wallets that bought in the first ~3 blocks${m.sniperPct != null ? `: ${pctText(m.sniperPct)} of supply` : ''} (Solana)`, m.sniperPct > RISK.sniperPct),
  ];
}
