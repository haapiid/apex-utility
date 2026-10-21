import { h, api, state, chainInfo, loggedIn, fromUnits, fmtNum, native, copyButton, panel, empty, loginRequired, toast, errorToast } from '../lib.js';

// Rewards dashboard: claim referral + revenue share per chain (gas paid by ApeX), cashback, referral
// links, revenue share pools, burn credits
const countdown = (at) => {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
};
const usd = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);

export default function rewards(container) {
  if (!loggedIn()) return loginRequired(container, 'your rewards');
  const body = h('div', { class: 'grid' }, h('div', { class: 'skeleton' }));
  container.append(h('div', { class: 'page-head' }, h('h1', {}, 'Rewards'), h('p', { class: 'fine' }, 'Claims are sent from the ApeX rewards wallet: you pay no gas.')), body);

  async function claim(chainKey, btn) {
    btn.disabled = true;
    try {
      const res = await api('/api/rewards/claim', { method: 'POST', body: { chain: chainKey } });
      toast(`Claimed ${native(res.amount, chainInfo(res.chain), 8)} ✅`, { link: res.txUrl });
      load();
    } catch (err) {
      errorToast(err);
      btn.disabled = false;
    }
  }

  async function load() {
    let d;
    try {
      d = await api('/api/rewards');
    } catch (err) {
      return errorToast(err);
    }
    const claimRows = state.config.chains
      .map((c) => [c, d.balances[c.key]])
      .filter(([, b]) => b && (b.available !== '0' || b.claimed !== '0'))
      .map(([c, b]) => {
        const btn = h('button', { class: 'btn btn-sm btn-yellow', type: 'button', disabled: b.available === '0', onclick: (e) => claim(c.key, e.currentTarget) }, 'Claim');
        return h(
          'div',
          { class: 'line-item' },
          h('div', {}, h('b', {}, native(b.available, c, 8)), h('div', { class: 'fine' }, `${c.name} · referral ${native(b.referral, c, 6)} · revenue ${native(b.revenue, c, 6)} · min ${c.claimMin} ${c.native}`)),
          btn,
        );
      });

    const cashbackBtn = h(
      'button',
      {
        class: 'btn btn-sm btn-yellow',
        type: 'button',
        disabled: !d.apexLive || d.cashback.availableUsd < 1,
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            const res = await api('/api/rewards/cashback', { method: 'POST' });
            toast(`Claimed ${fmtNum(fromUnits(res.amount, res.decimals), 4)} $APEX ✅`, { link: res.txUrl });
            load();
          } catch (err) {
            errorToast(err);
          }
        },
      },
      'Claim',
    );

    const pools = Object.entries(d.pools)
      .filter(([, v]) => v !== '0')
      .map(([k, v]) => h('div', { class: 'line-item' }, h('span', {}, chainInfo(k)?.name || k), h('b', { class: 'mono' }, native(v, chainInfo(k), 6))));

    const ref = d.referral;
    body.replaceChildren(
      panel('Claimable', h('div', { class: 'panel-body' }, claimRows.length ? claimRows : empty('Nothing to claim yet. Invite friends or hold $APEX to earn.'))),
      panel(
        'Cashback',
        h(
          'div',
          { class: 'panel-body stack' },
          h('div', { class: 'line-item' }, h('div', { class: 'stat' }, h('span', {}, 'Available'), h('b', {}, usd(d.cashback.availableUsd))), cashbackBtn),
          h('p', { class: 'fine' }, d.apexLive ? 'Paid in $APEX at the current price, from $1.' : '$APEX has not launched yet. Your cashback keeps adding up and can be claimed once it does.'),
        ),
      ),
      panel(
        'Referral',
        h(
          'div',
          { class: 'panel-body stack' },
          h('p', {}, `Earn ${fmtNum(ref.shareBps / 100, 2)}% of the trading fees of everyone you invite, forever, paid in the coin they trade.`),
          h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', { class: 'fine' }, 'Web link'), h('div', { class: 'mono break' }, ref.webLink)), copyButton(ref.webLink, 'Copy web link')),
          ref.link ? h('div', { class: 'line-item' }, h('div', { class: 'grow' }, h('div', { class: 'fine' }, 'Telegram bot link'), h('div', { class: 'mono break' }, ref.link)), copyButton(ref.link, 'Copy bot link')) : null,
          h('div', { class: 'row' }, h('div', { class: 'stat grow' }, h('span', {}, 'Invited'), h('b', {}, ref.invited))),
        ),
      ),
      panel(
        'Revenue share',
        h(
          'div',
          { class: 'panel-body stack' },
          h('p', {}, `${fmtNum(d.revenueShareBps / 100, 2)}% of fees (after referrals) go to $APEX holders with ${d.minHold}+ tokens in their ApeX wallets, every ${d.epochHours}h.`),
          h('div', { class: 'stat' }, h('span', {}, 'Next distribution'), h('b', {}, countdown(d.nextEpochAt))),
          pools.length ? h('div', {}, h('div', { class: 'fine' }, 'Holder pool waiting'), pools) : h('p', { class: 'fine' }, 'The holder pool is empty so far.'),
        ),
      ),
      panel(
        'Credits',
        h(
          'div',
          { class: 'panel-body stack' },
          h('div', { class: 'row' }, h('div', { class: 'stat grow' }, h('span', {}, 'Credits'), h('b', {}, d.credits.credits)), h('div', { class: 'stat grow' }, h('span', {}, 'Extra wallet slots'), h('b', {}, d.credits.extra_wallet_slots))),
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: async () => {
                try {
                  await api('/api/rewards/slot', { method: 'POST' });
                  toast('Extra wallet slot unlocked');
                  load();
                  document.dispatchEvent(new Event('apex:refresh'));
                } catch (err) {
                  errorToast(err);
                }
              },
            },
            `Unlock a wallet slot (${d.slotCost} credits)`,
          ),
          h('p', { class: 'fine' }, 'Burn $APEX in the Telegram bot (/rewards) to earn credits.'),
        ),
      ),
    );
  }
  load();
  const timer = setInterval(load, 60_000);
  return () => clearInterval(timer);
}
