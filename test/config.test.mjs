// shared/config.js: defaults, derived values, env overrides, the public subset, and the README table.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig, publicConfig, fill, DEFAULTS, accentInk, contrast, githubRepoOf } from '../shared/config.js';
import { configTable } from '../scripts/config-table.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// The root config is the fork placeholder (this repo, no admins); examples/claude-mem.json is a fully
// customised lounge, and the one the claude-mem lounge runs with (CONFIG_PATH).
const root = JSON.parse(fs.readFileSync(path.join(ROOT, 'lounge.config.json'), 'utf8'));
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'claude-mem.json'), 'utf8'));

test('the root lounge.config.json is a placeholder for this repo with no admins, and resolves cleanly', () => {
  assert.deepEqual(Object.keys(root).sort(), ['admins', 'repo']);
  // a fork that changes only repo must not hand anyone admin of its lounge
  assert.deepEqual(root.admins, []);
  assert.notEqual(root.repo.toLowerCase(), committed.repo.toLowerCase());
  const { config: c, warnings } = resolveConfig(root, {}, { requireRepo: true });
  assert.deepEqual(warnings, []);
  assert.equal(c.repo, root.repo);
  assert.deepEqual(c.admins, []);
  // everything else is the generic default text, worked out from the repo name
  assert.deepEqual(c.skyline.billboards, DEFAULTS.skyline.billboards);
  assert.deepEqual(c.bot.mention, DEFAULTS.bot.mention);
  assert.deepEqual(c.ticker, DEFAULTS.ticker);
  assert.equal(c.project.url, `https://github.com/${root.repo}`);
});

test('forking: changing repo in the root config leaves nothing of the original project', () => {
  const { config: c, warnings } = resolveConfig({ ...root, repo: 'octo/hello-world', admins: ['octo'] }, {}, { requireRepo: true });
  assert.deepEqual(warnings, []);
  const text = JSON.stringify(c).toLowerCase();
  for (const word of [root.repo, root.repo.split('/')[1], committed.repo, ...committed.admins, committed.blimp, committed.codePrefix, committed.bot.name]) {
    assert.ok(!text.includes(String(word).toLowerCase()), `forked config still mentions ${word}`);
  }
});

test('forking: changing repo but forgetting admins gives nobody admin', () => {
  const { config: c } = resolveConfig({ ...root, repo: 'octo/hello-world' }, {}, { requireRepo: true });
  assert.deepEqual(c.admins, []);
});

test('the example config sets everything its lounge depends on by itself', () => {
  // the claude-mem lounge runs with CONFIG_PATH=examples/claude-mem.json, so nothing may come from the root file
  // or from defaults that could change: its repo, admins and bot name (chat history refers to bot:<name>)
  assert.equal(committed.repo, 'thedotmack/claude-mem');
  assert.ok(committed.admins.length >= 1);
  assert.equal(committed.bot.name, 'observer');
  const { config: c } = resolveConfig(committed, {}, { requireRepo: true });
  assert.equal(c.bot.name, 'observer');
  assert.deepEqual(c.admins, committed.admins.map((a) => a.toLowerCase()));
});

test('copying the example but changing only repo is flagged', () => {
  const { warnings } = resolveConfig({ ...committed, repo: 'octo/hello-world' }, {}, { requireRepo: true });
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], new RegExp(`project.url points at ${committed.repo}, but repo is octo/hello-world`));
});

test('a config with only a repo is a complete, generic lounge', () => {
  const { config: c, warnings } = resolveConfig({ repo: 'sindresorhus/slugify' }, {}, { requireRepo: true });
  assert.deepEqual(warnings, []);
  assert.equal(c.loungeName, 'Merge Lounge');
  assert.equal(c.project.name, 'slugify');
  assert.equal(c.project.url, 'https://github.com/sindresorhus/slugify');
  assert.deepEqual(c.neon, { top: 'SLUGIFY', bottom: 'LGTM' });
  assert.equal(c.blimp, 'SLUGIFY');
  assert.equal(c.codePrefix, 'slugify-lounge');
  assert.equal(c.bot.name, 'doorbot');
  assert.deepEqual(c.admins, []);
  assert.equal(c.minMergedPRs, 1);
  assert.equal(c.skyline.city, 'Los Angeles');
  // nothing from the committed example config leaks into the defaults
  const text = JSON.stringify(c).toLowerCase();
  for (const word of [committed.project.name, committed.blimp, committed.codePrefix, ...committed.admins, committed.bot.name]) {
    assert.ok(!text.includes(String(word).toLowerCase()), `default config mentions ${word}`);
  }
});

test('repo names become a sign, a blimp and a code prefix', () => {
  const pick = (repo) => { const { config: c } = resolveConfig({ repo }); return [c.neon.top, c.neon.bottom, c.blimp, c.codePrefix]; };
  assert.deepEqual(pick('octo/hello-world'), ['HELLO', 'WORLD', 'HWORLD', 'hworld-lounge']);
  assert.deepEqual(pick('pi-hole/pi-hole'), ['PI', 'HOLE', 'PIHOLE', 'pihole-lounge']);
  assert.deepEqual(pick('websockets/ws'), ['', 'WS', 'WS', 'ws-lounge']);
  assert.deepEqual(pick('necolas/react-native-web'), ['REACT', 'WEB', 'RNWEB', 'rnweb-lounge']);
});

test('the example config resolves cleanly and keeps its own text', () => {
  const { config: c, warnings } = resolveConfig(committed, {}, { requireRepo: true });
  assert.deepEqual(warnings, []);
  assert.deepEqual(c.neon, { top: committed.neon.top, bottom: committed.neon.bottom });
  assert.equal(c.blimp, committed.blimp);
  assert.equal(c.codePrefix, committed.codePrefix);
  assert.deepEqual(c.skyline.billboards, committed.skyline.billboards);
  assert.deepEqual(c.skyline.names, committed.skyline.names);
  assert.deepEqual(c.ticker, committed.ticker);
  assert.deepEqual(c.bot.mention, committed.bot.mention);
});

test('REPO for a different repo sets the whole file aside (its admins too)', () => {
  const { config: c, warnings } = resolveConfig(committed, { REPO: 'sindresorhus/slugify' }, { requireRepo: true });
  assert.equal(c.repo, 'sindresorhus/slugify');
  assert.deepEqual(c.admins, []);
  assert.equal(c.project.name, 'slugify');
  assert.equal(c.blimp, 'SLUGIFY');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /different repo/);
});

test('REPO for the same repo and ADMINS override as documented', () => {
  const { config: c } = resolveConfig(committed, { REPO: committed.repo.toUpperCase(), ADMINS: 'Alice, bob ,not a login' });
  assert.equal(c.blimp, committed.blimp);
  assert.deepEqual(c.admins, ['alice', 'bob']);
});

test('the server refuses to start without a usable repo', () => {
  assert.throws(() => resolveConfig({}, {}, { requireRepo: true }), /no repo set/);
  assert.throws(() => resolveConfig({ repo: 'not a repo' }, {}, { requireRepo: true }), /owner\/name/);
  assert.doesNotThrow(() => resolveConfig({}, {}));
});

test('bad values fall back to defaults with a warning', () => {
  const { config: c, warnings } = resolveConfig({
    repo: 'a/b', timezone: 'Mars/Olympus', theme: { accent: 'orange' }, minMergedPRs: 0, bot: { name: 'has space' },
    codePrefix: 'Bad Prefix!', skyline: { billboards: [['ONLY ONE']] }, admins: ['ok-user', 'no way'], surprise: 1,
  });
  assert.equal(c.timezone, DEFAULTS.timezone);
  assert.equal(c.theme.accent, DEFAULTS.theme.accent);
  assert.equal(c.minMergedPRs, 1);
  assert.equal(c.bot.name, DEFAULTS.bot.name);
  assert.equal(c.codePrefix, 'b-lounge');
  assert.deepEqual(c.skyline.billboards, DEFAULTS.skyline.billboards);
  assert.deepEqual(c.admins, ['ok-user']);
  assert.ok(warnings.length >= 7, warnings.join('\n'));
});

test('the public config has no admins, allow list or bot script', () => {
  const { config } = resolveConfig({ ...committed, admins: ['boss'], allow: ['friend'] });
  const pub = publicConfig(config);
  const text = JSON.stringify(pub);
  assert.ok(!('admins' in pub) && !('allow' in pub));
  assert.ok(!text.includes('boss') && !text.includes('friend'));
  assert.deepEqual(Object.keys(pub.bot), ['name']);
  // the browser can resolve it again and get the same thing back
  assert.deepEqual(publicConfig(resolveConfig(pub).config), pub);
});

test('unknown nested settings, non-object sections and http links are warned about', () => {
  const { config: c, warnings } = resolveConfig({
    repo: 'a/b', bot: { greeting: ['hi'], $note: 'fine' }, theme: { accnet: '#000000' }, neon: 'BIG', project: { url: 'http://example.com' },
  });
  assert.ok(warnings.some((w) => w.includes('"bot.greeting"')), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes('"theme.accnet"')), warnings.join('\n'));
  assert.ok(warnings.some((w) => w.includes('"neon" should be an object')), warnings.join('\n'));
  assert.ok(warnings.some((w) => /project\.url should start with https:\/\//.test(w)), warnings.join('\n'));
  assert.ok(!warnings.some((w) => w.includes('$note')));
  assert.equal(c.project.url, 'https://github.com/a/b'); // http is not used
  assert.equal(resolveConfig({ repo: 'a/b', project: { url: 'https://example.com/docs' } }).warnings.length, 0);
});

test('project.url naming another GitHub repo is warned about', () => {
  assert.equal(githubRepoOf('https://github.com/Owner/Name.git'), 'Owner/Name');
  assert.equal(githubRepoOf('https://github.com/owner/name/tree/main'), 'owner/name');
  assert.equal(githubRepoOf('https://github.com/owner'), '');
  assert.equal(githubRepoOf('https://example.com/a/b'), '');
  const same = resolveConfig({ repo: 'Owner/Name', project: { url: 'https://github.com/owner/name/issues' } });
  assert.deepEqual(same.warnings, []);
  const other = resolveConfig({ repo: 'me/mine', project: { url: 'https://github.com/them/theirs' } });
  assert.equal(other.warnings.length, 1);
  assert.match(other.warnings[0], /them\/theirs.*me\/mine/);
});

test('button text on the accent colour stays readable', () => {
  for (const accent of ['#f26b3a', '#ffeb3b', '#7dff8a', '#1a237e', '#000000', '#5b2c83', '#2e7d32', '#808080', '#ff0000']) {
    const ink = accentInk(accent);
    const other = ink === '#1b1007' ? '#fff8ef' : '#1b1007';
    assert.ok(contrast(accent, ink) >= contrast(accent, other), `${accent}: ${ink}`);
    assert.ok(contrast(accent, ink) >= 3.9, `${accent} with ${ink}: ${contrast(accent, ink).toFixed(2)}`);
  }
  assert.equal(accentInk('#f26b3a'), '#1b1007'); // the default keeps its dark text
  assert.equal(accentInk('#1a237e'), '#fff8ef'); // a dark accent gets light text
});

test('fill handles numbers, words and plurals', () => {
  assert.equal(fill('{gongs:GONG} TODAY', { gongs: 1 }), '1 GONG TODAY');
  assert.equal(fill('{gongs:GONG} TODAY', { gongs: 0 }), '0 GONGS TODAY');
  assert.equal(fill('@{login} — {merged:merged PR}', { login: 'ada', merged: 1672 }), '@ada — 1,672 merged PRs');
  assert.equal(fill('{unknown} stays', {}), '{unknown} stays');
});

test('the README config table matches shared/config.js', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const m = /<!-- config-table:start -->\n([\s\S]*?)\n<!-- config-table:end -->/.exec(readme);
  assert.ok(m, 'README is missing the config-table markers');
  assert.equal(m[1].trim(), configTable().trim(), 'README table is stale: run `npm run config-table` and paste the output');
});
