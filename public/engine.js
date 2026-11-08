// The room renderer: isometric pixel lounge drawn at 1x into an offscreen scene,
// then scaled up by an integer factor. Text (names, bubbles, emoji) is drawn on top
// at full device resolution so it stays crisp.
import { W, H, FURNITURE, WALL_ITEMS, WALL_H, WINDOW, STEP_MS, dirFrom, reachable, furnitureAt, hash32, LOOK } from '/shared/world.js';
import { fillPoly, line, ellipsePts, shade, mix, pixelText, textWidth, rng, makeCanvas } from './pixel.js';
import { avatarSprite, AV_AX, AV_AY } from './avatar.js';
import { Valley, localHour, skyAt } from './valley.js';
import { fill, defaultConfig } from '/shared/config.js';

export const SW = 520, SH = 428, OX = 236, OY = 154;
export const P = (gx, gy, z = 0) => [OX + (gx - gy) * 16, OY + (gx + gy) * 8 - z];

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
    base(g, f) {
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
        const cx = 32 + l.ox, cy = FAY + 8 - 12 - (l.z - 12);
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

function buildFurnSprite(f, layer) {
  const p = PAINT[f.kind];
  if (!p || !p[layer]) return null;
  const [c, g] = makeCanvas(FW, FH);
  const r = p[layer](g, f);
  if (r === false) return null;
  return c;
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
function buildExit() {
  const [c, g] = makeCanvas(18, 8);
  g.fillStyle = '#0d2a18'; g.fillRect(0, 0, 18, 8);
  g.fillStyle = '#3dff7a'; pixelText(g, 'EXIT', 2, 2);
  return c;
}
function buildPoster() {
  const [c, g] = makeCanvas(29, 40);
  g.fillStyle = '#e63946'; g.fillRect(0, 0, 29, 40);
  g.fillStyle = '#f4efe3'; g.fillRect(1, 1, 27, 38);
  g.fillStyle = '#e63946'; pixelText(g, 'MERGED', 3, 3);
  g.fillStyle = '#8338ec';
  // a little merge graph: two branches meeting
  g.fillRect(9, 12, 1, 16); g.fillRect(19, 12, 1, 8);
  g.fillRect(10, 22, 1, 1); g.fillRect(11, 23, 1, 1); g.fillRect(12, 24, 1, 1); g.fillRect(18, 20, 1, 1); g.fillRect(17, 21, 1, 1);
  g.fillRect(13, 24, 4, 1); g.fillRect(16, 22, 1, 2);
  g.fillStyle = '#f26b3a'; g.fillRect(8, 11, 3, 3); g.fillRect(18, 11, 3, 3); g.fillRect(8, 27, 3, 3);
  g.fillStyle = '#2b2d42'; pixelText(g, 'LGTM', 7, 32);
  return c;
}
// The neon sign: a small top line and a big bottom line (config.neon), centred, each scaled to fit.
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
// the board's lettering, drawn upright on the wall by wallText()
function fameText(list) {
  const label = `${list ? list.length : 0} MERGED`;
  return [
    { s: 'WALL OF FAME', x: 7, y: 4, color: '#ffd166' },
    { s: label, x: 58 - textWidth(label), y: 37, color: '#a59fc7' },
  ];
}

// ------------------------------------------------------------------ static room
function buildStatic() {
  const [c, g] = makeCanvas(SW, SH);
  const poly = (pts, color) => { g.fillStyle = color; fillPoly(g, pts); };

  // walls
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, WALL_H), P(0, 0, WALL_H)], '#30275a');
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, 28), P(0, 0, 28)], '#251e47');
  poly([P(0, 0, 27), P(0, H, 27), P(0, H, 30), P(0, 0, 30)], '#4b3f86');
  poly([P(0, 0, 0), P(0, H, 0), P(0, H, 3), P(0, 0, 3)], '#1a1433');
  poly([P(0, 0, 95), P(0, H, 95), P(0, H, WALL_H), P(0, 0, WALL_H)], '#3d3373');
  g.fillStyle = '#1f1940';
  for (let a = 0.5; a < H; a += 0.5) { const p0 = P(0, a, 4), p1 = P(0, a, 26); line(g, p0[0], p0[1], p1[0], p1[1]); }

  poly([P(0, 0, 0), P(W, 0, 0), P(W, 0, WALL_H), P(0, 0, WALL_H)], '#2a2350');
  poly([P(0, 0, 0), P(W, 0, 0), P(W, 0, 3), P(0, 0, 3)], '#1a1433');
  poly([P(0, 0, 95), P(W, 0, 95), P(W, 0, WALL_H), P(0, 0, WALL_H)], '#3a3070');
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
  // door mat + light spill
  poly([P(0.05, 9.1), P(0.9, 9.1), P(0.9, 9.9), P(0.05, 9.9)], '#2b2d42');
  poly([P(0.15, 9.2), P(0.8, 9.2), P(0.8, 9.8), P(0.15, 9.8)], '#3a3d5a');
  poly([P(0, 9), P(1.4, 9), P(1.4, 10), P(0, 10)], 'rgba(255,214,150,0.06)');

  // left wall art
  leftWallXform(g, 9, 10, 58); g.drawImage(buildDoor(), 0, 0);
  leftWallXform(g, 9, 10.06, 67); g.drawImage(buildExit(), 0, 0);
  const poster = WALL_ITEMS.find((w) => w.id === 'poster');
  leftWallXform(g, poster.a, poster.b, poster.hi); g.drawImage(buildPoster(), 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

// ------------------------------------------------------------------ engine
export class Engine {
  // opts.config: the lounge config from /api/config (lettering, bot name, time zone)
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const cfg = this.cfg = opts.config || defaultConfig();
    [this.scene, this.sg] = makeCanvas(SW, SH);
    this.static = buildStatic();
    this.valley = new Valley(undefined, { names: cfg.skyline.names, billboards: cfg.skyline.billboards, blimp: cfg.blimp, timezone: cfg.timezone });
    this.winW = Math.round((WINDOW.b - WINDOW.a) * 16) + 2;
    this.winH = WINDOW.hi - WINDOW.lo;
    [this.sky, this.skyG] = makeCanvas(this.winW, this.winH);
    [this.tick, this.tickG] = makeCanvas(Math.round(15 * 16), 7);
    this.neonOn = buildNeon(true, cfg.neon);
    this.neonOff = buildNeon(false, cfg.neon);
    this.fameBuf = buildFame(null);
    this.fameText = fameText(null);
    this.furn = FURNITURE.map((f) => ({ f, base: buildFurnSprite(f, 'base'), front: buildFurnSprite(f, 'front') }));
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
    this.userZoom = null;
    this.alphaCache = new WeakMap();
    this.joinedAt = 0;
    this.lastHour = localHour(cfg.timezone);
    this.hourAt = 0;
    this.resize();
  }

  setFame(list) { this.fameBuf = buildFame(list); this.fameText = fameText(list); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.cw = Math.max(1, Math.round(r.width * this.dpr));
    this.ch = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.width = this.cw;
    this.canvas.height = this.ch;
    this.ctx.imageSmoothingEnabled = false;
    const safeH = this.ch - (this.insets.top + this.insets.bottom) * this.dpr;
    const fit = Math.min(this.cw / SW, Math.max(1, safeH) / SH) * 1.12;
    const narrow = r.width < 720;
    // phones: bigger pixels and let the camera follow you around; desktops: fit the whole room
    this.autoS = narrow ? Math.max(2, Math.round(1.3 * this.dpr)) : Math.max(1, Math.floor(fit), Math.ceil(0.6 * this.dpr - 0.01));
    this.s = Math.max(1, Math.min(8, this.userZoom ?? this.autoS));
    this.clampCam(true);
  }

  zoomBy(step, anchorDx, anchorDy) {
    const old = this.s;
    const next = Math.max(1, Math.min(8, old + step));
    if (next === old) return;
    const ax = anchorDx ?? this.cw / 2, ay = anchorDy ?? this.ch / 2;
    const wx = this.cam.x + ax / old, wy = this.cam.y + ay / old;
    this.s = next;
    this.userZoom = next;
    this.cam.x = wx - ax / next;
    this.cam.y = wy - ay / next;
    this.clampCam(false);
  }

  viewLog() { return { w: this.cw / this.s, h: this.ch / this.s, top: (this.insets.top * this.dpr) / this.s, bottom: (this.insets.bottom * this.dpr) / this.s }; }

  clampCam(center) {
    const v = this.viewLog();
    const usableH = v.h - v.top - v.bottom;
    if (SW <= v.w) this.cam.x = -(v.w - SW) / 2;
    else {
      if (center) this.cam.x = (SW - v.w) / 2;
      this.cam.x = Math.max(-20, Math.min(SW - v.w + 20, this.cam.x));
    }
    // when the room fits, sit it low so chat bubbles have open sky to rise into
    if (SH <= usableH) this.cam.y = -v.top - Math.max(0, usableH - SH) * 0.6;
    else {
      if (center) this.cam.y = (SH - usableH) / 2 - v.top;
      this.cam.y = Math.max(-v.top - 30, Math.min(SH - v.h + v.bottom + 30, this.cam.y));
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
  posOf(u, t) {
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
    return { gx, gy, moving, phase };
  }

  spriteFor(u, t, pos) {
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
    const blink = !u.npc && ((t + (hash32(u.id) % 5000)) % 4300) < 140;
    const spr = avatarSprite(u.look || {}, { view, pose, frame, flip, item: u.item, blink, afk: u.afk, wave });
    return { spr, raise, flip, view, pose };
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
    const fs = this.furn.slice().sort((a, b) => (b.f.x + b.f.y) - (a.f.x + a.f.y));
    for (const it of fs) {
      const [tx, ty] = P(it.f.x, it.f.y);
      const sx = lx - (tx - FAX), sy = ly - (ty - FAY);
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
    let x = SW / 2, y = 60;
    if (u) {
      const pos = this.posOf(u, t);
      const [cx, cy] = this.centerOf(pos.gx, pos.gy);
      const sp = this.spriteFor(u, t, pos);
      x = cx; y = cy - sp.raise - 48 - (u.npc ? 6 : 0);
    }
    const color = u && u.look && !u.look.bot ? LOOK.topColor[u.look.topColor] || '#f26b3a' : '#f26b3a';
    const b = { uid, login: u ? u.login : '', text, kind, color, x, y, ty: y, y0: y, born: t, ...extra };
    this.measureBubble(b);
    this.bubbles.push(b);
    this.layoutBubbles();
    if (this.bubbles.length > 30) this.bubbles.splice(0, this.bubbles.length - 30);
  }

  measureBubble(b) {
    const c = this.ctx, d = this.dpr;
    const fs = this.cw / d < 600 ? 12 : 13;
    b.fs = fs;
    const maxW = (this.cw / d < 600 ? 210 : 236) * d;
    const nameFont = `700 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
    const textFont = `${b.kind === 'me' ? 'italic ' : ''}400 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
    c.font = nameFont;
    const prefix = b.kind === 'me' ? b.login + ' ' : b.kind === 'whisper' ? `${b.login} → ${b.to}: ` : b.login + ': ';
    const nameW = c.measureText(prefix).width;
    c.font = textFont;
    const words = String(b.text).split(/(\s+)/);
    const lines = [];
    let cur = '', curW = nameW;
    for (const w of words) {
      const ww = c.measureText(w).width;
      if (curW + ww > maxW && cur.trim()) {
        lines.push(cur); cur = w.trimStart(); curW = c.measureText(cur).width;
      } else if (ww > maxW) {
        // a very long word: hard-break it
        let piece = '';
        for (const ch of w) {
          if (curW + c.measureText(piece + ch).width > maxW) { lines.push(cur + piece); cur = ''; piece = ch; curW = 0; }
          else piece += ch;
        }
        cur += piece; curW = c.measureText(cur).width + (lines.length ? 0 : nameW);
      } else { cur += w; curW += ww; }
    }
    if (cur) lines.push(cur);
    if (!lines.length) lines.push('');
    let w = 0;
    lines.forEach((l, i) => { w = Math.max(w, c.measureText(l).width + (i === 0 ? nameW : 0)); });
    b.prefix = prefix; b.lines = lines;
    b.wDev = Math.ceil(w + 16 * d + 12 * d);
    b.hDev = Math.ceil(lines.length * (fs + 3) * d + 10 * d);
  }

  layoutBubbles() {
    const toLog = (dev) => dev / this.s;
    const list = this.bubbles.slice().sort((a, b) => b.born - a.born);
    const gap = toLog(4 * this.dpr);
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      for (let j = 0; j < i; j++) {
        const n = list[j];
        if (Math.abs(b.x - n.x) < (toLog(b.wDev) + toLog(n.wDev)) / 2 + gap) {
          const nTop = n.ty - toLog(n.hDev) - gap;
          if (b.ty > nTop) b.ty = nTop;
        }
      }
    }
  }

  addReact(uid, r) { this.reacts.push({ uid, r, born: performance.now() }); if (this.reacts.length > 40) this.reacts.shift(); }
  addFx(kind, data = {}) { this.fx.push({ kind, born: performance.now(), ...data }); if (this.fx.length > 12) this.fx.shift(); }

  // ---------- render
  render(t) {
    const g = this.sg;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, SW, SH);
    const now = Date.now();

    // hour refresh once a minute
    if (t - this.hourAt > 60_000) { this.lastHour = localHour(this.cfg.timezone); this.hourAt = t; }
    const sky = skyAt(this.lastHour);

    // the view out the window
    this.valley.render(this.skyG, this.winW, this.winH, now, { hour: this.lastHour, speed: 3.2, deferText: true });
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

    // ticker
    this.drawTicker(t);
    // neon (with the odd flicker)
    const flick = (Math.floor(now / 120) % 97 === 0) || (Math.floor(now / 90) % 211 === 3);
    const neon = WALL_ITEMS.find((w) => w.id === 'neon');
    leftWallXform(g, neon.a, neon.b, neon.hi);
    g.drawImage(flick ? this.neonOff : this.neonOn, 0, 0);
    const fame = WALL_ITEMS.find((w) => w.id === 'fame');
    leftWallXform(g, fame.a, fame.b, fame.hi);
    g.drawImage(this.fameBuf, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const fo = leftWallOrigin(fame.b, fame.hi);
    for (const tx of this.fameText) { g.fillStyle = tx.color; wallText(g, fo, tx.s, tx.x, tx.y); }

    // neon glow on the floor under the sign at night-ish
    // floor overlays: hover + target
    if (this.hoverTile && this.hoverTile.ok) this.tileOutline(this.hoverTile.x, this.hoverTile.y, 'rgba(255,255,255,0.55)');
    if (this.target && t - this.target.t < 900) {
      const k = (t - this.target.t) / 900;
      this.tileOutline(this.target.x, this.target.y, `rgba(242,107,58,${1 - k})`);
    }

    // sortable things
    const items = [];
    for (const it of this.furn) {
      const d = it.f.x + it.f.y;
      items.push({ d, kind: 'f', it });
      if (it.front) items.push({ d: d + 0.75, kind: 'ff', it });
    }
    const avatarInfo = [];
    for (const u of this.users.values()) {
      const pos = this.posOf(u, t);
      const sp = this.spriteFor(u, t, pos);
      const [cx, cy] = this.centerOf(pos.gx, pos.gy);
      const bob = u.npc ? Math.round(Math.sin(t / 420) * 1.5) - 6 : 0;
      const info = { u, pos, sp, cx: Math.round(cx), cy: Math.round(cy), bob };
      avatarInfo.push(info);
      items.push({ d: pos.gx + pos.gy + 0.5, kind: 'a', info });
    }
    items.sort((a, b) => a.d - b.d);
    for (const item of items) {
      if (item.kind === 'f') this.drawFurn(item.it, t, now);
      else if (item.kind === 'ff') { const [tx, ty] = P(item.it.f.x, item.it.f.y); g.drawImage(item.it.front, tx - FAX, ty - FAY); }
      else this.drawAvatar(item.info, t);
    }

    // deploy alarm wash
    for (const f of this.fx) {
      if (f.kind === 'deploy' && t - f.born < 2400) {
        const k = (t - f.born) / 2400;
        const a = 0.22 * Math.max(0, Math.sin(k * Math.PI * 6)) * (1 - k);
        g.fillStyle = `rgba(255,40,60,${a.toFixed(3)})`;
        g.fillRect(0, 0, SW, SH);
      }
    }

    // ---- blit
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.cw, this.ch);
    this.updateCamera(avatarInfo);
    let shx = 0, shy = 0;
    for (const f of this.fx) {
      const dur = f.kind === 'deploy' ? 700 : f.kind === 'gong' ? 380 : 0;
      if (dur && t - f.born < dur) { const a = (1 - (t - f.born) / dur) * (f.kind === 'deploy' ? 3 : 1.5); shx += Math.round((Math.random() - 0.5) * a) * this.s; shy += Math.round((Math.random() - 0.5) * a) * this.s; }
    }
    c.imageSmoothingEnabled = false;
    const ox = Math.round(-this.cam.x * this.s) + shx, oy = Math.round(-this.cam.y * this.s) + shy;
    c.drawImage(this.scene, ox, oy, SW * this.s, SH * this.s);
    this.drawOverlay(avatarInfo, t);
  }

  tileOutline(x, y, color) {
    const g = this.sg;
    g.fillStyle = color;
    const a = P(x, y), b = P(x + 1, y), cc = P(x + 1, y + 1), d = P(x, y + 1);
    line(g, a[0], a[1], b[0] - 1, b[1]);
    line(g, b[0] - 1, b[1], cc[0], cc[1] - 1);
    line(g, cc[0], cc[1] - 1, d[0] + 1, d[1]);
    line(g, d[0] + 1, d[1], a[0], a[1]);
  }

  drawTicker(t) {
    const g = this.tickG;
    const w = this.tick.width;
    g.fillStyle = '#07060c';
    g.fillRect(0, 0, w, 7);
    g.fillStyle = '#1a1206';
    for (let x = 0; x < w; x += 2) for (let y = 1; y < 6; y += 2) g.fillRect(x, y, 1, 1);
    const s = this.stats;
    const vars = {
      contributors: Number(s.contributors) || 0, mergedPRs: Number(s.mergedPRs) || 0, online: Number(s.online) || 0,
      gongs: Number(s.gongs) || 0, deploys: Number(s.deploys) || 0, loungeName: this.cfg.loungeName,
    };
    const msg = this.cfg.ticker.map((line) => `  * ${fill(line, vars)}`).join('').toUpperCase() + ' ';
    // an LED ticker steps one character at a time, which also keeps every glyph crisp on the wall
    const tw = msg.length * 4;
    const off = (Math.floor(t / 170) * 4) % tw;
    rightWallXform(this.sg, 0.55, 92);
    this.sg.drawImage(this.tick, 0, 0);
    this.sg.setTransform(1, 0, 0, 1, 0, 0);
    const o = rightWallOrigin(0.55, 92);
    this.sg.fillStyle = '#ffb347';
    wallText(this.sg, o, msg, -off, 1, 1, w);
    wallText(this.sg, o, msg, -off + tw, 1, 1, w);
  }

  drawFurn(it, t, now) {
    const g = this.sg;
    const f = it.f;
    const [tx, ty] = P(f.x, f.y);
    if (it.base) g.drawImage(it.base, tx - FAX, ty - FAY);
    const Pf = (lx, ly, z) => P(f.x + lx, f.y + ly, z);
    switch (f.kind) {
      case 'desk': {
        const [x0, y0] = Pf(0.15, 0.2, 36);
        g.setTransform(1, 0.5, 0, 1, Math.round(x0), Math.round(y0));
        this.drawScreen(g, f.screen, now, f.x);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
      case 'rack': {
        const cols = [0.22, 0.36, 0.5, 0.64, 0.78];
        for (let z = 9, row = 0; z < 54; z += 6, row++) {
          for (let ci = 0; ci < cols.length; ci++) {
            const on = (Math.floor(now / (140 + ((row * 7 + ci * 13 + f.y * 5) % 9) * 60)) + row + ci) % 3 !== 0;
            if (!on) continue;
            const [x, y] = Pf(0.66, cols[ci], z);
            g.fillStyle = ci === 0 ? '#ffbe0b' : (row + ci) % 4 === 0 ? '#33e1ff' : '#7dff8a';
            g.fillRect(Math.round(x), Math.round(y), 1, 1);
          }
        }
        break;
      }
      case 'arcade': {
        const [x0, y0] = Pf(0.24, 0.74, 41);
        g.setTransform(1, 0.5, 0, 1, Math.round(x0), Math.round(y0));
        this.drawArcade(g, f, now);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
      case 'gong': {
        const fx = this.fx.filter((e) => e.kind === 'gong').pop();
        const age = fx ? t - fx.born : 1e9;
        const amp = age < 3000 ? (1 - age / 3000) * 2.6 : 0;
        const sw = amp * Math.sin(age / 90);
        const [cx, cy] = Pf(0.5, 0.5, 26);
        const x = Math.round(cx + sw), y = Math.round(cy);
        g.fillStyle = '#5a3a22';
        const top = Pf(0.5, 0.5, 46);
        line(g, x - 4, y - 9, Math.round(top[0]) - 6, Math.round(top[1]));
        line(g, x + 4, y - 9, Math.round(top[0]) + 6, Math.round(top[1]));
        g.fillStyle = '#8a6214'; fillPoly(g, ellipsePts(x, y, 10, 11, 24));
        g.fillStyle = '#d4a017'; fillPoly(g, ellipsePts(x, y, 9, 10, 24));
        g.fillStyle = '#e9c46a'; fillPoly(g, ellipsePts(x, y, 6, 7, 20));
        g.fillStyle = '#c99712'; fillPoly(g, ellipsePts(x, y, 4, 5, 16));
        g.fillStyle = age < 600 ? '#fff3c4' : '#f4d58d'; fillPoly(g, ellipsePts(x, y, 2, 2.5, 12));
        g.fillStyle = '#fff3c4'; g.fillRect(x - 6, y - 6, 2, 1);
        break;
      }
      case 'lavalamp': {
        const base = Pf(0.5, 0.5, 19);
        const bx = Math.round(base[0]), by = Math.round(base[1]);
        for (let i = 0; i < 3; i++) {
          const k = (Math.sin(now / (1700 + i * 600) + i * 2) + 1) / 2;
          const yy = by - 3 - Math.round(k * 12);
          g.fillStyle = i === 1 ? '#ff5fa2' : '#ff9a3c';
          g.fillRect(bx - 2 + (i % 2), yy, 3 - (i === 2 ? 1 : 0), 2 + (i === 0 ? 1 : 0));
        }
        g.fillStyle = 'rgba(255,120,200,0.10)';
        fillPoly(g, ellipsePts(bx, by - 8, 12, 14, 16));
        break;
      }
      case 'button': {
        const fx = this.fx.filter((e) => e.kind === 'deploy').pop();
        const age = fx ? t - fx.born : 1e9;
        const pressed = age < 600;
        const [cx, cy] = Pf(0.5, 0.5, 20);
        const x = Math.round(cx), y = Math.round(cy) + (pressed ? 1 : 0);
        g.fillStyle = '#9c1c28'; fillPoly(g, ellipsePts(x, y, 5, 2.6, 16));
        g.fillStyle = '#e63946'; fillPoly(g, ellipsePts(x, y - 2, 5, 2.6, 16));
        g.fillRect(x - 5, y - 2, 11, 2);
        g.fillStyle = '#ff8a94'; g.fillRect(x - 2, y - 4, 2, 1);
        if (age < 2400 && Math.floor(age / 150) % 2 === 0) {
          g.fillStyle = 'rgba(255,60,60,0.35)';
          fillPoly(g, ellipsePts(x, y - 2, 10, 6, 16));
        }
        break;
      }
      case 'fridge': {
        const hum = 0.06 + 0.03 * Math.sin(now / 900);
        const [x0, y0] = Pf(0.12, 0.64, 46);
        g.fillStyle = `rgba(159,232,255,${hum.toFixed(3)})`;
        g.setTransform(1, 0.5, 0, 1, Math.round(x0), Math.round(y0));
        g.fillRect(0, 0, 12, 41);
        g.setTransform(1, 0, 0, 1, 0, 0);
        break;
      }
    }
  }

  drawScreen(g, kind, now, seed) {
    g.fillStyle = '#0b1320';
    g.fillRect(0, 0, 11, 10);
    if (kind === 'code') {
      const off = Math.floor(now / 380 + seed * 3);
      const cols = ['#c08bff', '#7dff8a', '#33e1ff', '#ffbe0b', '#ff9a3c', '#ff5fa2'];
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
      for (let y = 0; y < 12; y += 2) { g.fillStyle = '#3a2840'; g.fillRect(4, y, 1, 1); }
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

  drawAvatar(info, t) {
    const g = this.sg;
    const { u, pos, sp, cx, cy, bob } = info;
    if (u.npc) {
      g.fillStyle = 'rgba(0,0,0,0.22)';
      fillPoly(g, ellipsePts(cx, cy, 5, 2, 12));
    } else if (!(u.pose === 'sit' && !pos.moving && furnitureAt(Math.round(pos.gx), Math.round(pos.gy)))) {
      g.fillStyle = 'rgba(0,0,0,0.30)';
      fillPoly(g, ellipsePts(cx, cy, 8, 3, 14));
    }
    const x = cx - AV_AX, y = cy - AV_AY - sp.raise + bob;
    if (u.afk) g.globalAlpha = 0.72;
    g.drawImage(sp.spr, x, y);
    g.globalAlpha = 1;
    if (u.npc) {
      // live eye, antenna light, thruster
      const scan = Math.round(Math.sin(t / 700) * 3);
      const ex = sp.flip ? 32 - 1 - (15 + scan) - 1 : 15 + scan;
      if (sp.view === 'front') {
        g.fillStyle = '#33e1ff';
        g.fillRect(x + ex, y + 21, 2, 2);
        g.fillStyle = 'rgba(51,225,255,0.35)';
        g.fillRect(x + ex - 1, y + 20, 4, 4);
      }
      g.fillStyle = Math.floor(t / 500) % 2 ? '#ff3b3b' : '#7dff8a';
      g.fillRect(x + (sp.flip ? 16 : 15), y + 8, 1, 1);
      g.fillStyle = Math.floor(t / 90) % 2 ? '#33e1ff' : '#9fe8ff';
      g.fillRect(x + 13, y + 37, 6, 1);
      g.fillStyle = 'rgba(51,225,255,0.4)';
      g.fillRect(x + 14, y + 38, 4, 1);
    }
  }

  updateCamera(avatarInfo) {
    if (!this.follow || !this.selfId) return;
    const me = avatarInfo.find((a) => a.u.id === this.selfId);
    if (!me) return;
    const v = this.viewLog();
    const px = me.cx, py = me.cy - 24;
    let tx = this.cam.x, ty = this.cam.y;
    if (SW > v.w) {
      const l = this.cam.x + v.w * 0.28, r = this.cam.x + v.w * 0.72;
      if (px < l) tx = px - v.w * 0.28; else if (px > r) tx = px - v.w * 0.72;
    }
    const usableH = v.h - v.top - v.bottom;
    if (SH > usableH) {
      const top = this.cam.y + v.top + usableH * 0.3, bot = this.cam.y + v.top + usableH * 0.72;
      if (py < top) ty = py - v.top - usableH * 0.3; else if (py > bot) ty = py - v.top - usableH * 0.72;
    }
    this.cam.x += (tx - this.cam.x) * 0.12;
    this.cam.y += (ty - this.cam.y) * 0.12;
    this.clampCam(false);
  }

  snapTo(gx, gy) {
    const v = this.viewLog();
    const [cx, cy] = this.centerOf(gx, gy);
    this.cam.x = cx - v.w / 2;
    this.cam.y = cy - 24 - v.top - (v.h - v.top - v.bottom) / 2;
    this.clampCam(false);
  }

  // ---------- crisp overlay: names, bubbles, reactions, typing
  drawOverlay(avatarInfo, t) {
    const c = this.ctx, d = this.dpr, s = this.s;
    c.textBaseline = 'alphabetic';
    // gong rings
    for (const f of this.fx) {
      if (f.kind === 'gong' && t - f.born < 1800) {
        const g = FURNITURE.find((x) => x.id === 'gong');
        const [lx, ly] = P(g.x + 0.5, g.y + 0.5, 26);
        const [dx, dy] = this.toDevice(lx, ly);
        for (let i = 0; i < 3; i++) {
          const k = (t - f.born - i * 220) / 1400;
          if (k < 0 || k > 1) continue;
          c.strokeStyle = `rgba(255,209,102,${(1 - k) * 0.8})`;
          c.lineWidth = 2 * d;
          c.beginPath();
          c.ellipse(dx, dy, (10 + k * 90) * s * 0.5, (10 + k * 60) * s * 0.5, 0, 0, Math.PI * 2);
          c.stroke();
        }
      }
    }
    // name tags (front-most get first pick of the space; the rest stack below instead of overlapping)
    c.font = `600 ${11 * d}px "Pixelify Sans", system-ui, sans-serif`;
    c.textAlign = 'center';
    c.lineJoin = 'round';
    const taken = [];
    const ordered = avatarInfo.slice().sort((p, q) => (q.u.id === this.selfId) - (p.u.id === this.selfId) || (q.pos.gx + q.pos.gy) - (p.pos.gx + p.pos.gy));
    for (const a of ordered) {
      const { u, cx, cy, sp } = a;
      const [dx, dy] = this.toDevice(cx, cy + 3);
      let label = u.npc ? `${u.login} · bot` : u.login;
      if (u.admin) label = '★ ' + label;
      if (u.afk) label += ' · away';
      const tw = c.measureText(label).width + 6 * d, th = 13 * d;
      let ty = dy + 11 * d;
      for (let k = 0; k < 4; k++) {
        const hit = taken.find((r) => Math.abs(r.x - dx) < (r.w + tw) / 2 && Math.abs(r.y - ty) < th);
        if (!hit) break;
        ty = hit.y + th;
      }
      taken.push({ x: dx, y: ty, w: tw });
      c.lineWidth = 3 * d;
      c.strokeStyle = 'rgba(10,8,20,0.85)';
      c.strokeText(label, dx, ty);
      c.fillStyle = u.id === this.selfId ? '#ffb38a' : u.npc ? '#9fe8ff' : '#f4f1de';
      c.fillText(label, dx, ty);
    }
    for (const a of avatarInfo) {
      const { u, cx, cy, sp } = a;
      const [hx, hy] = this.toDevice(cx, cy - AV_AY + 8 - sp.raise + (a.bob || 0));
      if (u.typing) this.drawTyping(hx, hy - 6 * d, t);
      if (u.afk) {
        c.font = `700 ${12 * d}px "Silkscreen", monospace`;
        const k = (t / 1600) % 1;
        c.fillStyle = `rgba(200,210,255,${1 - k})`;
        c.fillText('z', hx + 12 * d + k * 8 * d, hy - k * 14 * d);
        c.font = `600 ${11 * d}px "Pixelify Sans", system-ui, sans-serif`;
      }
      if (u.id === this.selfId && t - this.joinedAt < 5000) {
        const bobY = Math.sin(t / 180) * 3 * d;
        c.fillStyle = '#ff8a4c';
        c.beginPath();
        c.moveTo(hx - 6 * d, hy - 22 * d + bobY);
        c.lineTo(hx + 6 * d, hy - 22 * d + bobY);
        c.lineTo(hx, hy - 14 * d + bobY);
        c.closePath();
        c.fill();
      }
    }
    // reactions
    c.font = `${22 * d}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
    this.reacts = this.reacts.filter((r) => t - r.born < 1800);
    for (const r of this.reacts) {
      const a = avatarInfo.find((x) => x.u.id === r.uid);
      if (!a) continue;
      const k = (t - r.born) / 1800;
      const [hx, hy] = this.toDevice(a.cx, a.cy - AV_AY + 6 - a.sp.raise + (a.bob || 0));
      c.globalAlpha = Math.min(1, (1 - k) * 2);
      c.fillText(r.r, hx + Math.sin(k * 9) * 5 * d, hy - 10 * d - k * 46 * d);
      c.globalAlpha = 1;
    }
    this.drawBubbles(t);
    // hover label (desktop)
    if (this.hoverLabel) {
      const { text, dx, dy } = this.hoverLabel;
      c.font = `600 ${12 * d}px "Pixelify Sans", system-ui, sans-serif`;
      const w = c.measureText(text).width + 14 * d;
      const x = Math.min(this.cw - w - 4 * d, dx + 14 * d), y = dy + 18 * d;
      c.fillStyle = 'rgba(14,11,28,0.92)';
      c.fillRect(x, y, w, 20 * d);
      c.fillStyle = '#ffb38a';
      c.fillRect(x, y, 3 * d, 20 * d);
      c.fillStyle = '#f4f1de';
      c.textAlign = 'left';
      c.fillText(text, x + 9 * d, y + 14 * d);
    }
  }

  drawTyping(x, y, t) {
    const c = this.ctx, d = this.dpr;
    const w = 28 * d, h = 14 * d;
    c.fillStyle = 'rgba(255,255,255,0.95)';
    roundRect(c, x - w / 2, y - h, w, h, 4 * d);
    c.fill();
    for (let i = 0; i < 3; i++) {
      const on = Math.floor(t / 250) % 3 === i;
      c.fillStyle = on ? '#2b2d42' : '#9aa0b5';
      c.fillRect(x - 9 * d + i * 7 * d, y - h / 2 - 1.5 * d, 4 * d, 3 * d);
    }
  }

  drawBubbles(t) {
    const c = this.ctx, d = this.dpr;
    // periodic drift upward, Habbo style
    if (!this.lastDrift) this.lastDrift = t;
    if (t - this.lastDrift > 4200) {
      this.lastDrift = t;
      const step = (22 * d) / this.s;
      for (const b of this.bubbles) b.ty -= step;
    }
    this.bubbles = this.bubbles.filter((b) => t - b.born < 26000 && (b.ty - this.cam.y) * this.s > -200 * d);
    for (const b of this.bubbles) {
      b.y += (b.ty - b.y) * 0.25;
      const [ax, ay] = this.toDevice(b.x, b.y);
      let x = ax - b.wDev / 2;
      x = Math.max(6 * d, Math.min(this.cw - b.wDev - 6 * d, x));
      const y = ay - b.hDev;
      const age = t - b.born;
      const alpha = age > 23000 ? Math.max(0, 1 - (age - 23000) / 3000) : 1;
      c.globalAlpha = alpha;
      const fill = b.kind === 'whisper' ? '#e9e7f5' : b.kind === 'me' ? '#fff4d6' : b.npc ? '#ffe7da' : '#ffffff';
      c.fillStyle = 'rgba(10,8,20,0.9)';
      roundRect(c, x - d, y - d, b.wDev + 2 * d, b.hDev + 2 * d, 7 * d);
      c.fill();
      c.fillStyle = fill;
      roundRect(c, x, y, b.wDev, b.hDev, 6 * d);
      c.fill();
      // tail while fresh
      if (Math.abs(b.ty - b.y0) < 0.5) {
        const tx = Math.max(x + 10 * d, Math.min(x + b.wDev - 10 * d, ax));
        c.fillStyle = 'rgba(10,8,20,0.9)';
        c.beginPath(); c.moveTo(tx - 6 * d, y + b.hDev); c.lineTo(tx + 6 * d, y + b.hDev); c.lineTo(tx, y + b.hDev + 7 * d); c.closePath(); c.fill();
        c.fillStyle = fill;
        c.beginPath(); c.moveTo(tx - 4.5 * d, y + b.hDev - d); c.lineTo(tx + 4.5 * d, y + b.hDev - d); c.lineTo(tx, y + b.hDev + 4.5 * d); c.closePath(); c.fill();
      }
      // speaker color chip
      c.fillStyle = b.color || '#f26b3a';
      roundRect(c, x + 6 * d, y + 6 * d, 8 * d, b.hDev - 12 * d, 2 * d);
      c.fill();
      c.textAlign = 'left';
      const fs = b.fs || 13;
      let ly = y + 5 * d + (fs - 1) * d;
      b.lines.forEach((l, i) => {
        let lx = x + 20 * d;
        if (i === 0) {
          c.font = `700 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
          c.fillStyle = b.kind === 'whisper' ? '#6b5fb5' : '#1b1830';
          c.fillText(b.prefix, lx, ly);
          lx += c.measureText(b.prefix).width;
        }
        c.font = `${b.kind === 'me' ? 'italic ' : ''}400 ${fs * d}px "Pixelify Sans", system-ui, sans-serif`;
        c.fillStyle = b.kind === 'whisper' ? '#4a4470' : '#2b2d42';
        c.fillText(l, lx, ly);
        ly += (fs + 3) * d;
      });
      c.globalAlpha = 1;
    }
  }
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
