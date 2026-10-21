// Build the banana SVG; computes cut faces from the actual curves
const bez = (p0, p1, p2, p3, t) => { const u = 1 - t; return [0, 1].map((i) => u*u*u*p0[i] + 3*u*u*t*p1[i] + 3*u*t*t*p2[i] + t*t*t*p3[i]); };
const yAt = (curve, x) => { let best; for (let t = 0; t <= 1; t += 0.0005) { const p = bez(...curve, t); if (!best || Math.abs(p[0] - x) < Math.abs(best[0] - x)) best = p; } return best[1]; };
const TOP = [[110, 66], [270, 168], [730, 180], [905, 58]];
const BOT = [[952, 96], [800, 352], [220, 352], [56, 128]];
const cut = (x) => { const t = yAt(TOP, x), b = yAt(BOT, x); return { cy: (t + b) / 2, ry: (b - t) / 2 }; };
const cA = cut(600), cB = cut(880);
const body = `M110 66 C270 168 730 180 905 58 C926 42 966 58 952 96 C800 352 220 352 56 128 C42 106 78 50 110 66 Z`;
const svg = (standalone) => `<svg ${standalone ? 'xmlns="http://www.w3.org/2000/svg" ' : ''}viewBox="0 0 1060 340" class="banana" aria-hidden="true">
  <defs>
    <path id="b-body" d="${body}"/>
    <clipPath id="b-clip"><use href="#b-body"/></clipPath>
    <clipPath id="cut-a"><rect x="0" y="0" width="600" height="340"/></clipPath>
    <clipPath id="cut-b"><rect x="600" y="0" width="280" height="340"/></clipPath>
    <clipPath id="cut-c"><rect x="880" y="0" width="180" height="340"/></clipPath>
    <g id="b-whole">
      <path d="M104 70 C86 56 62 40 44 30 C34 24 22 36 30 46 C44 62 60 84 74 112 Z" fill="#8C7A26"/>
      <path d="M44 30 C34 24 22 36 30 46 L38 54 C42 46 46 40 52 36 Z" fill="#4E3A12"/>
      <use href="#b-body" fill="#F6D232"/>
      <g clip-path="url(#b-clip)">
        <path d="M30 150 C220 350 800 350 1000 92 L1000 360 L30 360 Z" fill="#E2B10C"/>
        <path d="M78 116 C250 270 760 280 942 84" fill="none" stroke="#D49E08" stroke-width="7" stroke-linecap="round" opacity=".55"/>
        <path d="M180 112 C340 196 600 204 780 140" fill="none" stroke="#FFF3B0" stroke-width="12" stroke-linecap="round" opacity=".8"/>
        <circle cx="420" cy="250" r="5" fill="#8A6414" opacity=".45"/><circle cx="446" cy="266" r="3.5" fill="#8A6414" opacity=".4"/>
        <circle cx="700" cy="240" r="4" fill="#8A6414" opacity=".4"/>
      </g>
      <ellipse cx="944" cy="76" rx="15" ry="17" fill="#4E3A12" transform="rotate(-30 944 76)"/>
    </g>
  </defs>
  <g class="piece piece-a" clip-path="url(#cut-a)"><use href="#b-whole"/><ellipse cx="600" cy="${cA.cy.toFixed(1)}" rx="20" ry="${cA.ry.toFixed(1)}" fill="#FFF6D5" stroke="#E2B10C" stroke-width="4"/></g>
  <g class="piece piece-b" clip-path="url(#cut-b)" transform="translate(34 0)"><use href="#b-whole"/><ellipse cx="600" cy="${cA.cy.toFixed(1)}" rx="20" ry="${cA.ry.toFixed(1)}" fill="#FFF6D5" stroke="#E2B10C" stroke-width="4"/><ellipse cx="880" cy="${cB.cy.toFixed(1)}" rx="15" ry="${cB.ry.toFixed(1)}" fill="#FFF6D5" stroke="#E2B10C" stroke-width="4"/></g>
  <g class="piece piece-c" clip-path="url(#cut-c)" transform="translate(68 0) rotate(-5 880 ${cB.cy.toFixed(0)})"><use href="#b-whole"/><ellipse cx="880" cy="${cB.cy.toFixed(1)}" rx="15" ry="${cB.ry.toFixed(1)}" fill="#FFF6D5" stroke="#E2B10C" stroke-width="4"/></g>
</svg>`;
require('fs').writeFileSync('banana.svg', svg(true).replace('<svg ', '<svg ').replace('aria-hidden="true">', 'aria-hidden="true"><rect width="1060" height="340" fill="#0E2B1D"/>'));
require('fs').writeFileSync('banana.inline.svg', svg(false));
console.log('cuts', cA, cB);
