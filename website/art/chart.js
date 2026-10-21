// Builds the trading chart for "Where your 0.5% goes": rising candles and a trend line in the brand
// palette (yellow up candles, muted down candles on the black section). Deterministic: the same seed always
// draws the same chart. The top-right corner is left clear for the mascot riding a rocket.
//   node chart.js  → chart.svg (preview on black) + chart.inline.svg (pasted into index.html)
const W = 1060;
const H = 340;
const C = { up: '#F2C94C', down: '#5F5B51', line: '#F7DC86', grid: '#26261F', area: '#F2C94C' };

// Small seeded PRNG (mulberry32)
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(7);
const N = 22;
const candles = [];
let price = 100;
for (let i = 0; i < N; i++) {
  const open = price;
  // Mostly up with a few pullbacks; the last stretch accelerates like a breakout
  const drift = i > N - 7 ? 6 : 2.2;
  const pullback = rand() < 0.28 && i < N - 4;
  const close = open + (pullback ? -(2 + rand() * 6) : drift + rand() * 6);
  const high = Math.max(open, close) + rand() * 4;
  const low = Math.min(open, close) - rand() * 4;
  candles.push({ open, close, high, low });
  price = close;
}

const min = Math.min(...candles.map((c) => c.low));
const max = Math.max(...candles.map((c) => c.high));
const PAD_T = 110; // headroom: the trend line climbs on from the last candle to the top-right corner
const PAD_B = 22;
const left = 30;
const right = 860; // keep the top-right corner free for the rocket rider
const y = (v) => PAD_T + ((max - v) / (max - min)) * (H - PAD_T - PAD_B);
const step = (right - left) / N;
const bodyW = step * 0.62;
const cx = (i) => left + step * i + step / 2;
const r = (n) => Math.round(n * 10) / 10;

const grid = [0.25, 0.5, 0.75]
  .map((f) => `<line x1="0" x2="${W}" y1="${r(f * H)}" y2="${r(f * H)}" stroke="${C.grid}" stroke-width="2"/>`)
  .join('');

const bars = candles
  .map((c, i) => {
    const up = c.close >= c.open;
    const color = up ? C.up : C.down;
    const top = y(Math.max(c.open, c.close));
    const height = Math.max(4, Math.abs(y(c.open) - y(c.close)));
    return (
      `<line x1="${r(cx(i))}" x2="${r(cx(i))}" y1="${r(y(c.high))}" y2="${r(y(c.low))}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>` +
      `<rect x="${r(cx(i) - bodyW / 2)}" y="${r(top)}" width="${r(bodyW)}" height="${r(height)}" rx="3" fill="${color}"/>`
    );
  })
  .join('');

// Trend line through the closes, then on to the top-right corner where the rocket takes off
const points = candles.map((c, i) => [cx(i), y(c.close)]);
points.push([W - 30, 22]);
const path = points.map(([px, py], i) => `${i ? 'L' : 'M'}${r(px)} ${r(py)}`).join(' ');
const area = `${path} L${r(W - 30)} ${H} L${r(points[0][0])} ${H} Z`;

const svg = (standalone) => `<svg ${standalone ? 'xmlns="http://www.w3.org/2000/svg" ' : ''}viewBox="0 0 ${W} ${H}" class="chart" aria-hidden="true">
  ${grid}
  <path d="${area}" fill="${C.area}" opacity=".07"/>
  ${bars}
  <path d="${path}" fill="none" stroke="${C.line}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1 10"/>
  <circle cx="${W - 30}" cy="22" r="7" fill="${C.up}"/>
</svg>`;

const fs = require('fs');
const out = (name) => require('path').join(__dirname, name); // always next to this script, whatever the cwd
fs.writeFileSync(out('chart.svg'), svg(true).replace('aria-hidden="true">', `aria-hidden="true"><rect width="${W}" height="${H}" fill="#171714"/>`));
fs.writeFileSync(out('chart.inline.svg'), svg(false));
console.log('candles', N, 'up', candles.filter((c) => c.close >= c.open).length);
