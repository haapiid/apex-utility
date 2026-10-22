import { h, svg, fmtNum, short, explorerAddress } from './lib.js';

// Bubble map of the biggest holders: bubble area = share of supply. On Solana, holders first funded by
// the same wallet are drawn in one colour and linked (likely one person behind several wallets).
const W = 640;
const H = 420;
const CLUSTER_COLORS = ['#F2C94C', '#3DD68C', '#6FA8FF', '#C084FC', '#F0616D', '#2DD4BF', '#F59E0B', '#F472B6'];
const LONE = '#3A3A33';

// Funders shared by 2+ holders (pools and programs left out) → cluster index
function clusters(list) {
  const byFunder = new Map();
  for (const x of list) {
    if (!x.funder || x.tags.includes('pool') || x.tags.includes('pool / program')) continue;
    byFunder.set(x.funder, [...(byFunder.get(x.funder) || []), x]);
  }
  return [...byFunder.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([funder, members]) => ({ funder, members, pct: members.reduce((s, m) => s + m.pct, 0) }))
    .sort((a, b) => b.pct - a.pct);
}

// Spiral placement: biggest bubble in the middle, each next one at the first free spot outward
function layout(items) {
  const max = Math.max(...items.map((x) => x.pct), 0.0001);
  const scale = 80 / Math.sqrt(max);
  const placed = [];
  for (const x of items) {
    const r = Math.max(5, Math.sqrt(x.pct) * scale);
    let spot = { x: W / 2, y: H / 2 };
    for (let t = 0; t < 4000; t++) {
      const angle = t * 0.35;
      const dist = t * 0.9;
      const cand = { x: W / 2 + Math.cos(angle) * dist, y: H / 2 + Math.sin(angle) * dist * 0.75 };
      if (placed.every((p) => Math.hypot(p.x - cand.x, p.y - cand.y) >= p.r + r + 2)) {
        spot = cand;
        break;
      }
    }
    placed.push({ ...x, ...spot, r });
  }
  return placed;
}

export function bubbleMap(chainKey, { list, source }) {
  const items = list.filter((x) => x.pct > 0).slice(0, 100);
  if (!items.length) return h('div', { class: 'empty' }, 'No holder data for this token.');
  const groups = clusters(items);
  const colorOf = new Map();
  groups.forEach((g, i) => g.members.forEach((m) => colorOf.set(m.address, CLUSTER_COLORS[i % CLUSTER_COLORS.length])));
  const placed = layout(items);
  const at = new Map(placed.map((p) => [p.address, p]));

  const links = groups.flatMap((g, i) => {
    const lead = at.get(g.members[0].address);
    return g.members.slice(1).map((m) => {
      const p = at.get(m.address);
      return svg('line', { x1: lead.x, y1: lead.y, x2: p.x, y2: p.y, stroke: CLUSTER_COLORS[i % CLUSTER_COLORS.length], 'stroke-width': 1.5, 'stroke-opacity': 0.55 });
    });
  });
  const bubbles = placed.map((p) => {
    const pool = p.tags.some((t) => t.startsWith('pool'));
    const dev = p.tags.includes('dev');
    const fill = pool ? 'none' : colorOf.get(p.address) || LONE;
    const tip = `${p.address}\n${fmtNum(p.pct, 2)}% of supply${p.tags.length ? `\n${p.tags.join(', ')}` : ''}${p.funder ? `\nfunded by ${short(p.funder, 5)}` : ''}`;
    return svg(
      'a',
      { href: explorerAddress(chainKey, p.address), target: '_blank', rel: 'noopener' },
      svg(
        'circle',
        {
          cx: p.x.toFixed(1),
          cy: p.y.toFixed(1),
          r: p.r.toFixed(1),
          fill,
          'fill-opacity': pool ? 0 : 0.85,
          stroke: dev ? '#F0616D' : pool ? '#9A958A' : '#0E0E0C',
          'stroke-width': dev ? 3 : 1.5,
          'stroke-dasharray': pool ? '4 3' : null,
          class: 'bubble',
        },
        svg('title', {}, tip),
      ),
      p.r > 16 ? svg('text', { x: p.x.toFixed(1), y: (p.y + 4).toFixed(1), 'text-anchor': 'middle', class: 'bubble-label' }, `${fmtNum(p.pct, 1)}%`) : null,
    );
  });

  const legend = groups.length
    ? groups.slice(0, 8).map((g, i) =>
        h('div', { class: 'legend-row' }, h('span', { class: `dot dot-${i % CLUSTER_COLORS.length}` }), `${g.members.length} wallets hold ${fmtNum(g.pct, 2)}%`, h('span', { class: 'muted mono' }, ` funded by ${short(g.funder, 5)}`)),
      )
    : [h('div', { class: 'fine' }, list.some((x) => x.funder) ? 'No linked wallets among the top holders.' : 'Wallet links are only available for Solana tokens.')];

  return h(
    'div',
    { class: 'bubble-wrap' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'bubble-map', role: 'img', 'aria-label': 'Holder bubble map' }, links, bubbles),
    h(
      'div',
      { class: 'bubble-legend' },
      legend,
      h('div', { class: 'fine' }, `Bubble size = share of supply · dashed = pool · red ring = dev · ${items.length} biggest holders · ${source}`),
    ),
  );
}
