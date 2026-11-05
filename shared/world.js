// Shared world definition — imported by both the server (Node) and the browser.
// Grid coordinates: x grows toward the screen's lower-right, y toward the lower-left.
// Back walls run along x = 0 (left wall) and y = 0 (window wall).

export const W = 16;
export const H = 13;
export const STEP_MS = 420; // time to walk one tile
export const DOOR = { x: 0, y: 9 };

// Directions (dx, dy) → index. 0 = straight up on screen, clockwise.
export const DIRS = [
  [-1, -1], // 0 N  (screen up)
  [0, -1],  // 1 NE
  [1, -1],  // 2 E  (screen right)
  [1, 0],   // 3 SE
  [1, 1],   // 4 S  (screen down)
  [0, 1],   // 5 SW
  [-1, 1],  // 6 W  (screen left)
  [-1, 0],  // 7 NW
];
export function dirFrom(dx, dy) {
  const sx = Math.sign(dx), sy = Math.sign(dy);
  for (let i = 0; i < 8; i++) if (DIRS[i][0] === sx && DIRS[i][1] === sy) return i;
  return 4;
}

// Furniture. kind drives the drawing; seat = sit spot facing `dir`;
// use = an interaction you walk up to.
export const FURNITURE = [
  // window wall (y = 0)
  { id: 'plant1', kind: 'plant', x: 1, y: 0 },
  { id: 'desk1', kind: 'desk', x: 3, y: 0, screen: 'code' },
  { id: 'desk2', kind: 'desk', x: 4, y: 0, screen: 'graph' },
  { id: 'desk3', kind: 'desk', x: 6, y: 0, screen: 'term' },
  { id: 'desk4', kind: 'desk', x: 7, y: 0, screen: 'code' },
  { id: 'chair1', kind: 'chair', x: 3, y: 1, seat: true, dir: 1 },
  { id: 'chair2', kind: 'chair', x: 4, y: 1, seat: true, dir: 1 },
  { id: 'chair3', kind: 'chair', x: 6, y: 1, seat: true, dir: 1 },
  { id: 'chair4', kind: 'chair', x: 7, y: 1, seat: true, dir: 1 },
  { id: 'fridge', kind: 'fridge', x: 9, y: 0, use: 'kombucha', label: 'kombucha fridge' },
  { id: 'bar1', kind: 'bar', x: 10, y: 0, use: 'coldbrew', label: 'cold brew bar' },
  { id: 'bar2', kind: 'bar', x: 11, y: 0, use: 'coldbrew', label: 'cold brew bar', espresso: true },
  { id: 'stool1', kind: 'stool', x: 10, y: 1, seat: true, dir: 1 },
  { id: 'stool2', kind: 'stool', x: 11, y: 1, seat: true, dir: 1 },
  { id: 'plant2', kind: 'plant', x: 13, y: 0, tall: true },
  { id: 'arcade1', kind: 'arcade', x: 14, y: 0, hue: 'pink' },
  { id: 'arcade2', kind: 'arcade', x: 15, y: 0, hue: 'cyan' },

  // left wall (x = 0)
  { id: 'rack1', kind: 'rack', x: 0, y: 1, label: 'OBSERVER-01' },
  { id: 'rack2', kind: 'rack', x: 0, y: 2, label: 'OBSERVER-02' },
  { id: 'gong', kind: 'gong', x: 0, y: 4, use: 'gong', label: 'the merge gong' },
  { id: 'lamp', kind: 'lavalamp', x: 0, y: 6 },
  { id: 'plant3', kind: 'plant', x: 0, y: 11 },

  // the lounge pit
  { id: 'sofa1', kind: 'sofa', x: 5, y: 3, seat: true, dir: 5, part: 'L' },
  { id: 'sofa2', kind: 'sofa', x: 6, y: 3, seat: true, dir: 5, part: 'M' },
  { id: 'sofa3', kind: 'sofa', x: 7, y: 3, seat: true, dir: 5, part: 'R' },
  { id: 'table1', kind: 'table', x: 6, y: 6 },
  { id: 'bean1', kind: 'beanbag', x: 6, y: 5, seat: true, dir: 5, hue: 0 },
  { id: 'bean2', kind: 'beanbag', x: 5, y: 6, seat: true, dir: 3, hue: 1 },
  { id: 'bean3', kind: 'beanbag', x: 7, y: 6, seat: true, dir: 7, hue: 2 },
  { id: 'bean4', kind: 'beanbag', x: 6, y: 7, seat: true, dir: 1, hue: 3 },

  // ping pong
  { id: 'pong1', kind: 'pingpong', x: 11, y: 6, part: 'L' },
  { id: 'pong2', kind: 'pingpong', x: 12, y: 6, part: 'R' },

  // front-left standup corner
  { id: 'couch1', kind: 'armchair', x: 2, y: 10, seat: true, dir: 3 },
  { id: 'couch2', kind: 'armchair', x: 2, y: 11, seat: true, dir: 3 },
  { id: 'side1', kind: 'sidetable', x: 4, y: 11 },
  { id: 'arm3', kind: 'armchair', x: 5, y: 11, seat: true, dir: 7 },

  // front-right
  { id: 'button', kind: 'button', x: 13, y: 10, use: 'deploy', label: 'deploy to prod' },
  { id: 'plant4', kind: 'plant', x: 15, y: 12, tall: true },
  { id: 'bean5', kind: 'beanbag', x: 10, y: 11, seat: true, dir: 6, hue: 4 },
  { id: 'bean6', kind: 'beanbag', x: 9, y: 12, seat: true, dir: 0, hue: 5 },
  { id: 'plant5', kind: 'plant', x: 15, y: 7 },
];

// Wall pieces (no floor footprint). `wall: 'L'` = left wall (along x=0, spans y),
// `wall: 'R'` = window wall (along y=0, spans x). a/b are the start/end along the wall,
// lo/hi are pixel heights above the floor.
export const WALL_ITEMS = [
  { id: 'neon', wall: 'L', a: 1.0, b: 3.95, lo: 60, hi: 94, kind: 'neon' },
  { id: 'fame', wall: 'L', a: 4.5, b: 8.3, lo: 48, hi: 94, kind: 'fame', label: 'wall of fame' },
  { id: 'door', wall: 'L', a: 9, b: 10, lo: 0, hi: 58, kind: 'door' },
  { id: 'poster', wall: 'L', a: 10.6, b: 12.4, lo: 40, hi: 80, kind: 'poster' },
  { id: 'ticker', wall: 'R', a: 0.4, b: 15.6, lo: 86, hi: 94, kind: 'ticker' },
];

export const WALL_H = 100;
export const WINDOW = { a: 0.35, b: 15.65, lo: 10, hi: 80 }; // the glass on the window wall

export const REACTIONS = ['🔥', '🚀', '🧠', '❤️', '😂', '👀', '🎉', '💯'];
export const ITEMS = ['kombucha', 'coldbrew'];

// Avatar wardrobe — indexes into these lists are what gets stored.
export const LOOK = {
  skin: ['#f7d5b5', '#e9b48a', '#c98b5e', '#9c6440', '#6e4428', '#ffe0c4'],
  hairStyle: ['short', 'long', 'bun', 'spiky', 'curly', 'buzz', 'mohawk', 'bald'],
  hairColor: ['#1b1416', '#4a2c1d', '#8a5a33', '#d9a95b', '#b4372d', '#e8e3d9', '#5b6bff', '#ff6fb5', '#33c9a7'],
  top: ['hoodie', 'tee', 'vest', 'turtleneck', 'flannel', 'jacket'],
  topColor: ['#f26b3a', '#2b2d42', '#3a86ff', '#2ec4b6', '#8338ec', '#e63946', '#f4f1de', '#6a994e', '#ffbe0b', '#141414'],
  pants: ['#23263a', '#3b4a6b', '#6b4e3d', '#2f2f2f', '#c2b280', '#4f6d7a'],
  shoes: ['#f5f5f5', '#141414', '#e63946', '#3a86ff', '#ffbe0b'],
  acc: ['none', 'glasses', 'shades', 'headphones', 'beanie', 'cap', 'visor', 'halo'],
};

export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function defaultLook(login) {
  let h = hash32(String(login).toLowerCase());
  const pick = (arr) => { const v = h % arr.length; h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0; return v; };
  return {
    skin: pick(LOOK.skin), hairStyle: pick(LOOK.hairStyle), hairColor: pick(LOOK.hairColor),
    top: pick(LOOK.top), topColor: pick(LOOK.topColor), pants: pick(LOOK.pants),
    shoes: pick(LOOK.shoes), acc: pick(LOOK.acc.slice(0, 6)),
  };
}

export function cleanLook(look, login) {
  const base = defaultLook(login || 'x');
  const out = {};
  for (const k of Object.keys(LOOK)) {
    const v = look && Number.isInteger(look[k]) ? look[k] : base[k];
    out[k] = v >= 0 && v < LOOK[k].length ? v : base[k];
  }
  return out;
}

// ---- walkability & pathfinding --------------------------------------------
const furnAt = new Map();
for (const f of FURNITURE) furnAt.set(f.x + ',' + f.y, f);
export function furnitureAt(x, y) { return furnAt.get(x + ',' + y) || null; }
export function inside(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
export function walkable(x, y) { return inside(x, y) && !furnAt.has(x + ',' + y); }
export function isSeat(x, y) { const f = furnAt.get(x + ',' + y); return !!(f && f.seat); }

// A* over 8 neighbours; no corner cutting. `goalOk` lets the final tile be a seat.
export function findPath(sx, sy, tx, ty, opts = {}) {
  const allowGoalSeat = opts.allowGoalSeat !== false;
  const goalPassable = walkable(tx, ty) || (allowGoalSeat && isSeat(tx, ty));
  if (!goalPassable) return null;
  if (sx === tx && sy === ty) return [];
  const key = (x, y) => y * W + x;
  const open = [[sx, sy]];
  const g = new Map([[key(sx, sy), 0]]);
  const f = new Map([[key(sx, sy), Math.hypot(tx - sx, ty - sy)]]);
  const came = new Map();
  const closed = new Set();
  let guard = 0;
  while (open.length && guard++ < 4000) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f.get(key(...open[i])) < f.get(key(...open[bi]))) bi = i;
    const [cx, cy] = open.splice(bi, 1)[0];
    const ck = key(cx, cy);
    if (cx === tx && cy === ty) {
      const out = [];
      let k = ck;
      while (k !== key(sx, sy)) { out.push([k % W, Math.floor(k / W)]); k = came.get(k); }
      return out.reverse();
    }
    closed.add(ck);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const isGoal = nx === tx && ny === ty;
      if (!(walkable(nx, ny) || (isGoal && goalPassable))) continue;
      if (dx && dy && (!walkable(cx + dx, cy) || !walkable(cx, cy + dy))) continue;
      const ng = g.get(ck) + (dx && dy ? 1.414 : 1);
      if (ng < (g.get(nk) ?? Infinity)) {
        came.set(nk, ck);
        g.set(nk, ng);
        f.set(nk, ng + Math.hypot(tx - nx, ty - ny));
        if (!open.some(([ox, oy]) => ox === nx && oy === ny)) open.push([nx, ny]);
      }
    }
  }
  return null;
}

// Closest walkable tile next to a piece of furniture (for "walk up and use it").
export function approachTiles(fx, fy) {
  const out = [];
  for (const [dx, dy] of DIRS) {
    const x = fx + dx, y = fy + dy;
    if (walkable(x, y)) out.push([x, y]);
  }
  return out;
}

// Every floor tile you can actually get to from the door.
export const REACHABLE = (() => {
  const seen = new Set([DOOR.x + ',' + DOOR.y]);
  const q = [[DOOR.x, DOOR.y]];
  while (q.length) {
    const [cx, cy] = q.shift();
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!walkable(nx, ny) || seen.has(nx + ',' + ny)) continue;
      if (dx && dy && (!walkable(cx + dx, cy) || !walkable(cx, cy + dy))) continue;
      seen.add(nx + ',' + ny);
      q.push([nx, ny]);
    }
  }
  return seen;
})();
export function reachable(x, y) { return REACHABLE.has(x + ',' + y); }

export function randomWalkable(rng = Math.random) {
  const tiles = [...REACHABLE].filter((k) => k !== DOOR.x + ',' + DOOR.y);
  const k = tiles[Math.floor(rng() * tiles.length)];
  return k.split(',').map(Number);
}
