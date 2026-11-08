// Low-level pixel helpers: crisp polygon fills, lines, a 3x5 bitmap font, color math.
// These run inside the render loop, so they avoid allocating per call where they can.

const xsScratch = [];
const byNumber = (p, q) => p - q;
export function fillPoly(ctx, pts) {
  let minY = Infinity, maxY = -Infinity;
  const n = pts.length;
  for (let i = 0; i < n; i++) { const y = pts[i][1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  const xs = xsScratch;
  for (let y = minY; y < maxY; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[i + 1 === n ? 0 : i + 1];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    if (xs.length > 2) xs.sort(byNumber);
    else if (xs.length === 2 && xs[0] > xs[1]) { const tmp = xs[0]; xs[0] = xs[1]; xs[1] = tmp; }
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.round(xs[k]), xb = Math.round(xs[k + 1]);
      if (xb > xa) ctx.fillRect(xa, y, xb - xa, 1);
    }
  }
}

export function line(ctx, x0, y0, x1, y1) {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let i = 0; i < 2000; i++) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function ellipsePts(cx, cy, rx, ry, n = 20) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

// ---- color ----
const HEX2 = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const hexCache = new Map();
export function hex2rgb(h) {
  let c = hexCache.get(h);
  if (c) return c;
  const s = h.replace('#', '');
  c = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  hexCache.set(h, c);
  return c;
}
const byte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
export function rgb2hex(r, g, b) {
  return '#' + HEX2[byte(r)] + HEX2[byte(g)] + HEX2[byte(b)];
}
export function shade(h, amt) {
  // amt in [-1, 1]: negative darkens toward black, positive lightens toward white
  const [r, g, b] = hex2rgb(h);
  if (amt < 0) return rgb2hex(r * (1 + amt), g * (1 + amt), b * (1 + amt));
  return rgb2hex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}
export function mix(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
// '#rrggbb' + alpha → 'rgba(...)'
export function rgba(h, a) {
  const [r, g, b] = hex2rgb(h);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

// ---- 3x5 bitmap font (row-major, 3 wide x 5 tall) ----
// All the lettering in the art uses it: the neon sign, ticker, skyline signs, billboards, blimp and the
// wall signs. A character that isn't here draws as a blank, so the README lists this set for config
// writers; add a glyph here and to that list together.
const G = {
  'A': '.#.#.#####.##.#',
  'B': '##.#.###.#.###.',
  'C': '.###..#..#...##',
  'D': '##.#.##.##.###.',
  'E': '####..##.#..###',
  'F': '####..##.#..#..',
  'G': '.###..#.##.#.##',
  'H': '#.##.#####.##.#',
  'I': '###.#..#..#.###',
  'J': '..#..#..##.#.#.',
  'K': '#.##.###.#.##.#',
  'L': '#..#..#..#..###',
  'M': '#.########.##.#',
  'N': '##.#.##.##.##.#',
  'O': '.#.#.##.##.#.#.',
  'P': '##.#.###.#..#..',
  'Q': '.#.#.##.###..##',
  'R': '##.#.###.#.##.#',
  'S': '.###...#...###.',
  'T': '###.#..#..#..#.',
  'U': '#.##.##.##.####',
  'V': '#.##.##.##.#.#.',
  'W': '#.##.########.#',
  'X': '#.##.#.#.#.##.#',
  'Y': '#.##.#.#..#..#.',
  'Z': '###..#.#.#..###',
  '0': '####.##.##.####',
  '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###',
  '3': '##...#.#...###.',
  '4': '#.##.####..#..#',
  '5': '####..##...###.',
  '6': '.###..####.####',
  '7': '###..#.#..#..#.',
  '8': '####.#####.####',
  '9': '####.####..###.',
  ' ': '...............',
  '.': '.............#.',
  ',': '..........#.#..',
  '!': '.#..#..#.....#.',
  '?': '##...#.#.....#.',
  '-': '......###......',
  '+': '....#.###.#....',
  ':': '....#.....#....',
  '/': '..#..#.#.#..#..',
  "'": '.#..#..........',
  '&': '.#.#.#.#.#.#.##',
  '$': '.####..#..####.',
  '%': '#.#..#.#.#..#.#',
  '(': '.#.#..#..#...#.',
  ')': '.#...#..#..#.#.',
  '#': '#.#####.#####.#',
  '@': '.#.#.#####...##',
  '*': '...#.#.#.#.#...',
  '>': '#...#...#.#.#..',
  '<': '..#.#.#...#...#',
  '=': '...###...###...',
  '_': '............###',
  '|': '.#..#..#..#..#.',
  '~': '.......####....',
  '"': '#.##.#.........',
  '^': '.#.#.#.........',
  '[': '##.#..#..#..##.',
  ']': '.##..#..#..#.##',
  '♥': '#.#######.#....',
};
// glyph → flat list of lit [col,row] pairs, looked up by the character as typed (upper- or lower-case)
const LIT = new Map();
for (const [ch, bits] of Object.entries(G)) {
  const on = [];
  for (let i = 0; i < 15; i++) if (bits[i] === '#') on.push(i % 3, Math.floor(i / 3));
  LIT.set(ch, on);
  const lo = ch.toLowerCase();
  if (lo !== ch) LIT.set(lo, on);
}
const BLANK = [];
function glyph(ch) {
  let on = LIT.get(ch);
  if (on) return on;
  const up = ch.toUpperCase();
  on = LIT.get(up) || BLANK;
  LIT.set(ch, on);
  return on;
}

export function textWidth(s, scale = 1) {
  return Math.max(0, String(s).length * 4 * scale - scale);
}
export function pixelText(ctx, s, x, y, scale = 1) {
  if (typeof s !== 'string') s = String(s);
  x = Math.round(x); y = Math.round(y);
  for (let i = 0; i < s.length; i++) {
    const on = glyph(s[i]);
    const gx = x + i * 4 * scale;
    for (let k = 0; k < on.length; k += 2) ctx.fillRect(gx + on[k] * scale, y + on[k + 1] * scale, scale, scale);
  }
}

// deterministic RNG
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
// The same generator, but one function you re-seed instead of allocating a closure per use:
//   const r = seededRng(); ... r.seed(b.seed); r(); r();
export function seededRng() {
  let s = 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  next.seed = (v) => { s = v >>> 0 || 1; return next; };
  return next;
}

// readback: the canvas will be read with getImageData (picking, bounds), so the browser keeps it in
// memory it can read cheaply ({ willReadFrequently }). Only for the canvases that are read.
export function makeCanvas(w, h, { readback = false } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', readback ? { willReadFrequently: true } : undefined);
  g.imageSmoothingEnabled = false;
  return [c, g];
}
