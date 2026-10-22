import { h, api, state, loggedIn, fmtNum, short, ago, panel, empty, toast, errorToast } from '../lib.js';

// pump.fun sniper: live launches / migrations from the feed (public) and the user's standing rules
const STATUS = { bought: ['✅', 'up'], skipped: ['⏭', 'muted'], failed: ['❌', 'down'] };
const tokenLink = (mint, text) => h('a', { href: `#/token/sol/${mint}`, class: 'up' }, text);

export default function pump(container) {
  const live = { launches: h('div', { class: 'panel-body feed-list' }), migrations: h('div', { class: 'panel-body feed-list' }) };
  const feedState = h('span', { class: 'fine' }, 'Connecting…');
  const rulesList = h('div', { class: 'panel-body' });
  const recentList = h('div', { class: 'panel-body' });

  // --- rule form ---
  const mode = h('select', { class: 'input' }, h('option', { value: 'launch' }, '🚀 New launches'), h('option', { value: 'migration' }, '🎓 Migrations'));
  const amount = h('input', { class: 'input mono', inputmode: 'decimal', value: '0.05' });
  const maxBuys = h('input', { class: 'input mono', inputmode: 'numeric', value: '5' });
  const keyword = h('input', { class: 'input', placeholder: 'optional, e.g. cat', maxlength: '32' });
  const maxDev = h('input', { class: 'input mono', inputmode: 'decimal', placeholder: 'optional, e.g. 10' });
  const safety = h('input', { type: 'checkbox', checked: true });
  const launchOnly = h('div', { class: 'row wrap' }, h('label', { class: 'field grow' }, 'Name / symbol contains', keyword), h('label', { class: 'field grow' }, 'Max dev buy %', maxDev));
  mode.addEventListener('change', () => (launchOnly.hidden = mode.value !== 'launch'));

  const form = h(
    'form',
    {
      class: 'stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/pump', {
            method: 'POST',
            body: { mode: mode.value, amount: amount.value, maxBuys: Number(maxBuys.value), keyword: keyword.value, maxDevPct: maxDev.value, safety: safety.checked },
          });
          toast('Rule armed 💊 You get a notification for every buy.');
          loadMine();
        } catch (err) {
          errorToast(err);
        }
      },
    },
    h('div', { class: 'row wrap' }, h('label', { class: 'field grow' }, 'Buy', mode), h('label', { class: 'field grow' }, 'SOL per buy', amount), h('label', { class: 'field grow' }, 'Max buys', maxBuys)),
    launchOnly,
    h('label', { class: 'row fine' }, safety, 'Safety filter: skip freeze authority and transfer fees'),
    h('p', { class: 'fine' }, 'Budget = SOL per buy × max buys. Most new launches go to zero: keep amounts small.'),
    h('button', { class: 'btn btn-yellow', type: 'submit' }, `Arm rule (fee ${fmtNum((state.config?.fees.snipeBps ?? 100) / 100, 2)}% per buy)`),
  );

  const formBox = h('div', { class: 'panel-body divided' }, form);

  container.append(
    h(
      'div',
      { class: 'page-head' },
      h('div', {}, h('h1', {}, 'pump.fun sniper'), h('p', { class: 'fine' }, 'Auto-buy new pump.fun launches, or tokens the moment they migrate to PumpSwap. Runs while this page is closed.')),
      feedState,
    ),
    h(
      'div',
      { class: 'grid' },
      panel('🚀 New launches', live.launches),
      panel('🎓 Migrations', live.migrations),
      panel('Your rules', h('div', {}, rulesList, formBox)),
      panel('Recent snipes', recentList),
    ),
  );

  const stopBtn = (id) =>
    h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => (await api(`/api/cancel/pump/${id}`, { method: 'POST' }).catch(errorToast), loadMine()) }, 'Stop');

  async function loadLive() {
    try {
      const data = await api('/api/pump/live');
      feedState.textContent = data.connected ? '🟢 Live feed' : '🟡 Connecting to the feed…';
      live.launches.replaceChildren(
        ...(data.launches.length
          ? data.launches.map((t) =>
              h(
                'div',
                { class: 'line-item' },
                h('div', { class: 'grow' }, tokenLink(t.mint, `$${t.symbol || '?'}`), ' ', h('span', { class: 'muted' }, t.name), h('div', { class: 'fine mono' }, `${short(t.mint, 5)} · dev bought ${fmtNum(t.devBuyPct, 1)}%`)),
                h('span', { class: 'fine' }, ago(t.at)),
              ),
            )
          : [empty('Waiting for the next launch…')]),
      );
      live.migrations.replaceChildren(
        ...(data.migrations.length
          ? data.migrations.map((m) => h('div', { class: 'line-item' }, h('div', { class: 'grow mono' }, tokenLink(m.mint, short(m.mint, 6))), h('span', { class: 'fine' }, ago(m.at))))
          : [empty('No migrations seen yet. Tokens graduate a few times an hour.')]),
      );
    } catch {
      feedState.textContent = '🔴 Feed unavailable';
    }
  }

  async function loadMine() {
    if (!loggedIn()) {
      rulesList.replaceChildren(empty('Log in to arm rules.'));
      recentList.replaceChildren(empty('Log in to see your snipes.'));
      formBox.hidden = true;
      return;
    }
    formBox.hidden = false;
    try {
      const data = await api('/api/pump');
      rulesList.replaceChildren(
        ...(data.rules.length
          ? data.rules.map((r) => {
              const filters = [r.keyword && `name has “${r.keyword}”`, r.max_dev_pct != null && `dev ≤ ${r.max_dev_pct}%`, !r.safety && 'safety off'].filter(Boolean);
              return h(
                'div',
                { class: 'line-item' },
                h('div', {}, h('b', {}, r.mode === 'launch' ? '🚀 New launches' : '🎓 Migrations'), h('div', { class: 'fine' }, `${r.amount} SOL each · ${r.buys_done}/${r.max_buys} bought${filters.length ? ` · ${filters.join(', ')}` : ''}`)),
                stopBtn(r.id),
              );
            })
          : [empty('No rules yet.')]),
      );
      recentList.replaceChildren(
        ...(data.recent.length
          ? data.recent.map((b) => {
              const [icon, cls] = STATUS[b.status] || ['•', 'muted'];
              return h(
                'div',
                { class: 'line-item' },
                h('div', { class: 'grow' }, h('span', { class: cls }, `${icon} `), tokenLink(b.mint, b.symbol ? `$${b.symbol}` : short(b.mint, 5)), b.status === 'bought' ? null : h('div', { class: 'fine' }, b.error || b.status)),
                h('span', { class: 'fine' }, ago(b.at)),
              );
            })
          : [empty('Nothing bought or skipped yet.')]),
      );
    } catch (err) {
      errorToast(err);
    }
  }

  loadLive();
  loadMine();
  const timers = [setInterval(loadLive, 3_000), setInterval(loadMine, 15_000)];
  return () => timers.forEach(clearInterval);
}
