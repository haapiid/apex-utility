// Cuts the website's mascot, logo and icon images out of the approved master sheet
// (assets/mascot/apex-mascot-master.png, read-only) into website/img/. No dependencies.
//   node website/art/crop-mascot.js [previewDir]
// previewDir (optional) also gets each cut composited on ivory and on black, to check the edges.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..', '..');
const MASTER = path.join(ROOT, 'assets', 'mascot', 'apex-mascot-master.png');
const OUT = path.join(ROOT, 'website', 'img');
const IVORY = [0xf4, 0xf0, 0xe7];
const BLACK = [0x17, 0x17, 0x14];

// ---------- PNG read / write (8-bit RGB or RGBA, non-interlaced) ----------

function readPng(file) {
  const buf = fs.readFileSync(file);
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bpp = buf[25] === 6 ? 4 : 3;
  const idat = [];
  for (let off = 8; off < buf.length; ) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('ascii', off + 4, off + 8) === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      px[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]) & 255;
    }
  }
  // Always hand back RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = px[i * bpp];
    rgba[i * 4 + 1] = px[i * bpp + 1];
    rgba[i * 4 + 2] = px[i * bpp + 2];
    rgba[i * 4 + 3] = bpp === 4 ? px[i * bpp + 3] : 255;
  }
  return { width, height, data: rgba };
}

function writePng(file, { width, height, data }) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

// ---------- image operations ----------

function crop(img, [x0, y0, x1, y1]) {
  const width = x1 - x0;
  const height = y1 - y0;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) img.data.copy(data, y * width * 4, ((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x1) * 4);
  return { width, height, data };
}

const dist = (data, i, c) => Math.max(Math.abs(data[i] - c[0]), Math.abs(data[i + 1] - c[1]), Math.abs(data[i + 2] - c[2]));

// Median color of the image border = the paper the art was drawn on (the median ignores lettering or
// dark panels the crop happens to touch; the sheet's ivory also varies a little between areas)
function borderColor(img) {
  const channels = [[], [], []];
  const add = (x, y) => {
    const i = (y * img.width + x) * 4;
    for (let k = 0; k < 3; k++) channels[k].push(img.data[i + k]);
  };
  for (let x = 0; x < img.width; x++) (add(x, 0), add(x, img.height - 1));
  for (let y = 0; y < img.height; y++) (add(0, y), add(img.width - 1, y));
  return channels.map((c) => c.sort((a, b) => a - b)[c.length >> 1]);
}

/**
 * Makes the paper transparent.
 *   flood: only paper connected to the border (or to extra seeds) is removed, so white teeth and
 *          highlights inside the character survive.
 *   key:   every paper-colored pixel is removed (for lettering, whose counters are enclosed).
 * Edge pixels get partial alpha and are "un-mixed" from the paper color, so there's no light halo.
 */
function removePaper(img, { mode = 'flood', seeds = [], hard = 14, soft = 70 } = {}) {
  const paper = borderColor(img);
  const { width, height, data } = img;
  const inRegion = new Uint8Array(width * height);
  if (mode === 'key') {
    inRegion.fill(1);
  } else {
    const stack = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      const p = y * width + x;
      if (inRegion[p] || dist(data, p * 4, paper) >= soft) return;
      inRegion[p] = 1;
      stack.push(p);
    };
    for (let x = 0; x < width; x++) (push(x, 0), push(x, height - 1));
    for (let y = 0; y < height; y++) (push(0, y), push(width - 1, y));
    for (const [x, y] of seeds) push(x, y);
    while (stack.length) {
      const p = stack.pop();
      const x = p % width;
      const y = (p - x) / width;
      push(x + 1, y), push(x - 1, y), push(x, y + 1), push(x, y - 1);
    }
  }
  for (let p = 0; p < width * height; p++) {
    if (!inRegion[p]) continue;
    const i = p * 4;
    const d = dist(data, i, paper);
    if (d >= soft) continue;
    const a = Math.max(0, (d - hard) / (soft - hard));
    if (a === 0) {
      data[i + 3] = 0;
      continue;
    }
    for (let k = 0; k < 3; k++) data[i + k] = Math.max(0, Math.min(255, Math.round((data[i + k] - (1 - a) * paper[k]) / a)));
    data[i + 3] = Math.round(a * 255);
  }
  return img;
}

function erase(img, rects) {
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data[(y * img.width + x) * 4 + 3] = 0;
  }
  return img;
}

// Crops away fully transparent margins, keeping `pad` pixels
function trim(img, pad = 4) {
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (img.data[(y * img.width + x) * 4 + 3] > 8) {
        x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y);
      }
    }
  }
  return crop(img, [Math.max(0, x0 - pad), Math.max(0, y0 - pad), Math.min(img.width, x1 + 1 + pad), Math.min(img.height, y1 + 1 + pad)]);
}

// Box-filter resize with premultiplied alpha (only used to shrink)
function resize(img, width, height) {
  const data = Buffer.alloc(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = Math.floor(y * sy); yy < Math.min(img.height, Math.ceil((y + 1) * sy)); yy++) {
        for (let xx = Math.floor(x * sx); xx < Math.min(img.width, Math.ceil((x + 1) * sx)); xx++) {
          const i = (yy * img.width + xx) * 4;
          const a = img.data[i + 3] / 255;
          acc[0] += img.data[i] * a;
          acc[1] += img.data[i + 1] * a;
          acc[2] += img.data[i + 2] * a;
          acc[3] += a;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      for (let k = 0; k < 3; k++) data[o + k] = acc[3] ? Math.round(acc[k] / acc[3]) : 0;
      data[o + 3] = Math.round((acc[3] / n) * 255);
    }
  }
  return { width, height, data };
}

// Centers the image on a square canvas of `size`, filled with `bg` (or transparent), image scaled to `fill`
function square(img, size, { bg = null, fill = 0.86, radius = 0 } = {}) {
  const scale = (size * fill) / Math.max(img.width, img.height);
  const small = resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  const data = Buffer.alloc(size * size * 4);
  const r = radius * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // Rounded-corner mask
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      const inside = !(cx < r && cy < r && (r - cx) ** 2 + (r - cy) ** 2 > r * r);
      if (bg && inside) (data[o] = bg[0], data[o + 1] = bg[1], data[o + 2] = bg[2], data[o + 3] = 255);
    }
  }
  const ox = Math.round((size - small.width) / 2), oy = Math.round((size - small.height) / 2);
  return composite({ width: size, height: size, data }, small, ox, oy);
}

// Draws `top` over `base` at (ox, oy), "over" operator
function composite(base, top, ox, oy) {
  for (let y = 0; y < top.height; y++) {
    for (let x = 0; x < top.width; x++) {
      const bx = x + ox, by = y + oy;
      if (bx < 0 || by < 0 || bx >= base.width || by >= base.height) continue;
      const t = (y * top.width + x) * 4, b = (by * base.width + bx) * 4;
      const ta = top.data[t + 3] / 255, ba = base.data[b + 3] / 255;
      const oa = ta + ba * (1 - ta);
      if (oa === 0) continue;
      for (let k = 0; k < 3; k++) base.data[b + k] = Math.round((top.data[t + k] * ta + base.data[b + k] * ba * (1 - ta)) / oa);
      base.data[b + 3] = Math.round(oa * 255);
    }
  }
  return base;
}

function onColor(img, color) {
  const data = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < data.length; i += 4) (data[i] = color[0], data[i + 1] = color[1], data[i + 2] = color[2], data[i + 3] = 255);
  return composite({ width: img.width, height: img.height, data }, img, 0, 0);
}

// ---------- the cuts (coordinates on the 1254 × 1254 master) ----------

const master = readPng(MASTER);
const cut = (rect, opts) => removePaper(crop(master, rect), opts);

const outputs = {
  // Hero: bust pointing at you with the banana and the crown. The hoodie is cut flat at the bottom on
  // purpose (it sits on the hero's bottom edge). The "™" of the wordmark next to it is erased.
  // Seed (357, 50) clears the paper inside the crown outline.
  'mascot-hero.png': trim(erase(cut([398, 12, 924, 527], { seeds: [[357, 50]] }), [[0, 60, 58, 205]]), 0),
  // Poses
  'mascot-trading.png': trim(cut([232, 830, 492, 1062])),
  'mascot-win.png': trim(cut([498, 796, 732, 1064])),
  'mascot-casual.png': trim(cut([28, 796, 218, 1092])),
  // Face mark (Happy head) for the logo, the bot avatar and the touch icon
  // (stops at y 703: the lockup's "ApeX" lettering starts right below)
  'face-mark.png': trim(cut([1062, 596, 1198, 703])),
  // Wordmark "ApeX" from the hero, black lettering (keyed: the letter counters are enclosed)
  'wordmark.png': trim(cut([44, 84, 418, 214], { mode: 'key' })),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, img] of Object.entries(outputs)) writePng(path.join(OUT, name), img);

// Icons: the yellow X from the brand panel, kept on its black ground
const xOnly = removePaper(crop(master, [1036, 62, 1168, 178]), { mode: 'key', hard: 20, soft: 90 });
writePng(path.join(OUT, 'x-mark.png'), trim(xOnly));
writePng(path.join(OUT, 'favicon-32.png'), square(trim(xOnly), 32, { bg: BLACK, fill: 0.78, radius: 0.22 }));
writePng(path.join(OUT, 'favicon-192.png'), square(trim(xOnly), 192, { bg: BLACK, fill: 0.7, radius: 0.22 }));
writePng(path.join(OUT, 'apple-touch-icon.png'), square(outputs['face-mark.png'], 180, { bg: [0xf2, 0xc9, 0x4c], fill: 0.82 }));

const preview = process.argv[2];
if (preview) {
  fs.mkdirSync(preview, { recursive: true });
  for (const name of [...Object.keys(outputs), 'x-mark.png']) {
    const img = readPng(path.join(OUT, name));
    writePng(path.join(preview, `ivory-${name}`), onColor(img, IVORY));
    writePng(path.join(preview, `black-${name}`), onColor(img, BLACK));
  }
}
console.log(Object.keys(outputs).concat('x-mark.png', 'favicon-32.png', 'favicon-192.png', 'apple-touch-icon.png').map((n) => {
  const b = fs.readFileSync(path.join(OUT, n));
  return `${n} ${b.readUInt32BE(16)}x${b.readUInt32BE(20)} ${(b.length / 1024).toFixed(0)}KB`;
}).join('\n'));
