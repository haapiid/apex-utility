import { h, api, state, chainInfo, loggedIn, fromUnits, fmtNum, short, ago, panel, empty, loginRequired, toast, errorToast, explorerAddress } from '../lib.js';

// Wallet tracker: follow any wallet's trades (without copying them), with an optional message per trade.
// Checked every ~15 s; the feed keeps 7 days.

// Solana symbols for the feed (Jupiter, via /api/metrics); EVM tokens show their address
const symbols = new Map();
async function resolveSymbols(events) {
  const missing = [...new Set(events.filter((e) => chainInfo(e.chain)?.kind === 'sol' && !symbols.has(e.token)).map((e) => e.token))].slice(0, 100);
  if (!missing.length) return;
  const found = await api(`/api/metrics?chain=sol&tokens=${missing.join(',')}`).catch(() => ({}));
  for (const t of missing) symbols.set(t, found[t]?.symbol || null);
}

export function trackerFeed(events) {
  if (!events.length) return empty('No trades yet. New trades of your tracked wallets show up here within ~15 seconds.');
  return h(
    'div',
    { class: 'feed' },
    events.map((e) => {
      const c = chainInfo(e.chain);
      const amount = e.token_amount != null && e.decimals != null ? `${fmtNum(fromUnits(e.token_amount, e.decimals), 2)} ` : '';
      const value = e.native != null ? ` for ${fmtNum(fromUnits(e.native, c?.decimals ?? 18), 4)} ${c?.native || ''}` : '';
      return h(
        'div',
        { class: 'line-item' },
        h(
          'div',
          { class: 'grow' },
          h('b', {}, e.label),
          h('span', { class: e.side === 'buy' ? 'up' : 'down' }, e.side === 'buy' ? ' bought ' : ' sold '),
          amount,
          h('a', { href: `#/token/${e.chain}/${e.token}`, class: 'up' }, symbols.get(e.token) ? `$${symbols.get(e.token)}` : short(e.token, 5)),
          value,
          h('div', { class: 'fine' }, `${c?.name || e.chain} · ${ago(e.at)} ago`),
        ),
        h('a', { href: `${c?.txExplorer || ''}${e.ref}`, target: '_blank', rel: 'noopener', class: 'btn btn-sm btn-ghost', title: 'View transaction' }, '↗'),
      );
    }),
  );
}

export default function tracker(container) {
  if (!loggedIn()) return loginRequired(container, 'your tracked wallets');
  const walletsBox = h('div', { class: 'panel-body' });
  const feedBox = h('div', { class: 'panel-body feed-list tall' }, h('div', { class: 'skeleton' }));
  let filter = '';

  const chain = h('select', { class: 'input' }, state.config.chains.map((c) => h('option', { value: c.key, selected: c.key === state.chain }, c.name)));
  const address = h('input', { class: 'input mono', placeholder: 'Wallet address', spellcheck: 'false' });
  const label = h('input', { class: 'input', placeholder: 'Name (optional)', maxlength: '24' });
  const form = h(
    'form',
    {
      class: 'panel-body stack divided',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/tracker', { method: 'POST', body: { chain: chain.value, address: address.value.trim(), label: label.value } });
          toast('Tracking this wallet 👁 New trades from now on show up here.');
          address.value = '';
          label.value = '';
          load();
        } catch (err) {
          errorToast(err);
        }
      },
    },
    h('div', { class: 'row wrap' }, h('label', { class: 'field' }, 'Chain', chain), h('label', { class: 'field grow' }, 'Name', label)),
    h('label', { class: 'field' }, 'Wallet', address),
    h('button', { class: 'btn btn-yellow', type: 'submit' }, 'Track wallet'),
  );

  container.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Wallet tracker'), h('p', { class: 'fine' }, 'Watch any wallet’s buys and sells. Nothing is copied: use Copy trading in Orders for that.')),
    h('div', { class: 'tracker-grid' }, panel('Tracked wallets', h('div', {}, walletsBox, form)), panel('Live feed', feedBox)),
  );

  const update = async (id, body) => (await api(`/api/tracker/${id}`, { method: 'POST', body }).catch(errorToast), load());

  async function load() {
    try {
      const data = await api(`/api/tracker${filter ? `?wallet=${filter}` : ''}`);
      await resolveSymbols(data.events);
      walletsBox.replaceChildren(
        ...(data.wallets.length
          ? [
              filter ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => ((filter = ''), load()) }, '← All wallets') : null,
              ...data.wallets.map((w) =>
                h(
                  'div',
                  { class: `line-item${String(w.id) === filter ? ' selected' : ''}` },
                  h(
                    'button',
                    { class: 'plain grow', type: 'button', title: 'Show only this wallet', onclick: () => ((filter = String(w.id)), load()) },
                    h('b', {}, w.label),
                    h('div', { class: 'fine mono' }, `${chainInfo(w.chain)?.name || w.chain} · ${short(w.address, 5)}`),
                  ),
                  h(
                    'div',
                    { class: 'row' },
                    h('a', { class: 'btn btn-sm btn-ghost', href: explorerAddress(w.chain, w.address), target: '_blank', rel: 'noopener', title: 'Open in explorer' }, '↗'),
                    h('button', { class: 'btn btn-sm', type: 'button', title: 'Message me on every trade', onclick: () => update(w.id, { notify: !w.notify }) }, w.notify ? '🔔 On' : '🔕 Off'),
                    h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => confirm(`Stop tracking ${w.label}?`) && update(w.id, { remove: true }) }, 'Remove'),
                  ),
                ),
              ),
            ].filter(Boolean) // replaceChildren() would print null as text
          : [empty('No wallets tracked yet.')]),
      );
      feedBox.replaceChildren(trackerFeed(data.events));
    } catch (err) {
      errorToast(err);
    }
  }
  load();
  const timer = setInterval(load, 15_000);
  return () => clearInterval(timer);
}
