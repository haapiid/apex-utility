import { h, api, chainInfo, fmtNum, native, short, empty, copyButton } from '../lib.js';

// Public fee & pool dashboard: where every fee went, from ApeX's own books, plus the treasury and
// rewards wallets so anyone can check the balances on an explorer. Aggregates only.

const REFRESH_MS = 60_000;
const pctOf = (bps) => `${fmtNum(bps / 100, 2)}%`;
const usd = (n) => `$${fmtNum(n, 2)}`;
const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function until(ms) {
  const left = Math.max(0, ms - Date.now());
  const hrs = Math.floor(left / 3_600_000);
  const min = Math.floor((left % 3_600_000) / 60_000);
  return hrs ? `${hrs}h ${min}m` : `${min}m`;
}

export default function transparency(container) {
  const body = h('div', { class: 'stack-lg' }, h('div', { class: 'skeleton spaced' }), h('div', { class: 'skeleton spaced' }));
  container.append(
    h(
      'div',
      { class: 'page-head' },
      h('h1', {}, 'Fees & pools'),
      h('p', { class: 'fine' }, 'Live from ApeX’s own books, updated every minute. Totals only, nothing about any single user.'),
    ),
    body,
  );

  let alive = true;
  async function load() {
    try {
      const d = await api('/api/transparency');
      if (alive) body.replaceChildren(...render(d));
    } catch {
      if (alive && !body.querySelector('table')) body.replaceChildren(h('div', { class: 'panel empty' }, 'Could not load the numbers. Try again in a minute.'));
    }
  }
  load();
  const timer = setInterval(load, REFRESH_MS);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

function render(d) {
  const chains = d.chains.map((c) => ({ ...c, info: chainInfo(c.chain) })).filter((c) => c.info);
  const fee = (c, v) => (c.feeUnit === 'SOL' ? `${fmtNum(v, 4)} SOL` : usd(v));
  const vol = (c, v) => (c.feeUnit === 'SOL' ? `${fmtNum(v, 2)} SOL` : usd(v));

  // ---------- how a fee is split ----------
  const split = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'How a fee is split')),
    h(
      'div',
      { class: 'panel-body grid' },
      h('div', { class: 'stat' }, h('span', {}, 'Trading fee'), h('b', {}, `${pctOf(d.fees.manualBps)} / ${pctOf(d.fees.snipeBps)}`), h('p', { class: 'fine' }, `Manual, limit, DCA and copy trades ${pctOf(d.fees.autoBps)}; snipes ${pctOf(d.fees.snipeBps)}.`)),
      h('div', { class: 'stat' }, h('span', {}, 'Referral'), h('b', {}, pctOf(d.split.referralBps)), h('p', { class: 'fine' }, 'Of the fee, to whoever invited the trader, in the coin of the trade.')),
      h('div', { class: 'stat' }, h('span', {}, '$APEX holders'), h('b', {}, pctOf(d.split.holderBps)), h('p', { class: 'fine' }, `Of the rest, into the holder pool. Paid every ${d.epochHours} h to holders of at least ${fmtNum(d.minHold, 0)} $APEX.`)),
      h('div', { class: 'stat' }, h('span', {}, 'Next distribution'), h('b', {}, d.apexLive ? until(d.nextEpochAt) : 'After launch'), h('p', { class: 'fine' }, d.apexLive ? when(d.nextEpochAt) : '$APEX hasn’t launched yet. The pools keep filling until it does.')),
    ),
  );

  // ---------- per chain ----------
  const perChain = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Fees and pools per chain')),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', {}, 'Chain'),
            h('th', { class: 'num' }, 'Fees 24h'),
            h('th', { class: 'num' }, 'Fees 30d'),
            h('th', { class: 'num' }, 'Fees all time'),
            h('th', { class: 'num' }, 'Volume all time'),
            h('th', { class: 'num' }, 'Trades'),
            h('th', { class: 'num', title: 'Earned by referrers' }, 'Referral'),
            h('th', { class: 'num', title: 'Waiting for the next distribution' }, 'Holder pool'),
            h('th', { class: 'num' }, 'Distributed'),
            h('th', { class: 'num', title: 'Referral and revenue rewards paid out' }, 'Claimed'),
          ),
        ),
        h(
          'tbody',
          {},
          chains.map((c) =>
            h(
              'tr',
              {},
              h('td', {}, h('b', {}, c.info.name)),
              h('td', { class: 'num' }, fee(c, c.day.fees)),
              h('td', { class: 'num' }, fee(c, c.month.fees)),
              h('td', { class: 'num' }, fee(c, c.all.fees)),
              h('td', { class: 'num' }, vol(c, c.all.volume)),
              h('td', { class: 'num' }, fmtNum(c.all.trades, 0)),
              h('td', { class: 'num' }, native(c.referral, c.info)),
              h('td', { class: 'num' }, native(c.pool, c.info)),
              h('td', { class: 'num' }, native(c.distributed, c.info)),
              h('td', { class: 'num' }, native(c.claimed, c.info)),
            ),
          ),
        ),
      ),
    ),
    h('p', { class: 'panel-body fine' }, `Solana fees are counted in SOL, EVM fees in USD at the time of the trade. Cashback in $APEX: ${usd(d.cashback.earnedUsd)} earned, ${usd(d.cashback.claimedUsd)} claimed.`),
  );

  // ---------- wallets anyone can check ----------
  const walletCell = (c, address, balance) =>
    address
      ? h(
          'td',
          {},
          h('div', { class: 'row' }, h('a', { class: 'mono', href: `${c.explorer}${address}`, target: '_blank', rel: 'noopener' }, short(address, 6)), copyButton(address)),
          h('div', { class: 'fine' }, balance == null ? 'balance unavailable' : native(balance, c.info, 4)),
        )
      : h('td', { class: 'fine' }, 'Not set up yet');
  const wallets = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Wallets you can check')),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Chain'), h('th', {}, 'Treasury (receives fees)'), h('th', {}, 'Rewards wallet (pays claims)'))),
        h(
          'tbody',
          {},
          chains.map((c) => h('tr', {}, h('td', {}, h('b', {}, c.info.name)), walletCell(c, c.treasury, c.treasuryBalance), walletCell(c, c.rewardsWallet, c.rewardsBalance))),
        ),
      ),
    ),
  );

  // ---------- past distributions ----------
  const epochs = h(
    'section',
    { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', {}, 'Recent distributions')),
    d.epochs.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Chain'), h('th', { class: 'num' }, 'Paid to holders'), h('th', { class: 'num' }, 'Holders'))),
            h(
              'tbody',
              {},
              d.epochs.map((e) => {
                const info = chainInfo(e.chain);
                return h('tr', {}, h('td', {}, when(e.at)), h('td', {}, info?.name || e.chain), h('td', { class: 'num' }, info ? native(e.amount, info) : e.amount), h('td', { class: 'num' }, fmtNum(e.holders, 0)));
              }),
            ),
          ),
        )
      : empty('No distribution yet. The first one runs after $APEX launches.'),
  );

  return [split, perChain, wallets, epochs, h('p', { class: 'fine' }, `Updated ${when(d.at)}.`)];
}
