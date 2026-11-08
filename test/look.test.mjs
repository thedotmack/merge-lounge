// shared/world.js wardrobe: saved looks are indices, so the lists only grow at the end,
// default looks never change, and cleanLook accepts every saved look old and new.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOK, defaultLook, cleanLook } from '../shared/world.js';

// The first release's lists. Every saved look in the wild indexes into these.
const V1 = {
  skin: ['#f7d5b5', '#e9b48a', '#c98b5e', '#9c6440', '#6e4428', '#ffe0c4'],
  hairStyle: ['short', 'long', 'bun', 'spiky', 'curly', 'buzz', 'mohawk', 'bald'],
  hairColor: ['#1b1416', '#4a2c1d', '#8a5a33', '#d9a95b', '#b4372d', '#e8e3d9', '#5b6bff', '#ff6fb5', '#33c9a7'],
  top: ['hoodie', 'tee', 'vest', 'turtleneck', 'flannel', 'jacket'],
  topColor: ['#f26b3a', '#2b2d42', '#3a86ff', '#2ec4b6', '#8338ec', '#e63946', '#f4f1de', '#6a994e', '#ffbe0b', '#141414'],
  pants: ['#23263a', '#3b4a6b', '#6b4e3d', '#2f2f2f', '#c2b280', '#4f6d7a'],
  shoes: ['#f5f5f5', '#141414', '#e63946', '#3a86ff', '#ffbe0b'],
  acc: ['none', 'glasses', 'shades', 'headphones', 'beanie', 'cap', 'visor', 'halo'],
};

// defaultLook() output of the first release (computed with its world.js).
const GOLDEN = {
  octocat: { skin: 0, hairStyle: 7, hairColor: 8, top: 0, topColor: 0, pants: 3, shoes: 1, acc: 2 },
  'Test-Ada': { skin: 2, hairStyle: 2, hairColor: 2, top: 1, topColor: 5, pants: 2, shoes: 3, acc: 3 },
  'test-bob': { skin: 1, hairStyle: 6, hairColor: 8, top: 4, topColor: 0, pants: 1, shoes: 2, acc: 2 },
  a: { skin: 4, hairStyle: 1, hairColor: 0, top: 0, topColor: 1, pants: 1, shoes: 1, acc: 2 },
  x: { skin: 3, hairStyle: 1, hairColor: 7, top: 0, topColor: 3, pants: 2, shoes: 0, acc: 3 },
  'someone-with-a-very-long-login-name': { skin: 4, hairStyle: 2, hairColor: 1, top: 0, topColor: 9, pants: 5, shoes: 3, acc: 4 },
  ZZ9: { skin: 0, hairStyle: 0, hairColor: 5, top: 3, topColor: 7, pants: 1, shoes: 4, acc: 2 },
};

test('LOOK keeps the same keys, and every first-release entry at its index', () => {
  assert.deepEqual(Object.keys(LOOK), Object.keys(V1));
  for (const k of Object.keys(V1)) {
    assert.ok(LOOK[k].length >= V1[k].length, `${k} shrank`);
    assert.deepEqual(LOOK[k].slice(0, V1[k].length), V1[k], `${k} reordered or changed`);
  }
});

test('LOOK entries are valid swatches or short chip labels, no duplicates', () => {
  for (const k of ['skin', 'hairColor', 'topColor', 'pants', 'shoes']) for (const v of LOOK[k]) assert.match(v, /^#[0-9a-f]{6}$/, `${k} ${v}`);
  for (const k of ['hairStyle', 'top', 'acc']) for (const v of LOOK[k]) assert.match(v, /^[a-z]+( [a-z]+)?$/, `${k} ${v}`);
  for (const k of Object.keys(LOOK)) assert.equal(new Set(LOOK[k]).size, LOOK[k].length, `${k} has a duplicate`);
});

test('defaultLook is unchanged from the first release', () => {
  for (const [login, look] of Object.entries(GOLDEN)) assert.deepEqual(defaultLook(login), look, login);
  // and stays inside the first-release ranges for any login (acc never picks visor or halo)
  for (let i = 0; i < 3000; i++) {
    const l = defaultLook('user-' + i.toString(36));
    for (const k of Object.keys(V1)) assert.ok(l[k] >= 0 && l[k] < (k === 'acc' ? 6 : V1[k].length), `${k}=${l[k]}`);
  }
});

test('cleanLook accepts first-release looks unchanged', () => {
  for (const k of Object.keys(V1)) for (let i = 0; i < V1[k].length; i++) {
    const look = { ...defaultLook('test-ada'), [k]: i };
    assert.deepEqual(cleanLook(look, 'test-ada'), look);
  }
});

test('cleanLook accepts every appended option', () => {
  for (const k of Object.keys(LOOK)) for (let i = V1[k].length; i < LOOK[k].length; i++) {
    const look = { ...defaultLook('test-ada'), [k]: i };
    assert.deepEqual(cleanLook(look, 'test-ada'), look, `${k}=${i}`);
  }
  const last = Object.fromEntries(Object.keys(LOOK).map((k) => [k, LOOK[k].length - 1]));
  assert.deepEqual(cleanLook(last, 'x'), last);
});

test('cleanLook falls back to the default for anything out of range or junk', () => {
  const base = defaultLook('test-ada');
  const bad = [-1, 1.5, '2', null, undefined, NaN, Infinity, {}, []];
  for (const k of Object.keys(LOOK)) {
    assert.equal(cleanLook({ ...base, [k]: LOOK[k].length }, 'test-ada')[k], base[k], `${k} one past the end`);
    for (const v of bad) assert.equal(cleanLook({ ...base, [k]: v }, 'test-ada')[k], base[k], `${k}=${String(v)}`);
  }
  // unknown keys are dropped; missing look → the default look
  assert.deepEqual(cleanLook({ ...base, bot: true, extra: 1 }, 'test-ada'), base);
  assert.deepEqual(cleanLook(null, 'test-ada'), base);
  assert.deepEqual(cleanLook('junk', 'test-ada'), base);
});
