// ApeX mascot v3: outlined cartoon construction, correct layering, head overlaps body (no neck gap)
const fs = require('fs');
const C = { fur: '#8B5530', furDark: '#6B3B1E', face: '#F3D2A6', earIn: '#E7B587', ink: '#2A1608', blush: '#F2957A', line: '#3B2210' };
const LW = 3.2; // outline width
const o = `stroke="${C.line}" stroke-width="${LW}" stroke-linejoin="round" stroke-linecap="round"`;

// Tube limb with outline: dark wide stroke under a fur stroke
const tube = (d, w, fill = C.fur) =>
  `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="${w + LW * 2}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<path d="${d}" fill="none" stroke="${fill}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

// Same face as before (the one the client likes), now with an outline on the fur parts
const head = `
  <circle cx="16" cy="60" r="17" fill="${C.fur}" ${o}/><circle cx="16" cy="60" r="9.5" fill="${C.earIn}"/>
  <circle cx="104" cy="60" r="17" fill="${C.fur}" ${o}/><circle cx="104" cy="60" r="9.5" fill="${C.earIn}"/>
  <path d="M50 22 C47 10 56 3 62 10 C65 2 77 5 72 18" fill="${C.fur}" ${o}/>
  <ellipse cx="60" cy="58" rx="42" ry="40" fill="${C.fur}" ${o}/>
  <path d="M60 46 C54 34 30 32 28 52 C26 64 32 72 36 76 C40 94 80 94 84 76 C88 72 94 64 92 52 C90 32 66 34 60 46 Z" fill="${C.face}"/>
  <ellipse cx="45.5" cy="55" rx="6.8" ry="8.4" fill="${C.ink}"/><ellipse cx="74.5" cy="55" rx="6.8" ry="8.4" fill="${C.ink}"/>
  <circle cx="48" cy="51.5" r="2.6" fill="#fff"/><circle cx="77" cy="51.5" r="2.6" fill="#fff"/>
  <circle cx="43.5" cy="58.5" r="1.2" fill="#fff" opacity=".8"/><circle cx="72.5" cy="58.5" r="1.2" fill="#fff" opacity=".8"/>
  <ellipse cx="35" cy="71" rx="6" ry="3.8" fill="${C.blush}" opacity=".6"/><ellipse cx="85" cy="71" rx="6" ry="3.8" fill="${C.blush}" opacity=".6"/>
  <ellipse cx="56" cy="69" rx="2" ry="1.5" fill="${C.furDark}"/><ellipse cx="64" cy="69" rx="2" ry="1.5" fill="${C.furDark}"/>
  <path d="M50 77 C54 85 66 85 70 77" fill="none" stroke="${C.furDark}" stroke-width="3" stroke-linecap="round"/>`;

const banana = `<g ${o}>
  <path d="M4 -2 C0 -12 -6 -18 -10 -20 C-14 -22 -17 -17 -14 -14 C-10 -10 -6 -4 -4 4 Z" fill="#8C7A26"/>
  <path d="M0 0 C20 22 62 24 84 2 C88 -2 94 2 91 7 C70 40 20 40 -4 10 C-8 5 -4 -2 0 0 Z" fill="#F6D232"/>
  <path d="M10 14 C28 30 60 30 80 12" fill="none" stroke="#E2B10C" stroke-width="3"/>
  <ellipse cx="90" cy="3" rx="3.2" ry="3.8" fill="#4E3A12" stroke="none"/>
</g>`;

const mascot = `
  <!-- everything attached to the body is drawn behind it, so joints are hidden -->
  ${tube('M146 262 C182 280 206 262 202 238 C199 220 178 220 178 234', 8)}
  ${tube('M116 256 C118 276 122 290 124 300', 17)}
  <ellipse cx="130" cy="304" rx="16" ry="8.5" fill="${C.furDark}" ${o}/>
  ${tube('M144 258 C140 282 116 296 94 302', 17)}
  <ellipse cx="86" cy="304" rx="16" ry="8.5" fill="${C.furDark}" ${o}/>
  ${tube('M150 184 C178 186 202 166 220 136', 14)}
  ${tube('M100 192 C82 204 72 220 74 236', 14)}
  <g transform="rotate(6 128 214)">
    <path d="M128 148 C162 148 172 190 170 222 C168 258 150 278 126 278 C100 278 84 258 84 224 C84 188 96 148 128 148 Z" fill="${C.fur}" ${o}/>
    <path d="M128 174 C149 174 155 200 154 224 C153 250 143 264 128 264 C111 264 102 250 102 226 C102 200 108 174 128 174 Z" fill="${C.face}"/>
  </g>
  <!-- hand on the phone: palm at the edge, fingers wrap onto the screen -->
  <circle cx="224" cy="132" r="11" fill="${C.furDark}" ${o}/>
  <ellipse cx="237" cy="124" rx="6" ry="4.4" fill="${C.furDark}" ${o}/>
  <ellipse cx="239" cy="133.5" rx="6" ry="4.4" fill="${C.furDark}" ${o}/>
  <ellipse cx="237" cy="143" rx="6" ry="4.4" fill="${C.furDark}" ${o}/>
  <!-- head overlaps the top of the body: no neck gap -->
  <g transform="translate(46 34) rotate(7 60 58) scale(1.24)">${head}</g>
  <!-- banana in the left hand -->
  <g transform="translate(74 238) rotate(-116) scale(.9) translate(-2 -6)">${banana}</g>
  <circle cx="75" cy="238" r="10.5" fill="${C.furDark}" ${o}/>`;

fs.writeFileSync('mascot.inline.txt', '<g transform="rotate(6 108 304)">' + mascot.replace(/<!--[^>]*-->/g, '') + '</g>');
const preview = (scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 330">
  <rect width="360" height="330" fill="#F6D232"/>
  <rect x="246" y="16" width="200" height="360" rx="24" fill="#CFDCC2"/><rect x="246" y="16" width="200" height="58" rx="24" fill="#24331F"/>
  <g transform="rotate(6 108 304)">${mascot}</g>
</svg>`;
fs.writeFileSync('mascot.svg', preview());
fs.writeFileSync('head.inline.txt', head);
