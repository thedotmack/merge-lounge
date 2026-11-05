// Low-level pixel helpers: crisp polygon fills, lines, a 3x5 bitmap font, color math.

export function fillPoly(ctx, pts) {
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  minY = Math.floor(minY); maxY = Math.ceil(maxY);
  const n = pts.length;
  const xs = [];
  for (let y = minY; y < maxY; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) {
        xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
    xs.sort((p, q) => p - q);
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
const hexCache = new Map();
export function hex2rgb(h) {
  let c = hexCache.get(h);
  if (c) return c;
  const s = h.replace('#', '');
  c = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  hexCache.set(h, c);
  return c;
}
export function rgb2hex(r, g, b) {
  const t = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + t(r) + t(g) + t(b);
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

// ---- 3x5 bitmap font (row-major, 3 wide x 5 tall) ----
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

export function textWidth(s, scale = 1) {
  return Math.max(0, String(s).length * 4 * scale - scale);
}
export function pixelText(ctx, s, x, y, scale = 1) {
  s = String(s).toUpperCase();
  x = Math.round(x); y = Math.round(y);
  for (let i = 0; i < s.length; i++) {
    const g = G[s[i]] || G[' '];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c] === '#') ctx.fillRect(x + (i * 4 + c) * scale, y + r * scale, scale, scale);
      }
    }
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

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}
