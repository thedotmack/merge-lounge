// The view out the window: a procedurally drawn "AI valley" that drifts by like a TV bumper —
// mountains, a skyline of made-up startups whose rooftop signs keep rebranding, billboards on the
// freeway, a blimp. The sky follows the actual time of day in San Francisco.
import { rng, mix, shade, pixelText, textWidth } from './pixel.js';

export const NAMES = [
  'TOKENLY', 'CTXBASE', 'VECTORLY', 'PROMPTCO', 'AGI SOON', 'GPU BARN', 'MEMLABS', 'LGTM CAP',
  'SHIPIT', '10X LABS', 'RAGTAG', 'EVALS4U', 'DIFFCO', 'HOTFIX', 'SERIES Z', 'INFER.IO',
  'STEALTH', 'YOLO OPS', 'MERGEINC', 'NEURALLY', 'COMPUTE+', 'PIVOTLY', 'ATTENTIO', 'WEIGHTS',
];
export const BILLBOARDS = [
  ['CONTEXT IS', 'ALL YOU NEED'], ['YOUR AGENT', 'FORGOT AGAIN?'], ['MEMORY >', 'VIBES'],
  ['HIRING: 10X', 'PROMPTER'], ['SHIP ON', 'FRIDAYS'], ['TOKENS: CHEAP', 'MEMORY: RARE'],
  ['CLAUDE-MEM', 'REMEMBERS'], ['AGI BY Q3', '(MAYBE)'], ['SESSION', 'AMNESIA? NAH'],
  ['MERGED >', 'PERFECT'], ['LGTM', 'SHIP IT'], ['ZERO-SHOT', 'ZERO SLEEP'],
];
const NEON = ['#ff5fa2', '#33e1ff', '#ff9a3c', '#7dff8a', '#c08bff', '#ffe066'];

// sky keyframes: hour → [top, bottom, night]
const SKY = [
  [0, '#060819', '#17123a', 1],
  [5, '#0a0e2a', '#2b1d4d', 0.9],
  [6.2, '#2c2a62', '#f08a5d', 0.45],
  [7.4, '#5aa2f0', '#ffd6a5', 0.05],
  [9, '#4c93e6', '#a9d4ff', 0],
  [16, '#5b8fd6', '#ffd9a8', 0],
  [17.4, '#3d4386', '#ff8a5c', 0.15],
  [18.3, '#2b2064', '#d9507e', 0.4],
  [19.2, '#140f3a', '#4a2464', 0.75],
  [20.5, '#080a22', '#1d1442', 0.95],
  [24, '#060819', '#17123a', 1],
];

export function skyAt(hour) {
  let i = 0;
  while (i < SKY.length - 2 && SKY[i + 1][0] <= hour) i++;
  const a = SKY[i], b = SKY[i + 1];
  const k = Math.min(1, Math.max(0, (hour - a[0]) / (b[0] - a[0])));
  return { top: mix(a[1], b[1], k), bottom: mix(a[2], b[2], k), night: a[3] + (b[3] - a[3]) * k };
}

export function sfHour() {
  const q = new URLSearchParams(location.search).get('tod');
  if (q !== null && q !== '' && !Number.isNaN(Number(q))) return ((Number(q) % 24) + 24) % 24;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h + m / 60;
}

export class Valley {
  constructor(seed = 20250901) {
    const r = rng(seed);
    this.worldW = 1040;
    this.buildings = [];
    let x = 0, signCount = 0;
    while (x < this.worldW - 10) {
      const w = 10 + Math.floor(r() * 20);
      const kind = Math.floor(r() * 4);
      const b = {
        x, w, hf: 0.22 + r() * r() * 0.55 + (kind === 0 ? 0.12 : 0), kind,
        seed: Math.floor(r() * 1e9), antenna: r() < 0.3, roofBox: r() < 0.4,
        sign: null,
      };
      if (w >= 14 && r() < 0.42) b.sign = signCount++;
      this.buildings.push(b);
      x += w + 1 + Math.floor(r() * 5);
    }
    this.signCount = signCount;
    this.backBuildings = [];
    x = 0;
    while (x < this.worldW) {
      const w = 8 + Math.floor(r() * 18);
      this.backBuildings.push({ x, w, hf: 0.15 + r() * 0.3, seed: Math.floor(r() * 1e9) });
      x += w + Math.floor(r() * 3);
    }
    this.stars = Array.from({ length: 110 }, () => ({ x: r() * this.worldW, y: r() * 0.55, p: r() * 6.28, b: r() }));
    this.boards = Array.from({ length: 5 }, (_, i) => ({ x: 60 + i * (this.worldW / 5) + r() * 60, text: BILLBOARDS[(i * 5 + Math.floor(r() * 3)) % BILLBOARDS.length], ci: i }));
    this.palms = Array.from({ length: 7 }, (_, i) => ({ x: i * (this.worldW / 7) + r() * 70, h: 0.28 + r() * 0.16, lean: r() * 2 - 1 }));
    this.clouds = Array.from({ length: 6 }, () => ({ x: r() * this.worldW, y: 0.08 + r() * 0.25, w: 14 + Math.floor(r() * 24), s: 0.4 + r() * 0.8 }));
    this.cars = Array.from({ length: 22 }, (_, i) => ({ o: r() * this.worldW, v: 18 + r() * 22, lane: i % 2, c: ['#e63946', '#f4f1de', '#3a86ff', '#2b2d42', '#ffbe0b', '#9aa0b5'][Math.floor(r() * 6)] }));
  }

  signName(k, t) {
    const period = 7000;
    const epoch = Math.floor(t / period);
    const n = this.signCount || 1;
    const changes = epoch >= k ? Math.floor((epoch - k) / n) + 1 : 0;
    const idx = (k * 5 + changes) % NAMES.length;
    const glitch = epoch % n === k && t % period < 700;
    return { name: NAMES[idx], prev: NAMES[(idx + NAMES.length - 1) % NAMES.length], glitch, gt: (t % period) / 700 };
  }

  // Draw into g over [0,W)x[0,H). t in ms. opts.speed in px/s of the city layer.
  // Lettering goes through here. With opts.deferText the text is collected in this.texts
  // (flat coordinates + colour) so a sheared view can draw it upright, glyph by glyph.
  text(g, s, x, y) {
    if (this.deferText) this.texts.push({ s, x, y, color: g.fillStyle });
    else pixelText(g, s, x, y);
  }

  render(g, W, H, t, opts = {}) {
    this.deferText = !!opts.deferText;
    this.texts = [];
    const hour = opts.hour ?? sfHour();
    const sky = skyAt(hour);
    const night = sky.night;
    const speed = opts.speed ?? 3;
    const scroll = (t / 1000) * speed;
    const WW = this.worldW;
    const ground = H - Math.max(8, Math.round(H * 0.12));
    const fwyH = Math.max(5, Math.round(H * 0.07));
    const fwyY = ground - fwyH;

    // sky in 3px bands
    const band = H > 100 ? 4 : 3;
    for (let y = 0; y < H; y += band) {
      g.fillStyle = mix(sky.top, sky.bottom, Math.min(1, (y / (fwyY || 1)) ** 1.15));
      g.fillRect(0, y, W, band);
    }

    // stars
    if (night > 0.3) {
      for (const s of this.stars) {
        const sx = Math.floor(((s.x - scroll * 0.04) % WW + WW) % WW);
        if (sx >= W) continue;
        const tw = 0.5 + 0.5 * Math.sin(t / 700 + s.p);
        if (tw * night * (0.5 + s.b) < 0.45) continue;
        g.fillStyle = s.b > 0.85 ? '#ffffff' : '#c9d4ff';
        g.fillRect(sx, Math.floor(s.y * fwyY * 0.9), 1, 1);
      }
    }

    // sun or moon (rises east = right, sets west = left)
    const dayFrac = (hour - 6.3) / (18.4 - 6.3);
    if (dayFrac > -0.05 && dayFrac < 1.05) {
      const sx = Math.round(W * (0.92 - dayFrac * 0.84));
      const sy = Math.round(fwyY * (0.75 - Math.sin(Math.max(0, Math.min(1, dayFrac)) * Math.PI) * 0.6));
      const sc = mix('#fff6d5', '#ffb36b', Math.abs(dayFrac - 0.5) * 1.6);
      disc(g, sx, sy, H > 100 ? 7 : 4, sc);
      g.globalAlpha = 0.25; disc(g, sx, sy, H > 100 ? 11 : 6, sc); g.globalAlpha = 1;
    } else {
      const nf = hour > 12 ? (hour - 18.4) / (24 - 18.4 + 6.3) : (hour + 24 - 18.4) / (24 - 18.4 + 6.3);
      const mx = Math.round(W * (0.9 - nf * 0.8));
      const my = Math.round(fwyY * (0.6 - Math.sin(nf * Math.PI) * 0.45));
      const r = H > 100 ? 6 : 3;
      disc(g, mx, my, r, '#f1ecd6');
      g.fillStyle = '#d5cfb8';
      g.fillRect(mx - 1, my - 1, 1, 1);
      if (r > 3) { g.fillRect(mx + 2, my + 1, 2, 2); g.fillRect(mx - 3, my + 2, 1, 1); }
    }

    // clouds
    for (const c of this.clouds) {
      const cx = Math.floor(((c.x - scroll * 0.12 - (t / 1000) * c.s) % WW + WW) % WW);
      if (cx > W + 30) continue;
      const cy = Math.floor(c.y * fwyY);
      const col = night > 0.6 ? mix(sky.top, '#3a3a6a', 0.35) : mix(sky.bottom, '#ffffff', 0.55);
      g.fillStyle = col;
      g.fillRect(cx, cy, c.w, 2);
      g.fillRect(cx + 3, cy - 1, c.w - 7, 1);
      g.fillRect(cx + 5, cy - 2, Math.floor(c.w / 3), 1);
      g.fillStyle = shade(col, -0.08);
      g.fillRect(cx + 1, cy + 2, c.w - 2, 1);
    }

    // far mountains (Santa Cruz range vibes)
    const farC = mix(sky.bottom, night > 0.5 ? '#1c1838' : '#5b6aa0', 0.6);
    const nearC = mix(sky.bottom, night > 0.5 ? '#100d22' : '#2f4a52', 0.78);
    const mo = scroll * 0.14;
    for (let x = 0; x < W; x++) {
      const wx = x + mo;
      const h1 = Math.round(fwyY * (0.42 + 0.1 * Math.sin(wx * 0.011) + 0.06 * Math.sin(wx * 0.031 + 1) + 0.025 * Math.sin(wx * 0.09)));
      g.fillStyle = farC;
      g.fillRect(x, h1, 1, fwyY - h1);
    }
    // haze band
    g.globalAlpha = 0.18;
    g.fillStyle = sky.bottom;
    g.fillRect(0, Math.round(fwyY * 0.62), W, Math.round(fwyY * 0.2));
    g.globalAlpha = 1;
    const ho = scroll * 0.3;
    for (let x = 0; x < W; x++) {
      const wx = x + ho;
      let h2 = Math.round(fwyY * (0.66 + 0.05 * Math.sin(wx * 0.02 + 2) + 0.03 * Math.sin(wx * 0.07)));
      if ((Math.floor(wx) * 7) % 11 < 3) h2 -= 1; // treeline bumps
      g.fillStyle = nearC;
      g.fillRect(x, h2, 1, fwyY - h2);
    }

    // back row of city
    const bo = scroll * 0.42;
    const backC = mix(nearC, sky.bottom, 0.18);
    for (const b of this.backBuildings) {
      for (const off of [0, WW]) {
        const x = Math.floor(b.x + off - (bo % WW));
        if (x > W || x + b.w < 0) continue;
        const h = Math.round(b.hf * fwyY * 0.9);
        g.fillStyle = backC;
        g.fillRect(x, fwyY - h, b.w, h);
        if (night > 0.5) {
          const r = rng(b.seed);
          g.fillStyle = '#ffd98a';
          for (let wy = fwyY - h + 2; wy < fwyY - 2; wy += 3) for (let wx = x + 1; wx < x + b.w - 1; wx += 3) if (r() < 0.12) g.fillRect(wx, wy, 1, 1);
        }
      }
    }

    // main city row
    const co = scroll * 0.6;
    for (const b of this.buildings) {
      for (const off of [0, WW]) {
        const x = Math.floor(b.x + off - (co % WW));
        if (x > W + 30 || x + b.w < -30) continue;
        this.building(g, b, x, fwyY, t, night, sky);
      }
    }

    // freeway
    const asphalt = night > 0.5 ? '#16151f' : mix('#4a4a55', sky.bottom, 0.15);
    g.fillStyle = shade(asphalt, -0.3);
    g.fillRect(0, fwyY - 1, W, 1);
    g.fillStyle = asphalt;
    g.fillRect(0, fwyY, W, fwyH);
    const lo = scroll * 0.85;
    g.fillStyle = night > 0.5 ? '#6b6a52' : '#d8d2a8';
    const midY = fwyY + Math.floor(fwyH / 2);
    for (let x = -((lo * 1.0) % 8); x < W; x += 8) g.fillRect(Math.floor(x), midY, 3, 1);
    // cars
    for (const c of this.cars) {
      const dir = c.lane ? 1 : -1;
      const raw = c.o + dir * (t / 1000) * c.v - lo;
      const x = Math.floor(((raw % WW) + WW) % WW);
      if (x > W + 4) continue;
      const y = c.lane ? midY + 1 : fwyY + 1;
      g.fillStyle = night > 0.5 ? shade(c.c, -0.55) : c.c;
      g.fillRect(x, y, 4, 2);
      g.fillStyle = night > 0.5 ? '#fff6c2' : '#ffffff';
      g.fillRect(dir > 0 ? x + 3 : x, y + 1, 1, 1);
      g.fillStyle = '#ff3b3b';
      g.fillRect(dir > 0 ? x : x + 3, y + 1, 1, 1);
      if (night > 0.5) {
        g.globalAlpha = 0.35;
        g.fillStyle = '#fff6c2';
        g.fillRect(dir > 0 ? x + 4 : x - 2, y + 1, 2, 1);
        g.globalAlpha = 1;
      }
    }

    // billboards along the freeway
    const bbo = scroll * 0.85;
    for (const bb of this.boards) {
      for (const off of [0, WW]) {
        const x = Math.floor(bb.x + off - (bbo % WW));
        const bw = Math.max(textWidth(bb.text[0]), textWidth(bb.text[1])) + 6;
        if (x > W || x + bw < 0) continue;
        const bh = 15;
        const by = fwyY - bh - (H > 100 ? 16 : 7);
        g.fillStyle = '#2a2730';
        g.fillRect(x + Math.floor(bw / 2) - 1, by + bh, 2, fwyY - by - bh);
        g.fillStyle = '#3a3640';
        g.fillRect(x - 1, by - 1, bw + 2, bh + 2);
        g.fillStyle = night > 0.5 ? '#1b1830' : '#f4efe3';
        g.fillRect(x, by, bw, bh);
        g.fillStyle = night > 0.5 ? NEON[bb.ci % NEON.length] : ['#e63946', '#2b2d42', '#f26b3a', '#3a86ff', '#8338ec'][bb.ci % 5];
        this.text(g, bb.text[0], x + 3, by + 2);
        g.fillStyle = night > 0.5 ? '#f4efe3' : '#2b2d42';
        this.text(g, bb.text[1], x + 3, by + 8);
        if (night > 0.5) { // spotlight
          g.globalAlpha = 0.12; g.fillStyle = '#fff6c2'; g.fillRect(x, by, bw, 4); g.globalAlpha = 1;
        }
      }
    }

    // blimp
    const cyc = 95000, bt = t % cyc;
    if (bt < 60000) {
      const k = bt / 60000;
      const bx = Math.round(-50 + k * (W + 100));
      const by = Math.round(fwyY * 0.2 + Math.sin(t / 2500) * 1.5);
      const bw = 34, bh = 11;
      g.fillStyle = night > 0.5 ? '#5d6175' : '#c9ccd6';
      g.fillRect(bx + 3, by, bw - 6, bh);
      g.fillRect(bx + 1, by + 2, bw - 2, bh - 4);
      g.fillRect(bx, by + 4, bw, bh - 8);
      g.fillStyle = night > 0.5 ? '#3d4052' : '#9aa0b5';
      g.fillRect(bx + 3, by + bh - 1, bw - 6, 1);
      g.fillRect(bx - 3, by + 2, 4, 2); g.fillRect(bx - 3, by + bh - 4, 4, 2);
      g.fillRect(bx + 13, by + bh, 8, 2);
      g.fillStyle = '#f26b3a';
      this.text(g, 'CMEM', bx + 9, by + 3);
      if (night > 0.5 && Math.floor(t / 600) % 2) { g.fillStyle = '#ff3b3b'; g.fillRect(bx + bw - 1, by + 5, 1, 1); }
    }

    // palms
    const po = scroll * 1.05;
    const palmC = night > 0.5 ? '#07060f' : mix('#1d2b22', sky.bottom, 0.15);
    for (const p of this.palms) {
      for (const off of [0, WW]) {
        const x0 = Math.floor(p.x + off - (po % WW));
        if (x0 < -20 || x0 > W + 20) continue;
        const ph = Math.round(H * p.h);
        g.fillStyle = palmC;
        let tx = x0, ty = ground;
        for (let i = 0; i < ph; i++) {
          tx = x0 + Math.round(p.lean * (i / ph) ** 2 * 5);
          ty = ground - i;
          g.fillRect(tx, ty, 1, 1);
        }
        const fr = H > 100 ? 9 : 6;
        for (const [ax, ay] of [[-1, 0.2], [1, 0.2], [-0.8, -0.5], [0.8, -0.5], [0, -0.9], [-0.4, 0.6], [0.4, 0.6]]) {
          for (let i = 1; i <= fr; i++) {
            const fx = Math.round(tx + ax * i);
            const fy = Math.round(ty + ay * i * 0.7 + (i * i) / (fr * 1.6));
            g.fillRect(fx, fy, 1, 1);
          }
        }
      }
    }

    // foreground strip
    g.fillStyle = night > 0.5 ? '#0b0a14' : mix('#2d3a2b', sky.bottom, 0.1);
    g.fillRect(0, ground, W, H - ground);
    g.fillStyle = night > 0.5 ? '#14121f' : mix('#3e5034', sky.bottom, 0.1);
    for (let x = -((po) % 5); x < W; x += 5) g.fillRect(Math.floor(x), ground, 2, 1);
  }

  building(g, b, x, baseY, t, night, sky) {
    const h = Math.round(b.hf * baseY);
    const y = baseY - h;
    const r = rng(b.seed);
    const pal = [
      ['#2d3b55', '#4b6a93'], // glass tower
      ['#5b5458', '#7d7478'], // concrete
      ['#25222f', '#3a3548'], // dark modern
      ['#6a5a4a', '#8a7863'], // campus brick
    ][b.kind];
    let body = night > 0.5 ? shade(pal[0], -0.45) : mix(pal[0], sky.bottom, 0.12);
    const edge = night > 0.5 ? shade(pal[1], -0.5) : mix(pal[1], sky.bottom, 0.1);
    g.fillStyle = body;
    g.fillRect(x, y, b.w, h);
    g.fillStyle = edge;
    g.fillRect(x, y, 1, h);
    g.fillRect(x, y, b.w, 1);
    // windows
    const lit = ['#ffd98a', '#fff1c1', '#9fe8ff', '#ffb36b'];
    for (let wy = y + 2; wy < baseY - 2; wy += 3) {
      for (let wx = x + 2; wx < x + b.w - 2; wx += b.kind === 0 ? 2 : 3) {
        const v = r();
        if (night > 0.5) {
          if (v < 0.3) {
            const flick = ((Math.floor(t / 4000) + Math.floor(v * 1000)) % 23) === 0;
            if (!flick) { g.fillStyle = lit[Math.floor(v * 13) % 4]; g.fillRect(wx, wy, 1, 1); }
          }
        } else if (v < 0.7) {
          g.fillStyle = b.kind === 0 ? mix(sky.top, '#ffffff', 0.25 + v * 0.3) : shade(body, -0.25);
          g.fillRect(wx, wy, 1, b.kind === 0 ? 2 : 1);
        }
      }
    }
    if (b.roofBox) { g.fillStyle = edge; g.fillRect(x + 2, y - 2, Math.min(5, b.w - 4), 2); }
    if (b.antenna) {
      g.fillStyle = edge;
      g.fillRect(x + b.w - 3, y - 6, 1, 6);
      if (night > 0.3 && Math.floor(t / 900 + b.x) % 2) { g.fillStyle = '#ff3b3b'; g.fillRect(x + b.w - 3, y - 7, 1, 1); }
    }
    if (b.sign !== null) {
      const s = this.signName(b.sign, t);
      const name = s.glitch && s.gt < 0.5 ? s.prev : s.name;
      const tw = textWidth(name);
      const sx = x + Math.round(b.w / 2 - tw / 2) - 2;
      const sy = y - 9;
      g.fillStyle = '#1a1820';
      g.fillRect(sx + 2, y - 2, 1, 2);
      g.fillRect(sx + tw, y - 2, 1, 2);
      if (night > 0.5) {
        g.fillStyle = '#0d0b14';
        g.fillRect(sx, sy, tw + 4, 7);
        const c = NEON[b.sign % NEON.length];
        if (s.glitch) {
          g.fillStyle = Math.floor(t / 60) % 2 ? '#ffffff' : c;
          if (s.gt > 0.35 && s.gt < 0.65) { g.fillRect(sx, sy, tw + 4, 7); return; }
        } else g.fillStyle = c;
        this.text(g, name, sx + 2, sy + 1);
        g.globalAlpha = 0.2;
        g.fillRect(sx, sy - 1, tw + 4, 9);
        g.globalAlpha = 1;
      } else {
        g.fillStyle = '#f4efe3';
        g.fillRect(sx, sy, tw + 4, 7);
        g.fillStyle = s.glitch && s.gt > 0.35 && s.gt < 0.65 ? '#ffffff' : ['#e63946', '#2b2d42', '#f26b3a', '#3a86ff', '#8338ec', '#2a9d8f'][b.sign % 6];
        this.text(g, name, sx + 2, sy + 1);
      }
    }
  }
}

function disc(g, cx, cy, r, color) {
  g.fillStyle = color;
  for (let y = -r; y <= r; y++) {
    const w = Math.floor(Math.sqrt(r * r - y * y));
    g.fillRect(cx - w, cy + y, w * 2 + 1, 1);
  }
}
