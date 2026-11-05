// Procedural pixel avatars. Every sprite is 32x52 with the feet anchored at (16, 48).
import { LOOK } from '/shared/world.js';
import { shade, makeCanvas } from './pixel.js';

export const AV_W = 32, AV_H = 52, AV_AX = 16, AV_AY = 48;

const cache = new Map();
export function avatarSprite(look, opts) {
  const key = JSON.stringify(look) + '|' + opts.view + '|' + opts.pose + '|' + opts.frame + '|' + (opts.flip ? 1 : 0) + '|' + (opts.item || '') + '|' + (opts.blink ? 1 : 0) + '|' + (opts.afk ? 1 : 0) + '|' + (opts.wave ? 1 : 0);
  let c = cache.get(key);
  if (c) return c;
  if (cache.size > 900) cache.clear();
  const [cv, g] = makeCanvas(AV_W, AV_H);
  if (look && look.bot) paintBot(g, opts);
  else paintPerson(g, look, opts);
  if (opts.flip) {
    const [fc, fg] = makeCanvas(AV_W, AV_H);
    fg.translate(AV_W, 0);
    fg.scale(-1, 1);
    fg.drawImage(cv, 0, 0);
    c = fc;
  } else c = cv;
  cache.set(key, c);
  return c;
}

function px(g, x, y, w, h, color) {
  g.fillStyle = color;
  g.fillRect(x, y, w, h);
}

const KNIT = ['#e63946', '#3a86ff', '#ffbe0b', '#2ec4b6', '#f26b3a', '#8338ec', '#f4f1de', '#141414', '#6a994e', '#ff6fb5'];

function paintPerson(g, look, o) {
  const skin = LOOK.skin[look.skin] || LOOK.skin[0];
  const skinD = shade(skin, -0.18);
  const hair = LOOK.hairColor[look.hairColor] || LOOK.hairColor[0];
  const hairD = shade(hair, -0.3);
  const hairL = shade(hair, 0.18);
  const topName = LOOK.top[look.top] || 'tee';
  const top = LOOK.topColor[look.topColor] || LOOK.topColor[0];
  const topD = shade(top, -0.22);
  const topL = shade(top, 0.15);
  const pants = LOOK.pants[look.pants] || LOOK.pants[0];
  const pantsD = shade(pants, -0.25);
  const shoes = LOOK.shoes[look.shoes] || LOOK.shoes[0];
  const shoesD = shade(shoes, -0.35);
  const style = LOOK.hairStyle[look.hairStyle] || 'short';
  const acc = LOOK.acc[look.acc] || 'none';
  const back = o.view === 'back';
  const pose = o.pose; // stand | walk | sit | sitf | dance | wave
  const f = o.frame | 0;

  // vertical offsets
  let bob = 0;
  if (pose === 'walk' && (f === 1 || f === 3)) bob = -1;
  if (pose === 'dance') bob = [0, -2, 0, -1][f % 4];
  const sitting = pose === 'sit' || pose === 'sitf';
  const dy = sitting ? (pose === 'sit' ? 7 : 9) : bob;

  const shirt = topName === 'vest' ? '#dfe7f2' : top;
  const shirtD = topName === 'vest' ? '#b9c4d4' : topD;
  const longSleeve = topName !== 'tee';

  // --- arms setup
  let nearArm = 'down', farArm = 'down';
  let nearSwing = 0, farSwing = 0;
  if (pose === 'walk') { nearSwing = [1, 0, -1, 0][f]; farSwing = -nearSwing; }
  if (pose === 'wave' || o.wave) nearArm = f % 2 ? 'up2' : 'up';
  if (pose === 'dance') {
    const seq = [['up', 'up'], ['down', 'down'], ['up', 'down'], ['down', 'up']][f % 4];
    nearArm = seq[0]; farArm = seq[1];
  }

  // --- far arm (behind body)
  drawArm(g, 'far', farArm, farSwing, dy, shirtD, skinD, longSleeve, back);

  // --- legs
  if (!sitting) {
    let nearDx = 0, farDx = 0, nearLift = 0, farLift = 0;
    if (pose === 'walk') {
      if (f === 0) { nearDx = 1; farDx = -1; farLift = 1; }
      if (f === 2) { nearDx = -1; farDx = 1; nearLift = 1; }
    }
    if (pose === 'dance' && f === 1) { nearLift = 1; farLift = 1; }
    // far leg
    px(g, 11 + farDx, 37 + dy, 4, 8 - farLift, pantsD);
    px(g, 11 + farDx, 45 + dy - farLift, 5, 2, shoesD);
    px(g, 11 + farDx, 47 + dy - farLift, 5, 1, shade(shoesD, -0.3));
    // near leg
    px(g, 17 + nearDx, 37 + dy, 4, 8 - nearLift, pants);
    px(g, 17 + nearDx, 45 + dy - nearLift, 5, 2, shoes);
    px(g, 17 + nearDx, 47 + dy - nearLift, 5, 1, shoesD);
    if (!back) px(g, 21 + nearDx, 45 + dy - nearLift, 1, 1, shade(shoes, 0.3));
  } else if (!back) {
    // thighs forward
    px(g, 11, 34 + dy, 12, 4, pants);
    px(g, 11, 34 + dy, 12, 1, shade(pants, 0.12));
    if (pose === 'sit') {
      px(g, 19, 38 + dy, 4, 4, pantsD);
      px(g, 19, 41 + dy, 6, 2, shoes);
    } else {
      // cross-legged on the floor
      px(g, 13, 38 + dy, 10, 2, pantsD);
      px(g, 22, 38 + dy, 3, 2, shoes);
    }
  } else {
    px(g, 11, 34 + dy, 10, 3, pantsD);
  }

  // --- hips
  px(g, 11, 34 + dy, 10, 3, pants);
  px(g, 11, 34 + dy, 10, 1, pantsD);

  // --- torso
  px(g, 10, 23 + dy, 12, 11, shirt);
  px(g, 10, 23 + dy, 1, 11, shirtD);
  px(g, 10, 33 + dy, 12, 1, shirtD);
  if (topName === 'flannel') {
    for (let y = 23; y < 34; y++) for (let x = 11; x < 22; x++) if (((x >> 1) + (y >> 1)) % 2 === 0) px(g, x, y + dy, 1, 1, topD);
    if (!back) px(g, 15, 23 + dy, 2, 2, topL);
  }
  if (topName === 'vest') {
    px(g, 10, 23 + dy, 5, 11, top);
    px(g, 17, 23 + dy, 5, 11, top);
    px(g, 10, 23 + dy, 1, 11, topD);
    if (!back) { px(g, 16, 24 + dy, 1, 10, '#b9c4d4'); px(g, 14, 23 + dy, 1, 2, topL); px(g, 17, 23 + dy, 1, 2, topL); }
    else px(g, 15, 23 + dy, 2, 11, top);
  }
  if (topName === 'jacket' && !back) {
    px(g, 14, 23 + dy, 4, 11, '#f1f1f1');
    px(g, 13, 23 + dy, 1, 6, topL);
    px(g, 18, 23 + dy, 1, 6, topL);
  }
  if (topName === 'hoodie') {
    if (!back) {
      px(g, 11, 22 + dy, 10, 2, topD); // hood around neck
      px(g, 15, 24 + dy, 1, 3, '#f4f1de');
      px(g, 18, 24 + dy, 1, 3, '#f4f1de');
      px(g, 13, 29 + dy, 8, 1, topD); // pocket
      px(g, 13, 29 + dy, 1, 3, topD);
      px(g, 20, 29 + dy, 1, 3, topD);
      // tiny claude-mem dot on the chest
      px(g, 17, 26 + dy, 2, 2, top === '#f26b3a' ? '#2b2d42' : '#f26b3a');
    } else {
      px(g, 11, 21 + dy, 10, 5, topD);
      px(g, 12, 22 + dy, 8, 3, shade(top, -0.32));
    }
  }
  if (topName === 'turtleneck') {
    px(g, 13, 20 + dy, 6, 3, top);
    px(g, 13, 20 + dy, 6, 1, topL);
  }
  if (topName === 'tee' && !back) {
    px(g, 14, 23 + dy, 4, 1, skin);
    px(g, 15, 24 + dy, 2, 1, skin);
  }

  // --- neck
  if (topName !== 'turtleneck' && topName !== 'hoodie') px(g, 14, 22 + dy, 4, 1, skinD);
  if (topName === 'hoodie' && back) { /* hood covers */ }

  // --- head
  const hy = 10 + dy;
  px(g, 11, hy, 10, 12, skin);
  px(g, 10, hy + 1, 12, 10, skin);
  px(g, 10, hy + 1, 1, 10, skinD);
  px(g, 11, hy + 11, 10, 1, skinD);
  if (!back) {
    // ear on the far side (we face right, so the ear shows at the back-left)
    px(g, 11, hy + 5, 2, 3, skinD);
    if (o.afk || o.blink) {
      px(g, 16, hy + 6, 2, 1, '#2a1c1c');
      px(g, 19, hy + 6, 2, 1, '#2a1c1c');
    } else {
      px(g, 16, hy + 5, 1, 2, '#1b1416');
      px(g, 19, hy + 5, 1, 2, '#1b1416');
      px(g, 16, hy + 5, 1, 1, '#3a2a2a');
    }
    px(g, 21, hy + 7, 1, 1, shade(skin, -0.1)); // nose tip
    px(g, 18, hy + 9, 2, 1, shade(skin, -0.32)); // mouth
    px(g, 20, hy + 8, 1, 1, '#f0a3a3'); // cheek
  } else {
    px(g, 11, hy + 5, 2, 3, skinD);
  }

  // --- hair
  paintHair(g, style, hy, hair, hairD, hairL, back, skin);

  // --- accessories
  paintAcc(g, acc, hy, back, look);

  // --- near arm (in front of body)
  drawArm(g, 'near', nearArm, nearSwing, dy, shirt, skin, longSleeve, back, o.item);

  if (o.afk) {
    // little sleepy tilt: a darker cap line on the eyes is enough at this size
  }
}

function drawArm(g, which, mode, swing, dy, sleeve, skin, longSleeve, back, item) {
  const x = which === 'near' ? 22 : 8;
  const w = which === 'near' ? 3 : 2;
  const sleeveC = which === 'near' ? sleeve : shade(sleeve, -0.1);
  if (mode === 'down') {
    const top = 24 + dy + swing;
    if (longSleeve) px(g, x, top, w, 9, sleeveC);
    else { px(g, x, top, w, 4, sleeveC); px(g, x, top + 4, w, 5, skin); }
    px(g, x, top + 9, w, 2, skin);
    if (which === 'near' && item) paintItem(g, item, x, top + 9);
  } else {
    // raised arm: shoulder at row 24, hand up near the head
    const off = mode === 'up2' ? 1 : 0;
    const ax = x + (which === 'near' ? 1 + off : -1);
    if (longSleeve) px(g, ax, 15 + dy, w, 10, sleeveC);
    else { px(g, ax, 21 + dy, w, 4, sleeveC); px(g, ax, 15 + dy, w, 6, skin); }
    px(g, ax, 13 + dy, w, 2, skin);
  }
}

function paintItem(g, item, hx, hy) {
  if (item === 'kombucha') {
    px(g, hx + 2, hy - 6, 2, 8, '#c9772b');
    px(g, hx + 2, hy - 8, 2, 2, '#6b3d12');
    px(g, hx + 2, hy - 3, 2, 2, '#f4f1de');
    px(g, hx + 3, hy - 6, 1, 3, '#e8a15e');
  } else if (item === 'coldbrew') {
    px(g, hx + 1, hy - 4, 4, 6, '#d9eef7');
    px(g, hx + 1, hy - 2, 4, 4, '#3b2416');
    px(g, hx + 3, hy - 8, 1, 4, '#2ec4b6');
  }
}

function paintHair(g, style, hy, hair, hairD, hairL, back, skin) {
  const P = (x, y, w, h, c = hair) => px(g, x, y, w, h, c);
  if (style === 'bald') {
    P(13, hy + 1, 2, 1, shade(skin, 0.35));
    return;
  }
  if (style === 'buzz') {
    const b = shade(hair, 0.25);
    P(11, hy - 1, 10, 3, b);
    P(10, hy, 3, 6, b);
    if (back) P(10, hy, 12, 7, b);
    return;
  }
  if (back) {
    // from behind the hair covers most of the head
    if (style === 'mohawk') {
      P(10, hy + 1, 12, 5, shade(hair, 0.35));
      P(14, hy - 4, 4, 9, hair);
      P(14, hy - 4, 4, 1, hairL);
      return;
    }
    P(11, hy - 1, 10, 2);
    P(10, hy, 12, 9);
    P(10, hy, 12, 1, hairL);
    P(21, hy + 1, 1, 8, hairD);
    if (style === 'long') { P(10, hy + 8, 12, 9); P(10, hy + 16, 12, 1, hairD); }
    if (style === 'curly') { P(9, hy - 1, 14, 10); for (let i = 0; i < 7; i++) P(9 + i * 2, hy - 2, 1, 1); P(9, hy + 9, 14, 1, hairD); }
    if (style === 'bun') { P(13, hy - 5, 6, 5); P(14, hy - 6, 4, 1); P(13, hy - 5, 6, 1, hairL); }
    if (style === 'spiky') for (let i = 0; i < 6; i++) P(10 + i * 2, hy - 3 + (i % 2), 2, 3);
    return;
  }
  switch (style) {
    case 'short':
      P(11, hy - 1, 10, 3);
      P(10, hy, 12, 3);
      P(10, hy + 2, 3, 5); // back of the head
      P(18, hy + 2, 4, 1); // fringe
      P(11, hy - 1, 6, 1, hairL);
      break;
    case 'long':
      P(11, hy - 1, 10, 3);
      P(10, hy, 12, 3);
      P(9, hy + 1, 4, 16);
      P(9, hy + 16, 4, 1, hairD);
      P(19, hy + 2, 3, 2);
      P(21, hy + 3, 1, 7);
      P(11, hy - 1, 6, 1, hairL);
      break;
    case 'bun':
      P(11, hy - 1, 10, 3);
      P(10, hy, 12, 3);
      P(10, hy + 2, 3, 5);
      P(9, hy - 4, 5, 4);
      P(10, hy - 5, 3, 1);
      P(9, hy - 4, 5, 1, hairL);
      P(19, hy + 2, 3, 1);
      break;
    case 'spiky':
      P(10, hy, 12, 3);
      P(10, hy + 2, 3, 5);
      for (let i = 0; i < 6; i++) P(10 + i * 2, hy - 3 + (i % 2), 2, 3, i % 2 ? hair : hairL);
      P(19, hy + 2, 3, 1);
      break;
    case 'curly':
      P(10, hy - 2, 12, 5);
      P(9, hy - 1, 14, 3);
      P(9, hy + 1, 5, 8);
      for (let i = 0; i < 7; i++) P(9 + i * 2, hy - 3, 1, 1);
      P(8, hy + 3, 1, 4);
      P(19, hy + 2, 3, 2);
      P(10, hy - 2, 4, 1, hairL);
      break;
    case 'mohawk':
      P(10, hy + 1, 4, 5, shade(hair, 0.35));
      P(14, hy - 5, 4, 7);
      P(15, hy - 6, 3, 1);
      P(14, hy - 5, 2, 1, hairL);
      break;
  }
}

function paintAcc(g, acc, hy, back, look) {
  const P = (x, y, w, h, c) => px(g, x, y, w, h, c);
  switch (acc) {
    case 'glasses':
      if (back) { P(10, hy + 5, 1, 1, '#1c1c24'); return; }
      for (const lx of [15, 18]) {
        P(lx, hy + 4, 3, 1, '#1c1c24'); P(lx, hy + 7, 3, 1, '#1c1c24');
        P(lx, hy + 5, 1, 2, '#1c1c24'); P(lx + 2, hy + 5, 1, 2, '#1c1c24');
      }
      P(13, hy + 5, 2, 1, '#1c1c24');
      break;
    case 'shades':
      if (back) { P(10, hy + 5, 1, 1, '#0d0d10'); return; }
      P(15, hy + 4, 7, 3, '#0d0d10');
      P(16, hy + 4, 1, 1, '#5b6bff');
      P(13, hy + 5, 2, 1, '#0d0d10');
      break;
    case 'headphones':
      P(11, hy - 2, 10, 1, '#25252e');
      P(10, hy - 1, 1, 3, '#25252e');
      P(21, hy - 1, 1, 3, '#25252e');
      if (!back) { P(9, hy + 3, 4, 5, '#f26b3a'); P(9, hy + 3, 4, 1, '#ff9a6b'); }
      else { P(9, hy + 3, 3, 5, '#f26b3a'); P(20, hy + 3, 3, 5, '#f26b3a'); }
      break;
    case 'beanie': {
      const c = KNIT[(look.topColor + 3) % KNIT.length];
      P(10, hy - 2, 12, 5, c);
      P(11, hy - 3, 10, 1, c);
      P(10, hy + 2, 12, 1, shade(c, -0.25));
      P(15, hy - 5, 2, 2, shade(c, 0.4));
      for (let x = 11; x < 21; x += 2) P(x, hy - 1, 1, 3, shade(c, -0.12));
      break;
    }
    case 'cap': {
      const c = KNIT[(look.topColor + 5) % KNIT.length];
      P(10, hy - 2, 12, 4, c);
      P(11, hy - 3, 10, 1, c);
      if (!back) { P(17, hy + 2, 8, 1, shade(c, -0.3)); P(15, hy - 1, 2, 2, '#f4f1de'); }
      else P(13, hy + 1, 6, 1, shade(c, -0.3));
      break;
    }
    case 'visor':
      if (back) { P(10, hy + 4, 12, 3, '#1b2433'); return; }
      P(13, hy + 4, 10, 4, '#1b2433');
      P(15, hy + 5, 7, 2, '#33e1ff');
      P(15, hy + 5, 2, 1, '#c9f7ff');
      break;
    case 'halo':
      P(12, hy - 6, 8, 1, '#ffd166');
      P(11, hy - 5, 1, 1, '#ffd166');
      P(20, hy - 5, 1, 1, '#ffd166');
      P(12, hy - 4, 8, 1, '#e8b440');
      break;
  }
}

// The Observer — the lounge's resident bot. Floats; its eye is drawn live.
function paintBot(g, o) {
  const back = o.view === 'back';
  const O = '#f26b3a', OL = '#ff9466', OD = '#c4532c', ODD = '#8f3a1d';
  px(g, 15, 9, 1, 5, '#8a8fa3'); // antenna
  px(g, 11, 15, 10, 1, O);
  px(g, 10, 16, 12, 1, O);
  px(g, 9, 17, 14, 18, O);
  px(g, 10, 35, 12, 1, O);
  px(g, 11, 36, 10, 1, OD);
  px(g, 9, 17, 2, 18, OL);
  px(g, 21, 17, 2, 18, OD);
  px(g, 11, 15, 3, 1, OL);
  if (!back) {
    px(g, 11, 19, 10, 7, '#1a1530');
    px(g, 10, 20, 12, 5, '#1a1530');
    px(g, 11, 19, 10, 1, '#2e2752');
    px(g, 13, 29, 6, 4, OD); // belly plate
    px(g, 14, 30, 4, 2, '#ffd2bd');
    // clipboard in the near hand
    px(g, 23, 27, 5, 6, '#f4f1de');
    px(g, 24, 28, 3, 1, '#9aa0b5');
    px(g, 24, 30, 3, 1, '#9aa0b5');
    px(g, 24, 26, 3, 1, '#8a8fa3');
  } else {
    px(g, 12, 22, 8, 8, OD);
    px(g, 13, 23, 6, 1, ODD);
    px(g, 13, 25, 6, 1, ODD);
    px(g, 13, 27, 6, 1, ODD);
  }
  // stubby arms
  px(g, 7, 26, 2, 5, OD);
  px(g, 23, 25, 2, 3, O);
}
