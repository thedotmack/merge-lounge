// The room renderer: isometric pixel lounge drawn at 1x into an offscreen scene,
// then scaled up by an integer factor. Text (names, bubbles, emoji) is drawn on top
// at device resolution so it stays crisp.
//
// How it stays cheap:
// - The backing store is capped at 2 device px per CSS px (pixel art scales cleanly; the canvas
//   hand-off to the compositor costs in proportion to its pixel count).
// - Everything that only changes with the ambient clock (the window view, ticker, neon, screens,
//   LEDs, plants, the bot) is drawn into cached layers at 12 fps: `walls` (window view + room +
//   wall signs) and `back` (walls + every piece of furniture).
// - Each frame copies `back`, then redraws only the rectangles around people and floor markers,
//   with the furniture that overlaps them, in depth order.
// - A frame is skipped entirely when nothing a person could see has changed: app.js writes
//   engine state directly, so render() keeps a cheap signature of everything it draws
//   (positions, sprites, bubbles, camera, hover, stats, the ambient tick) and compares it.
// - Name tags and bubbles are rendered once into small canvases and blitted.
import { W, H, FURNITURE, WALL_ITEMS, WALL_H, WINDOW, STEP_MS, dirFrom, reachable, furnitureAt, hash32, LOOK } from '/shared/world.js';
import { fillPoly, line, ellipsePts, shade, mix, rgba, pixelText, textWidth, rng, makeCanvas } from './pixel.js';
import { avatarSprite, AV_AX, AV_AY } from './avatar.js';
import { Valley, localHour, skyAt, BOARD_MS } from './valley.js';
import { fill, defaultConfig } from '/shared/config.js';

export const SW = 520, SH = 428, OX = 236, OY = 154;
export const P = (gx, gy, z = 0) => [OX + (gx - gy) * 16, OY + (gx + gy) * 8 - z];

const DPR_CAP = 2;            // backing store px per CSS px for whole-number pixel ratios above 2
const AMB_MS = 1000 / 12;     // ambient animation clock: 12 fps
const TICK_STEPS = 2;         // the ticker moves one character every 2 ambient ticks (~167 ms)
const RM_TICKER_MS = 10000;   // reduced motion: the ticker pages instead of scrolling
const TICKER_AT = 0.55, TICKER_HI = 92; // where the ticker strip sits on the window wall
// what the room covers in scene px (wall caps to the bottom of the floor slab): used for framing
const ROOM = { x0: 24, x1: 496, y0: 50, y1: 396 };
const BUBBLE_LIFE = 12000, BUBBLE_LIFE_BUSY = 8000, BUBBLE_FADE = 500, BUBBLE_POP = 150, BUBBLE_EVICT = 220;
const BUBBLE_LINES = 2;
const TALK_TAG_MS = BUBBLE_LIFE; // a speaker's name tag keeps first pick of the space this long
const TAG_GAP = 3;            // room px between the bottom of a sprite and its name tag
const BOT_THRUSTER_Y = 37;    // sprite row of the bot's thruster (drawn by drawAvatar, 2 rows + glow)
// Framing. A phone may crop up to ~1/6 of the room's width (and ~1/11 of its height) to get bigger
// pixels; anything else fits the whole room, with 4% of slack before it drops a zoom step.
const PHONE_CROP_W = 1.2, PHONE_CROP_H = 1.1, FIT_SLACK = 1.04;
// Camera follow: when the room doesn't fit, you're kept between these fractions of the view.
const FOLLOW_X0 = 0.28, FOLLOW_X1 = 0.72, FOLLOW_Y0 = 0.3, FOLLOW_Y1 = 0.72;
const MAX_S = 8;              // largest zoom, in backing px per room px

// Backing store px per CSS px for a device pixel ratio. Up to 2 it's the device's own ratio (one
// canvas px per device px). A whole ratio above 2 is capped at 2: on a 3x phone 2 canvas px become
// 3 device px, so a room pixel drawn 2 (or 4, 6…) canvas px wide still covers whole device pixels
// (see scaleStep). A fractional ratio above 2 (2.625 on Pixel phones) has no such pairing with 2,
// so it keeps its full ratio and every room pixel is a whole number of device pixels.
function backingRatio(raw) {
  if (!(raw > 0)) raw = 1;
  raw = Math.min(4, raw);
  return raw > DPR_CAP && Math.abs(raw - Math.round(raw)) < 0.01 ? DPR_CAP : raw;
}
// the smallest zoom step (in canvas px per room px) that lands on whole device pixels
function scaleStep(raw, dpr) {
  const k = raw / dpr;
  for (let n = 1; n <= 4; n++) if (Math.abs(n * k - Math.round(n * k)) < 0.02) return n;
  return 1;
}

// ------------------------------------------------------------------ furniture sprites
const FW = 64, FH = 116, FAX = 32, FAY = 92;
const LP = (lx, ly, z = 0) => [FAX + (lx - ly) * 16, FAY + (lx + ly) * 8 - z];

function box(g, x0, y0, x1, y1, z0, z1, c, opt = {}) {
  const top = opt.top || shade(c, 0.14), left = opt.left || c, right = opt.right || shade(c, -0.24);
  g.fillStyle = left;
  fillPoly(g, [LP(x0, y1, z1), LP(x1, y1, z1), LP(x1, y1, z0), LP(x0, y1, z0)]);
  g.fillStyle = right;
  fillPoly(g, [LP(x1, y0, z1), LP(x1, y1, z1), LP(x1, y1, z0), LP(x1, y0, z0)]);
  g.fillStyle = top;
  fillPoly(g, [LP(x0, y0, z1), LP(x1, y0, z1), LP(x1, y1, z1), LP(x0, y1, z1)]);
}
function faceL(g, lx0, lx1, ly, z0, z1, c) { // a rectangle on a +y facing plane
  g.fillStyle = c;
  fillPoly(g, [LP(lx0, ly, z1), LP(lx1, ly, z1), LP(lx1, ly, z0), LP(lx0, ly, z0)]);
}
function faceR(g, lx, ly0, ly1, z0, z1, c) { // a rectangle on a +x facing plane
  g.fillStyle = c;
  fillPoly(g, [LP(lx, ly0, z1), LP(lx, ly1, z1), LP(lx, ly1, z0), LP(lx, ly0, z0)]);
}
function topLine(g, a, b, c) {
  g.fillStyle = c;
  line(g, a[0], a[1], b[0], b[1]);
}

const HUES = ['#f26b3a', '#3a86ff', '#8338ec', '#2ec4b6', '#ffbe0b', '#ff6fb5'];
export const SEAT_H = { chair: 12, stool: 19, sofa: 11, beanbag: 7, armchair: 11 };

const PAINT = {
  desk: {
    base(g) {
      for (const [a, b] of [[0.1, 0.12], [0.84, 0.12], [0.1, 0.62], [0.84, 0.62]]) box(g, a, b, a + 0.06, b + 0.06, 0, 18, '#2b2b33');
      box(g, 0.06, 0.08, 0.94, 0.72, 18, 21, '#b98d62', { top: '#d4a87a' });
      box(g, 0.44, 0.16, 0.56, 0.26, 21, 24, '#2b2b33');
      box(g, 0.1, 0.12, 0.9, 0.2, 24, 38, '#15151c');
      box(g, 0.3, 0.44, 0.7, 0.58, 21, 22, '#20212b', { top: '#30313d' });
      box(g, 0.76, 0.46, 0.84, 0.54, 21, 25, '#f26b3a');
      box(g, 0.14, 0.46, 0.24, 0.6, 21, 22, '#2a2a33', { top: '#4a4a58' });
    },
  },
  chair: {
    base(g) {
      box(g, 0.28, 0.28, 0.72, 0.72, 0, 2, '#1c1c22');
      box(g, 0.46, 0.46, 0.54, 0.54, 2, 9, '#3a3a44');
      box(g, 0.2, 0.2, 0.8, 0.76, 9, 12, '#2b2d42', { top: '#3a3d5a' });
    },
    front(g) {
      box(g, 0.2, 0.72, 0.8, 0.86, 12, 31, '#2b2d42', { top: '#3a3d5a' });
      faceL(g, 0.44, 0.56, 0.86, 13, 30, '#f26b3a');
    },
  },
  stool: {
    base(g) {
      box(g, 0.34, 0.34, 0.66, 0.66, 0, 1, '#6b7086');
      box(g, 0.46, 0.46, 0.54, 0.54, 1, 17, '#9aa0b5');
      box(g, 0.36, 0.36, 0.64, 0.64, 7, 8, '#9aa0b5');
      box(g, 0.3, 0.3, 0.7, 0.7, 17, 20, '#8b4a2b', { top: '#a85d38' });
    },
  },
  sofa: {
    base(g, f) {
      const c = '#1f6f78';
      const L = f.part === 'L', R = f.part === 'R';
      box(g, 0, 0.12, 1, 0.9, 0, 6, '#174f55');
      box(g, 0, 0.1, 1, 0.34, 6, 25, c, { top: '#2a8f9a' });
      if (L) box(g, 0, 0.1, 0.16, 0.9, 6, 16, c, { top: '#2a8f9a' });
      box(g, L ? 0.16 : 0.02, 0.34, R ? 0.84 : 0.98, 0.9, 6, 11, '#2a8f9a', { top: '#39a6b1' });
      if (R) box(g, 0.84, 0.1, 1, 0.9, 6, 16, c, { top: '#2a8f9a' });
      if (L) box(g, 0.2, 0.3, 0.42, 0.4, 11, 19, '#f26b3a');
      if (R) box(g, 0.58, 0.3, 0.8, 0.4, 11, 18, '#ffbe0b');
    },
  },
  beanbag: {
    base(g, f) {
      const c = HUES[f.hue % HUES.length];
      g.fillStyle = 'rgba(0,0,0,0.28)';
      fillPoly(g, ellipsePts(32, 101, 13, 6));
      g.fillStyle = shade(c, -0.32);
      fillPoly(g, ellipsePts(32, 99, 12, 6));
      g.fillStyle = c;
      const up = ellipsePts(32, 91, 11, 5.5, 24).filter(([, y]) => y <= 91);
      const lo = ellipsePts(32, 98, 12, 6, 24).filter(([, y]) => y >= 98);
      fillPoly(g, [...up.sort((a, b) => a[0] - b[0]), ...lo.sort((a, b) => b[0] - a[0])]);
      g.fillStyle = shade(c, 0.16);
      fillPoly(g, ellipsePts(32, 90, 10, 4.5));
      const d = [[0, -1], [-2, 0], [0, 1], [2, 0]][[0, 1, 2, 3, 4, 5, 6, 7].indexOf(f.dir) % 4] || [0, 0];
      g.fillStyle = shade(c, -0.12);
      fillPoly(g, ellipsePts(32 - d[0] * 2, 89 - d[1], 6, 2.5));
      g.fillStyle = shade(c, 0.4);
      g.fillRect(25, 87, 3, 1);
    },
    front(g, f) {
      if (![0, 1, 7].includes(f.dir)) return false;
      const c = HUES[f.hue % HUES.length];
      g.fillStyle = c;
      const lo = ellipsePts(32, 97, 12, 6, 24).filter(([, y]) => y >= 97);
      fillPoly(g, [[20, 93], [44, 93], ...lo.sort((a, b) => b[0] - a[0])]);
      g.fillStyle = shade(c, 0.12);
      g.fillRect(22, 93, 20, 1);
      return true;
    },
  },
  table: {
    base(g) {
      for (const [a, b] of [[0.18, 0.18], [0.76, 0.18], [0.18, 0.76], [0.76, 0.76]]) box(g, a, b, a + 0.06, b + 0.06, 0, 7, '#1e1712');
      box(g, 0.14, 0.14, 0.86, 0.86, 7, 10, '#4a3527', { top: '#6b4c38' });
      box(g, 0.28, 0.38, 0.62, 0.62, 10, 11, '#c9ccd6');
      box(g, 0.28, 0.34, 0.62, 0.38, 11, 21, '#c9ccd6', { left: '#16243a' });
      faceL(g, 0.32, 0.5, 0.38, 18, 19, '#7dff8a');
      faceL(g, 0.32, 0.56, 0.38, 15, 16, '#33e1ff');
      faceL(g, 0.32, 0.44, 0.38, 12, 13, '#ff9a3c');
      box(g, 0.62, 0.58, 0.84, 0.82, 10, 12, '#e9dfc8', { top: '#f4ecd8' });
      box(g, 0.2, 0.68, 0.27, 0.75, 10, 15, '#2ec4b6');
    },
  },
  plant: {
    // sway: -1 | 0 | 1, leans the upper leaves by a pixel (the room keeps three frames per plant)
    base(g, f, sway = 0) {
      box(g, 0.3, 0.3, 0.7, 0.7, 0, 12, '#e9e4da', { right: '#bdb5a6' });
      faceL(g, 0.3, 0.7, 0.7, 8, 9, '#f26b3a');
      faceR(g, 0.7, 0.3, 0.7, 8, 9, '#c4532c');
      box(g, 0.34, 0.34, 0.66, 0.66, 12, 12.5, '#3b2a1f');
      const r = rng(hash32(f.id));
      const n = f.tall ? 13 : 8;
      const maxZ = f.tall ? 48 : 28;
      const leaves = Array.from({ length: n }, () => ({ z: 14 + r() * (maxZ - 14), ox: (r() - 0.5) * (f.tall ? 20 : 16), rx: 3 + r() * 3, c: ['#2f8f4e', '#3fae5f', '#237a3f', '#4cc26c'][Math.floor(r() * 4)] }));
      leaves.sort((a, b) => a.z - b.z);
      for (const l of leaves) {
        const lean = Math.round(sway * ((l.z - 14) / (maxZ - 14)) * 1.6);
        const cx = 32 + l.ox + lean, cy = FAY + 8 - 12 - (l.z - 12);
        g.fillStyle = '#1d5c33';
        line(g, 32, FAY + 8 - 13, cx, cy + 1);
        g.fillStyle = shade(l.c, -0.3);
        fillPoly(g, ellipsePts(cx, cy + 1, l.rx, l.rx * 0.55, 12));
        g.fillStyle = l.c;
        fillPoly(g, ellipsePts(cx, cy, l.rx, l.rx * 0.5, 12));
        g.fillStyle = shade(l.c, 0.35);
        g.fillRect(Math.round(cx - 1), Math.round(cy - 1), 2, 1);
      }
    },
  },
  fridge: {
    base(g) {
      box(g, 0.06, 0.06, 0.94, 0.64, 0, 56, '#dfe3ea', { right: '#aab1bf' });
      faceL(g, 0.12, 0.88, 0.64, 5, 50, '#0f2230');
      faceL(g, 0.12, 0.88, 0.64, 46, 50, '#9fe8ff');
      const bottles = ['#c9772b', '#ff6fb5', '#7dff8a', '#ffbe0b', '#e63946', '#33e1ff'];
      for (const [i, z] of [16, 28, 40].entries()) {
        faceL(g, 0.12, 0.88, 0.64, z, z + 1, '#3a5566');
        for (let k = 0; k < 6; k++) {
          const lx = 0.16 + k * 0.12;
          faceL(g, lx, lx + 0.08, 0.64, z + 1, z + 8, bottles[(k + i * 2) % 6]);
          faceL(g, lx, lx + 0.08, 0.64, z + 8, z + 9, '#e8e8e8');
        }
      }
      faceL(g, 0.06, 0.94, 0.64, 51, 56, '#f26b3a');
      faceL(g, 0.8, 0.84, 0.64, 20, 36, '#9aa0b5');
    },
  },
  bar: {
    base(g, f) {
      box(g, 0, 0.06, 1, 0.72, 0, 22, '#3a2a22');
      for (let k = 0; k < 8; k++) faceL(g, k / 8 + 0.02, k / 8 + 0.08, 0.72, 2, 20, '#4b372b');
      box(g, 0, 0.02, 1, 0.78, 22, 24, '#e8e3d9', { top: '#f4f0e8' });
      if (f.espresso) {
        box(g, 0.16, 0.12, 0.66, 0.42, 24, 37, '#c9ccd6', { top: '#dfe2ea' });
        box(g, 0.34, 0.42, 0.48, 0.5, 28, 31, '#3a3a44');
        faceL(g, 0.2, 0.26, 0.42, 33, 35, '#e63946');
        box(g, 0.74, 0.24, 0.86, 0.36, 24, 31, '#7a4a2a', { top: '#c9ccd6' });
      } else {
        box(g, 0.4, 0.2, 0.5, 0.3, 24, 37, '#9aa0b5');
        box(g, 0.3, 0.3, 0.6, 0.36, 33, 35, '#c9ccd6');
        box(g, 0.32, 0.36, 0.36, 0.4, 28, 33, '#2b2b33');
        box(g, 0.52, 0.36, 0.56, 0.4, 28, 33, '#2b2b33');
        box(g, 0.66, 0.3, 0.8, 0.44, 24, 32, '#f4f1de');
        box(g, 0.66, 0.3, 0.8, 0.44, 32, 33, '#3b2416');
      }
    },
  },
  arcade: {
    base(g, f) {
      const hc = f.hue === 'pink' ? '#ff5fa2' : '#33e1ff';
      box(g, 0.16, 0.16, 0.84, 0.74, 0, 52, '#1d1b2e', { top: '#2b2840' });
      faceR(g, 0.84, 0.24, 0.32, 4, 48, hc);
      faceR(g, 0.84, 0.44, 0.48, 4, 48, shade(hc, -0.3));
      faceR(g, 0.84, 0.6, 0.66, 4, 48, hc);
      faceL(g, 0.2, 0.8, 0.74, 45, 51, mix(hc, '#ffffff', 0.25));
      faceL(g, 0.2, 0.8, 0.74, 27, 43, '#0a0912');
      box(g, 0.18, 0.74, 0.82, 0.96, 21, 25, '#2b2840', { top: '#3a3655' });
      g.fillStyle = '#e63946'; const a = LP(0.4, 0.84, 25); g.fillRect(Math.round(a[0]), Math.round(a[1]), 2, 1);
      g.fillStyle = '#ffbe0b'; const b = LP(0.6, 0.84, 25); g.fillRect(Math.round(b[0]), Math.round(b[1]), 2, 1);
      faceL(g, 0.42, 0.58, 0.74, 10, 14, '#3a3650');
      faceL(g, 0.48, 0.52, 0.74, 11, 13, '#e63946');
    },
  },
  rack: {
    base(g) {
      box(g, 0.06, 0.08, 0.66, 0.92, 0, 58, '#1b1d26', { top: '#2a2d3a', right: '#14161d' });
      for (let z = 6; z < 54; z += 6) faceR(g, 0.66, 0.1, 0.9, z, z + 1, '#0c0d12');
      faceR(g, 0.66, 0.1, 0.9, 54, 57, '#f26b3a');
      faceL(g, 0.06, 0.66, 0.92, 2, 56, '#20232e');
    },
  },
  gong: {
    base(g) {
      box(g, 0.06, 0.74, 0.26, 0.92, 0, 3, '#3b2718');
      box(g, 0.74, 0.06, 0.92, 0.26, 0, 3, '#3b2718');
      box(g, 0.12, 0.79, 0.2, 0.87, 3, 47, '#6b4630');
      box(g, 0.79, 0.12, 0.87, 0.2, 3, 47, '#6b4630');
      const a = LP(0.16, 0.83, 47), b = LP(0.83, 0.16, 47);
      g.fillStyle = '#7a5236';
      g.fillRect(Math.round(a[0]) - 2, Math.round(a[1]) - 2, Math.round(b[0] - a[0]) + 5, 3);
      g.fillStyle = '#9a6a46';
      g.fillRect(Math.round(a[0]) - 2, Math.round(a[1]) - 2, Math.round(b[0] - a[0]) + 5, 1);
      g.fillStyle = '#5a3a22';
      line(g, 46, FAY + 2, 50, FAY - 18);
      g.fillStyle = '#e8e3d9';
      g.fillRect(49, FAY - 21, 3, 3);
    },
  },
  lavalamp: {
    base(g) {
      box(g, 0.22, 0.22, 0.78, 0.78, 0, 15, '#2b2d42', { top: '#3a3d56' });
      box(g, 0.42, 0.42, 0.58, 0.58, 15, 19, '#c9ccd6');
      g.fillStyle = '#4a1f6e';
      fillPoly(g, [[29, FAY + 8 - 19], [36, FAY + 8 - 19], [35, FAY + 8 - 36], [30, FAY + 8 - 36]]);
      box(g, 0.44, 0.44, 0.56, 0.56, 36, 39, '#c9ccd6');
    },
  },
  pingpong: {
    base(g, f) {
      const L = f.part === 'L';
      const legs = L ? [[0.1, 0.16], [0.1, 0.78]] : [[0.84, 0.16], [0.84, 0.78]];
      for (const [a, b] of legs) box(g, a, b, a + 0.06, b + 0.06, 0, 15, '#2b2b33');
      if (L) box(g, 0.04, 0.1, 1, 0.9, 15, 17, '#1f7a4d', { top: '#24905a' });
      else box(g, 0, 0.1, 0.96, 0.9, 15, 17, '#1f7a4d', { top: '#24905a' });
      const W1 = L ? 0.06 : 0, W2 = L ? 1 : 0.94;
      topLine(g, LP(W1, 0.12, 17), LP(W2, 0.12, 17), '#e8f5ec');
      topLine(g, LP(W1, 0.88, 17), LP(W2, 0.88, 17), '#e8f5ec');
      topLine(g, LP(W1, 0.5, 17), LP(W2, 0.5, 17), '#bfe3cc');
      if (L) topLine(g, LP(0.06, 0.12, 17), LP(0.06, 0.88, 17), '#e8f5ec');
      else topLine(g, LP(0.94, 0.12, 17), LP(0.94, 0.88, 17), '#e8f5ec');
      if (L) {
        g.fillStyle = '#e63946'; fillPoly(g, ellipsePts(LP(0.4, 0.66, 17)[0], LP(0.4, 0.66, 17)[1], 3, 1.6));
        g.fillStyle = '#8b5a2b'; g.fillRect(Math.round(LP(0.4, 0.66, 17)[0]) + 2, Math.round(LP(0.4, 0.66, 17)[1]) + 1, 3, 1);
      } else {
        faceR(g, 0.02, 0.06, 0.94, 17, 22, 'rgba(235,240,240,0.55)');
        faceR(g, 0.02, 0.06, 0.94, 21, 22, '#f4f4f4');
        g.fillStyle = '#1b1b22'; fillPoly(g, ellipsePts(LP(0.62, 0.34, 17)[0], LP(0.62, 0.34, 17)[1], 3, 1.6));
        g.fillStyle = '#ff9a3c'; const b = LP(0.72, 0.66, 19); g.fillRect(Math.round(b[0]), Math.round(b[1]), 1, 1);
      }
    },
  },
  armchair: {
    base(g, f) {
      const c = '#c98f2e', cd = '#8a5a1a', top = '#dba446';
      box(g, 0.12, 0.12, 0.88, 0.88, 0, 7, cd);
      if (f.dir === 3) {
        box(g, 0.1, 0.12, 0.3, 0.88, 7, 25, c, { top });
        box(g, 0.3, 0.1, 0.88, 0.24, 7, 15, c, { top });
        box(g, 0.3, 0.24, 0.86, 0.76, 7, 11, shade(c, 0.08), { top: '#e6b65a' });
        box(g, 0.3, 0.76, 0.88, 0.9, 7, 15, c, { top });
      } else {
        box(g, 0.12, 0.1, 0.7, 0.24, 7, 15, c, { top });
        box(g, 0.14, 0.24, 0.7, 0.76, 7, 11, shade(c, 0.08), { top: '#e6b65a' });
      }
    },
    front(g, f) {
      if (f.dir === 3) return false;
      const c = '#c98f2e', top = '#dba446';
      box(g, 0.12, 0.76, 0.7, 0.9, 7, 15, c, { top });
      box(g, 0.7, 0.12, 0.9, 0.88, 7, 25, c, { top });
      return true;
    },
  },
  sidetable: {
    base(g) {
      box(g, 0.24, 0.24, 0.76, 0.76, 0, 13, '#4a3527');
      box(g, 0.2, 0.2, 0.8, 0.8, 13, 14, '#5d4432', { top: '#7a5a44' });
      box(g, 0.26, 0.48, 0.56, 0.74, 14, 16, '#3a86ff');
      box(g, 0.28, 0.5, 0.54, 0.72, 16, 18, '#e63946');
      box(g, 0.3, 0.52, 0.5, 0.7, 18, 19, '#ffbe0b');
      box(g, 0.6, 0.3, 0.66, 0.36, 14, 26, '#c9ccd6');
      const c = LP(0.63, 0.33, 26);
      g.fillStyle = '#ffd98a';
      fillPoly(g, [[c[0] - 4, c[1] + 1], [c[0] + 5, c[1] + 1], [c[0] + 3, c[1] - 5], [c[0] - 2, c[1] - 5]]);
      g.fillStyle = '#ffe9b8';
      g.fillRect(Math.round(c[0]) - 1, Math.round(c[1]) - 4, 3, 1);
    },
  },
  button: {
    base(g) {
      box(g, 0.3, 0.3, 0.7, 0.7, 0, 18, '#d9dde6', { right: '#a9afbe' });
      faceL(g, 0.3, 0.7, 0.7, 2, 7, '#ffbe0b');
      faceR(g, 0.7, 0.3, 0.7, 2, 7, '#d49a00');
      g.fillStyle = '#1b1b22';
      for (let k = 0; k < 4; k++) {
        const a = LP(0.33 + k * 0.1, 0.7, 2), b = LP(0.38 + k * 0.1, 0.7, 7);
        line(g, a[0], a[1], b[0], b[1]);
      }
      box(g, 0.26, 0.26, 0.74, 0.74, 18, 20, '#2b2d42', { top: '#3a3d56' });
    },
  },
};


function buildFurnSprite(f, layer, extra) {
  const p = PAINT[f.kind];
  if (!p || !p[layer]) return null;
  const [c, g] = makeCanvas(FW, FH);
  const r = p[layer](g, f, extra);
  if (r === false) return null;
  return c;
}

// bounding box of the non-transparent pixels of a canvas, or null
function alphaBounds(cv) {
  if (!cv) return null;
  const { width: w, height: h } = cv;
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}
function unionBox(a, b) {
  if (!a) return b; if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

// ------------------------------------------------------------------ wall buffers
function leftWallXform(g, a, b, hi) { g.setTransform(1, -0.5, 0, 1, Math.round(OX - b * 16), Math.round(OY + b * 8 - hi)); }
function rightWallXform(g, a, hi) { g.setTransform(1, 0.5, 0, 1, Math.round(OX + a * 16), Math.round(OY + a * 8 - hi)); }
// Shearing a 3x5 font tears the glyphs apart, so text on a wall is drawn upright one glyph at a
// time, each glyph stepped to follow the wall's slope. Coordinates are in the item's flat space.
const leftWallOrigin = (b, hi) => [Math.round(OX - b * 16), Math.round(OY + b * 8 - hi), -0.5];
const rightWallOrigin = (a, hi) => [Math.round(OX + a * 16), Math.round(OY + a * 8 - hi), 0.5];
function wallText(g, origin, s, x, y, scale = 1, clipW = Infinity) {
  const [X, Y, slope] = origin;
  s = String(s);
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') continue;
    const cx = x + i * 4 * scale;
    if (cx < 0 || cx + 3 * scale > clipW) continue;
    pixelText(g, s[i], X + cx, Y + y + Math.round(slope * (cx + 1.5 * scale)), scale);
  }
}

function buildDoor() {
  const [c, g] = makeCanvas(16, 58);
  g.fillStyle = '#4b3f86'; g.fillRect(0, 0, 16, 58);
  g.fillStyle = '#0b0814'; g.fillRect(2, 2, 12, 56);
  for (let y = 30; y < 58; y++) { g.fillStyle = mix('#0b0814', '#3a2a55', (y - 30) / 28); g.fillRect(2, y, 12, 1); }
  g.fillStyle = '#5d50a0'; g.fillRect(0, 0, 16, 1);
  return c;
}
function buildExit() { // the box; the word goes on upright with wallText
  const [c, g] = makeCanvas(18, 8);
  g.fillStyle = '#0d2a18'; g.fillRect(0, 0, 18, 8);
  g.fillStyle = '#1d4a2c'; g.fillRect(0, 0, 18, 1);
  return c;
}
function buildPoster() { // the art; its two words go on upright with wallText
  const [c, g] = makeCanvas(29, 40);
  g.fillStyle = '#e63946'; g.fillRect(0, 0, 29, 40);
  g.fillStyle = '#f4efe3'; g.fillRect(1, 1, 27, 38);
  g.fillStyle = '#8338ec';
  // a little merge graph: two branches meeting
  g.fillRect(9, 12, 1, 16); g.fillRect(19, 12, 1, 8);
  g.fillRect(10, 22, 1, 1); g.fillRect(11, 23, 1, 1); g.fillRect(12, 24, 1, 1); g.fillRect(18, 20, 1, 1); g.fillRect(17, 21, 1, 1);
  g.fillRect(13, 24, 4, 1); g.fillRect(16, 22, 1, 2);
  g.fillStyle = '#f26b3a'; g.fillRect(8, 11, 3, 3); g.fillRect(18, 11, 3, 3); g.fillRect(8, 27, 3, 3);
  return c;
}
// two small framed pictures for the left wall (no lettering)
function buildFrameGraph() {
  const [c, g] = makeCanvas(12, 12);
  g.fillStyle = '#6b4630'; g.fillRect(0, 0, 12, 12);
  g.fillStyle = '#8a5d40'; g.fillRect(0, 0, 12, 1);
  g.fillStyle = '#10161a'; g.fillRect(1, 1, 10, 10);
  const greens = ['#1d3324', '#1f6b3a', '#2f9a52', '#5fd17c'];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    g.fillStyle = greens[(hash32(`cg${x},${y}`) >>> 2) % 4];
    g.fillRect(2 + x * 2, 2 + y * 2, 1, 1);
  }
  return c;
}
function buildFrameRocket() {
  const [c, g] = makeCanvas(12, 12);
  g.fillStyle = '#2b2d42'; g.fillRect(0, 0, 12, 12);
  g.fillStyle = '#3a3d5a'; g.fillRect(0, 0, 12, 1);
  g.fillStyle = '#1b1838'; g.fillRect(1, 1, 10, 10);
  g.fillStyle = '#c9d4ff'; g.fillRect(2, 2, 1, 1); g.fillRect(9, 3, 1, 1); g.fillRect(3, 8, 1, 1);
  g.fillStyle = '#f4f1de'; g.fillRect(5, 3, 2, 5); g.fillRect(4, 6, 1, 2); g.fillRect(7, 6, 1, 2);
  g.fillStyle = '#33e1ff'; g.fillRect(5, 4, 2, 1);
  g.fillStyle = '#ff8a4c'; g.fillRect(5, 8, 2, 1);
  g.fillStyle = '#ffd166'; g.fillRect(5, 9, 1, 1);
  return c;
}
// The neon sign: a small top line and a big bottom line (config.neon), centred, each scaled to fit.
// Unlike the rest of the wall lettering (upright glyphs from wallText), the sign is lettered flat in
// its own buffer and the whole board is sheared onto the wall, on purpose: it reads as a neon sign
// mounted flat against the wall, tubes following the wall's slope like the poster and the frames.
function buildNeon(on, neon = {}) {
  const NW = 47, NH = 34, fitW = NW - 2;
  const [c, g] = makeCanvas(NW, NH);
  g.fillStyle = '#17112c'; g.fillRect(0, 0, NW, NH);
  g.fillStyle = '#2a2050'; g.fillRect(0, 0, NW, 1); g.fillRect(0, 33, NW, 1); g.fillRect(0, 0, 1, NH); g.fillRect(46, 0, 1, NH);
  const orange = on ? '#ff8a4c' : '#7a4630', pink = on ? '#ff5fa2' : '#6a2f4a';
  let top = String(neon.top || '');
  while (top && textWidth(top) > fitW) top = top.slice(0, -1);
  let bottom = String(neon.bottom || '');
  while (bottom && textWidth(bottom) > fitW) bottom = bottom.slice(0, -1);
  const bs = [3, 2, 1].find((k) => textWidth(bottom, k) <= fitW) || 1;
  const tx = Math.floor((NW - textWidth(top)) / 2), ty = 5;
  // the big line sits in rows 13-27 (15 px, a scale-3 glyph); smaller scales centre in that band,
  // or in the whole sign when there is no top line
  const band = top ? [13, 15] : [3, 25];
  const bx = Math.floor((NW - textWidth(bottom, bs)) / 2), by = band[0] + Math.floor((band[1] - 5 * bs) / 2);
  if (on) {
    g.globalAlpha = 0.3;
    g.fillStyle = orange;
    if (top) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) pixelText(g, top, tx + dx, ty + dy);
    g.fillStyle = pink;
    if (bottom) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) pixelText(g, bottom, bx + dx, by + dy, bs);
    g.globalAlpha = 1;
  }
  g.fillStyle = orange; if (top) pixelText(g, top, tx, ty);
  g.fillStyle = pink; if (bottom) pixelText(g, bottom, bx, by, bs);
  g.fillStyle = on ? '#ffd2e6' : pink;
  if (bottom && bs === 3) for (let x = bx + 1; x < bx + textWidth(bottom, bs); x += 5) g.fillRect(x, by + 1, 1, 1);
  g.fillStyle = on ? '#33e1ff' : '#1d4a55';
  g.fillRect(6, 30, 35, 1);
  return c;
}

function buildFame(list) {
  const [c, g] = makeCanvas(61, 46);
  g.fillStyle = '#6b4630'; g.fillRect(0, 0, 61, 46);
  g.fillStyle = '#8a5d40'; g.fillRect(0, 0, 61, 1);
  g.fillStyle = '#4a2f1f'; g.fillRect(0, 45, 61, 1);
  g.fillStyle = '#141226'; g.fillRect(2, 2, 57, 42);
  const cols = 28, rows = 12;
  let i = 0;
  for (const p of list || []) {
    if (i >= cols * rows) break;
    const col = i % cols, row = Math.floor(i / cols);
    const x = 3 + col * 2, y = 11 + row * 2;
    const hue = HUES[hash32(p.login) % HUES.length];
    g.fillStyle = p.online ? '#7dff8a' : p.visited ? hue : shade(hue, -0.62);
    g.fillRect(x, y, 1, 1);
    i++;
  }
  if (!list) {
    g.fillStyle = '#2a2547';
    for (let k = 0; k < cols * rows; k++) g.fillRect(3 + (k % cols) * 2, 11 + Math.floor(k / cols) * 2, 1, 1);
  }
  return c;
}
// the board's lettering, drawn upright on the wall by wallText(). "N MERGED" counts people (one pixel
// each), not PRs; "N CONTRIBUTORS" would run past the 57 px board in the 3x5 font.
function fameText(list) {
  const label = `${list ? list.length : 0} MERGED`;
  return [
    { s: 'WALL OF FAME', x: 7, y: 4, color: '#ffd166' },
    { s: label, x: 58 - textWidth(label), y: 37, color: '#a59fc7' },
  ];
}
function buildTickerBg(w) {
  const [c, g] = makeCanvas(w, 7);
  g.fillStyle = '#07060c'; g.fillRect(0, 0, w, 7);
  g.fillStyle = '#1a1206';
  for (let x = 0; x < w; x += 2) for (let y = 1; y < 6; y += 2) g.fillRect(x, y, 1, 1);
  return c;
}

// ------------------------------------------------------------------ static room
function buildStatic() {
  const [c, g] = makeCanvas(SW, SH);
  const poly = (pts, color) => { g.fillStyle = color; fillPoly(g, pts); };
  const seg = (a, b, color) => { g.fillStyle = color; line(g, a[0], a[1], b[0], b[1]); };

  // walls
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, WALL_H), P(0, 0, WALL_H)], '#30275a');
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, 28), P(0, 0, 28)], '#251e47');
  poly([P(0, 0, 27), P(0, H, 27), P(0, H, 30), P(0, 0, 30)], '#4b3f86');
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, 3), P(0, 0, 3)], '#1a1433');
  poly([P(0, 0, 95), P(0, H, 95), P(0, H, WALL_H), P(0, 0, WALL_H)], '#3d3373');
  g.fillStyle = '#1f1940';
  for (let a = 0.5; a < H; a += 0.5) { const p0 = P(0, a, 4), p1 = P(0, a, 26); line(g, p0[0], p0[1], p1[0], p1[1]); }
  // trim: wainscot cap, skirting and crown highlights
  seg(P(0, 0, 30), P(0, H, 30), '#5d50a0');
  seg(P(0, 0, 3), P(0, H, 3), '#3b3170');
  seg(P(0, 0, 95), P(0, H, 95), '#4f4390');

  poly([P(0, 0, 0), P(W, 0, 0), P(W, 0, WALL_H), P(0, 0, WALL_H)], '#2a2350');
  poly([P(0, 0, 0), P(W, 0, 0), P(W, 0, 3), P(0, 0, 3)], '#1a1433');
  poly([P(0, 0, 95), P(W, 0, 95), P(W, 0, WALL_H), P(0, 0, WALL_H)], '#3a3070');
  seg(P(0, 0, 3), P(W, 0, 3), '#382e6b');
  seg(P(0, 0, 95), P(W, 0, 95), '#4a3f88');
  for (let x = 1; x < W; x += 2) seg(P(x, 0, 4), P(x, 0, 8), '#221c45'); // panel seams under the window
  // cut the window out
  g.globalCompositeOperation = 'destination-out';
  poly([P(WINDOW.a, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.hi), P(WINDOW.a, 0, WINDOW.hi)], '#000');
  g.globalCompositeOperation = 'source-over';
  // glass tint + reflections
  poly([P(WINDOW.a, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.hi), P(WINDOW.a, 0, WINDOW.hi)], 'rgba(150,190,255,0.07)');
  const panes = 8, pw = (WINDOW.b - WINDOW.a) / panes;
  for (let k = 0; k < panes; k++) {
    const g0 = WINDOW.a + k * pw;
    poly([P(g0 + pw * 0.55, 0, WINDOW.hi), P(g0 + pw * 0.8, 0, WINDOW.hi), P(g0 + pw * 0.35, 0, WINDOW.lo), P(g0 + pw * 0.1, 0, WINDOW.lo)], 'rgba(255,255,255,0.05)');
  }
  for (let k = 0; k <= panes; k++) {
    const gx = WINDOW.a + k * pw;
    poly([P(gx - 0.07, 0, WINDOW.lo), P(gx + 0.07, 0, WINDOW.lo), P(gx + 0.07, 0, WINDOW.hi + 1), P(gx - 0.07, 0, WINDOW.hi + 1)], '#191431');
    g.fillStyle = '#463b85';
    const a = P(gx + 0.07, 0, WINDOW.lo), b = P(gx + 0.07, 0, WINDOW.hi);
    line(g, a[0], a[1], b[0], b[1]);
  }
  poly([P(WINDOW.a, 0, WINDOW.hi), P(WINDOW.b, 0, WINDOW.hi), P(WINDOW.b, 0, WINDOW.hi + 2), P(WINDOW.a, 0, WINDOW.hi + 2)], '#191431');
  poly([P(WINDOW.a, 0, 59), P(WINDOW.b, 0, 59), P(WINDOW.b, 0, 61), P(WINDOW.a, 0, 61)], '#191431');
  // sill
  poly([P(WINDOW.a, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.lo), P(WINDOW.b, 0.16, WINDOW.lo), P(WINDOW.a, 0.16, WINDOW.lo)], '#5a4d99');
  poly([P(WINDOW.a, 0.16, WINDOW.lo), P(WINDOW.b, 0.16, WINDOW.lo), P(WINDOW.b, 0.16, WINDOW.lo - 3), P(WINDOW.a, 0.16, WINDOW.lo - 3)], '#3b3170');
  // ticker housing
  poly([P(0.4, 0, 85), P(15.6, 0, 85), P(15.6, 0, 94), P(0.4, 0, 94)], '#2c2458');
  poly([P(0.5, 0, 86), P(15.5, 0, 86), P(15.5, 0, 93), P(0.5, 0, 93)], '#07060c');

  // corner seam and wall caps
  g.fillStyle = '#4b3f86';
  { const a = P(0, 0, 0), b = P(0, 0, WALL_H); line(g, a[0], a[1], b[0], b[1]); }
  poly([P(0, 0, WALL_H), P(0, H, WALL_H), P(-0.22, H, WALL_H), P(-0.22, -0.22, WALL_H)], '#4f4390');
  poly([P(0, 0, WALL_H), P(W, 0, WALL_H), P(W, -0.22, WALL_H), P(-0.22, -0.22, WALL_H)], '#463b82');
  poly([P(-0.22, H, 0), P(0, H, 0), P(0, H, WALL_H), P(-0.22, H, WALL_H)], '#1f1940');
  poly([P(W, -0.22, 0), P(W, 0, 0), P(W, 0, WALL_H), P(W, -0.22, WALL_H)], '#1a1538');
  // floor slab edges
  poly([P(0, H, 0), P(W, H, 0), P(W, H, -8), P(0, H, -8)], '#2a1b12');
  poly([P(W, 0, 0), P(W, H, 0), P(W, H, -8), P(W, 0, -8)], '#1d130c');
  poly([P(0, H, -7), P(W, H, -7), P(W, H, -8), P(0, H, -8)], '#140d08');

  // floor planks
  const woods = ['#5b3d2b', '#634330', '#573a28', '#6a4733', '#5f402d'];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let s = 0; s < 4; s++) {
        const y0 = y + s / 4, y1 = y + (s + 1) / 4;
        poly([P(x, y0), P(x + 1, y0), P(x + 1, y1), P(x, y1)], woods[(hash32(`${x},${y},${s}`) >>> 3) % woods.length]);
      }
    }
  }
  g.fillStyle = '#3e281b';
  for (let k = 0; k <= H * 4; k++) { const a = P(0, k / 4), b = P(W, k / 4); line(g, a[0], a[1], b[0], b[1]); }
  for (let y = 0; y < H; y++) for (let s = 0; s < 4; s++) {
    const r = hash32(`seam${y},${s}`);
    for (let x = (r % 3); x < W; x += 2 + (r % 2)) {
      const j = x + ((r >>> 5) % 100) / 100;
      const a = P(j, y + s / 4), b = P(j, y + (s + 1) / 4);
      line(g, a[0], a[1], b[0], b[1]);
    }
  }
  // the floor darkens a little toward the walls (ambient occlusion)
  poly([P(0, 0), P(W, 0), P(W, 0.35), P(0.35, 0.35), P(0.35, H), P(0, H)], 'rgba(10,6,24,0.16)');
  poly([P(0, 0), P(W, 0), P(W, 0.14), P(0.14, 0.14), P(0.14, H), P(0, H)], 'rgba(10,6,24,0.14)');
  // rug
  poly([P(4.25, 4.25), P(8.75, 4.25), P(8.75, 8.75), P(4.25, 8.75)], '#f26b3a');
  poly([P(4.45, 4.45), P(8.55, 4.45), P(8.55, 8.55), P(4.45, 8.55)], '#2a2350');
  poly([P(4.9, 4.9), P(8.1, 4.9), P(8.1, 8.1), P(4.9, 8.1)], '#ff5fa2');
  poly([P(5.0, 5.0), P(8.0, 5.0), P(8.0, 8.0), P(5.0, 8.0)], '#352d66');
  poly([P(6.5, 5.6), P(7.4, 6.5), P(6.5, 7.4), P(5.6, 6.5)].map(([x, y]) => [x, y]), '#f26b3a');
  for (let k = 0; k < 18; k++) {
    g.fillStyle = '#ffb38a';
    const a = P(4.25 + k * 0.25, 8.75), b = P(8.75, 4.25 + k * 0.25);
    g.fillRect(Math.round(a[0]), Math.round(a[1]) + 1, 1, 2);
    g.fillRect(Math.round(b[0]) + 1, Math.round(b[1]), 1, 2);
  }
  // soft contact shadows under the furniture (beanbags draw their own)
  for (const f of FURNITURE) {
    if (f.kind === 'beanbag') continue;
    const small = f.kind === 'plant' || f.kind === 'stool' || f.kind === 'lavalamp' || f.kind === 'button' || f.kind === 'sidetable';
    const rings = small ? [[0.2, 0.13], [0.3, 0.12]] : [[0.02, 0.12], [0.14, 0.12]];
    for (const [k, a] of rings) poly([P(f.x + k, f.y + k), P(f.x + 1 - k, f.y + k), P(f.x + 1 - k, f.y + 1 - k), P(f.x + k, f.y + 1 - k)], `rgba(8,4,18,${a})`);
  }
  // door mat + light spill
  poly([P(0.05, 9.1), P(0.9, 9.1), P(0.9, 9.9), P(0.05, 9.9)], '#2b2d42');
  poly([P(0.15, 9.2), P(0.8, 9.2), P(0.8, 9.8), P(0.15, 9.8)], '#3a3d5a');
  poly([P(0, 9), P(1.4, 9), P(1.4, 10), P(0, 10)], 'rgba(255,214,150,0.06)');

  // wall details: outlets, a light switch by the door
  for (const a of [3.3, 8.45, 12.55]) {
    poly([P(0, a, 8), P(0, a + 0.22, 8), P(0, a + 0.22, 13), P(0, a, 13)], '#c9c3e0');
    g.fillStyle = '#4a4466';
    const s1 = P(0, a + 0.09, 11), s2 = P(0, a + 0.09, 9);
    g.fillRect(Math.round(s1[0]), Math.round(s1[1]), 1, 1); g.fillRect(Math.round(s2[0]), Math.round(s2[1]), 1, 1);
  }
  poly([P(0, 10.2, 31), P(0, 10.42, 31), P(0, 10.42, 38), P(0, 10.2, 38)], '#c9c3e0');
  { const s1 = P(0, 10.3, 35); g.fillStyle = '#6b6590'; g.fillRect(Math.round(s1[0]), Math.round(s1[1]), 1, 2); }

  // left wall art
  leftWallXform(g, 9, 10, 58); g.drawImage(buildDoor(), 0, 0);
  leftWallXform(g, 9, 10.06, 67); g.drawImage(buildExit(), 0, 0);
  const poster = WALL_ITEMS.find((w) => w.id === 'poster');
  leftWallXform(g, poster.a, poster.b, poster.hi); g.drawImage(buildPoster(), 0, 0);
  leftWallXform(g, 5.15, 5.9, 44); g.drawImage(buildFrameGraph(), 0, 0);
  leftWallXform(g, 7.15, 7.9, 44); g.drawImage(buildFrameRocket(), 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  // their lettering, upright
  g.fillStyle = '#3dff7a'; wallText(g, leftWallOrigin(10.06, 67), 'EXIT', 2, 2);
  const po = leftWallOrigin(poster.b, poster.hi);
  g.fillStyle = '#e63946'; wallText(g, po, 'MERGED', 3, 3);
  g.fillStyle = '#2b2d42'; wallText(g, po, 'LGTM', 7, 32);
  return c;
}

// where light can fall: the room (walls, floor, slab) plus the glass
function buildRoomMask(staticCv) {
  const [c, g] = makeCanvas(SW, SH);
  g.drawImage(staticCv, 0, 0);
  g.fillStyle = '#000';
  fillPoly(g, [P(WINDOW.a, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.lo), P(WINDOW.b, 0, WINDOW.hi), P(WINDOW.a, 0, WINDOW.hi)]);
  return c;
}

// light sources in scene px. night: only drawn after dark.
function roomLights() {
  const L = [];
  // tint: the pool is painted on the floor or wall (under the furniture); otherwise it only lifts the dark
  const add = (p, rx, ry, c, a, night = false, tint = true) => L.push({ x: p[0], y: p[1], rx, ry, c, a, night, tint });
  const air = (p, rx, ry, c, a) => add(p, rx, ry, c, a, false, false);
  for (const f of FURNITURE) {
    const c = (x, y, z = 0) => P(f.x + x, f.y + y, z);
    switch (f.kind) {
      case 'desk': air(c(0.5, 0.25, 40), 12, 12, '#8fd8ff', 0.2); add(c(0.5, 1.15), 26, 12, '#8fd8ff', 0.12); break;
      case 'lavalamp': air(c(0.5, 0.5, 27), 16, 20, '#ff5fa2', 0.22); add(c(0.9, 0.6), 36, 17, '#ff5fa2', 0.14); break;
      case 'sidetable': air(c(0.63, 0.33, 24), 18, 18, '#ffd98a', 0.26); add(c(0.5, 0.5), 44, 21, '#ffd98a', 0.16); break;
      case 'arcade': { const h = f.hue === 'pink' ? '#ff5fa2' : '#33e1ff'; air(c(0.5, 0.74, 35), 14, 14, h, 0.2); add(c(0.5, 1.3), 24, 11, h, 0.13); break; }
      case 'fridge': air(c(0.5, 0.64, 28), 18, 26, '#9fe8ff', 0.16); add(c(0.5, 1.2), 24, 11, '#9fe8ff', 0.1); break;
      case 'rack': air(c(0.7, 0.5, 30), 10, 22, '#7dff8a', 0.1); break;
      case 'button': air(c(0.5, 0.5, 20), 10, 8, '#ff3b3b', 0.14); break;
      case 'bar': if (f.espresso) air(c(0.4, 0.5, 30), 14, 10, '#ffbe7a', 0.12); break;
    }
  }
  const neon = WALL_ITEMS.find((w) => w.id === 'neon');
  const nm = (neon.a + neon.b) / 2;
  add(P(0, nm, (neon.lo + neon.hi) / 2), 30, 24, '#ff5fa2', 0.18);
  add(P(1.1, nm), 36, 15, '#ff8a4c', 0.1);
  add(P(0, 9.53, 63), 12, 8, '#3dff7a', 0.16);       // EXIT
  add(P(0.8, 9.5), 22, 10, '#ffd696', 0.12);         // light from the hallway
  for (const x of [3, 8, 13]) add(P(x, 1.4), 58, 24, '#7f9cff', 0.06, true); // city glow through the window
  for (const x of [2, 6, 10, 14]) add(P(x, 0, 89), 22, 8, '#ffb347', 0.08, true); // the ticker
  return L;
}

const SWAY_SEQ = [1, 2, 1, 0];
const byDepth = (a, b) => a.d - b.d;
const byTagPriority = (a, b) => (b.pri - a.pri) || (b.d - a.d);
const FRIDGE_HUM = Array.from({ length: 9 }, (_, i) => `rgba(159,232,255,${(0.03 + i * 0.0075).toFixed(4)})`);
const STEAM = Array.from({ length: 6 }, (_, i) => `rgba(236,236,250,${(0.12 + i * 0.09).toFixed(3)})`);

// a phone (or a small tablet) held either way round: touch-first and small
function isPhone() {
  try {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    return !!coarse && Math.min(window.innerWidth, window.innerHeight) < 600;
  } catch { return false; }
}
function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

// ------------------------------------------------------------------ engine
// The contract with app.js, which owns the render loop and the WebSocket and writes room state straight
// into the engine. Keep all of these when changing it (new methods are fine; app.js calls optional
// ones as engine.x?.()):
// - methods: render(t), resize(), invalidate(), setPaused(on), setReducedMotion(on), setBubblesHidden(on),
//   setFame(list), addBubble(uid, text, kind, extra), addReact(uid, emoji), addFx(kind, data),
//   pick(dxDev, dyDev), posOf(user, t), snapTo(gx, gy), zoomBy(step, anchorDx, anchorDy), panBy(dxCss, dyCss);
// - fields: users (id → person), selfId, stats, insets { top, bottom }, dpr, bubbles, follow, target,
//   hoverTile, hoverLabel, joinedAt.
export class Engine {
  // opts.config: the lounge config from /api/config (lettering, bot name, time zone)
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const cfg = this.cfg = opts.config || defaultConfig();
    [this.scene, this.sg] = makeCanvas(SW, SH);
    [this.walls, this.wallsG] = makeCanvas(SW, SH);   // window view + room + wall signs
    [this.back, this.backG] = makeCanvas(SW, SH);     // walls + all furniture
    this.static = buildStatic();
    this.roomMask = buildRoomMask(this.static);
    [this.light, this.lightG] = makeCanvas(SW, SH);           // the dark, with holes where lamps are (night)
    [this.floorLight, this.floorLightG] = makeCanvas(SW, SH); // sun patches and light pools, under the furniture
    this.lights = roomLights();
    this.lightBox = null;
    this.floorLightBox = null;
    this.valley = new Valley(undefined, { names: cfg.skyline.names, billboards: cfg.skyline.billboards, blimp: cfg.blimp, timezone: cfg.timezone });
    this.winW = Math.round((WINDOW.b - WINDOW.a) * 16) + 2;
    this.winH = WINDOW.hi - WINDOW.lo;
    [this.sky, this.skyG] = makeCanvas(this.winW, this.winH);
    this.tick = buildTickerBg(Math.round(15 * 16));
    // the ticker strip as it sits on the wall (sheared background + upright glyphs), cached
    [this.tickX, this.tickY] = rightWallOrigin(TICKER_AT, TICKER_HI);
    [this.tickCv, this.tickG] = makeCanvas(this.tick.width + 1, Math.ceil(this.tick.width * 0.5) + this.tick.height + 1);
    this.neonOn = buildNeon(true, cfg.neon);
    this.neonOff = buildNeon(false, cfg.neon);
    this.neonItem = WALL_ITEMS.find((w) => w.id === 'neon');
    this.fameItem = WALL_ITEMS.find((w) => w.id === 'fame');
    this.fameBuf = buildFame(null);
    this.fameText = fameText(null);
    this.furn = FURNITURE.map((f) => this.prepFurn(f));
    // draw order for the furniture (stable: same tile depth keeps the list order), and pick order
    this.furnDraw = [];
    for (const it of this.furn) {
      const d = it.f.x + it.f.y;
      this.furnDraw.push({ d, kind: 'f', it });
      if (it.front) this.furnDraw.push({ d: d + 0.75, kind: 'ff', it });
    }
    this.furnDraw.sort(byDepth);
    this.furnPick = this.furn.slice().sort((a, b) => (b.f.x + b.f.y) - (a.f.x + a.f.y));
    this.gongF = FURNITURE.find((x) => x.id === 'gong');
    this.shadowSpr = this.buildShadow(8, 3);
    this.botShadowSpr = this.buildShadow(5, 2);

    this.users = new Map();
    this.selfId = null;
    this.bubbles = [];
    this.reacts = [];
    this.fx = [];
    this.hoverTile = null;
    this.hoverLabel = null;
    this.target = null;
    this.stats = { contributors: 0, mergedPRs: 0, online: 0, gongs: 0, deploys: 0 };
    this.insets = { top: 0, bottom: 0 };
    this.cam = { x: 0, y: 0 };
    this.follow = true;
    this.s = 2;
    this.dpr = 1;
    this.cw = 1; this.ch = 1;
    this.userZoom = null;
    this.alphaCache = new WeakMap();
    this.joinedAt = 0;
    this.lastHour = localHour(cfg.timezone);
    this.hourAt = 0;

    // frame skipping, pausing, motion and bubble settings
    this.framesDrawn = 0;
    this.framesSkipped = 0;
    this._dirty = true;
    this._needNext = false;
    this._sig = []; this._sigK = 0; this._sigCh = false;
    this._u = new WeakMap();       // per-user render cache (sprite memo, name tag, when they last spoke)
    this._tagV = 0;                // name tag version: bumped when the text caches are reset
    this._sStep = 1;               // zoom step that keeps room pixels whole on this screen
    this._sprFoot = new WeakMap(); // sprite canvas → its lowest drawn row (where a name tag hangs)
    this._avs = []; this._nAvs = 0; this._self = null;
    this._list = []; this._rects = []; this._order = []; this._tagRects = []; this._placed = []; this._vis = [];
    this._band = { l: 0, r: 1, t: 0, b: 1 }; // the uncovered part of the stage, device px (drawOverlay)
    this._nTags = 0;
    this._labelW = new Map();
    this._small = null;            // cached small sprites (typing dots, away z), per dpr
    this._fameV = 0;
    this._wk = null;               // what the walls layer was last drawn with
    this._bk = null;               // what the backdrop was last drawn with
    this._lightKey = null;
    this._lastPick = null; this._lastPickT = -1e9;
    this.bubblesHidden = false;
    this.reducedMotion = prefersReducedMotion();
    this._rmExplicit = false;
    this._rmT = 0;
    this._userPaused = false;
    this.pausedTotal = 0;
    this._hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    this._pausedAt = this._hidden ? performance.now() : null;
    this._onVisibility = () => { this._hidden = document.visibilityState === 'hidden'; this._updatePause(); };
    try { document.addEventListener('visibilitychange', this._onVisibility); } catch { /* no document */ }
    try {
      const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
      if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { if (!this._rmExplicit) this._setReducedMotion(e.matches); });
    } catch { /* fine */ }
    // canvas text caches must be rebuilt once the pixel fonts arrive
    try {
      const fonts = document.fonts;
      if (fonts) {
        fonts.addEventListener?.('loadingdone', () => this._fontsChanged());
        for (const f of ['600 11px "Pixelify Sans"', '700 12px "Silkscreen"', '700 12px "Pixelify Sans"', '12px "Pixelify Sans"']) fonts.load?.(f).catch(() => {});
      }
    } catch { /* fine */ }
    this.resize();
  }

  // ---------- public controls (app.js calls these with optional chaining)
  setPaused(on) {
    on = !!on;
    if (on === this._userPaused) return;
    this._userPaused = on;
    this._updatePause();
  }
  setReducedMotion(on) { this._rmExplicit = true; this._setReducedMotion(!!on); }
  setBubblesHidden(on) {
    on = !!on;
    if (on === this.bubblesHidden) return;
    this.bubblesHidden = on;
    this._dirty = true;
  }
  // Asks for the next frame to be drawn. It deliberately leaves the cached backdrop layers alone:
  // their keys (ambient tick, hour, stats, fame, ticker step, reduced motion, effects) already catch
  // every real change, and app.js calls this on every pointer move and every move/state/say message.
  invalidate() { this._dirty = true; }

  _updatePause() {
    const now = performance.now();
    const paused = this._userPaused || this._hidden;
    if (paused && this._pausedAt == null) this._pausedAt = now;
    else if (!paused && this._pausedAt != null) {
      // the ambient clock skips the paused time, so animations carry on where they stopped
      this.pausedTotal += now - this._pausedAt;
      this._pausedAt = null;
      this._resumed = true;
      this._dirty = true;
    }
  }
  _setReducedMotion(on) {
    if (on === this.reducedMotion) return;
    if (on) this._rmT = Math.floor((performance.now() - this.pausedTotal) / AMB_MS) * AMB_MS;
    this.reducedMotion = on;
    this.invalidate();
  }
  _fontsChanged() { this._textReset(); this._dirty = true; }
  // Text caches drawn at the old pixel ratio or before the fonts arrived. Name tags are rebuilt by
  // bumping a version (the per-person cache keeps who spoke when, and the sprite memo).
  _textReset() {
    this._tagV++;
    this._labelW.clear();
    this._small = null;
    for (const b of this.bubbles) this.measureBubble(b);
  }

  setFame(list) { this.fameBuf = buildFame(list); this.fameText = fameText(list); this._fameV++; this._dirty = true; }

  // ---------- furniture prep: sprites, sway frames, the box each piece can paint, animation anchors
  prepFurn(f) {
    const it = { f, base: buildFurnSprite(f, 'base'), front: buildFurnSprite(f, 'front'), frames: null, phase: hash32(f.id) % 4 };
    const [px, py] = P(f.x, f.y);
    it.px = px; it.py = py;
    if (f.kind === 'plant') { it.frames = [-1, 0, 1].map((s) => buildFurnSprite(f, 'base', s)); it.base = it.frames[1]; }
    let bb = unionBox(alphaBounds(it.base), alphaBounds(it.front));
    if (it.frames) for (const fr of it.frames) bb = unionBox(bb, alphaBounds(fr));
    bb = bb || { x0: 0, y0: 0, x1: FW, y1: FH };
    const r = { x0: px - FAX + bb.x0 - 3, y0: py - FAY + bb.y0 - 3, x1: px - FAX + bb.x1 + 3, y1: py - FAY + bb.y1 + 3 };
    const Pf = (lx, ly, z) => P(f.x + lx, f.y + ly, z);
    const A = it.anim = {};
    const grow = (x0, y0, x1, y1) => { r.x0 = Math.min(r.x0, x0); r.y0 = Math.min(r.y0, y0); r.x1 = Math.max(r.x1, x1); r.y1 = Math.max(r.y1, y1); };
    switch (f.kind) {
      case 'desk': { const [x0, y0] = Pf(0.15, 0.2, 36); A.sx = Math.round(x0); A.sy = Math.round(y0); break; }
      case 'rack': {
        A.leds = [];
        const cols = [0.22, 0.36, 0.5, 0.64, 0.78];
        for (let z = 9, row = 0; z < 54; z += 6, row++) {
          for (let ci = 0; ci < cols.length; ci++) {
            const [x, y] = Pf(0.66, cols[ci], z);
            A.leds.push({ x: Math.round(x), y: Math.round(y), period: 140 + ((row * 7 + ci * 13 + f.y * 5) % 9) * 60, k: row + ci,
              c: ci === 0 ? '#ffbe0b' : (row + ci) % 4 === 0 ? '#33e1ff' : '#7dff8a' });
          }
        }
        break;
      }
      case 'arcade': { const [x0, y0] = Pf(0.24, 0.74, 41); A.sx = Math.round(x0); A.sy = Math.round(y0); break; }
      case 'gong': {
        const [cx, cy] = Pf(0.5, 0.5, 26), top = Pf(0.5, 0.5, 46);
        A.cx = cx; A.cy = cy; A.tx = Math.round(top[0]); A.ty = Math.round(top[1]);
        A.disc = this.buildGongDisc(false); A.discHit = this.buildGongDisc(true);
        grow(cx - 14, cy - 22, cx + 14, cy + 14);
        break;
      }
      case 'lavalamp': {
        const base = Pf(0.5, 0.5, 19);
        A.bx = Math.round(base[0]); A.by = Math.round(base[1]);
        const [gc, gg] = makeCanvas(26, 30);
        gg.fillStyle = 'rgba(255,120,200,0.10)'; fillPoly(gg, ellipsePts(13, 15, 12, 14, 16));
        A.glow = gc;
        grow(A.bx - 14, A.by - 24, A.bx + 14, A.by + 8);
        break;
      }
      case 'button': {
        const [cx, cy] = Pf(0.5, 0.5, 20);
        A.cx = Math.round(cx); A.cy = Math.round(cy);
        const [gc, gg] = makeCanvas(22, 14);
        gg.fillStyle = 'rgba(255,60,60,0.35)'; fillPoly(gg, ellipsePts(11, 7, 10, 6, 16));
        A.flash = gc;
        grow(A.cx - 12, A.cy - 12, A.cx + 12, A.cy + 8);
        break;
      }
      case 'fridge': { const [x0, y0] = Pf(0.12, 0.64, 46); A.sx = Math.round(x0); A.sy = Math.round(y0); break; }
      case 'bar': {
        if (f.espresso) { const [x, y] = Pf(0.41, 0.46, 31); A.steamX = Math.round(x); A.steamY = Math.round(y); grow(A.steamX - 3, A.steamY - 20, A.steamX + 4, A.steamY); }
        break;
      }
    }
    it.rect = r;
    return it;
  }
  buildGongDisc(hit) {
    const [c, g] = makeCanvas(22, 24);
    const x = 11, y = 12;
    g.fillStyle = '#8a6214'; fillPoly(g, ellipsePts(x, y, 10, 11, 24));
    g.fillStyle = '#d4a017'; fillPoly(g, ellipsePts(x, y, 9, 10, 24));
    g.fillStyle = '#e9c46a'; fillPoly(g, ellipsePts(x, y, 6, 7, 20));
    g.fillStyle = '#c99712'; fillPoly(g, ellipsePts(x, y, 4, 5, 16));
    g.fillStyle = hit ? '#fff3c4' : '#f4d58d'; fillPoly(g, ellipsePts(x, y, 2, 2.5, 12));
    g.fillStyle = '#fff3c4'; g.fillRect(x - 6, y - 6, 2, 1);
    return c;
  }
  buildShadow(rx, ry) { // a soft two-step contact shadow
    const w = rx * 2 + 4, h = ry * 2 + 4;
    const [c, g] = makeCanvas(w, h);
    g.fillStyle = 'rgba(0,0,0,0.13)'; fillPoly(g, ellipsePts(w / 2, h / 2, rx + 1.5, ry + 0.8, 18));
    g.fillStyle = 'rgba(0,0,0,0.2)'; fillPoly(g, ellipsePts(w / 2, h / 2, rx - 0.5, ry - 0.4, 16));
    c.ox = Math.floor(w / 2); c.oy = Math.floor(h / 2);
    return c;
  }

  // ---------- size and camera
  resize() {
    const r = this.canvas.getBoundingClientRect();
    const raw = window.devicePixelRatio || 1;
    const dpr = backingRatio(raw);
    const cw = Math.max(1, Math.round(r.width * dpr));
    const ch = Math.max(1, Math.round(r.height * dpr));
    const ins = this.insets || {};
    const it = +ins.top || 0, ib = +ins.bottom || 0, il = +ins.left || 0, ir = +ins.right || 0;
    const k = this._rk;
    const same = k && k.cw === cw && k.ch === ch && k.raw === raw && k.it === it && k.ib === ib && k.il === il && k.ir === ir && k.uz === this.userZoom;
    if (same && this.canvas.width === cw && this.canvas.height === ch) return; // nothing changed: keep the canvas and the camera
    this.dpr = dpr;
    this._sStep = scaleStep(raw, dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.cw = cw; this.ch = ch;
    this.ctx.imageSmoothingEnabled = false;
    // Framing. Phones (a touch screen that's small either way round) may crop a little of the room
    // for bigger pixels, and the camera follows you; everything else fits the whole room, whatever
    // the stage width (a desktop with the chat sidebar can leave a 560 px stage). A room pixel is
    // at least one CSS px wide when the screen has the pixels for it (floor: a 1.5x screen may draw
    // it 1 canvas px wide rather than crop a third of the room). Above 2x round instead, so a 2.625x
    // phone draws ~1.14 CSS px per room pixel like a 3x phone's 1, not a tiny 0.76.
    const usableW = Math.max(1, cw - (il + ir) * dpr), usableH = Math.max(1, ch - (it + ib) * dpr);
    const bw = ROOM.x1 - ROOM.x0, bh = ROOM.y1 - ROOM.y0;
    const minS = this._snapS(Math.max(1, dpr > 2 ? Math.round(dpr) : Math.floor(dpr)), true);
    this.phone = isPhone();
    this.autoS = Math.max(minS, this._snapS(this.phone
      ? Math.min(Math.floor((usableW * PHONE_CROP_W) / bw), Math.floor((usableH * PHONE_CROP_H) / bh))
      : Math.floor(Math.min(usableW / bw, usableH / bh) * FIT_SLACK)));
    this.s = this._snapS(this.userZoom ?? this.autoS);
    this.clampCam(true);
    // text sizes follow how big the room is drawn, not the window: compact when a room pixel is
    // under 1.5 CSS px (phones, narrow stages), larger name tags from 1.75 CSS px up
    const roomPx = this.autoS / dpr;
    const small = r.width - il - ir < 600 || roomPx < 1.5;
    this.compact = small;
    this.bigTags = !small && roomPx >= 1.75;
    const textChanged = !k || k.dpr !== dpr || k.small !== small;
    this._rk = { cw, ch, raw, dpr, it, ib, il, ir, uz: this.userZoom, small };
    if (textChanged) this._textReset();
    this._dirty = true;
  }

  // a zoom (canvas px per room px) on a whole number of device px per room px, within 1..MAX_S
  _snapS(s, up = false) {
    const k = this._sStep || 1;
    const top = MAX_S - (MAX_S % k);
    const v = (up ? Math.ceil(s / k) : Math.floor(s / k)) * k;
    return Math.max(k, Math.min(top, v));
  }

  zoomBy(step, anchorDx, anchorDy) {
    const old = this.s;
    const next = this._snapS(old + step * (this._sStep || 1));
    if (next === old) return;
    const ax = anchorDx ?? this.cw / 2, ay = anchorDy ?? this.ch / 2;
    const wx = this.cam.x + ax / old, wy = this.cam.y + ay / old;
    this.s = next;
    this.userZoom = next;
    if (this._rk) this._rk.uz = next;
    this.cam.x = wx - ax / next;
    this.cam.y = wy - ay / next;
    this.clampCam(false);
    for (const b of this.bubbles) b.off = null;
  }

  viewLog() {
    const ins = this.insets || {}, k = this.dpr / this.s;
    return { w: this.cw / this.s, h: this.ch / this.s, top: (+ins.top || 0) * k, bottom: (+ins.bottom || 0) * k, left: (+ins.left || 0) * k, right: (+ins.right || 0) * k };
  }

  clampCam(center) {
    const v = this.viewLog();
    const usableW = v.w - v.left - v.right, usableH = v.h - v.top - v.bottom;
    const bw = ROOM.x1 - ROOM.x0, bh = ROOM.y1 - ROOM.y0;
    // centre the room when it fits; otherwise centre (on request) and keep a little slack at the edges
    if (bw <= usableW) this.cam.x = ROOM.x0 - v.left - (usableW - bw) / 2;
    else {
      if (center) this.cam.x = ROOM.x0 - v.left + (bw - usableW) / 2;
      this.cam.x = Math.max(ROOM.x0 - v.left - 12, Math.min(ROOM.x1 - v.w + v.right + 12, this.cam.x));
    }
    if (bh <= usableH) this.cam.y = ROOM.y0 - v.top - (usableH - bh) / 2;
    else {
      if (center) this.cam.y = ROOM.y0 - v.top + (bh - usableH) / 2;
      this.cam.y = Math.max(ROOM.y0 - v.top - 30, Math.min(ROOM.y1 - v.h + v.bottom + 30, this.cam.y));
    }
  }

  panBy(dxCss, dyCss) {
    this.cam.x -= (dxCss * this.dpr) / this.s;
    this.cam.y -= (dyCss * this.dpr) / this.s;
    this.follow = false;
    this.clampCam(false);
  }

  toDevice(lx, ly) { return [Math.round((lx - this.cam.x) * this.s), Math.round((ly - this.cam.y) * this.s)]; }
  toLogical(dx, dy) { return [dx / this.s + this.cam.x, dy / this.s + this.cam.y]; }

  // ---------- positions
  posOf(u, t) { const o = { gx: 0, gy: 0, moving: false, phase: 0 }; this._posInto(u, t, o); return o; }
  _posInto(u, t, o) {
    let gx = u.x, gy = u.y, moving = false, phase = 0;
    if (u.move) {
      const n = u.move.nodes;
      const e = t - u.move.t0 + u.move.el;
      let i = Math.floor(e / STEP_MS);
      if (i >= n.length - 1) {
        const last = n[n.length - 1];
        if (n.length >= 2) { const pv = n[n.length - 2]; u.dir = dirFrom(last[0] - pv[0], last[1] - pv[1]); }
        u.x = last[0]; u.y = last[1];
        u.move = null;
        if (u.pendingState) { Object.assign(u, u.pendingState); u.pendingState = null; }
        gx = u.x; gy = u.y;
      } else {
        if (i < 0) i = 0;
        const k = Math.max(0, Math.min(1, (e - i * STEP_MS) / STEP_MS));
        const a = n[i], b = n[i + 1];
        u.dir = dirFrom(b[0] - a[0], b[1] - a[1]);
        gx = a[0] + (b[0] - a[0]) * k;
        gy = a[1] + (b[1] - a[1]) * k;
        moving = true;
        phase = e;
      }
    }
    if (u.corr) {
      const k = 1 - (t - u.corr.t0) / 220;
      if (k <= 0) u.corr = null;
      else { gx += u.corr.dx * k; gy += u.corr.dy * k; }
    }
    o.gx = gx; o.gy = gy; o.moving = moving; o.phase = phase;
    return o;
  }

  _uc(u) {
    let c = this._u.get(u);
    if (!c) { c = { h: hash32(String(u.id)), id: u.id, spr: null, key: [], tag: null, spoke: -1e9 }; this._u.set(u, c); }
    else if (c.id !== u.id) { c.id = u.id; c.h = hash32(String(u.id)); }
    return c;
  }

  spriteFor(u, t, pos) {
    const o = { spr: null, raise: 0, flip: false, view: 'front', pose: 'stand' };
    return this._spriteInto(u, t, this._amb ?? 0, this.reducedMotion, pos, o);
  }
  _spriteInto(u, t, amb, rm, pos, o) {
    const dir = u.dir ?? 3;
    const view = dir === 0 || dir === 1 || dir === 7 ? 'back' : 'front';
    const flip = dir === 5 || dir === 6 || dir === 7;
    let pose = 'stand', frame = 0, raise = 0, wave = false;
    const seat = !pos.moving && u.pose === 'sit' ? furnitureAt(Math.round(pos.gx), Math.round(pos.gy)) : null;
    if (pos.moving) { pose = 'walk'; frame = Math.floor(pos.phase / (STEP_MS / 4)) % 4; }
    else if (u.pose === 'sit') {
      if (seat && seat.seat) { pose = 'sit'; raise = (SEAT_H[seat.kind] || 10) - 4; }
      else { pose = 'sitf'; raise = -2; }
    } else if (u.pose === 'dance') { pose = 'dance'; frame = Math.floor(t / 210) % 4; }
    if (u.gesture && t - u.gesture.t0 < 2600) { wave = true; frame = Math.floor((t - u.gesture.t0) / 260) % 2; if (pose === 'stand') pose = 'wave'; }
    const c = this._uc(u);
    // blinks: two overlapping cycles whose lengths vary per person, so they come at uneven gaps.
    // They run on the 12 fps ambient clock, so a blink never asks for a frame of its own.
    const p1 = 3100 + (c.h % 1900), p2 = 7300 + ((c.h >>> 11) % 3100);
    const blink = !rm && (((amb + (c.h % p1)) % p1) < 130 || ((amb + ((c.h >>> 5) % p2)) % p2) < 110);
    const idle = !pos.moving && !wave && (pose === 'stand' || pose === 'sit' || pose === 'sitf');
    const breath = idle && !rm && ((amb + (c.h % 3400)) % 3400) >= 1700 ? 1 : 0;
    const K = c.key;
    const look = u.look, item = u.item, afk = u.afk;
    if (c.spr && K[0] === look && K[1] === view && K[2] === pose && K[3] === frame && K[4] === flip && K[5] === item && K[6] === blink && K[7] === afk && K[8] === wave && K[9] === breath) {
      o.spr = c.spr;
    } else {
      o.spr = c.spr = avatarSprite(look || {}, { view, pose, frame, flip, item, blink, afk, wave, breath });
      K[0] = look; K[1] = view; K[2] = pose; K[3] = frame; K[4] = flip; K[5] = item; K[6] = blink; K[7] = afk; K[8] = wave; K[9] = breath;
    }
    o.raise = raise; o.flip = flip; o.view = view; o.pose = pose; o.blink = blink;
    return o;
  }

  centerOf(gx, gy) { return [OX + (gx - gy) * 16, OY + (gx + gy + 1) * 8]; }

  // ---------- picking
  alphaAt(canvas, x, y) {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return 0;
    let d = this.alphaCache.get(canvas);
    if (!d) { d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; this.alphaCache.set(canvas, d); }
    return d[(Math.floor(y) * canvas.width + Math.floor(x)) * 4 + 3];
  }

  pick(dxDev, dyDev, t = performance.now()) {
    const hit = this._pick(dxDev, dyDev, t);
    this._lastPick = hit && hit.type === 'user' ? hit.id : null;
    this._lastPickT = t;
    return hit;
  }
  _pick(dxDev, dyDev, t) {
    const [lx, ly] = this.toLogical(dxDev, dyDev);
    // avatars (front-most first), generous box for fat fingers
    const avs = [];
    for (const u of this.users.values()) {
      const pos = this.posOf(u, t);
      const [cx, cy] = this.centerOf(pos.gx, pos.gy);
      const sp = this.spriteFor(u, t, pos);
      const fy = u.npc ? -6 : 0;
      avs.push({ u, cx, cy: cy - sp.raise + fy, depth: pos.gx + pos.gy + 0.5, spr: sp.spr });
    }
    avs.sort((a, b) => b.depth - a.depth);
    for (const a of avs) {
      const sx = lx - (a.cx - AV_AX), sy = ly - (a.cy - AV_AY);
      if (this.alphaAt(a.spr, sx, sy) > 20) return { type: 'user', id: a.u.id };
    }
    for (const a of avs) {
      if (Math.abs(lx - a.cx) <= 8 && ly <= a.cy + 2 && ly >= a.cy - 40) return { type: 'user', id: a.u.id };
    }
    // furniture
    for (const it of this.furnPick) {
      const sx = lx - (it.px - FAX), sy = ly - (it.py - FAY);
      if ((it.front && this.alphaAt(it.front, sx, sy) > 20) || (it.base && this.alphaAt(it.base, sx, sy) > 20)) return { type: 'furn', f: it.f };
    }
    // wall items
    for (const w of WALL_ITEMS) {
      let gpos, z;
      if (w.wall === 'L') { gpos = (OX - lx) / 16; z = OY + gpos * 8 - ly; }
      else { gpos = (lx - OX) / 16; z = OY + gpos * 8 - ly; }
      if (gpos >= w.a && gpos <= w.b && z >= w.lo && z <= w.hi) return { type: 'wall', w };
    }
    // floor tile
    const u = (lx - OX) / 16, v = (ly - OY) / 8;
    const gx = Math.floor((u + v) / 2), gy = Math.floor((v - u) / 2);
    if (gx >= 0 && gy >= 0 && gx < W && gy < H) return { type: 'tile', x: gx, y: gy, ok: reachable(gx, gy) };
    return null;
  }

  // ---------- events from the app
  addBubble(uid, text, kind = 'say', extra = {}) {
    const u = this.users.get(uid);
    if (!u && kind !== 'announce') return;
    const t = performance.now();
    const npc = !!(extra.npc || (u && u.npc));
    // the bot says hello to a burst of arrivals: keep only its newest line on screen
    if (npc) {
      let w = 0;
      for (let i = 0; i < this.bubbles.length; i++) { const o = this.bubbles[i]; if (!(o.uid === uid && t - o.born < 9000)) this.bubbles[w++] = o; }
      this.bubbles.length = w;
    }
    const color = u && u.look && !u.look.bot ? LOOK.topColor[u.look.topColor] || '#f26b3a' : '#f26b3a';
    // where it's drawn is worked out every frame from its speaker (drawBubbles)
    const b = { uid, login: u ? u.login : '', text, kind, color, born: t, ...extra };
    b.dieAt = t + BUBBLE_LIFE;
    b.fadeLen = BUBBLE_FADE;
    this.measureBubble(b);
    this.bubbles.push(b);
    if (this.bubbles.length > 30) this.bubbles.splice(0, this.bubbles.length - 30);
    if (u) this._uc(u).spoke = t;
  }

  // Lays the text out (at most two lines; the rest becomes "…") and paints the bubble body once.
  measureBubble(b) {
    const c = this.ctx, d = this.dpr;
    const small = this.compact ?? this.cw / d < 600;
    const fs = small ? 12 : 13;
    b.fs = fs;
    const maxW = (small ? 210 : 236) * d;
    const nameFont = `700 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
    const textFont = `${b.kind === 'me' ? 'italic ' : ''}400 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
    c.font = nameFont;
    const prefix = b.kind === 'me' ? b.login + ' ' : b.kind === 'whisper' ? `${b.login} → ${b.to}: ` : b.kind === 'announce' ? '' : b.login + ': ';
    const nameW = prefix ? c.measureText(prefix).width : 0;
    c.font = textFont;
    const words = String(b.text).split(/(\s+)/);
    const lines = [];
    let cur = '', curW = nameW, cut = false;
    const breakLine = () => {
      lines.push(cur);
      cur = ''; curW = 0;
      if (lines.length >= BUBBLE_LINES) cut = true;
    };
    for (const w of words) {
      if (!w || cut) { if (cut) break; continue; }
      const ws = /^\s+$/.test(w);
      const ww = c.measureText(w).width;
      if (curW + ww <= maxW) { cur += w; curW += ww; continue; }
      if (ws) { breakLine(); continue; }
      if (cur.trim() && ww <= maxW) { breakLine(); if (cut) break; cur = w; curW = ww; continue; }
      // a very long word: hard-break it (between characters as a reader sees them)
      for (const ch of graphemes(w)) {
        const chw = c.measureText(ch).width;
        if (curW + chw > maxW && (cur || lines.length)) { breakLine(); if (cut) break; }
        cur += ch; curW += chw;
      }
    }
    if (!cut && cur) lines.push(cur);
    if (!cut && lines.length > BUBBLE_LINES) cut = true;
    if (!lines.length) lines.push('');
    if (cut) {
      lines.length = Math.min(lines.length, BUBBLE_LINES);
      const li = lines.length - 1;
      const lim = maxW - (li === 0 ? nameW : 0);
      // trim whole characters, so an emoji (or one with a skin tone or a ZWJ) is never cut in half
      const gs = graphemes(lines[li].replace(/\s+$/, ''));
      while (gs.length && c.measureText(gs.join('') + '…').width > lim) gs.pop();
      lines[li] = gs.join('').replace(/\s+$/, '') + '…';
    }
    let w = 0;
    for (let i = 0; i < lines.length; i++) w = Math.max(w, c.measureText(lines[i]).width + (i === 0 ? nameW : 0));
    b.prefix = prefix; b.lines = lines;
    b.wDev = Math.ceil(w + 16 * d + 12 * d);
    b.hDev = Math.ceil(lines.length * (fs + 3) * d + 10 * d);
    b.nameW = nameW;
    b.img = this.paintBubble(b, nameFont, textFont);
    b.off = null;
  }
  paintBubble(b, nameFont, textFont) {
    const d = this.dpr;
    const pad = Math.ceil(d) + 1;
    const [cv, g] = makeCanvas(b.wDev + pad * 2, b.hDev + pad * 2);
    g.translate(pad, pad);
    const fillC = b.kind === 'whisper' ? '#e9e7f5' : b.kind === 'me' ? '#fff4d6' : b.npc ? '#ffe7da' : '#ffffff';
    b.fill = fillC;
    g.fillStyle = 'rgba(10,8,20,0.9)';
    roundRect(g, -d, -d, b.wDev + 2 * d, b.hDev + 2 * d, 7 * d); g.fill();
    g.fillStyle = fillC;
    roundRect(g, 0, 0, b.wDev, b.hDev, 6 * d); g.fill();
    g.fillStyle = b.color || '#f26b3a';
    roundRect(g, 6 * d, 6 * d, 8 * d, b.hDev - 12 * d, 2 * d); g.fill();
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const fs = b.fs || 13;
    let ly = 5 * d + (fs - 1) * d;
    for (let i = 0; i < b.lines.length; i++) {
      let lx = 20 * d;
      if (i === 0 && b.prefix) {
        g.font = nameFont;
        g.fillStyle = b.kind === 'whisper' ? '#6b5fb5' : '#1b1830';
        g.fillText(b.prefix, lx, ly);
        lx += b.nameW;
      }
      g.font = textFont;
      g.fillStyle = b.kind === 'whisper' ? '#4a4470' : '#2b2d42';
      g.fillText(b.lines[i], lx, ly);
      ly += (fs + 3) * d;
    }
    cv.pad = pad;
    return cv;
  }

  addReact(uid, r) { this.reacts.push({ uid, r, born: performance.now() }); if (this.reacts.length > 40) this.reacts.shift(); }
  addFx(kind, data = {}) { this.fx.push({ kind, born: performance.now(), ...data }); if (this.fx.length > 12) this.fx.shift(); }

  // ---------- render
  render(t) {
    if (this._userPaused || this._hidden) return;
    if (typeof t !== 'number' || !(t >= 0)) t = performance.now();
    const rm = this.reducedMotion;
    const at = t - this.pausedTotal;
    if (t - this.hourAt > 60_000) { this.lastHour = localHour(this.cfg.timezone); this.hourAt = t; }
    const tick = Math.floor(at / AMB_MS);
    const amb = this._amb = rm ? this._rmT : tick * AMB_MS;

    // short-lived effects
    let live = false;
    if (this.reacts.length) {
      let w = 0;
      for (let i = 0; i < this.reacts.length; i++) { const r = this.reacts[i]; if (t - r.born < 1800) this.reacts[w++] = r; }
      this.reacts.length = w;
      if (w) live = true;
    }
    let fxBusy = false;
    for (let i = 0; i < this.fx.length; i++) {
      const f = this.fx[i], age = t - f.born;
      if ((f.kind === 'gong' && age < 3000) || (f.kind === 'deploy' && age < 2400)) fxBusy = true;
    }
    if (fxBusy) live = true;
    if (this.target && t - this.target.t < 900) live = true;
    const arrow = !!this.selfId && t - this.joinedAt < 5000;
    if (arrow && !rm) live = true;

    // people, camera, bubbles
    this._collect(t, amb, rm);
    if (this._anyMoving) live = true;
    if (this._resumed) { this._resumed = false; this.snapToSelf(); for (const b of this.bubbles) b.off = null; }
    if (this.updateCamera()) live = true;
    if (this._bubbleClock(t, rm)) live = true;
    const picked = this._lastPick && (this.hoverLabel || t - this._lastPickT < 4000) ? this._lastPick : null;
    this._picked = picked;

    // what's on screen, as a cheap signature
    this._sigK = 0; this._sigCh = false;
    const ins = this.insets || {};
    this._sv(this.users.size); this._sv(this.bubbles); this._sv(this.bubbles.length); this._sv(this.bubbles[this.bubbles.length - 1]);
    this._sv(this.hoverTile); this._sv(this.hoverLabel); this._sv(this.target); this._sv(this.stats);
    this._sv(this.cam.x); this._sv(this.cam.y); this._sv(this.s); this._sv(this.cw); this._sv(this.ch);
    this._sv(ins); this._sv(+ins.top || 0); this._sv(+ins.bottom || 0); this._sv(+ins.left || 0); this._sv(+ins.right || 0);
    this._sv(this.selfId); this._sv(arrow); this._sv(this.bubblesHidden); this._sv(rm); this._sv(picked);
    this._sv(rm ? Math.floor(at / RM_TICKER_MS) : tick);
    this._sv(rm ? Math.floor(at / BOARD_MS) : 0); // billboards change (see _ensureLayers)
    this._sv(Math.round(this.lastHour * 4)); this._sv(this._fameV);
    // an effect ending changes the backdrop (the deploy glow goes out), so that frame is drawn too
    this._sv(fxBusy);
    const typeStep = rm ? 0 : Math.floor(t / 250) % 3;
    for (let i = 0; i < this._nAvs; i++) {
      const a = this._avs[i], u = a.u;
      this._sv(u); this._sv(a.cx); this._sv(a.cy); this._sv(a.sp.raise); this._sv(a.bob); this._sv(a.sp.spr);
      this._sv(u.login); this._sv(u.admin); this._sv(u.afk); this._sv(u.npc); this._sv(u.look); this._sv(u.typing ? typeStep : -1);
      this._sv(a.talk);
    }
    if (this._sig.length !== this._sigK) { this._sig.length = this._sigK; this._sigCh = true; }

    if (!live && !this._sigCh && !this._dirty && !this._needNext) { this.framesSkipped++; return; }
    this._needNext = false;
    this._dirty = false;
    this._draw(t, at, amb, tick, rm, fxBusy, arrow);
    this.framesDrawn++;
  }

  _sv(v) { const k = this._sigK++; if (this._sig[k] !== v) { this._sig[k] = v; this._sigCh = true; } }

  _collect(t, amb, rm) {
    const avs = this._avs;
    let n = 0, moving = false, self = null;
    for (const u of this.users.values()) {
      let a = avs[n];
      if (!a) a = avs[n] = { u: null, pos: { gx: 0, gy: 0, moving: false, phase: 0 }, sp: { spr: null, raise: 0, flip: false, view: 'front', pose: 'stand', blink: false }, cx: 0, cy: 0, bob: 0, d: 0, kind: 'a', pri: 0, talk: false, side: 0, sx: 0, sy: 0 };
      n++;
      a.u = u;
      this._posInto(u, t, a.pos);
      if (u.move || u.corr) moving = true;
      this._spriteInto(u, t, amb, rm, a.pos, a.sp);
      a.cx = Math.round(OX + (a.pos.gx - a.pos.gy) * 16);
      a.cy = Math.round(OY + (a.pos.gx + a.pos.gy + 1) * 8);
      a.bob = u.npc ? (rm ? -6 : Math.round(Math.sin(amb / 420) * 1.5) - 6) : 0;
      a.d = a.pos.gx + a.pos.gy + 0.5;
      // talking lately: their name tag gets first pick of the space (part of the frame signature,
      // so the layout changes when it runs out, even with nothing else moving)
      a.talk = t - this._uc(u).spoke < TALK_TAG_MS;
      if (u.id === this.selfId) self = a;
    }
    for (let i = n; i < avs.length; i++) avs[i].u = null;
    this._nAvs = n; this._self = self; this._anyMoving = moving;
  }

  // bubble lifetimes: shorter when it's busy; returns true while one is fading
  _bubbleClock(t, rm) {
    const list = this.bubbles;
    if (!list.length) return false;
    let recent = 0;
    for (let i = 0; i < list.length; i++) if (t - list[i].born < BUBBLE_LIFE) recent++;
    const busy = recent > this.maxBubbles();
    let w = 0, fading = false;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.dieAt == null) { b.dieAt = b.born + BUBBLE_LIFE; b.fadeLen = BUBBLE_FADE; }
      if (busy && b.dieAt > b.born + BUBBLE_LIFE_BUSY) b.dieAt = Math.max(b.born + BUBBLE_LIFE_BUSY, Math.min(b.dieAt, t + BUBBLE_FADE));
      if (t >= b.dieAt) continue;
      if (!rm && (t - b.born < BUBBLE_POP || b.dieAt - t < b.fadeLen)) fading = true;
      list[w++] = b;
    }
    list.length = w;
    return fading;
  }
  maxBubbles() { return (this.compact ?? this.cw / this.dpr < 600) ? 4 : 5; }

  // ---------- the backdrop layers
  _ensureLayers(t, at, amb, tick, rm, fxBusy) {
    const hourKey = Math.round(this.lastHour * 4);
    const tStep = rm ? Math.floor(at / RM_TICKER_MS) : Math.floor(tick / TICK_STEPS);
    const flick = !rm && ((Math.floor(amb / 120) % 97 === 0) || (Math.floor(amb / 90) % 211 === 3));
    const skyT = rm ? this._rmT : amb;
    // with reduced motion the view holds still, but the billboards still change (no flip): one
    // redraw of the view per change
    const bEp = rm ? Math.floor(at / BOARD_MS) : -1;
    if (this._lightKey !== hourKey) { this.buildLight(hourKey); this._wk = null; }
    let wk = this._wk;
    const wallsStale = !wk || wk.skyT !== skyT || wk.hour !== this.lastHour || wk.bEp !== bEp || wk.tStep !== tStep || wk.flick !== flick || wk.fame !== this._fameV || wk.stats !== this.stats || wk.rm !== rm;
    if (wallsStale) {
      if (!wk || wk.skyT !== skyT || wk.hour !== this.lastHour || wk.bEp !== bEp) {
        this.valley.render(this.skyG, this.winW, this.winH, skyT, { hour: this.lastHour, speed: 3.2, deferText: true, boardsAt: rm ? at : skyT, still: rm });
      }
      this._buildWalls(tStep, flick, rm);
      wk = this._wk = { skyT, hour: this.lastHour, bEp, tStep, flick, fame: this._fameV, stats: this.stats, rm };
    }
    // furniture animates on the ambient clock; the gong and the deploy button follow their effect live
    const fk = fxBusy ? t : rm ? -1 : tick;
    if (wallsStale || !this._bk || this._bk.fk !== fk) {
      this._buildBack(t, amb, rm);
      this._bk = { fk };
    }
  }

  _buildWalls(tStep, flick, rm) {
    const g = this.wallsG;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, SW, SH);
    // the view out the window
    rightWallXform(g, WINDOW.a - 0.06, WINDOW.hi);
    g.drawImage(this.sky, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // the valley's signs and billboards, upright (the wall drawn next hides anything outside the glass)
    const wo = rightWallOrigin(WINDOW.a - 0.06, WINDOW.hi);
    for (const tx of this.valley.texts) {
      if (tx.y < 0 || tx.y + 5 > this.winH) continue;
      g.fillStyle = tx.color;
      wallText(g, wo, tx.s, tx.x, tx.y, 1, this.winW);
    }
    g.drawImage(this.static, 0, 0);
    const fb = this.floorLightBox;
    if (fb) g.drawImage(this.floorLight, fb.x, fb.y, fb.w, fb.h, fb.x, fb.y, fb.w, fb.h);
    this.drawTicker(g, tStep, rm);
    // neon (with the odd flicker; sheared with its board, see buildNeon) and the wall of fame
    const neon = this.neonItem, fame = this.fameItem;
    leftWallXform(g, neon.a, neon.b, neon.hi);
    g.drawImage(flick ? this.neonOff : this.neonOn, 0, 0);
    leftWallXform(g, fame.a, fame.b, fame.hi);
    g.drawImage(this.fameBuf, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const fo = leftWallOrigin(fame.b, fame.hi);
    for (const tx of this.fameText) { g.fillStyle = tx.color; wallText(g, fo, tx.s, tx.x, tx.y); }
  }

  _buildBack(t, amb, rm) {
    const g = this.backG;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, SW, SH);
    g.drawImage(this.walls, 0, 0);
    for (const e of this.furnDraw) {
      if (e.kind === 'f') this.drawFurn(g, e.it, t, amb, rm);
      else g.drawImage(e.it.front, e.it.px - FAX, e.it.py - FAY);
    }
  }

  // Room lighting for the hour. Two cached canvases, rebuilt every 15 minutes of lounge time:
  // - floorLight (painted into the walls layer, under the furniture): sunlight through the panes by
  //   day, coloured pools under lamps, screens and the neon sign, stronger after dark;
  // - light (drawn over everything, night only): the room goes darker, with holes around each light.
  buildLight(hourKey) {
    this._lightKey = hourKey;
    const hour = this.lastHour;
    const night = skyAt(hour).night;
    const CUT = [0.38, 0.45, 0.5], SC = [1, 0.68, 0.38], TINT = [0.45, 0.7, 1];
    const glow = 0.12 + 0.88 * night;
    // floor and wall light
    const f = this.floorLightG;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, SW, SH);
    for (const L of this.lights) {
      if (!L.tint || (L.night && night < 0.35)) continue;
      for (let k = 0; k < 3; k++) { f.fillStyle = rgba(L.c, L.a * glow * TINT[k] * 0.55); fillPoly(f, ellipsePts(L.x, L.y, L.rx * SC[k], L.ry * SC[k], 28)); }
    }
    const dayFrac = (hour - 6.3) / (18.4 - 6.3);
    if (dayFrac > 0.02 && dayFrac < 0.98 && night < 0.6) {
      const el = Math.sin(dayFrac * Math.PI);
      const k = (0.6 + (1 - el) * 1.3) / 16;          // floor tiles travelled per px of window height
      const lean = (0.5 - dayFrac) * 1.5;              // morning light leans one way, evening the other
      const a = 0.13 * Math.min(1, el * 3) * (1 - night);
      const col = mix('#fff1cf', '#ffae66', Math.min(1, (1 - el) * 1.3));
      f.save();
      f.beginPath();
      const fl = [P(0, 0.17), P(W, 0.17), P(W, H), P(0, H)];
      f.moveTo(fl[0][0], fl[0][1]);
      for (let i = 1; i < 4; i++) f.lineTo(fl[i][0], fl[i][1]);
      f.closePath();
      f.clip();
      const panes = 8, pw = (WINDOW.b - WINDOW.a) / panes;
      const quad = (xa, xb, za, zb) => {
        const ya = za * k, yb = zb * k;
        return [P(xa + lean * ya, ya), P(xb + lean * ya, ya), P(xb + lean * yb, yb), P(xa + lean * yb, yb)];
      };
      for (let p = 0; p < panes; p++) {
        const xa = WINDOW.a + p * pw + 0.09, xb = WINDOW.a + (p + 1) * pw - 0.09;
        for (const [za, zb] of [[WINDOW.lo, 59], [61, WINDOW.hi]]) {
          f.fillStyle = rgba(col, a); fillPoly(f, quad(xa, xb, za, zb));
          f.fillStyle = rgba(col, a * 0.7); fillPoly(f, quad(xa + 0.12, xb - 0.12, za + 4, zb - 4));
        }
      }
      f.restore();
    }
    const fb = alphaBounds(this.floorLight);
    this.floorLightBox = fb ? { x: fb.x0, y: fb.y0, w: fb.x1 - fb.x0, h: fb.y1 - fb.y0 } : null;

    // the dark
    const g = this.lightG;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, SW, SH);
    this.lightBox = null;
    const dark = night * 0.46;
    if (dark <= 0.01) return;
    g.fillStyle = `rgba(8,6,30,${dark.toFixed(3)})`;
    g.fillRect(0, 0, SW, SH);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(this.roomMask, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    for (const L of this.lights) {
      if (L.night && night < 0.35) continue;
      for (let k = 0; k < 3; k++) { g.fillStyle = `rgba(0,0,0,${CUT[k]})`; fillPoly(g, ellipsePts(L.x, L.y, L.rx * SC[k], L.ry * SC[k], 28)); }
    }
    g.globalCompositeOperation = 'source-over';
    const bb = alphaBounds(this.light);
    this.lightBox = bb ? { x: bb.x0, y: bb.y0, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0 } : null;
  }

  // ---------- one frame
  _draw(t, at, amb, tick, rm, fxBusy, arrow) {
    this._ensureLayers(t, at, amb, tick, rm, fxBusy);
    const g = this.sg;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, SW, SH);
    g.drawImage(this.back, 0, 0);

    // the moving parts: people and the floor markers, each with a box; furniture that overlaps a
    // box is redrawn inside the boxes so depth stays right
    const rects = this._rects;
    let nr = 0;
    const list = this._list;
    list.length = 0;
    const addRect = (x0, y0, x1, y1) => {
      const r = rects[nr] || (rects[nr] = { x0: 0, y0: 0, x1: 0, y1: 0 });
      r.x0 = x0; r.y0 = y0; r.x1 = x1; r.y1 = y1; nr++;
    };
    const ht = this.hoverTile && this.hoverTile.ok ? this.hoverTile : null;
    const tg = this.target && t - this.target.t < 900 ? this.target : null;
    // a tile outline is painted on the floor, before any furniture or person in its box
    const outline = (ent, x, y, color) => {
      ent.x = x; ent.y = y; ent.color = color; ent.d = -1;
      const p = P(x, y);
      addRect(p[0] - 17, p[1] - 1, p[0] + 17, p[1] + 18);
    };
    if (ht) { this._hoverEnt = this._hoverEnt || { kind: 'o' }; outline(this._hoverEnt, ht.x, ht.y, 'rgba(255,255,255,0.55)'); }
    if (tg) { this._targetEnt = this._targetEnt || { kind: 'o' }; outline(this._targetEnt, tg.x, tg.y, `rgba(242,107,58,${(1 - (t - tg.t) / 900).toFixed(3)})`); }
    const n = this._nAvs;
    for (let i = 0; i < n; i++) {
      const a = this._avs[i];
      const top = a.cy - AV_AY - a.sp.raise + a.bob;
      addRect(a.cx - 17, top - 1, a.cx + 17, Math.max(a.cy + 6, top + 53));
    }
    if (nr) {
      g.save();
      g.beginPath();
      for (let i = 0; i < nr; i++) { const r = rects[i]; g.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); }
      g.clip();
      g.drawImage(this.walls, 0, 0);
      for (const e of this.furnDraw) {
        const fr = e.it.rect;
        for (let i = 0; i < nr; i++) {
          const r = rects[i];
          if (fr.x0 < r.x1 && fr.x1 > r.x0 && fr.y0 < r.y1 && fr.y1 > r.y0) { list.push(e); break; }
        }
      }
      if (ht) list.push(this._hoverEnt);
      if (tg) list.push(this._targetEnt);
      for (let i = 0; i < n; i++) list.push(this._avs[i]);
      list.sort(byDepth);
      for (const e of list) {
        if (e.kind === 'f') this.drawFurn(g, e.it, t, amb, rm);
        else if (e.kind === 'ff') g.drawImage(e.it.front, e.it.px - FAX, e.it.py - FAY);
        else if (e.kind === 'a') this.drawAvatar(g, e, amb, rm);
        else this.tileOutline(g, e.x, e.y, e.color);
      }
      g.restore();
    }
    // lighting for the hour
    const lb = this.lightBox;
    if (lb) g.drawImage(this.light, lb.x, lb.y, lb.w, lb.h, lb.x, lb.y, lb.w, lb.h);

    // ---- blit the scene, scaled, to the screen
    const c = this.ctx, s = this.s, cw = this.cw, ch = this.ch;
    c.setTransform(1, 0, 0, 1, 0, 0);
    let shx = 0, shy = 0;
    if (!rm) {
      for (const f of this.fx) {
        const dur = f.kind === 'deploy' ? 700 : f.kind === 'gong' ? 380 : 0;
        if (dur && t - f.born < dur) { const k = (1 - (t - f.born) / dur) * (f.kind === 'deploy' ? 3 : 1.5); shx += Math.round((Math.random() - 0.5) * k) * s; shy += Math.round((Math.random() - 0.5) * k) * s; }
      }
    }
    const ox = Math.round(-this.cam.x * s) + shx, oy = Math.round(-this.cam.y * s) + shy;
    const sx0 = Math.max(0, Math.floor(-ox / s)), sy0 = Math.max(0, Math.floor(-oy / s));
    const sx1 = Math.min(SW, Math.ceil((cw - ox) / s)), sy1 = Math.min(SH, Math.ceil((ch - oy) / s));
    // a full-canvas clear is special-cased by the browser (it drops the old frame's commands), then
    // only the part of the scene that's on screen is scaled up
    c.clearRect(0, 0, cw, ch);
    if (sx1 > sx0 && sy1 > sy0) {
      c.imageSmoothingEnabled = false;
      c.drawImage(this.scene, sx0, sy0, sx1 - sx0, sy1 - sy0, ox + sx0 * s, oy + sy0 * s, (sx1 - sx0) * s, (sy1 - sy0) * s);
    }
    // deploy alarm: a wash over the whole stage (none with reduced motion)
    if (!rm) {
      for (const f of this.fx) {
        if (f.kind === 'deploy' && t - f.born < 2400) {
          const k = (t - f.born) / 2400;
          const a = 0.2 * Math.max(0, Math.sin(k * Math.PI * 6)) * (1 - k);
          if (a > 0.003) { c.fillStyle = `rgba(255,40,60,${a.toFixed(3)})`; c.fillRect(0, 0, cw, ch); }
        }
      }
    }
    this.drawOverlay(t, amb, rm, arrow);
  }

  tileOutline(g, x, y, color) {
    g.fillStyle = color;
    const a = P(x, y), b = P(x + 1, y), cc = P(x + 1, y + 1), d = P(x, y + 1);
    line(g, a[0], a[1], b[0] - 1, b[1]);
    line(g, b[0] - 1, b[1], cc[0], cc[1] - 1);
    line(g, cc[0], cc[1] - 1, d[0] + 1, d[1]);
    line(g, d[0] + 1, d[1], a[0], a[1]);
  }

  // The LED ticker on the window wall. It steps one character at a time (which also keeps every
  // glyph crisp on the wall); with reduced motion it turns a page every 10 s instead. The strip is
  // kept in its own small canvas and repainted only when it steps or its text changes; the walls
  // layer (rebuilt at 12 fps for the window view) just copies it.
  drawTicker(g, step, rm) {
    if (this._tickStats !== this.stats || this._tickMsg == null) {
      const s = this.stats || {};
      const vars = {
        contributors: Number(s.contributors) || 0, mergedPRs: Number(s.mergedPRs) || 0, online: Number(s.online) || 0,
        gongs: Number(s.gongs) || 0, deploys: Number(s.deploys) || 0, loungeName: this.cfg.loungeName,
      };
      this._tickMsg = (this.cfg.ticker || []).map((line) => `  * ${fill(line, vars)}`).join('').toUpperCase() + ' ';
      this._tickStats = this.stats;
      this._tickKey = null;
    }
    const key = (rm ? 'page' : 'step') + step;
    if (this._tickKey !== key) { this._tickKey = key; this._paintTicker(step, rm); }
    g.drawImage(this.tickCv, this.tickX, this.tickY);
  }
  _paintTicker(step, rm) {
    const msg = this._tickMsg, L = msg.length;
    const w = this.tick.width, tw = L * 4;
    const off = rm ? (step * Math.floor(w / 4) * 4) % tw : (step * 4) % tw;
    const g = this.tickG;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.tickCv.width, this.tickCv.height);
    g.setTransform(1, 0.5, 0, 1, 0, 0); // the strip follows the wall's slope
    g.drawImage(this.tick, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // the part of the message that's showing, lettered upright by wallText
    const i0 = Math.floor(off / 4), n = Math.ceil(w / 4) + 2;
    let run = '';
    for (let i = 0; i < n; i++) run += msg[(i0 + i) % L];
    g.fillStyle = '#ffb347';
    wallText(g, [0, 0, 0.5], run, i0 * 4 - off, 1, 1, w);
  }

  drawFurn(g, it, t, now, rm) {
    const f = it.f, A = it.anim;
    const base = it.frames ? it.frames[rm ? 1 : SWAY_SEQ[(Math.floor(now / 1100) + it.phase) & 3]] : it.base;
    if (base) g.drawImage(base, it.px - FAX, it.py - FAY);
    switch (f.kind) {
      case 'desk':
        g.setTransform(1, 0.5, 0, 1, A.sx, A.sy);
        this.drawScreen(g, f.screen, now, f.x);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      case 'rack':
        for (const l of A.leds) {
          if ((Math.floor(now / l.period) + l.k) % 3 === 0) continue;
          g.fillStyle = l.c;
          g.fillRect(l.x, l.y, 1, 1);
        }
        break;
      case 'arcade':
        g.setTransform(1, 0.5, 0, 1, A.sx, A.sy);
        this.drawArcade(g, f, now);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      case 'gong': {
        let fx = null;
        for (let i = this.fx.length - 1; i >= 0; i--) if (this.fx[i].kind === 'gong') { fx = this.fx[i]; break; }
        const age = fx ? t - fx.born : 1e9;
        const amp = !rm && age < 3000 ? (1 - age / 3000) * 2.6 : 0;
        const sw = amp * Math.sin(age / 90);
        const x = Math.round(A.cx + sw), y = Math.round(A.cy);
        g.fillStyle = '#5a3a22';
        line(g, x - 4, y - 9, A.tx - 6, A.ty);
        line(g, x + 4, y - 9, A.tx + 6, A.ty);
        g.drawImage(age < 600 ? A.discHit : A.disc, x - 11, y - 12);
        break;
      }
      case 'lavalamp': {
        const bx = A.bx, by = A.by;
        for (let i = 0; i < 3; i++) {
          const k = (Math.sin(now / (1700 + i * 600) + i * 2) + 1) / 2;
          const yy = by - 3 - Math.round(k * 12);
          g.fillStyle = i === 1 ? '#ff5fa2' : '#ff9a3c';
          g.fillRect(bx - 2 + (i % 2), yy, 3 - (i === 2 ? 1 : 0), 2 + (i === 0 ? 1 : 0));
        }
        g.drawImage(A.glow, bx - 13, by - 23);
        break;
      }
      case 'button': {
        let fx = null;
        for (let i = this.fx.length - 1; i >= 0; i--) if (this.fx[i].kind === 'deploy') { fx = this.fx[i]; break; }
        const age = fx ? t - fx.born : 1e9;
        const pressed = age < 600;
        const x = A.cx, y = A.cy + (pressed ? 1 : 0);
        g.fillStyle = '#9c1c28'; fillPoly(g, BUTTON_LO(x, y));
        g.fillStyle = '#e63946'; fillPoly(g, BUTTON_HI(x, y));
        g.fillRect(x - 5, y - 2, 11, 2);
        g.fillStyle = '#ff8a94'; g.fillRect(x - 2, y - 4, 2, 1);
        if (age < 2400 && (rm || Math.floor(age / 150) % 2 === 0)) g.drawImage(A.flash, x - 11, y - 9);
        break;
      }
      case 'fridge': {
        const hum = rm ? 4 : Math.round(4 + 4 * Math.sin(now / 900));
        g.fillStyle = FRIDGE_HUM[Math.max(0, Math.min(8, hum))];
        g.setTransform(1, 0.5, 0, 1, A.sx, A.sy);
        g.fillRect(0, 0, 12, 41);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
      case 'bar':
        if (A.steamX != null && !rm) {
          // steam off the espresso machine: three wisps rising and fading
          for (let i = 0; i < 3; i++) {
            const ph = ((now / 1700) + i / 3) % 1;
            const y = A.steamY - 1 - Math.round(ph * 15);
            const x = A.steamX + Math.round(Math.sin(ph * 7 + i * 2.1) * 1.3) + (i === 1 ? 2 : 0);
            g.fillStyle = STEAM[Math.max(0, Math.min(5, Math.floor((1 - ph) * 6)))];
            g.fillRect(x, y, 1, ph < 0.5 ? 2 : 1);
          }
        }
        break;
    }
  }

  drawScreen(g, kind, now, seed) {
    g.fillStyle = '#0b1320';
    g.fillRect(0, 0, 11, 10);
    if (kind === 'code') {
      const off = Math.floor(now / 380 + seed * 3);
      const cols = SCREEN_COLS;
      for (let r = 0; r < 5; r++) {
        const h = hash32('l' + (off + r));
        g.fillStyle = cols[h % cols.length];
        const ind = (h >>> 4) % 3;
        g.fillRect(1 + ind, 1 + r * 2, 2 + ((h >>> 8) % 6), 1);
        g.fillStyle = '#9aa0b5';
        if ((h >>> 12) % 2) g.fillRect(4 + ind + ((h >>> 8) % 6), 1 + r * 2, 2, 1);
      }
    } else if (kind === 'graph') {
      for (let i = 0; i < 9; i++) {
        const v = 2 + Math.round((Math.sin(now / 900 + i * 0.9) + 1) * 3 + (i * 0.35));
        g.fillStyle = i === 8 ? '#f26b3a' : '#33e1ff';
        g.fillRect(1 + i, 9 - Math.min(8, v), 1, Math.min(8, v));
      }
    } else {
      g.fillStyle = '#7dff8a';
      const off = Math.floor(now / 700);
      for (let r = 0; r < 4; r++) {
        const h = hash32('t' + (off + r));
        g.fillRect(1, 1 + r * 2, 1, 1);
        g.fillRect(3, 1 + r * 2, 1 + (h % 7), 1);
      }
      if (Math.floor(now / 500) % 2) g.fillRect(3, 9, 2, 1);
    }
  }

  drawArcade(g, f, now) {
    g.fillStyle = '#05040a';
    g.fillRect(0, 0, 9, 12);
    if (f.hue === 'pink') {
      // pong
      const t = now / 1000;
      const bx = Math.round(4 + Math.sin(t * 2.3) * 3.5), by = Math.round(6 + Math.sin(t * 3.7) * 4.5);
      g.fillStyle = '#ffffff';
      g.fillRect(bx, by, 1, 1);
      g.fillStyle = '#ff5fa2';
      g.fillRect(0, Math.round(5 + Math.sin(t * 3.7) * 3.2), 1, 3);
      g.fillRect(8, Math.round(5 + Math.sin(t * 3.7 + 0.4) * 3.2), 1, 3);
      g.fillStyle = '#3a2840';
      for (let y = 0; y < 12; y += 2) g.fillRect(4, y, 1, 1);
    } else {
      // starfield + ship
      for (let i = 0; i < 7; i++) {
        const y = Math.floor((now / (90 + i * 25) + i * 37) % 12);
        g.fillStyle = i % 2 ? '#33e1ff' : '#9aa0b5';
        g.fillRect((i * 5) % 9, y, 1, 1);
      }
      g.fillStyle = '#ffbe0b';
      const sx = Math.round(4 + Math.sin(now / 600) * 3);
      g.fillRect(sx, 9, 1, 2); g.fillRect(sx - 1, 10, 3, 1);
    }
  }

  drawAvatar(g, info, amb, rm) {
    const { u, pos, sp, cx, cy, bob } = info;
    if (u.npc) {
      const sh = this.botShadowSpr;
      g.drawImage(sh, cx - sh.ox, cy - sh.oy);
    } else if (!(u.pose === 'sit' && !pos.moving && furnitureAt(Math.round(pos.gx), Math.round(pos.gy)))) {
      const sh = this.shadowSpr;
      g.drawImage(sh, cx - sh.ox, cy - sh.oy);
    }
    const x = cx - AV_AX, y = cy - AV_AY - sp.raise + bob;
    if (u.afk) g.globalAlpha = 0.72;
    g.drawImage(sp.spr, x, y);
    g.globalAlpha = 1;
    if (u.npc) {
      // live eye, antenna light, thruster
      const scan = Math.round(Math.sin(amb / 700) * 3);
      const ex = sp.flip ? 32 - 1 - (15 + scan) - 1 : 15 + scan;
      if (sp.view === 'front' && !sp.blink) { // the eye closes with the rest of the face
        g.fillStyle = '#33e1ff';
        g.fillRect(x + ex, y + 21, 2, 2);
        g.fillStyle = 'rgba(51,225,255,0.35)';
        g.fillRect(x + ex - 1, y + 20, 4, 4);
      }
      g.fillStyle = Math.floor(amb / 500) % 2 ? '#ff3b3b' : '#7dff8a';
      g.fillRect(x + (sp.flip ? 16 : 15), y + 8, 1, 1);
      g.fillStyle = Math.floor(amb / (AMB_MS * 2)) % 2 ? '#33e1ff' : '#9fe8ff';
      g.fillRect(x + 13, y + BOT_THRUSTER_Y, 6, 1);
      g.fillStyle = 'rgba(51,225,255,0.4)';
      g.fillRect(x + 14, y + BOT_THRUSTER_Y + 1, 4, 1);
    }
  }

  // camera follow; returns true while it's still gliding
  updateCamera() {
    const me = this._self;
    if (!this.follow || !this.selfId || !me) return false;
    const v = this.viewLog();
    const px = me.cx, py = me.cy - 24;
    let tx = this.cam.x, ty = this.cam.y;
    const bw = ROOM.x1 - ROOM.x0, bh = ROOM.y1 - ROOM.y0;
    const usableW = v.w - v.left - v.right, usableH = v.h - v.top - v.bottom;
    // Normally the camera glides to keep you inside the window. With reduced motion it doesn't scroll
    // along: once you step out of the window it jumps once, to centre on you.
    const rm = this.reducedMotion;
    if (bw > usableW) {
      const l = this.cam.x + v.left + usableW * FOLLOW_X0, r = this.cam.x + v.left + usableW * FOLLOW_X1;
      if (px < l || px > r) tx = px - v.left - usableW * (rm ? 0.5 : px < l ? FOLLOW_X0 : FOLLOW_X1);
    }
    if (bh > usableH) {
      const top = this.cam.y + v.top + usableH * FOLLOW_Y0, bot = this.cam.y + v.top + usableH * FOLLOW_Y1;
      if (py < top || py > bot) ty = py - v.top - usableH * (rm ? 0.5 : py < top ? FOLLOW_Y0 : FOLLOW_Y1);
    }
    const x0 = this.cam.x, y0 = this.cam.y;
    const eps = 0.5 / this.s;
    const glide = rm ? 1 : 0.12;
    this.cam.x = Math.abs(tx - x0) < eps ? tx : x0 + (tx - x0) * glide;
    this.cam.y = Math.abs(ty - y0) < eps ? ty : y0 + (ty - y0) * glide;
    this.clampCam(false);
    return this.cam.x !== x0 || this.cam.y !== y0;
  }

  snapTo(gx, gy) {
    const v = this.viewLog();
    const [cx, cy] = this.centerOf(gx, gy);
    this.cam.x = cx - v.left - (v.w - v.left - v.right) / 2;
    this.cam.y = cy - 24 - v.top - (v.h - v.top - v.bottom) / 2;
    this.clampCam(false);
  }
  snapToSelf() {
    const u = this.selfId && this.users.get(this.selfId);
    if (u && this.follow) { const p = this._self ? this._self.pos : this.posOf(u, performance.now()); this.snapTo(p.gx, p.gy); }
  }

  // ---------- crisp overlay: names, bubbles, reactions, typing
  drawOverlay(t, amb, rm, arrow) {
    const c = this.ctx, d = this.dpr, s = this.s;
    const camX = this.cam.x, camY = this.cam.y;
    c.textBaseline = 'alphabetic';
    // the part of the stage no chrome covers (device px), and who's in it: a person is on screen
    // when the middle of their body is (vertically with a little slack); the others get an edge
    // marker instead of a name tag
    const ins = this.insets || {}, band = this._band;
    band.l = Math.round((+ins.left || 0) * d); band.r = this.cw - Math.round((+ins.right || 0) * d);
    band.t = Math.round((+ins.top || 0) * d); band.b = this.ch - Math.round((+ins.bottom || 0) * d);
    for (let i = 0; i < this._nAvs; i++) {
      const a = this._avs[i];
      const x = a.sx = Math.round((a.cx - camX) * s), y = a.sy = Math.round((a.cy - 24 - a.sp.raise + a.bob - camY) * s);
      a.side = x < band.l ? 1 : x > band.r ? 2 : y < band.t - 12 * d ? 3 : y > band.b + 12 * d ? 4 : 0;
    }
    // gong rings
    if (!rm) {
      for (const f of this.fx) {
        if (f.kind === 'gong' && t - f.born < 1800) {
          const gf = this.gongF;
          const [lx, ly] = P(gf.x + 0.5, gf.y + 0.5, 26);
          const [dx, dy] = this.toDevice(lx, ly);
          for (let i = 0; i < 3; i++) {
            const k = (t - f.born - i * 220) / 1400;
            if (k < 0 || k > 1) continue;
            c.strokeStyle = `rgba(255,209,102,${((1 - k) * 0.8).toFixed(3)})`;
            c.lineWidth = 2 * d;
            c.beginPath();
            c.ellipse(dx, dy, (10 + k * 90) * s * 0.5, (10 + k * 60) * s * 0.5, 0, 0, Math.PI * 2);
            c.stroke();
          }
        }
      }
    }
    this.drawTags();
    const sm = this.smallSprites();
    const n = this._nAvs;
    for (let i = 0; i < n; i++) {
      const a = this._avs[i], u = a.u;
      const hx = Math.round((a.cx - camX) * s), hy = Math.round((a.cy - AV_AY + 8 - a.sp.raise + a.bob - camY) * s);
      if (u.typing) { const sp = sm.typing[rm ? 3 : Math.floor(t / 250) % 3]; c.drawImage(sp, hx - sp.ox, hy - 6 * d - sp.oy); }
      if (u.afk) {
        const k = rm ? 0.25 : (amb / 1600) % 1;
        c.globalAlpha = rm ? 0.85 : 1 - k;
        c.drawImage(sm.z, Math.round(hx + 12 * d + k * 8 * d), Math.round(hy - k * 14 * d) - sm.z.oy);
        c.globalAlpha = 1;
      }
      if (u.id === this.selfId && arrow) {
        const bobY = rm ? 0 : Math.sin(t / 180) * 3 * d;
        c.fillStyle = '#ff8a4c';
        c.beginPath();
        c.moveTo(hx - 6 * d, hy - 22 * d + bobY);
        c.lineTo(hx + 6 * d, hy - 22 * d + bobY);
        c.lineTo(hx, hy - 14 * d + bobY);
        c.closePath();
        c.fill();
      }
    }
    this.drawEdgeMarkers();
    // reactions
    if (this.reacts.length) {
      c.font = `${22 * d}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      c.textAlign = 'center';
      for (const r of this.reacts) {
        const a = this.avatarById(r.uid);
        if (!a) continue;
        const k = (t - r.born) / 1800;
        const hx = Math.round((a.cx - camX) * s), hy = Math.round((a.cy - AV_AY + 6 - a.sp.raise + a.bob - camY) * s);
        c.globalAlpha = Math.max(0, Math.min(1, (1 - k) * 2));
        if (rm) c.fillText(r.r, hx, hy - 14 * d);
        else c.fillText(r.r, hx + Math.sin(k * 9) * 5 * d, hy - 10 * d - k * 46 * d);
        c.globalAlpha = 1;
      }
    }
    if (!this.bubblesHidden) this.drawBubbles(t, rm);
    // hover label (desktop)
    if (this.hoverLabel) {
      const { text, dx, dy } = this.hoverLabel;
      const font = `600 ${12 * d}px "Pixelify Sans", system-ui, sans-serif`;
      c.font = font;
      let tw = this._labelW.get(text);
      if (tw == null) { tw = c.measureText(text).width; if (this._labelW.size > 300) this._labelW.clear(); this._labelW.set(text, tw); }
      const w = tw + 14 * d, h = 20 * d;
      const x = Math.max(band.l + 4 * d, Math.min(band.r - w - 4 * d, dx + 14 * d));
      let y = dy + 18 * d;
      if (y + h > band.b - 4 * d) y = dy - h - 10 * d; // no room under the pointer: show it above
      y = Math.max(band.t + 4 * d, y);
      c.fillStyle = 'rgba(14,11,28,0.92)';
      c.fillRect(x, y, w, h);
      c.fillStyle = '#ffb38a';
      c.fillRect(x, y, 3 * d, h);
      c.fillStyle = '#f4f1de';
      c.textAlign = 'left';
      c.fillText(text, x + 9 * d, y + 14 * d);
    }
  }

  avatarById(id) {
    for (let i = 0; i < this._nAvs; i++) if (this._avs[i].u.id === id) return this._avs[i];
    return null;
  }

  // typing dots (3 frames + a still one) and the away "z", rendered once per pixel ratio
  smallSprites() {
    const d = this.dpr;
    if (this._small && this._small.d === d) return this._small;
    const typing = [0, 1, 2, -1].map((on) => {
      const w = Math.ceil(28 * d), h = Math.ceil(14 * d);
      const [cv, g] = makeCanvas(w + 2, h + 2);
      g.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(g, 1, 1, w, h, 4 * d); g.fill();
      for (let i = 0; i < 3; i++) {
        g.fillStyle = on === i ? '#2b2d42' : on < 0 ? '#5d6078' : '#9aa0b5';
        g.fillRect(1 + w / 2 - 9 * d + i * 7 * d, 1 + h / 2 - 1.5 * d, 4 * d, 3 * d);
      }
      cv.ox = 1 + Math.round(w / 2); cv.oy = 1 + h;
      return cv;
    });
    const zf = Math.round(12 * d);
    const [zc, zg] = makeCanvas(Math.ceil(zf * 0.9) + 2, Math.ceil(zf * 1.2) + 2);
    zg.font = `700 ${zf}px "Silkscreen", monospace`;
    zg.textBaseline = 'alphabetic';
    zg.fillStyle = 'rgb(200,210,255)';
    zg.fillText('z', 1, zf);
    zc.oy = zf;
    this._small = { d, typing, z: zc };
    return this._small;
  }

  // Name tags under the feet. You, the person you're pointing at or just tapped, and whoever's
  // talking get first pick of the space; the rest step down a row (with a thin line back to
  // their feet) or are left out when it's crowded. Nobody gets a tag unless their body is on
  // screen (the edge marker stands in for the rest), and tags never overlap: a talker with no
  // room left goes without (their bubble carries their name).
  drawTags() {
    const c = this.ctx, d = this.dpr, s = this.s, camY = this.cam.y, band = this._band;
    const fpx = Math.round((this.bigTags ? 13 : 11) * d);
    const order = this._order;
    order.length = 0;
    const picked = this._picked;
    for (let i = 0; i < this._nAvs; i++) {
      const a = this._avs[i], u = a.u;
      if (a.side) continue;
      a.pri = u.id === this.selfId ? 3 : picked && u.id === picked ? 2 : a.talk ? 1 : 0;
      order.push(a);
    }
    order.sort(byTagPriority);
    const placed = this._tagRects;
    let np = 0;
    const rowH = Math.round(fpx * 1.18), gap = Math.round(d);
    const xMin = band.l + 2 * d, xMax = band.r - 2 * d;
    for (const a of order) {
      const tag = this.tagFor(a.u, fpx);
      const dx = a.sx;
      // just under the sprite as it's drawn: a seat's lift and the bot's float included
      const fy = Math.round((a.cy - AV_AY - a.sp.raise + a.bob + this._footRow(a) + TAG_GAP - camY) * s);
      const x0 = Math.max(xMin, Math.min(xMax - tag.w, dx - (tag.w >> 1))), x1 = x0 + tag.w;
      let row = -1, base = 0;
      const rows = a.pri > 0 ? 3 : 2;
      for (let k = 0; k < rows && row < 0; k++) {
        base = fy + fpx + k * rowH;
        const y0 = base - tag.asc, y1 = base + tag.desc;
        let hit = false;
        for (let j = 0; j < np; j++) { const r = placed[j]; if (x0 < r.x1 + gap && x1 > r.x0 - gap && y0 < r.y1 && y1 > r.y0) { hit = true; break; } }
        if (!hit) row = k;
      }
      if (row < 0) {
        if (a.pri < 2) continue;
        row = 0; base = fy + fpx; // you, or the person you picked, always keep a tag
      }
      const r = placed[np] || (placed[np] = { x0: 0, y0: 0, x1: 0, y1: 0, tag: null, id: null, dx: 0, fy: 0, row: 0, base: 0 });
      r.x0 = x0; r.x1 = x1; r.y0 = base - tag.asc; r.y1 = base + tag.desc;
      r.tag = tag; r.id = a.u.id; r.dx = dx; r.fy = fy; r.row = row; r.base = base;
      np++;
    }
    this._nTags = np; // _tagRects[0..n) are the tags on screen this frame
    // leader lines first, so every tag sits on top of them
    c.fillStyle = 'rgba(244,241,222,0.55)';
    const lw = Math.max(1, Math.round(d));
    for (let j = 0; j < np; j++) {
      const r = placed[j];
      if (r.row > 0) c.fillRect(r.dx - Math.floor(d / 2), r.fy + 2 * d, lw, r.y0 - r.fy - 2 * d);
    }
    for (let j = 0; j < np; j++) { const r = placed[j]; c.drawImage(r.tag.spr, r.x0, r.base - r.tag.base); r.tag = null; }
  }
  // Where the sprite stops (sprite rows, from its top): people stand on the foot anchor; a seated
  // pose is measured from its pixels; the bot floats, so its tag hangs under its thruster.
  _footRow(a) {
    const u = a.u, pose = a.sp.pose;
    if (!u.npc && pose !== 'sit' && pose !== 'sitf') return AV_AY;
    const spr = a.sp.spr;
    let f = this._sprFoot.get(spr);
    if (f == null) {
      f = AV_AY;
      try {
        const w = spr.width, h = spr.height, px = spr.getContext('2d').getImageData(0, 0, w, h).data;
        scan: for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 40) { f = y + 1; break scan; }
      } catch { /* keep the anchor */ }
      this._sprFoot.set(spr, f);
    }
    return u.npc ? Math.max(f, BOT_THRUSTER_Y + 2) : f;
  }
  tagFor(u, fpx) {
    const c = this._uc(u);
    const self = u.id === this.selfId;
    const T = c.tag;
    if (T && T.v === this._tagV && T.login === u.login && T.npc === u.npc && T.admin === u.admin && T.afk === u.afk && T.self === self && T.fpx === fpx) return T;
    let label = u.npc ? `${u.login} · bot` : String(u.login ?? '');
    if (u.admin) label = '★ ' + label;
    if (u.afk) label += ' · away';
    const color = self ? '#ffb38a' : u.npc ? '#9fe8ff' : '#f4f1de';
    const d = this.dpr;
    const font = `600 ${fpx}px "Pixelify Sans", system-ui, sans-serif`;
    const ctx = this.ctx;
    ctx.font = font;
    const tw = ctx.measureText(label).width;
    const w = Math.ceil(tw + 8 * d), h = Math.ceil(fpx * 1.5);
    const [cv, g] = makeCanvas(w, h);
    const base = Math.round(fpx * 1.05);
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.lineJoin = 'round';
    g.lineWidth = 3 * d; g.strokeStyle = 'rgba(10,8,20,0.85)';
    g.strokeText(label, w / 2, base);
    g.fillStyle = color;
    g.fillText(label, w / 2, base);
    c.tag = { v: this._tagV, login: u.login, npc: u.npc, admin: u.admin, afk: u.afk, self, fpx, spr: cv, w, h, base, asc: Math.round(fpx * 0.9), desc: Math.round(fpx * 0.3) };
    return c.tag;
  }

  // a small arrow at the edge for anyone the camera has cut off
  drawEdgeMarkers() {
    const c = this.ctx, d = this.dpr, band = this._band;
    const top = band.t + 18 * d, bot = band.b - 18 * d;
    const m = 9 * d, l = band.l + m, rt = band.r - m;
    for (let i = 0; i < this._nAvs; i++) {
      const a = this._avs[i], u = a.u, side = a.side;
      if (!side || u.id === this.selfId) continue;
      const x = side === 1 ? l : side === 2 ? rt : Math.max(l, Math.min(rt, a.sx));
      const y = side === 3 ? top : side === 4 ? bot : Math.max(top, Math.min(bot, a.sy));
      const col = u.look && !u.look.bot ? LOOK.topColor[u.look.topColor] || '#f26b3a' : '#9fe8ff';
      const r = 6 * d;
      c.beginPath();
      if (side === 1) { c.moveTo(x - r, y); c.lineTo(x + r * 0.6, y - r); c.lineTo(x + r * 0.6, y + r); }
      else if (side === 2) { c.moveTo(x + r, y); c.lineTo(x - r * 0.6, y - r); c.lineTo(x - r * 0.6, y + r); }
      else if (side === 3) { c.moveTo(x, y - r); c.lineTo(x - r, y + r * 0.6); c.lineTo(x + r, y + r * 0.6); }
      else { c.moveTo(x, y + r); c.lineTo(x - r, y - r * 0.6); c.lineTo(x + r, y - r * 0.6); }
      c.closePath();
      c.lineWidth = 2 * d;
      c.strokeStyle = 'rgba(10,8,20,0.9)';
      c.stroke();
      c.fillStyle = col;
      c.fill();
    }
  }

  // Bubbles sit above their speaker and follow them. The newest is closest to the head; older ones
  // stack above it. At most 4 (phone) or 5 are shown, newest first; nobody off-screen gets one
  // pinned to the edge (the chat feed has it). They never draw under the top bar or the dock.
  drawBubbles(t, rm) {
    const list = this.bubbles;
    if (!list.length) return;
    const c = this.ctx, d = this.dpr, s = this.s, band = this._band;
    const topY = band.t, botY = band.b, lX = band.l, rX = band.r;
    const max = this.maxBubbles();
    const vis = this._vis;
    vis.length = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      let ax, ay;
      if (b.uid == null || b.kind === 'announce') { ax = (lX + rX) >> 1; ay = topY + b.hDev + 18 * d; }
      else {
        const a = this.avatarById(b.uid);
        if (!a) continue;
        ax = Math.round((a.cx - this.cam.x) * s);
        ay = Math.round((a.cy - AV_AY - a.sp.raise + a.bob - this.cam.y) * s);
        if (ax < lX || ax > rX || ay < topY || ay > botY + 40 * d) continue;
      }
      if (vis.length >= max) {
        // pushed out by newer lines: fade out quickly
        if (rm) b.dieAt = t; else if (b.dieAt > t + BUBBLE_EVICT) { b.dieAt = t + BUBBLE_EVICT; b.fadeLen = BUBBLE_EVICT; this._needNext = true; }
        continue;
      }
      b.ax = ax; b.ay = ay;
      vis.push(b);
    }
    if (!vis.length) return;
    c.save();
    c.beginPath();
    c.rect(lX, topY, Math.max(0, rX - lX), Math.max(0, botY - topY));
    c.clip();
    const placed = this._placed;
    let np = 0;
    const gap = 4 * d, tailH = 7 * d, margin = 6 * d;
    for (const b of vis) {
      const w = b.wDev, h = b.hDev;
      let x = Math.round(b.ax - w / 2);
      x = Math.max(lX + margin, Math.min(rX - w - margin, x));
      const home = b.ay - tailH;
      let bottom = home;
      for (let guard = 0; guard < 24; guard++) {
        let moved = false;
        for (let j = 0; j < np; j++) {
          const p = placed[j];
          if (x < p.x1 + gap && x + w > p.x0 - gap && bottom > p.y0 - gap && bottom - h < p.y1 + gap) { bottom = p.y0 - gap; moved = true; }
        }
        if (!moved) break;
      }
      const lift = home - bottom;
      if (b.off == null || rm) b.off = lift;
      else if (Math.abs(b.off - lift) < 0.5) b.off = lift;
      else { b.off += (lift - b.off) * 0.3; this._needNext = true; }
      const by = Math.round(home - b.off);
      const r = placed[np] || (placed[np] = { x0: 0, y0: 0, x1: 0, y1: 0 });
      r.x0 = x; r.x1 = x + w; r.y0 = by - h; r.y1 = by; np++;
      b.drawX = x; b.drawY = by - h; b.tail = lift < 0.5 && b.off < 0.5;
    }
    // older ones first so the newest sits on top
    for (let i = vis.length - 1; i >= 0; i--) {
      const b = vis[i];
      const age = t - b.born;
      let alpha = 1;
      if (!rm) {
        if (age < BUBBLE_POP) alpha = Math.max(0.15, age / BUBBLE_POP);
        const left = b.dieAt - t;
        if (left < b.fadeLen) alpha = Math.min(alpha, Math.max(0, left / b.fadeLen));
      }
      if (alpha <= 0) continue;
      c.globalAlpha = alpha;
      const x = b.drawX, y = b.drawY;
      c.drawImage(b.img, x - b.img.pad, y - b.img.pad);
      if (b.tail && b.uid != null) {
        const tx = Math.max(x + 10 * d, Math.min(x + b.wDev - 10 * d, b.ax));
        const yb = y + b.hDev;
        c.fillStyle = 'rgba(10,8,20,0.9)';
        c.beginPath(); c.moveTo(tx - 6 * d, yb); c.lineTo(tx + 6 * d, yb); c.lineTo(tx, yb + 7 * d); c.closePath(); c.fill();
        c.fillStyle = b.fill;
        c.beginPath(); c.moveTo(tx - 4.5 * d, yb - d); c.lineTo(tx + 4.5 * d, yb - d); c.lineTo(tx, yb + 4.5 * d); c.closePath(); c.fill();
      }
    }
    c.globalAlpha = 1;
    c.restore();
  }
}

const SCREEN_COLS = ['#c08bff', '#7dff8a', '#33e1ff', '#ffbe0b', '#ff9a3c', '#ff5fa2'];
// the deploy button cap: two ellipses, cached per position
const btnCache = new Map();
function cachedEllipse(key, cx, cy, rx, ry, n) {
  let p = btnCache.get(key);
  if (!p) { p = ellipsePts(cx, cy, rx, ry, n); btnCache.set(key, p); if (btnCache.size > 16) btnCache.delete(btnCache.keys().next().value); }
  return p;
}
const BUTTON_LO = (x, y) => cachedEllipse(`lo${x},${y}`, x, y, 5, 2.6, 16);
const BUTTON_HI = (x, y) => cachedEllipse(`hi${x},${y}`, x, y - 2, 5, 2.6, 16);

// a string split into graphemes (what a reader sees as one character), or code points as a fallback
const GRAPHEMES = (() => { try { return new Intl.Segmenter(undefined, { granularity: 'grapheme' }); } catch { return null; } })();
function graphemes(s) {
  s = String(s);
  return GRAPHEMES ? Array.from(GRAPHEMES.segment(s), (x) => x.segment) : Array.from(s);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}
