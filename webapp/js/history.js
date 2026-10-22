import { h, chainInfo, fmtNum, short, ago } from './lib.js';

// The user's own trades, shared by the token page (My trades) and Positions (History)
const SOURCE_LABEL = { manual: 'Manual', snipe: 'Snipe', limit: 'Limit', dca: 'DCA', copy: 'Copy', antirug: 'Anti-rug' };

// rows: [{ at, chain, side, source, symbol, token, native, usd, wallet, txUrl }]
export function historyTable(rows) {
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Type'), h('th', {}, 'Token'), h('th', { class: 'num' }, 'Amount'), h('th', {}, 'Via'), h('th', {}, 'Wallet'), h('th', {}, 'Tx'))),
    h(
      'tbody',
      {},
      rows.map((t) => {
        const c = chainInfo(t.chain);
        return h(
          'tr',
          {},
          h('td', { class: 'muted', title: new Date(t.at).toLocaleString() }, `${ago(t.at)} ago`),
          h('td', { class: t.side === 'buy' ? 'up' : 'down' }, t.side.toUpperCase()),
          h('td', {}, h('a', { href: `#/token/${t.chain}/${t.token}` }, h('b', {}, t.symbol || short(t.token))), h('span', { class: 'muted' }, ` ${c?.name || t.chain}`)),
          h('td', { class: 'num' }, t.native ? `${fmtNum(t.native, 6)} ${c?.native || ''}` : t.usd ? `$${fmtNum(t.usd, 2)}` : '–'),
          h('td', { class: 'muted' }, SOURCE_LABEL[t.source] || t.source),
          h('td', { class: 'muted' }, t.wallet?.label || '–'),
          h('td', {}, t.txUrl ? h('a', { href: t.txUrl, target: '_blank', rel: 'noopener', class: 'up' }, '↗') : '–'),
        );
      }),
    ),
  );
}
