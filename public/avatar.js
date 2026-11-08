// Procedural pixel avatars. Every sprite is 32x52 with the feet anchored at (16, 48).
//
// A sprite is painted part by part (arm, legs, torso, head, hair, extras, arm) into a small
// pixel buffer. Each part gets a 1px outline as it lands: dark against empty space, a softer
// line where it overlaps a part painted earlier. The buffer goes to a canvas in one write.
//
// The base sprite faces right; facing left is a mirror flip. Front view = facing down-right,
// so the body's near side is on the left. Back view = facing up-right, near side on the right.
// Light comes from the left, like the room's furniture.
import { LOOK } from '/shared/world.js';
import { makeCanvas } from './pixel.js';

export const AV_W = 32, AV_H = 52, AV_AX = 16, AV_AY = 48;

// opts: view 'front'|'back', pose 'stand'|'walk'|'sit'|'sitf'|'dance'|'wave', frame (walk/dance
// 0-3, wave 0-1), flip, item null|'kombucha'|'coldbrew', blink, afk, wave.
// Optional: breath 0|1 (1px idle rise for stand/sit/sitf). Leaving it out draws breath 0.
const CACHE_CAP = 900;
const cache = new Map(); // least recently used first
let misses = 0;
export function avatarSprite(look, opts) {
  const o = opts || {};
  const bot = !!(look && look.bot);
  const view = o.view === 'back' ? 'back' : 'front';
  const pose = o.pose || 'stand';
  // only flags that change pixels go in the key
  const blink = (o.blink || (!bot && o.afk)) && view === 'front' ? 1 : 0;
  const breath = o.breath && !bot && (pose === 'stand' || pose === 'sit' || pose === 'sitf') ? 1 : 0;
  const wave = o.wave && pose !== 'wave' ? 1 : 0;
  const key = bot // the bot is drawn the same in every pose
    ? 'bot|' + view + '|' + (o.flip ? 1 : 0) + '|' + blink
    : JSON.stringify(look) + '|' + view + '|' + pose + '|' + (o.frame | 0) + '|' + (o.flip ? 1 : 0) + '|' + (o.item || '') + '|' + blink + '|' + wave + '|' + breath;
  let c = cache.get(key);
  if (c) { cache.delete(key); cache.set(key, c); return c; }
  misses++;
  reset();
  if (bot) paintBot({ view, blink });
  else paintPerson(look || {}, { view, pose, frame: o.frame | 0, item: o.item, blink, wave, breath });
  c = toCanvas(!!o.flip);
  cache.set(key, c);
  if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
  return c;
}
export function avatarCacheStats() { return { size: cache.size, cap: CACHE_CAP, misses }; }

// ------------------------------------------------------------------ pixel buffer
const N = AV_W * AV_H;
const main = new Int32Array(N); // -1 = empty, else 0xRRGGBB
const ink = new Uint8Array(N); // 1 = outer outline, 2 = inner outline
const part = new Int32Array(N);
const GROUND = AV_AY - 1; // bottom row of the shoe soles when standing; the anchor row is just below
let floorRow = GROUND; // no outline below the feet when standing

function reset() { main.fill(-1); ink.fill(0); floorRow = GROUND; }
function begin() { part.fill(-1); }
function R(x, y, w, h, c) {
  if (c == null) return;
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(AV_W, x + w), y1 = Math.min(AV_H, y + h);
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) part[yy * AV_W + xx] = c;
}
function D(x, y, c) { R(x, y, 1, 1, c); }
// ASCII template: each char looks up a colour in pal; anything else is transparent.
function T(x0, y0, rows, pal, clipY = -99) {
  for (let j = 0; j < rows.length; j++) {
    if (y0 + j < clipY) continue;
    const row = rows[j];
    for (let i = 0; i < row.length; i++) { const c = pal[row[i]]; if (c !== undefined) D(x0 + i, y0 + j, c); }
  }
}
const filled = (x, y) => x >= 0 && y >= 0 && x < AV_W && y < AV_H && part[y * AV_W + x] !== -1;
// Land the current part. mode 0: no outline, 1: outline over empty pixels only,
// 2: also a softer inner line over earlier parts (only on rows >= minInnerY).
function commit(inner, outer, mode = 2, minInnerY = -99) {
  if (mode) {
    for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) {
      const i = y * AV_W + x;
      if (part[i] !== -1) continue;
      if (!(filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1))) continue;
      if (main[i] === -1) { if (y <= floorRow) { main[i] = outer; ink[i] = 1; } }
      else if (mode === 2 && ink[i] !== 1 && y >= minInnerY) { main[i] = inner; ink[i] = 2; }
    }
  }
  for (let i = 0; i < N; i++) if (part[i] !== -1) { main[i] = part[i]; ink[i] = 0; }
}
function toCanvas(flip) {
  const [cv, g] = makeCanvas(AV_W, AV_H);
  const img = g.createImageData(AV_W, AV_H);
  const d = img.data;
  for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) {
    const c = main[y * AV_W + (flip ? AV_W - 1 - x : x)];
    if (c === -1) continue;
    const k = (y * AV_W + x) * 4;
    d[k] = (c >> 16) & 255; d[k + 1] = (c >> 8) & 255; d[k + 2] = c & 255; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------ colour
const hexInt = new Map();
function C(h) {
  let v = hexInt.get(h);
  if (v === undefined) { v = parseInt(String(h).slice(1, 7), 16); if (!(v >= 0)) v = 0x808080; hexInt.set(h, v); }
  return v;
}
function mix(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
const lum = (c) => 0.299 * ((c >> 16) & 255) + 0.587 * ((c >> 8) & 255) + 0.114 * (c & 255);
const INK = 0x1a1220, SHADE = 0x24163a, LIGHT = 0xfff4dc;
const dk = (c, t) => mix(c, SHADE, t); // shadows lean purple
const lt = (c, t) => mix(c, LIGHT, t); // highlights lean warm
const oL = (c) => mix(c, INK, 0.8); // outline over empty space
const iL = (c) => mix(c, INK, 0.5); // outline over another part
const tones = (c) => ({ c, s: dk(c, 0.24), d: dk(c, 0.45), l: lt(c, 0.2) });

const KNIT = ['#e63946', '#3a86ff', '#ffbe0b', '#2ec4b6', '#f26b3a', '#8338ec', '#f4f1de', '#141414', '#6a994e', '#ff6fb5'];
const BUCKET = ['#c8b98a', '#6b7a4a', '#2b2d42', '#e9e4da', '#d4a373', '#4f6d7a'];
const BOW = ['#ff6fb5', '#e63946', '#ffbe0b', '#3a86ff', '#f4f1de'];
const knit = (n) => C(KNIT[((n % KNIT.length) + KNIT.length) % KNIT.length]);
function lab(c) { // sRGB -> CIE L*a*b* (D65)
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const r = f((c >> 16) & 255), g = f((c >> 8) & 255), b = f(c & 255);
  const x = t((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), y = t(0.2126 * r + 0.7152 * g + 0.0722 * b), z = t((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
// Colour for a tie, bow or band on the hair: the list's colour at index n, or the next one that
// stands out against bg (no black tie on black hair, no pink bow on pink hair).
function onHair(list, n, bg) {
  for (let k = 0; k < list.length; k++) {
    const c = C(list[(((n + k) % list.length) + list.length) % list.length]);
    if (deltaE(c, bg) >= 34) return c;
  }
  return lum(bg) > 128 ? INK : LIGHT;
}

// ------------------------------------------------------------------ hair templates
// 20 columns starting at x = 6, first row at y = hy - 7 (hy = top row of the head).
// The head covers columns 4-15 (x 10-21), rows 7-18. Front view: the ear sits at columns 5-6,
// rows 12-14, eyes at columns 9-10 and 13-14 on rows 12-13. Back view: ear at columns 13-14.
// '#' hair, 'l' highlight, 'm' half highlight, 'd' shadow, 'e' deep shadow, 's' shaved sides
// (mohawk), 'k' stubble (buzz), 't' hair tie.
const HAIR = {
  short: {
    f: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll##......',
      '....##lll#######....',
      '....#ll#########....',
      '....###d....####....',
      '....##.......d#.....',
      '....#...............',
      '....#...............',
      '....d...............',
      '....d...............',
    ],
    b: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll##......',
      '....##lll#######....',
      '....#ll#########....',
      '....#l##########....',
      '....############....',
      '....#########.......',
      '....#########.......',
      '....d########.......',
      '.....dd######d......',
      '.......dddd.........',
    ],
  },
  long: {
    f: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll###.....',
      '....##lll#######....',
      '...##ll#########....',
      '...###d.....####....',
      '...##.........d#....',
      '...##..........#....',
      '...##..........#....',
      '...##..........d....',
      '...####.............',
      '...#l##.............',
      '...####.............',
      '...####.............',
      '...####.............',
      '...d##d.............',
      '....dd..............',
    ],
    b: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll##......',
      '....##lll#######....',
      '...##ll#########....',
      '...#ll##########....',
      '...#############....',
      '...##########.......',
      '...##########.......',
      '...##########.......',
      '...###########......',
      '...#l##########.....',
      '...############.....',
      '...############.....',
      '...############.....',
      '...############.....',
      '...d##########d.....',
      '....dddddddddd......',
    ],
  },
  bun: {
    f: [
      '', '', '',
      '......####..........',
      '.....#llll#.........',
      '.....#ll###.........',
      '......#t#####.......',
      '.....##lllll##......',
      '....##lll#######....',
      '....#ll#########....',
      '....###.....####....',
      '....##.......d#.....',
      '....#...............',
      '....#...............',
      '....d...............',
    ],
    b: [
      '', '',
      '.......####.........',
      '......#llll#........',
      '......#l####........',
      '.......dttd.........',
      '......#######.......',
      '.....##lllll##......',
      '....##lll#######....',
      '....#ll#########....',
      '....#l##########....',
      '....############....',
      '....#########.......',
      '....#########.......',
      '....d########.......',
      '.....dd######d......',
      '.......dddd.........',
    ],
  },
  spiky: {
    f: [
      '', '', '',
      '.......#...#........',
      '.....#.#l..##.#.....',
      '.....##ll#.##l##....',
      '....#l#l####l###....',
      '....###llll#####....',
      '....##lll#######....',
      '....#ll##########...',
      '....###......###d...',
      '....##..............',
      '....#...............',
      '....#...............',
      '....d...............',
    ],
    b: [
      '', '', '',
      '.......#...#........',
      '.....#.#l..##.#.....',
      '.....##ll#.##l##....',
      '....#l#l####l###....',
      '....###llll#####....',
      '....##lll#######....',
      '....#ll#########....',
      '....#l##########....',
      '....############....',
      '....#########.......',
      '....#########.......',
      '....d########.......',
      '.....dd######d......',
      '.......dddd.........',
    ],
  },
  curly: { // curls drawn in: puffs lit on the upper left, shadowed lower right
    f: [
      '', '', '', '',
      '......lm.d..#d......',
      '.....#m#dl##m#d.....',
      '....ll#d##dd#d#d....',
      '...m##dl####m###d...',
      '...##d#m#d##d###e...',
      '..d####ddddd###ee...',
      '...lm#d.....d##ee...',
      '...mdd.......eee....',
      '..m#d...............',
      '..##d...............',
      '...#d...............',
      '..#dd...............',
      '...d................',
    ],
    b: [
      '', '', '', '',
      '......lm.d..#d......',
      '.....#m#dl##m#d.....',
      '....ll#d##dd#d#d....',
      '...m##dl####m###d...',
      '...##d#m#d##d###d...',
      '..d#####dd#d###de...',
      '...lm##m##m#####e...',
      '...md#m##d##d#eee...',
      '..d####dd####.......',
      '...#m#m#####e.......',
      '...#d###d###e.......',
      '..dd###d###ee.......',
      '...d##d###e#e.......',
      '....##.eee.e........',
    ],
  },
  buzz: { // stubble: hair tone dithered with skin, no volume
    f: [
      '', '', '', '', '', '', '',
      '......#k#k#k#k......',
      '.....#l#k#k#k#k.....',
      '....#l#k#k#k#k#.....',
      '....#k#k...k........',
      '....k#k.............',
      '....#k..............',
      '....k...............',
      '....#...............',
    ],
    b: [
      '', '', '', '', '', '', '',
      '......#k#k#k#k......',
      '.....#l#k#k#k#k.....',
      '....#l#k#k#k#k#k....',
      '....l#k#k#k#k#k#....',
      '....#k#k#k#k#k#k....',
      '....k#k#k#k#k.......',
      '....#k#k#k#k#.......',
      '....k#k#k#k#k.......',
      '.....k.k.k.k........',
    ],
  },
  mohawk: { // a crest running front to back, seen from the side in the front view
    f: [
      '', '',
      '......l...l.........',
      '.....#l..#l..l......',
      '.....##l.##l#l......',
      '......##l###l##.....',
      '......#l########....',
      '.....s#########s....',
      '....sssssssssssss...',
      '....ssss.....sss....',
      '....sss.............',
      '....ss..............',
      '....s...............',
      '....s...............',
    ],
    b: [
      '', '',
      '........l...........',
      '.......#l#.l........',
      '.......#l##l#.......',
      '.......#l####.......',
      '.......#l###d.......',
      '.....ss#l###ss......',
      '....sss#l##dssss....',
      '....sss#l##dssss....',
      '....ssss#l#dssss....',
      '....ssss#l#dssss....',
      '....ssss#l#ds.......',
      '....sssss#dss.......',
      '....sssssssss.......',
      '.....ssssssss.......',
    ],
  },
  bald: { f: [], b: [] },
  ponytail: {
    f: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll##......',
      '....##lll######.....',
      '..#t#l#########.....',
      '.##t###d......#.....',
      '.###d#..............',
      '.##.#...............',
      '.##.#...............',
      '.##.d...............',
      '.#l#................',
      '.##.................',
      '.##.................',
      '..d.................',
    ],
    b: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll##......',
      '....##lll#######....',
      '....#ll#########....',
      '....#l###tt#####....',
      '....####d##d####....',
      '....####d##d#.......',
      '....d###d##d#.......',
      '....d###l##.........',
      '.....dd#l#d.........',
      '.......###..........',
      '.......#l#..........',
      '.......###..........',
      '.......###..........',
      '........d...........',
    ],
  },
  bob: {
    f: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll###.....',
      '....##lll########...',
      '...##ll##########...',
      '...###l#########d...',
      '...###d.........#...',
      '...##...........#...',
      '...##...........d...',
      '...##...............',
      '...###..............',
      '...###..............',
      '....dd..............',
    ],
    b: [
      '', '', '', '', '', '',
      '......#######.......',
      '.....##lllll###.....',
      '....##lll########...',
      '...##ll##########...',
      '...#ll###########...',
      '...##############...',
      '...###########......',
      '...###########......',
      '...###########......',
      '...############.....',
      '...############.....',
      '....dddddddddd......',
    ],
  },
  afro: { // curls drawn in: puffs lit on the upper left, shadowed lower right
    f: [
      '',
      '.....lmd.lld........',
      '....l##dm##d#d......',
      '...m#dd###d#m#d.....',
      '..m#d#l####m##dm.d..',
      '..#d##m#d###dd##dd..',
      '.dml###ddm########e.',
      '..#d#lm#m##d#mm###e.',
      '.#d##m#d#dd####d#ee.',
      '.####m#ddddd##d###e.',
      '.#lm##d.....d#####..',
      '.dm#dd.........e#ee.',
      '..#dd...........##e.',
      '.dm#d...........ee..',
      '..##d...............',
      '..m#d...............',
      '...#................',
    ],
    b: [
      '',
      '.....lmd.lld........',
      '....l##dm##d#d......',
      '...m#dd###d#m##d....',
      '..m#d#l####m##dm#...',
      '..#d##m#d###dd##dd..',
      '.#ml###ddm########e.',
      '.m#d#lm#m##d#mm###e.',
      '..d##m#d#dd####d#ee.',
      '.##ll#m###########e.',
      '.#m##d##d#########e.',
      '.###d##dd###d#ee#e..',
      '.dm########d######e.',
      '..##d#m###d#######..',
      '..dd##d##d###e##e...',
      '...d####d######ee...',
      '....d##d.#e###e.....',
      '......dee..ee.......',
    ],
  },
  braids: { // cornrow lines on top, rope braids with a twist pattern
    f: [
      '', '', '', '', '', '',
      '......#d#d#d#.......',
      '.....##d#d#d##......',
      '....#l#d#d#d#d##....',
      '....#l#d#d#d#d##....',
      '....#l#d.....###....',
      '....#l#.......d.....',
      '....#d..............',
      '....#d..............',
      '....dd..............',
      '.....l#d............',
      '......l#d...........',
      '......#l#...........',
      '......d#l...........',
      '......l#d...........',
      '......#l#...........',
      '......d#l...........',
      '......l#d...........',
      '......#l#...........',
      '......ttt...........',
      '.......d............',
    ],
    b: [
      '', '', '', '', '', '',
      '......#d#d#d#.......',
      '.....##d#d#d##......',
      '....#l#d#d#d#d##....',
      '....#l#d#d#d#d#d....',
      '....#l#d#d#d#d#d....',
      '....#l#d#d#d#d#d....',
      '....#l#d#d#d#.......',
      '....#l#d#d#d#.......',
      '....#l#d#d#d#.......',
      '.....d#d#d#d#.......',
      '.....l#d..l#d.......',
      '.....#l#..#l#.......',
      '.....d#l..d#l.......',
      '.....l#d..l#d.......',
      '.....#l#..#l#.......',
      '.....d#l..d#l.......',
      '.....l#d..l#d.......',
      '.....#l#..#l#.......',
      '.....ttt..ttt.......',
      '......d....d........',
    ],
  },
  swept: {
    f: [
      '', '', '', '',
      '..........###.......',
      '.......####ll##.....',
      '......##lllll###....',
      '.....##lllll#####...',
      '....##lll#########..',
      '....#ll##########d..',
      '....###......####d..',
      '....##........dd....',
      '....#...............',
      '....#...............',
      '....d...............',
    ],
    b: [
      '', '', '', '',
      '..........###.......',
      '.......####ll##.....',
      '......##lllll###....',
      '.....##lllll#####...',
      '....##lll#########..',
      '....#ll#########d...',
      '....#l##########....',
      '....############....',
      '....#########.......',
      '....#########.......',
      '....d########.......',
      '.....dd######d......',
      '.......dddd.........',
    ],
  },
  pigtails: {
    f: [
      '', '', '', '', '', '',
      '......###d###.......',
      '.....##ll#ll##......',
      '....##lll#l#####....',
      '..t##ll######d###t..',
      '.###l###.....###l##.',
      '.##l#d.........d#l#.',
      '.#l##...........##l.',
      '.##l#...........#l#.',
      '.#l#d...........d##.',
      '..##.............#..',
      '..d..............d..',
    ],
    b: [
      '', '', '', '', '', '',
      '......###d###.......',
      '.....##ll#ll##......',
      '....##lll#l#####....',
      '..t##ll###d####d#t..',
      '.###l#####d#####l##.',
      '.##l######d#####d#l#',
      '.#l######d#####..##l',
      '.##l#####d#####..#l#',
      '.#l##d###d####d..d##',
      '..##..dddddddd....#.',
      '..d...............d.',
    ],
  },
};

// First template row with any hair, front or back (so the halo doesn't jump when turning).
const hairTops = new Map();
function hairTop(style) {
  let t = hairTops.get(style);
  if (t === undefined) {
    const tpl = HAIR[style] || { f: [], b: [] };
    t = Math.min(...[tpl.f, tpl.b].map((rows) => { const i = rows.findIndex((r) => /[^.]/.test(r)); return i < 0 ? 99 : i; }));
    hairTops.set(style, t);
  }
  return t;
}

// ------------------------------------------------------------------ the person
// Body rows when standing; every other pose shifts them down (sitting) or up (bob, breath).
const HIP_Y = 34; // top of the 3 hip rows
const SHOULDER_Y = 23;
// How far the body drops when sitting. They pair with engine.js, which lifts a seated sprite
// by SEAT_H[kind] - 4 (SEAT_H at engine.js:40, the lift in Engine.spriteFor at engine.js:682)
// or by -2 on the floor: change one side and seated people float or sink into the furniture.
const SIT_DROP = 7; // 'sit': the last hip row, HIP_Y + SIT_DROP + 2 = 43, rests on the seat
const SITF_DROP = 9; // 'sitf': the crossed legs rest on the floor

function paintPerson(look, o) {
  const skin = C(LOOK.skin[look.skin] || LOOK.skin[0]);
  const hairC = C(LOOK.hairColor[look.hairColor] || LOOK.hairColor[0]);
  const topName = LOOK.top[look.top] || 'tee';
  const topC = C(LOOK.topColor[look.topColor] || LOOK.topColor[0]);
  const pantsC = C(LOOK.pants[look.pants] || LOOK.pants[0]);
  const shoesC = C(LOOK.shoes[look.shoes] || LOOK.shoes[0]);
  const style = LOOK.hairStyle[look.hairStyle] || 'short';
  const acc = LOOK.acc[look.acc] || 'none';
  const tc = Number.isInteger(look.topColor) ? look.topColor : 0;

  const back = o.view === 'back';
  const pose = o.pose;
  const f = o.frame & 3;
  const sitting = pose === 'sit' || pose === 'sitf';
  let bob = 0;
  if (pose === 'walk') bob = f & 1 ? -1 : 0;
  if (pose === 'dance') bob = [0, -2, 0, -1][f];
  const base = sitting ? (pose === 'sit' ? SIT_DROP : SITF_DROP) : bob;
  const hipY = HIP_Y + base;
  const sh = SHOULDER_Y + base - o.breath; // shoulder row
  const hy = sh - 13; // top row of the head
  floorRow = sitting ? AV_H - 1 : GROUND;

  const S = tones(skin);
  const Hc = tones(hairC);
  if (lum(hairC) < 80) Hc.l = lt(hairC, 0.3); // dark hair needs a stronger sheen to read
  const Pn = tones(pantsC);
  const Sh = { c: shoesC, s: dk(shoesC, 0.28), sole: mix(dk(shoesC, 0.6), INK, 0.35), l: lt(shoesC, 0.35) };
  // what covers the torso and arms
  const shirtC = topName === 'vest' ? C('#dfe7f2') : topC;
  const sleeveKind = topName === 'tank' ? 'none' : topName === 'tee' || topName === 'polo' || topName === 'overalls' ? 'short' : 'long';
  const sleeve = tones(shirtC);
  const cuffed = topName === 'hoodie' || topName === 'sweater' || topName === 'puffer' || topName === 'cardigan';

  // ---- arms: which screen side does what
  let armL = 'down', armR = 'down', swL = 0, swR = 0;
  if (pose === 'walk') { const s = [1, 0, -1, 0][f]; swR = -s; swL = s; } // opposite to the leg on that side
  if (sitting) { swL = 1; swR = 1; } // hands rest on the lap
  if (pose === 'dance') { const q = [['up', 'up'], ['down', 'down'], ['down', 'up'], ['up', 'down']][f]; armL = q[0]; armR = q[1]; }
  if (pose === 'wave' || o.wave) armR = f & 1 ? 'up2' : 'up'; // wave with the arm on the facing side
  const nearSide = back ? 'R' : 'L';
  let hand = null;

  const drawArm = (side, mode, sw) => {
    const near = side === nearSide;
    const sl = near ? sleeve : { c: sleeve.s, s: sleeve.d, l: sleeve.c };
    const sk = near ? S : { c: S.s, s: S.d, l: S.c };
    begin();
    if (mode === 'down') {
      const x = side === 'L' ? (near ? 9 : 8) : (near ? 20 : 21);
      const fx = x + (sw > 0 ? 1 : sw < 0 ? -1 : 0);
      const hx = x + (sw > 0 ? 2 : sw < 0 ? -1 : 0);
      const hY = sh + 10 - (sw > 0 ? 1 : 0);
      const col = (cx, y0, y1, isSleeve) => { // a 3px wide arm segment, lit on the left
        if (y1 < y0) return;
        const t = isSleeve ? sl : sk;
        R(cx, y0, 3, y1 - y0 + 1, t.c);
        R(cx, y0, 1, y1 - y0 + 1, t.l);
        R(cx + 2, y0, 1, y1 - y0 + 1, t.s);
      };
      const upTo = sleeveKind === 'long' ? hY - 1 : sleeveKind === 'short' ? sh + 3 : sh;
      // upper arm sh+1..sh+5, forearm sh+6..hY-1
      for (let y = sh + 1; y < hY; y++) {
        const cx = y <= sh + 5 ? x : fx;
        col(cx, y, y, y <= upTo && sleeveKind !== 'none');
      }
      if (sleeveKind === 'none') { R(x, sh + 1, 3, 1, sk.l); }
      if (cuffed) R(fx, hY - 1, 3, 1, sl.s);
      else if (sleeveKind === 'short') R(x, sh + 3, 3, 1, sl.s);
      // hand
      R(hx, hY, 3, 1, sk.c); D(hx, hY, sk.l); D(hx + 2, hY, sk.s);
      R(hx, hY + 1, 2, 1, sk.c); D(hx + 1, hY + 1, sk.s);
      if (near) hand = { x: hx, y: hY };
    } else {
      // raised: designed for the right side, mirrored for the left. 'up2' tips the forearm out.
      const m = side === 'L';
      const RR = (x, y, w, h, c) => R(m ? 32 - x - w : x, y, w, h, c);
      const ox = near ? 0 : 1; // the far arm sits a little further out, behind the head
      const out = mode === 'up2' ? 1 : 0;
      const seg = (x, y0, y1, isSleeve) => {
        const t = isSleeve ? sl : sk;
        RR(x, y0, 3, y1 - y0 + 1, t.c);
        RR(m ? x + 2 : x, y0, 1, y1 - y0 + 1, t.l);
        RR(m ? x : x + 2, y0, 1, y1 - y0 + 1, t.s);
      };
      const sx = 20 + ox; // shoulder
      const ax = 22 + ox; // upper arm column
      const longS = sleeveKind === 'long', shortS = sleeveKind === 'short';
      seg(sx, sh, sh + 2, sleeveKind !== 'none');
      seg(ax - 1, sh - 3, sh - 1, longS || shortS);
      seg(ax, sh - 6, sh - 4, longS);
      seg(ax + out, sh - 9, sh - 7, longS);
      if (longS) RR(ax + out, sh - 9, 3, 1, sl.s);
      // hand
      const hx = ax + out * 2;
      RR(hx, sh - 11, 3, 2, sk.c);
      RR(m ? hx + 2 : hx, sh - 11, 1, 2, sk.l);
      RR(m ? hx - 1 : hx + 3, sh - 10, 1, 1, sk.c); // thumb
      RR(hx + 1, sh - 12, 1, 1, sk.c); // fingertips
    }
    const ref = near ? sleeve.c : sleeve.s;
    commit(iL(ref), oL(ref), 2);
  };

  // ---- legs (+ hips)
  const drawLegs = () => {
    const legC = (near) => (near ? Pn : { c: Pn.s, s: Pn.d, d: dk(pantsC, 0.6), l: Pn.c });
    const shoe = (near) => (near ? Sh : { c: Sh.s, s: dk(shoesC, 0.45), sole: Sh.sole, l: Sh.c });
    if (!sitting) {
      const ground = GROUND + (pose === 'dance' ? bob : 0);
      let Lg = [0, 0, 0], Rg = [0, 0, 0]; // [thigh dx, shin dx, lift]
      if (pose === 'walk') {
        if (f === 0) { Rg = [1, 2, 0]; Lg = [0, -1, 1]; }
        if (f === 1) { Lg = [0, 1, 2]; }
        if (f === 2) { Lg = [1, 2, 0]; Rg = [0, -1, 1]; }
        if (f === 3) { Rg = [0, 1, 2]; }
      }
      if (pose === 'dance') {
        if (f === 0) { Lg = [-1, -1, 0]; Rg = [1, 1, 0]; }
        if (f === 2) Rg = [0, 1, 2];
        if (f === 3) Lg = [0, 1, 2];
      }
      const leg = (x, g, near) => {
        const [tdx, sdx, lift] = g;
        const t = legC(near), s = shoe(near);
        const top = hipY + 1, knee = hipY + 6, shoeTop = ground - 2 - lift;
        R(x + tdx, top, 4, knee - top, t.c);
        R(x + tdx, top, 1, knee - top, t.l);
        R(x + tdx + 3, top, 1, knee - top, t.s);
        R(x + sdx, knee, 4, shoeTop - knee, t.c);
        R(x + sdx, knee, 1, shoeTop - knee, t.l);
        R(x + sdx + 3, knee, 1, shoeTop - knee, t.s);
        if (lift === 0 && sdx === tdx) D(x + sdx + 3, shoeTop - 1, t.d); // hem crease
        // shoe: toe points right
        R(x + sdx, shoeTop, 4, 1, s.c);
        R(x + sdx, shoeTop + 1, 5, 1, s.c);
        R(x + sdx, shoeTop + 2, 5, 1, s.sole);
        if (back) D(x + sdx, shoeTop + 1, s.s);
        else { D(x + sdx + 3, shoeTop, s.l); D(x + sdx + 4, shoeTop + 1, s.s); }
      };
      const farX = back ? 11 : 16, nearX = back ? 16 : 11;
      const farG = back ? Lg : Rg, nearG = back ? Rg : Lg;
      // far leg + hips first, then the near leg with a line where it overlaps
      begin();
      leg(farX, farG, false);
      R(11, hipY, 9, 3, Pn.c);
      R(11, hipY, 9, 1, Pn.s);
      R(11, hipY + 1, 1, 2, Pn.l);
      commit(iL(pantsC), oL(pantsC), 1);
      begin();
      leg(nearX, nearG, true);
      R(nearX + Math.min(0, nearG[0]), hipY + 1, 4, 1, Pn.c);
      commit(iL(pantsC), oL(pantsC), 2, hipY + 3);
      return;
    }
    if (pose === 'sit') {
      begin();
      if (!back) {
        // far thigh (behind), near thigh (in front), shins hanging toward the floor
        const fl = legC(false), nl = legC(true), fs = shoe(false), ns = shoe(true);
        R(13, hipY - 1, 9, 3, fl.c); R(13, hipY - 1, 9, 1, fl.l);
        R(20, hipY + 2, 3, 4, fl.c); R(22, hipY + 2, 1, 4, fl.s);
        R(20, hipY + 6, 4, 1, fs.c); R(20, hipY + 7, 5, 1, fs.c); R(20, hipY + 8, 5, 1, fs.sole);
        commit(iL(pantsC), oL(pantsC), 1);
        begin();
        R(11, hipY, 9, 3, nl.c);
        R(11, hipY + 1, 10, 3, nl.c); R(11, hipY + 1, 10, 1, nl.l); R(11, hipY + 3, 10, 1, nl.s);
        R(18, hipY + 4, 3, 3, nl.c); R(18, hipY + 4, 1, 3, nl.l); R(20, hipY + 4, 1, 3, nl.s);
        R(18, hipY + 6, 4, 1, ns.c); R(18, hipY + 7, 5, 1, ns.c); R(18, hipY + 8, 5, 1, ns.sole);
        D(21, hipY + 6, ns.l);
        commit(iL(pantsC), oL(pantsC), 2);
      } else {
        // from behind: hips on the seat, the near knee and shin peeking out on the right
        const nl = legC(true), ns = shoe(true);
        R(11, hipY, 10, 3, Pn.c); R(11, hipY, 10, 1, Pn.s); R(11, hipY + 1, 1, 2, Pn.l);
        R(19, hipY - 2, 4, 3, nl.c); R(22, hipY - 2, 1, 3, nl.s);
        R(20, hipY + 1, 3, 4, nl.c); R(22, hipY + 1, 1, 4, nl.s);
        R(20, hipY + 5, 4, 1, ns.c); R(20, hipY + 6, 4, 1, ns.sole);
        commit(iL(pantsC), oL(pantsC), 2);
      }
      return;
    }
    // sitf: cross-legged on the floor
    begin();
    const nl = legC(true), ns = shoe(true), fs = shoe(false);
    // knees out to both sides, shins crossed in front, a foot tucked under each knee
    R(11, hipY, 9, 1, Pn.c);
    R(9, hipY + 1, 14, 1, nl.c);
    R(7, hipY + 2, 18, 2, nl.c);
    R(9, hipY + 4, 14, 1, nl.s);
    R(7, hipY + 2, 2, 1, nl.l); R(9, hipY + 1, 2, 1, nl.l); // near knee catches the light
    R(23, hipY + 2, 2, 2, nl.s); // far knee
    if (!back) {
      R(12, hipY + 3, 7, 1, nl.l); D(11, hipY + 2, nl.l); // near shin crossing over
      R(19, hipY + 3, 4, 1, ns.c); R(19, hipY + 4, 4, 1, ns.sole); D(19, hipY + 3, ns.l); // near foot
      R(9, hipY + 3, 3, 1, fs.c); R(9, hipY + 4, 3, 1, fs.sole); // far foot
    } else {
      R(11, hipY, 9, 1, Pn.s);
      R(11, hipY + 1, 9, 1, Pn.s);
    }
    commit(iL(pantsC), oL(pantsC), 2);
  };

  // ---- torso
  const hideNeck = topName === 'turtleneck' || topName === 'puffer';
  const drawTorso = () => {
    begin();
    const c = shirtC;
    const t = tones(c);
    const x0 = 11, x1 = 20, y0 = sh, y1 = hipY - 1, H = y1 - y0 + 1;
    const wide = topName === 'puffer' ? 1 : 0;
    R(x0 + 1 - wide, y0, x1 - x0 - 1 + 2 * wide, 1, t.c);
    R(x0 - wide, y0 + 1, x1 - x0 + 1 + 2 * wide, H - 1, t.c);
    R(x0 - wide, y0 + 1, 1, H - 1, t.l); D(x0 + 1 - wide, y0, t.l);
    R(x1 + wide, y0 + 1, 1, H - 1, t.s); D(x1 - 1 + wide, y0, t.s);
    R(x0 - wide, y1, x1 - x0 + 1 + 2 * wide, 1, t.s);
    const T2 = tones(topC);
    const light = lum(topC) > 150;
    const accent = light ? 0x2b2d42 : 0xf4f1de;
    const r = (n) => y0 + n; // row helper
    switch (topName) {
      case 'tee':
        if (!back) {
          R(14, r(0), 4, 1, S.s); R(15, r(1), 2, 1, S.c); D(13, r(0), T2.s); D(18, r(0), T2.s);
          // tiny logo: a little diamond on the chest
          const lg = mix(accent, topC, 0.15);
          D(18, r(3), lg); D(17, r(4), lg); D(19, r(4), lg); D(18, r(5), lg);
        } else R(13, r(0), 6, 1, T2.s);
        break;
      case 'hoodie':
        if (!back) {
          R(12, r(-1), 2, 1, T2.s); R(18, r(-1), 2, 1, T2.s);
          R(12, r(0), 8, 1, T2.s); R(13, r(0), 6, 1, T2.d);
          const cord = mix(accent, topC, 0.2);
          R(15, r(1), 1, 3, cord); R(17, r(1), 1, 3, cord);
          D(15, r(4), dk(cord, 0.3)); D(17, r(4), dk(cord, 0.3));
          R(14, r(H - 5), 5, 1, T2.s); D(13, r(H - 4), T2.s); D(19, r(H - 4), T2.s); D(13, r(H - 3), T2.s); D(19, r(H - 3), T2.s);
          R(11, y1, 10, 1, T2.d);
        } else {
          R(13, r(-1), 6, 1, T2.s);
          R(12, r(0), 8, 4, T2.s); R(13, r(0), 6, 3, T2.d); R(13, r(4), 6, 1, T2.s);
          R(11, y1, 10, 1, T2.d);
        }
        break;
      case 'vest': {
        const V = tones(topC);
        if (!back) {
          R(11, r(1), 4, H - 1, V.c); R(17, r(1), 4, H - 1, V.c);
          R(12, r(0), 3, 1, V.c); R(17, r(0), 3, 1, V.c);
          R(11, r(1), 1, H - 1, V.l); R(20, r(1), 1, H - 1, V.s);
          D(15, r(3), V.c); D(16, r(5), V.c); R(15, r(4), 2, 1, V.c); R(15, r(5), 1, H - 5, V.c);
          R(15, r(6), 2, H - 6, V.c);
          D(16, r(6), V.l); D(16, r(8), V.l);
          R(11, y1, 10, 1, V.s);
          R(15, r(0), 2, 1, 0x2b2d42); // tie knot at the collar
        } else {
          R(11, r(1), 10, H - 1, V.c); R(11, r(1), 1, H - 1, V.l); R(20, r(1), 1, H - 1, V.s);
          R(13, r(5), 6, 1, V.s); D(16, r(5), 0xc9ccd6);
          R(12, r(0), 8, 1, t.c); R(11, y1, 10, 1, V.s);
        }
        break;
      }
      case 'turtleneck':
        R(13, r(-2), 6, 2, T2.c); R(13, r(-2), 6, 1, T2.l); R(13, r(-1), 1, 1, T2.l); D(18, r(-1), T2.s);
        R(13, r(0), 6, 1, T2.s);
        for (let x = 13; x < 20; x += 2) R(x, r(2), 1, H - 3, mix(T2.c, T2.s, 0.45));
        break;
      case 'flannel': {
        for (let y = y0 + 1; y < y1; y++) for (let x = 11; x <= 20; x++) {
          const v = (x - 11) % 4 === 1, h = (y - y0) % 4 === 2;
          if (v && h) D(x, y, T2.d); else if (v || h) D(x, y, T2.s);
          else if ((x - 11) % 4 === 3 && (y - y0) % 4 === 0) D(x, y, T2.l);
        }
        if (!back) {
          R(13, r(0), 2, 1, T2.l); R(17, r(0), 2, 1, T2.l); D(14, r(1), T2.l); D(17, r(1), T2.l);
          R(16, r(1), 1, H - 2, T2.d); D(16, r(3), accent); D(16, r(6), accent);
        } else R(13, r(0), 6, 1, T2.l);
        break;
      }
      case 'jacket':
        if (!back) {
          const tee = 0xf1f1f1;
          R(14, r(0), 4, H - 1, tee); R(14, r(0), 1, H - 1, 0xd8d8de); R(15, r(0), 2, 1, S.s);
          R(13, r(0), 1, 5, T2.l); R(18, r(0), 1, 5, T2.l); D(12, r(0), T2.l); D(19, r(0), T2.l);
          R(13, r(5), 1, H - 6, T2.d); R(18, r(5), 1, H - 6, T2.d);
          R(11, y1, 10, 1, T2.s);
        } else { R(12, r(0), 8, 1, T2.l); R(16, r(2), 1, H - 3, T2.s); }
        break;
      case 'sweater': {
        const band = mix(accent, topC, 0.25);
        for (let x = 11; x <= 20; x++) { D(x, r(3), (x & 1) ? band : T2.c); D(x, r(4), (x & 1) ? T2.c : band); }
        R(11, r(2), 10, 1, T2.s); R(11, r(5), 10, 1, T2.s);
        for (let x = 11; x <= 20; x++) D(x, y1, (x & 1) ? T2.d : T2.s);
        if (!back) { R(13, r(0), 6, 1, T2.s); R(14, r(0), 4, 1, T2.d); }
        else R(13, r(0), 6, 1, T2.s);
        break;
      }
      case 'polo':
        if (!back) {
          const col = lt(topC, 0.35);
          R(13, r(0), 2, 1, col); R(17, r(0), 2, 1, col); D(14, r(1), col); D(17, r(1), col);
          D(15, r(0), S.s); D(16, r(0), S.s);
          R(15, r(1), 2, 3, T2.s); D(16, r(2), accent); D(16, r(3), accent);
        } else R(12, r(0), 8, 1, lt(topC, 0.35));
        break;
      case 'tank':
        // bare shoulders, thin straps
        R(11, r(0), 10, 2, S.c); R(11, r(0), 1, 2, S.l); R(20, r(0), 1, 2, S.s); R(12, r(0), 8, 1, S.c);
        if (!back) {
          R(13, r(0), 2, 2, T2.c); R(18, r(0), 2, 2, T2.c);
          R(15, r(2), 3, 1, S.s);
        } else { R(13, r(0), 2, 2, T2.c); R(17, r(0), 2, 2, T2.c); R(15, r(2), 2, 1, S.s); }
        break;
      case 'overalls': {
        const B = Pn;
        const btn = 0xe0b84a;
        if (!back) {
          R(13, r(0), 6, 1, S.s); R(14, r(1), 4, 1, S.c); D(13, r(1), T2.s); D(18, r(1), T2.s);
          R(13, r(4), 6, H - 4, B.c); R(13, r(4), 6, 1, B.l); R(13, r(4), 1, H - 4, B.l);
          R(14, r(6), 4, 1, B.s); D(14, r(7), B.s); D(17, r(7), B.s);
          R(13, r(0), 1, 4, B.c); R(18, r(0), 1, 4, B.c);
          D(13, r(4), btn); D(18, r(4), btn);
          R(11, r(H - 2), 10, 2, B.c); R(11, r(H - 2), 1, 2, B.l); R(20, r(H - 2), 1, 2, B.s);
        } else {
          for (let k = 0; k < 6; k++) { D(12 + k, r(k), B.c); D(19 - k, r(k), B.c); }
          R(13, r(6), 6, H - 6, B.c);
          R(11, r(H - 3), 10, 3, B.c); R(11, r(H - 3), 10, 1, B.l); R(20, r(H - 3), 1, 3, B.s);
        }
        break;
      }
      case 'puffer':
        for (let k = 3; k < H - 1; k += 3) { R(10, r(k), 12, 1, T2.s); R(11, r(k - 1), 9, 1, T2.l); }
        R(13, r(-1), 6, 2, T2.c); R(13, r(-1), 6, 1, T2.l); R(18, r(-1), 1, 2, T2.s);
        if (!back) { R(16, r(0), 1, H - 1, T2.d); D(16, r(2), 0xc9ccd6); }
        break;
      case 'cardigan':
        if (!back) {
          const tee = 0xece6d6;
          R(15, r(0), 2, H - 1, tee); R(14, r(0), 1, 3, tee); R(17, r(0), 1, 2, tee);
          R(14, r(3), 1, H - 4, T2.d); R(17, r(2), 1, H - 3, T2.s);
          D(17, r(4), accent); D(17, r(7), accent);
          R(12, r(H - 4), 2, 1, T2.s); R(19, r(H - 4), 1, 1, T2.s);
          for (let x = 11; x <= 20; x++) D(x, y1, (x & 1) ? T2.d : T2.s);
        } else {
          R(13, r(0), 6, 1, T2.s);
          for (let x = 11; x <= 20; x++) D(x, y1, (x & 1) ? T2.d : T2.s);
        }
        break;
    }
    commit(iL(c), oL(c), 2);
  };

  // ---- head
  const drawHead = () => {
    begin();
    if (!hideNeck) { R(14, hy + 12, 4, 1, S.s); D(14, hy + 12, S.d); }
    const rows = back
      ? [[12, 19], [11, 20], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [11, 20], [12, 19]]
      : [[12, 19], [11, 20], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [10, 21], [11, 21], [12, 20]];
    rows.forEach(([a, b], j) => R(a, hy + j, b - a + 1, 1, S.c));
    R(10, hy + 2, 1, 8, S.l); D(11, hy + 1, S.l);
    R(21, hy + 3, 1, 7, S.s);
    R(12, hy + 11, back ? 8 : 9, 1, S.s); D(11, hy + 10, S.s);
    if (!back) {
      // ear (near side)
      D(11, hy + 5, S.s); D(12, hy + 5, S.s); D(11, hy + 6, S.s); D(12, hy + 6, S.d); D(12, hy + 7, S.s);
      const browC = style === 'bald' || style === 'buzz' ? mix(hairC, skin, 0.25) : mix(hairC, INK, 0.25);
      R(15, hy + 4, 2, 1, browC); R(19, hy + 4, 2, 1, browC);
      const EYE = 0x1b1416;
      if (o.blink) {
        R(15, hy + 6, 2, 1, EYE); R(19, hy + 6, 2, 1, EYE);
      } else {
        R(15, hy + 5, 2, 2, EYE); R(19, hy + 5, 2, 2, EYE);
        D(15, hy + 5, 0xffffff); D(19, hy + 5, 0xffffff);
        if (lum(skin) < 110) { const w = mix(0xf4ede4, skin, 0.25); D(15, hy + 6, w); D(19, hy + 6, w); } // whites read on deep skin
      }
      D(21, hy + 7, S.d); // nose shadow on the cheek edge
      D(22, hy + 7, S.s); // nose tip
      R(18, hy + 9, 2, 1, mix(skin, 0x7a2232, 0.45));
      D(20, hy + 8, mix(skin, 0xff6b6b, 0.3)); D(15, hy + 8, mix(skin, 0xff6b6b, 0.22));
    } else {
      D(19, hy + 5, S.s); D(20, hy + 5, S.s); D(19, hy + 6, S.d); D(20, hy + 6, S.s); D(19, hy + 7, S.s);
    }
    commit(iL(skin), oL(skin), 2);
  };

  // ---- hair
  const hats = acc === 'beanie' || acc === 'cap' || acc === 'bucket hat';
  const drawHair = () => {
    const tpl = HAIR[style];
    if (style === 'bald') {
      begin(); D(12, hy + 1, lt(skin, 0.45)); D(13, hy + 1, lt(skin, 0.3)); commit(0, 0, 0);
      return;
    }
    if (!tpl) return;
    begin();
    const stub = mix(hairC, skin, 0.3);
    const pal = style === 'buzz'
      ? { '#': stub, k: mix(hairC, skin, 0.62), l: mix(stub, LIGHT, 0.2) }
      : { '#': Hc.c, l: Hc.l, m: mix(Hc.c, Hc.l, 0.5), d: Hc.s, e: Hc.d, s: mix(hairC, skin, 0.55), t: onHair(KNIT, tc + 6, hairC) };
    T(6, hy - 7, back ? tpl.b : tpl.f, pal, hats ? hy - 2 : -99);
    commit(iL(hairC), oL(hairC), 2, hy + 12);
  };

  // ---- accessories
  const drawAcc = () => {
    begin();
    let ref = 0x222222, mode = 2;
    // Seen from behind, glasses show only an earpiece at the head's edge; an afro covers that spot.
    const bigHair = style === 'afro';
    // What a head-worn accessory sits against: skin on bald/buzz heads, hair otherwise.
    const behindHead = style === 'bald' || style === 'buzz' ? skin : hairC;
    switch (acc) {
      case 'glasses': {
        const F = 0x1c1c24; ref = F; mode = 0;
        if (back) { if (!bigHair) D(21, hy + 5, F); break; }
        for (const lx of [14, 18]) { R(lx, hy + 4, 4, 1, F); R(lx, hy + 7, 4, 1, F); R(lx, hy + 5, 1, 2, F); R(lx + 3, hy + 5, 1, 2, F); }
        D(13, hy + 5, F); D(12, hy + 5, F);
        D(16, hy + 6, 0x9fd8ff); D(20, hy + 6, 0x9fd8ff);
        break;
      }
      case 'round glasses': {
        const F = 0xd9a441, Fd = 0xa87a2a; ref = F; mode = 0;
        if (back) { if (!bigHair) D(21, hy + 5, Fd); break; }
        for (const lx of [14, 18]) { R(lx + 1, hy + 4, 2, 1, F); R(lx + 1, hy + 7, 2, 1, Fd); R(lx, hy + 5, 1, 2, F); R(lx + 3, hy + 5, 1, 2, Fd); }
        D(13, hy + 5, F); D(12, hy + 5, Fd);
        break;
      }
      case 'shades': {
        const F = 0x0d0d14; ref = F; mode = 0;
        if (back) { if (!bigHair) D(21, hy + 5, F); break; }
        R(14, hy + 4, 4, 3, F); R(18, hy + 4, 4, 3, F); D(14, hy + 6, 0x24242e); D(18, hy + 6, 0x24242e);
        D(15, hy + 4, 0x5b6bff); D(19, hy + 4, 0x5b6bff); D(13, hy + 5, F); D(12, hy + 5, F);
        break;
      }
      case 'headphones': {
        const band = 0x2a2a36, cup = 0xf26b3a, cupL = 0xff9a6b, cupD = 0xb8481f; ref = band;
        R(12, hy - 2, 8, 1, band); D(11, hy - 1, band); D(20, hy - 1, band);
        if (!back) {
          R(10, hy, 1, 3, band); D(21, hy, band);
          R(9, hy + 3, 4, 6, cup); R(9, hy + 3, 4, 1, cupL); R(9, hy + 4, 1, 4, cupL); R(12, hy + 4, 1, 5, cupD); R(10, hy + 8, 3, 1, cupD);
        } else {
          R(21, hy, 1, 3, band); D(10, hy, band);
          R(19, hy + 3, 4, 6, cup); R(19, hy + 3, 4, 1, cupL); R(22, hy + 4, 1, 5, cupD); R(19, hy + 8, 3, 1, cupD);
          R(9, hy + 4, 2, 4, cupD);
        }
        break;
      }
      case 'beanie': {
        const k = knit(tc + 3), K = tones(k); ref = k;
        R(12, hy - 3, 8, 1, K.c); R(11, hy - 2, 10, 1, K.c); R(10, hy - 1, 12, 3, K.c);
        R(11, hy - 2, 2, 1, K.l); R(10, hy - 1, 1, 3, K.l);
        R(9, hy + 2, 14, 2, K.s); for (let x = 10; x < 23; x += 2) R(x, hy + 2, 1, 2, K.d);
        R(14, hy - 6, 4, 3, lt(k, 0.4)); D(14, hy - 6, lt(k, 0.65)); D(17, hy - 4, K.c);
        break;
      }
      case 'cap': {
        const k = knit(tc + 5), K = tones(k); ref = k;
        R(12, hy - 3, 8, 1, K.c); R(11, hy - 2, 10, 1, K.c); R(10, hy - 1, 12, 3, K.c);
        R(11, hy - 2, 2, 1, K.l); R(10, hy - 1, 1, 3, K.l); D(15, hy - 4, K.d);
        if (!back) { R(16, hy + 2, 9, 1, K.s); R(21, hy + 1, 4, 1, K.c); R(16, hy - 1, 3, 2, lt(k, 0.6)); R(10, hy + 2, 6, 1, K.d); }
        else { R(13, hy + 1, 5, 1, K.d); D(15, hy + 1, 0xc9ccd6); R(20, hy + 1, 4, 1, K.s); R(10, hy + 2, 3, 1, K.d); }
        break;
      }
      case 'bucket hat': {
        const k = C(BUCKET[((tc % BUCKET.length) + BUCKET.length) % BUCKET.length]), K = tones(k); ref = k;
        R(12, hy - 3, 8, 1, K.c); R(11, hy - 2, 10, 3, K.c); R(11, hy - 2, 2, 3, K.l);
        R(11, hy + 1, 10, 1, K.d);
        R(9, hy + 2, 14, 1, K.c); R(8, hy + 3, 3, 1, K.s); R(21, hy + 3, 3, 1, K.s); R(11, hy + 3, 10, 1, K.s);
        R(9, hy + 2, 2, 1, K.l);
        break;
      }
      case 'headband': {
        const k = onHair(KNIT, tc + 1, behindHead), K = tones(k); ref = k;
        R(10, hy + 2, 12, 2, K.c); R(10, hy + 2, 12, 1, K.l); R(10, hy + 3, 1, 1, K.s);
        if (!back) R(17, hy + 2, 2, 2, lt(k, 0.6)); else R(9, hy + 3, 2, 3, K.s);
        break;
      }
      case 'scarf': {
        const k = knit(tc + 2), K = tones(k), st = lt(k, 0.55); ref = k;
        R(12, sh - 1, 8, 3, K.c); R(12, sh - 1, 8, 1, K.l); R(11, sh, 1, 2, K.s); R(20, sh, 1, 2, K.s);
        for (let x = 13; x < 20; x += 3) R(x, sh, 1, 2, st);
        if (!back) { R(12, sh + 2, 3, 6, K.c); R(12, sh + 2, 1, 6, K.l); R(12, sh + 4, 3, 1, st); R(12, sh + 8, 1, 1, K.s); R(14, sh + 8, 1, 1, K.s); }
        break;
      }
      case 'beard': {
        const B = Hc; ref = hairC;
        if (!back) {
          R(17, hy + 8, 4, 1, B.c); D(17, hy + 8, B.s);
          R(13, hy + 9, 5, 1, B.c); R(20, hy + 9, 2, 1, B.c);
          R(12, hy + 10, 10, 1, B.c); R(13, hy + 11, 8, 1, B.s); R(13, hy + 5, 1, 4, B.c); D(12, hy + 9, B.s);
          D(18, hy + 10, B.l); D(15, hy + 10, B.l);
        } else { R(21, hy + 7, 1, 4, B.c); R(19, hy + 10, 3, 1, B.c); R(18, hy + 11, 3, 1, B.s); }
        break;
      }
      case 'bow': {
        const k = onHair(BOW, tc, behindHead), K = tones(k); ref = k;
        const bx = back ? 13 : 9, by = back ? hy + 1 : hy;
        T(bx, by, ['##.##', '#l#l#', '##.##'], { '#': K.c, l: K.l });
        D(bx + 2, by + 1, K.s); D(bx, by + 2, K.s); D(bx + 4, by + 2, K.s);
        break;
      }
      case 'visor':
        ref = 0x1b2433;
        if (back) { R(10, hy + 4, 12, 3, 0x1b2433); R(10, hy + 4, 12, 1, 0x2c3a52); break; }
        R(13, hy + 4, 10, 4, 0x1b2433); R(15, hy + 5, 7, 2, 0x33e1ff); R(15, hy + 5, 2, 1, 0xc9f7ff); R(11, hy + 5, 2, 2, 0x1b2433);
        break;
      case 'halo': {
        const G = 0xffd166, Gd = 0xe8a93a; ref = G; mode = 1;
        // One clear row above the hair's outline, never lower than over a plain head. Big hair
        // would push it off the top on the bounce frames, so it stops at row 1 (its outline
        // takes row 0) and lags the bounce, dipping onto the hair for a frame.
        const top = hy - 7 + hairTop(style); // first row of hair
        const y = Math.max(1, Math.min(hy - 6, top - 5));
        R(12, y, 8, 1, G); D(11, y + 1, G); D(20, y + 1, Gd); R(12, y + 2, 8, 1, Gd); D(13, y, 0xfff1b8);
        break;
      }
      default:
        return;
    }
    commit(iL(ref), oL(ref), mode);
  };

  // ---- item in the near hand
  const drawItem = () => {
    if (!o.item || !hand) return;
    const { x, y } = hand;
    begin();
    if (o.item === 'kombucha') {
      R(x, y - 5, 3, 7, 0xc9772b); R(x, y - 5, 1, 7, 0xe8a15e); R(x + 2, y - 5, 1, 7, 0x9a5520);
      R(x + 1, y - 7, 1, 2, 0x8a4a18); D(x + 1, y - 8, 0x3a2410);
      R(x, y - 3, 3, 2, 0xf4f1de); D(x + 1, y - 3, 0x6a994e);
    } else if (o.item === 'coldbrew') {
      R(x - 1, y - 4, 5, 1, 0xeef7fb); R(x - 1, y - 3, 5, 5, 0x3b2416); R(x - 1, y - 3, 1, 5, 0x6a4a36);
      D(x + 1, y - 2, 0x9fd8ff); D(x + 2, y, 0x7a5a48); R(x + 2, y - 7, 1, 3, 0x2ec4b6);
    }
    // fingers in front of the item
    R(x, y, 3, 1, S.c); D(x, y, S.l); R(x, y + 1, 2, 1, S.s);
    commit(iL(0x6b3d12), oL(0x6b3d12), 2);
  };

  // ---- paint, back to front
  const farSide = nearSide === 'L' ? 'R' : 'L';
  const armOf = (s) => (s === 'L' ? [armL, swL] : [armR, swR]);
  drawArm(farSide, ...armOf(farSide));
  drawLegs();
  drawTorso();
  drawHead();
  drawHair();
  drawAcc();
  drawArm(nearSide, ...armOf(nearSide));
  drawItem();
}

// ------------------------------------------------------------------ the bot
// The lounge's resident bot. It floats; the engine draws its scanning eye on the screen
// (x 12-19, rows 20-23), the antenna light at (15, 8) and the thruster under row 36.
function paintBot(o) {
  const back = o.view === 'back';
  const O = 0xf26b3a, OL = 0xff9466, OD = 0xc4532c, ODD = 0x8f3a1d;
  const SCR = 0x1a1530, SCR2 = 0x2e2752, GLOW = 0x33e1ff;
  floorRow = AV_H - 1;
  // far arm
  begin();
  R(6, 26, 3, 5, OD); R(6, 30, 3, 1, ODD); D(6, 26, O);
  commit(iL(OD), oL(OD), 1);
  // antenna
  begin();
  R(15, 9, 1, 5, 0x8a8fa3); D(15, 8, 0x4a4f63); R(14, 13, 3, 1, 0x6b7086);
  commit(iL(0x8a8fa3), oL(0x8a8fa3), 1);
  // body
  begin();
  const rows = [[12, 19], [10, 21], [9, 22]];
  rows.forEach(([a, b], j) => R(a, 14 + j, b - a + 1, 1, O));
  R(9, 17, 14, 18, O);
  R(10, 35, 12, 1, O); R(12, 36, 8, 1, OD);
  R(9, 16, 2, 19, OL); R(10, 15, 2, 1, OL); R(12, 14, 3, 1, OL);
  R(21, 16, 2, 19, OD); R(10, 34, 12, 1, OD); R(10, 35, 12, 1, ODD);
  R(8, 20, 1, 3, 0x9aa0b5); R(23, 20, 1, 3, 0x6b7086); // side bolts
  R(13, 36, 6, 1, 0x4a4f63); // thruster nozzle
  if (!back) {
    // screen face
    R(11, 18, 10, 9, SCR); R(10, 19, 12, 7, SCR);
    R(11, 18, 10, 1, SCR2); R(10, 19, 1, 7, SCR2);
    R(11, 27, 10, 1, ODD);
    for (let y = 20; y < 26; y += 2) R(11, y, 10, 1, 0x1f1a3a);
    const g2 = mix(GLOW, SCR, 0.35);
    D(13, 24, g2); R(14, 25, 4, 1, g2); D(18, 24, g2); // smile
    D(11, 24, 0x8a3a6a); D(20, 24, 0x8a3a6a); // cheeks
    if (o.blink) { R(13, 22, 6, 1, GLOW); D(12, 21, g2); D(19, 21, g2); }
    // belly panel
    R(13, 29, 6, 4, OD); R(13, 29, 6, 1, ODD); R(14, 30, 4, 2, 0xffd2bd);
    D(14, 30, 0x7dff8a); D(16, 30, 0xffbe0b);
  } else {
    R(12, 19, 8, 9, OD); R(12, 19, 8, 1, ODD);
    for (let y = 21; y < 27; y += 2) R(13, y, 6, 1, ODD);
    R(13, 29, 6, 3, OD); D(14, 30, 0x7dff8a);
  }
  commit(iL(O), oL(O), 2);
  // near arm + clipboard
  begin();
  R(23, 25, 3, 4, O); D(23, 25, OL); R(25, 25, 1, 4, OD);
  if (!back) {
    R(24, 26, 5, 7, 0xf4f1de); R(24, 26, 1, 7, 0xffffff); R(28, 26, 1, 7, 0xc9c4b0);
    R(25, 28, 3, 1, 0x9aa0b5); R(25, 30, 3, 1, 0x9aa0b5); R(25, 26, 3, 1, 0x8a8fa3); R(25, 25, 3, 1, 0x6b7086);
    R(23, 28, 2, 2, O);
  }
  commit(iL(O), oL(O), 2);
}
