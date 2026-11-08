// Merge Lounge: a pixel-art lounge that only people with a merged PR in one GitHub repo can walk into.
// One Node process serves the static files, a small JSON API and one WebSocket room. Everything
// project-specific comes from lounge.config.json (defaults and checks in shared/config.js).
//
// In order below: config → the state folder (JSON files in STATE_DIR) → the contributor list (who may
// check in; rebuilt by scripts/fetch-contributors.js) → GitHub lookups → check-in (a one-time code the
// person puts in a public gist; /api/auth/start and /api/auth/verify) → the room (people, walking,
// furniture) → the resident bot → chat commands → the WebSocket protocol → HTTP routes.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import {
  W, H, STEP_MS, DOOR, FURNITURE, REACTIONS, findPath, approachTiles, reachable,
  randomWalkable, dirFrom, cleanLook, defaultLook, isSeat, furnitureAt,
} from './shared/world.js';
import { resolveConfig, publicConfig, fill } from './shared/config.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const STATE_DIR = process.env.STATE_DIR || path.join(ROOT, 'state');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'lounge.config.json');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const OFFLINE = process.env.OFFLINE === '1'; // tests: never call GitHub (lookups answer "github-down")

// ---------------------------------------------------------------- config
function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') { console.error(`config: can't read ${CONFIG_PATH}: ${e.message}`); process.exit(1); }
    console.log(`config: ${CONFIG_PATH} not found, using defaults`);
  }
  try {
    const { config, warnings } = resolveConfig(raw, process.env, { requireRepo: true });
    for (const w of warnings) console.log(`config: ${w}`);
    return config;
  } catch (e) {
    console.error(`config: ${e.message}`);
    process.exit(1);
  }
}
const CFG = loadConfig();
const PUBLIC_CONFIG = publicConfig(CFG);
const REPO = CFG.repo;
const ADMINS = new Set(CFG.admins);
if (!ADMINS.size) {
  const file = path.relative(ROOT, CONFIG_PATH) || CONFIG_PATH;
  console.log(`config: no admins set: add your GitHub username to "admins" in ${file.startsWith('..') ? CONFIG_PATH : file} (or set ADMINS) to get /announce, /mute, /kick and the other admin commands`);
}
const ALLOW = new Map(CFG.allow.map((l) => [l.toLowerCase(), l])); // let in without merged PRs
const MIN_PRS = CFG.minMergedPRs;
const BOT = CFG.bot;
const TZ = CFG.timezone;
const UA = `merge-lounge (${REPO} contributor lounge)`;

fs.mkdirSync(STATE_DIR, { recursive: true });
const sameRepo = (r) => typeof r === 'string' && r.toLowerCase() === REPO.toLowerCase();
const SNAPSHOT_FILE = path.join(STATE_DIR, 'contributors.json');

// STATE_DIR/lounge.json says which repo this state belongs to. If the repo changes, sessions, chat
// history, daily counters and people found live belonged to another lounge, so they are cleared before
// anything loads (profiles stay: looks and bans follow the GitHub account). With no marker yet, the
// state is adopted, unless the contributor list in it was built for another repo.
(function claimStateDir() {
  const marker = path.join(STATE_DIR, 'lounge.json');
  let prev = '', from = 'lounge.json';
  try { prev = String(JSON.parse(fs.readFileSync(marker, 'utf8')).repo || ''); } catch { /* none yet */ }
  if (!prev) {
    from = 'contributors.json';
    try { const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); if (typeof snap?.repo === 'string') prev = snap.repo; } catch { /* none */ }
  }
  if (prev && sameRepo(prev) && from === 'lounge.json') return;
  if (prev && !sameRepo(prev)) {
    for (const f of ['sessions.json', 'chat.json', 'daily.json', 'contributors-extra.json']) {
      for (const x of [f, f + '.tmp']) { try { fs.rmSync(path.join(STATE_DIR, x), { force: true }); } catch { /* ignore */ } }
    }
    console.log(`state: ${STATE_DIR} was ${prev}'s lounge (says ${from}); cleared its sessions, chat history, daily counters and live-found contributors`);
  }
  const tmp = `${marker}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ repo: REPO, since: new Date().toISOString() }));
  fs.renameSync(tmp, marker);
})();

// ---------------------------------------------------------------- storage
class JsonStore {
  constructor(file, fallback) {
    this.file = path.join(STATE_DIR, file);
    this.data = fallback;
    this.timer = null;
    this.mtime = 0;
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch { /* first run */ }
  }
  save() {
    // first change starts the clock; later changes ride along, so a write lands within 800ms
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 800);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }
  reloadIfChanged() {
    try {
      const m = fs.statSync(this.file).mtimeMs;
      if (m !== this.mtime && !this.timer) {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.mtime = m;
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }
}

const profiles = new JsonStore('profiles.json', {});
const sessions = new JsonStore('sessions.json', {});
const chatStore = new JsonStore('chat.json', { seq: 0, items: [] });
const extraContrib = new JsonStore('contributors-extra.json', {});
const daily = new JsonStore('daily.json', { day: '', gongs: 0, deploys: 0, messages: 0, visitors: [] });

// The contributor snapshot lives in STATE_DIR and says which repo it was built for. One for another
// repo (or none at all) is never used: a fresh one is built in the background, and until it lands
// check-in asks GitHub about each person directly.
function readSnapshot() {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); }
  catch (e) { return { ok: false, why: e.code === 'ENOENT' ? 'none yet' : `unreadable (${e.message})` }; }
  if (!snap || !Array.isArray(snap.contributors)) return { ok: false, why: 'not a contributor list' };
  if (!sameRepo(snap.repo)) return { ok: false, why: snap.repo ? `it is for ${snap.repo}` : 'it does not say which repo it is for' };
  return { ok: true, snap };
}
const contributors = new Map();
let totalMergedPRs = 0;
let snapshotState = 'missing'; // 'ready' | 'building' | 'missing'
const bootSnap = readSnapshot();
if (bootSnap.ok) {
  for (const c of bootSnap.snap.contributors) if (c && typeof c.login === 'string') contributors.set(c.login.toLowerCase(), c);
  totalMergedPRs = Number(bootSnap.snap.total_merged_prs) || 0;
  snapshotState = 'ready';
}
// People found live after the snapshot, each tagged with the repo they were found in. Entries for
// another repo, or with no tag (written before tags existed, repo unknown), are dropped: the next
// snapshot or a live lookup finds those people again if they belong here.
{
  let dropped = 0;
  for (const [k, c] of Object.entries(extraContrib.data)) {
    if (!c || typeof c.login !== 'string' || !sameRepo(c.repo)) { delete extraContrib.data[k]; dropped++; continue; }
    if (!contributors.has(k)) contributors.set(k, c);
  }
  if (dropped) { console.log(`contributors: dropped ${dropped} live-found entr${dropped === 1 ? 'y' : 'ies'} not tagged with ${REPO}`); extraContrib.flush(); }
}

const HISTORY_MAX = 150; // chat lines kept in chat.json
const HISTORY_SEND = 80; // the most a visitor gets on arrival (fewer when the room is new); sent as welcome.historyLimit for the chat header

function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function weekdayLocal() {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(new Date()).toLowerCase();
}
function rollDay() {
  const d = todayLocal();
  if (daily.data.day !== d) {
    daily.data = { day: d, gongs: 0, deploys: 0, messages: 0, visitors: [] };
    daily.save();
  }
  return daily.data;
}

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/i;
const normLogin = (s) => (typeof s === 'string' ? s : '').trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '');

// The client address as the hosting proxy saw it. Only one header is ever read, and only one the host's
// proxy writes itself: CLIENT_IP_HEADER if set (Railway: x-real-ip, Render: cf-connecting-ip), else
// Fly-Client-IP when running on Fly (Fly sets FLY_APP_NAME in every Machine). Anywhere else a client
// could send that header itself, so it is ignored. X-Forwarded-For is never trusted on its own: the
// client writes the first hop, and on Fly the last hop is the app's own address. A value that isn't an
// IP address falls back to the socket address.
const CLIENT_IP_HEADER = String(process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();
const IP_HEADER = CLIENT_IP_HEADER || (process.env.FLY_APP_NAME ? 'fly-client-ip' : '');
function clientIp(req) {
  let ip = '';
  if (IP_HEADER) {
    const v = req.headers[IP_HEADER];
    const hops = String(Array.isArray(v) ? v[v.length - 1] : v || '').slice(0, 2000).split(',').map((s) => s.trim()).filter(Boolean);
    ip = hops.length ? hops[hops.length - 1] : ''; // a list: the entry the nearest proxy added
    if (!net.isIP(ip)) ip = '';
  }
  if (!ip) ip = req.socket.remoteAddress || '?';
  return ip.slice(0, 64);
}
// If all we can see is a private/proxy address, everyone shares it, so per-address limits get roomier.
function isSharedIp(ip) {
  const v4 = ip.replace(/^::ffff:/, '');
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(v4) || /^(::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip) || ip === '?';
}

// A token bucket: up to `cap` actions in a burst, then `perSec` a second as it refills.
class Bucket {
  constructor(cap, perSec) { this.cap = cap; this.perSec = perSec; this.tokens = cap; this.t = now(); }
  take(n = 1) {
    const t = now();
    this.tokens = Math.min(this.cap, this.tokens + ((t - this.t) / 1000) * this.perSec);
    this.t = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
const ipBuckets = new Map();
// Check-in calls per address: 30 in a burst, then one every 2 seconds (ten times that for a shared address).
function ipAllow(ip, cap = 30, perSec = 0.5) {
  let b = ipBuckets.get(ip);
  if (!b) { b = isSharedIp(ip) ? new Bucket(cap * 10, perSec * 10) : new Bucket(cap, perSec); ipBuckets.set(ip, b); }
  return b.take();
}
// Forget addresses whose bucket has filled back up (they carry no state); a busy one keeps its limit.
setInterval(() => {
  if (ipBuckets.size <= 2000) return;
  const t = now();
  for (const [ip, b] of ipBuckets) if (b.tokens + ((t - b.t) / 1000) * b.perSec >= b.cap) ipBuckets.delete(ip);
  if (ipBuckets.size > 50_000) ipBuckets.clear(); // memory backstop
}, 60_000).unref();

const plural = (n, word) => `${Number(n).toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function ago(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------- GitHub
async function gh(url, { api = false, timeout = 9000 } = {}) {
  if (OFFLINE) throw new Error('OFFLINE=1: no GitHub calls');
  const headers = { 'User-Agent': UA, 'Cache-Control': 'no-cache' };
  if (api) {
    headers.Accept = 'application/vnd.github+json';
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    return await fetch(url, { headers, signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(t);
  }
}

const negCache = new Map(); // login → time we confirmed "no merged PRs"

// Who may check in: enough merged PRs, or on the config's allow list.
function memberFor(key) {
  const c = contributors.get(key);
  if (c && c.merged >= MIN_PRS) return c;
  if (ALLOW.has(key)) return c || { login: ALLOW.get(key), merged: 0, first: '', last: '' };
  return null;
}

async function lookupContributor(rawLogin) {
  const login = normLogin(rawLogin);
  if (!LOGIN_RE.test(login)) return { ok: false, reason: 'bad-login' };
  const key = login.toLowerCase();
  const member = memberFor(key);
  if (member) return { ok: true, c: member };
  if (contributors.has(key)) return { ok: false, reason: 'not-contributor', login: contributors.get(key).login }; // under minMergedPRs
  const neg = negCache.get(key);
  if (neg && now() - neg < 5 * 60_000) return { ok: false, reason: 'not-contributor', login };
  const q = encodeURIComponent(`repo:${REPO} is:pr is:merged author:${login}`);
  let res;
  try {
    res = await gh(`https://api.github.com/search/issues?q=${q}&per_page=1`, { api: true });
  } catch {
    return { ok: false, reason: 'github-down' };
  }
  if (res.status === 422) { negCache.set(key, now()); return { ok: false, reason: 'not-contributor', login }; }
  if (res.status === 403 || res.status === 429) return { ok: false, reason: 'github-busy' };
  if (!res.ok) return { ok: false, reason: 'github-down' };
  const j = await res.json();
  if (!j.total_count || j.total_count < MIN_PRS || !j.items?.[0]?.user) { negCache.set(key, now()); return { ok: false, reason: 'not-contributor', login }; }
  const it = j.items[0];
  const c = { login: it.user.login, merged: j.total_count, first: (it.closed_at || '').slice(0, 10), last: (it.closed_at || '').slice(0, 10), repo: REPO };
  contributors.set(key, c);
  extraContrib.data[key] = c;
  extraContrib.save();
  return { ok: true, c };
}

// How many merged PRs GitHub shows for this login right now, or null if GitHub didn't answer.
async function liveMerged(login) {
  try {
    const q = encodeURIComponent(`repo:${REPO} is:pr is:merged author:${login}`);
    const res = await gh(`https://api.github.com/search/issues?q=${q}&per_page=1&sort=created&order=desc`, { api: true });
    if (res.status === 422) return { count: 0, last: null }; // GitHub: no such user
    if (!res.ok) return null;
    const j = await res.json();
    if (!Number.isFinite(j.total_count)) return null;
    return { count: j.total_count, last: j.items?.[0]?.closed_at ? j.items[0].closed_at.slice(0, 10) : null };
  } catch { return null; }
}

// Keep the repo-wide merged PR count honest (one search call every 20 minutes).
async function refreshRepoTotal() {
  try {
    const q = encodeURIComponent(`repo:${REPO} is:pr is:merged`);
    const res = await gh(`https://api.github.com/search/issues?q=${q}&per_page=1`, { api: true });
    if (!res.ok) return;
    const j = await res.json();
    if (Number.isFinite(j.total_count) && j.total_count >= totalMergedPRs) totalMergedPRs = j.total_count;
  } catch { /* best effort */ }
}
setTimeout(refreshRepoTotal, 15_000).unref();
setInterval(refreshRepoTotal, 20 * 60_000).unref();

// The snapshot is rebuilt by scripts/fetch-contributors.js in a child process: right away when there
// is no usable one, and once a day around 4am lounge time (a quiet hour, because the rebuild uses
// most of the search API's per-minute allowance for a few minutes).
let snapshotChild = null;
let snapshotRetry = null;
let snapshotDay = '';
function reloadSnapshot() {
  const r = readSnapshot();
  if (!r.ok) { console.log(`contributors: new snapshot not usable: ${r.why}`); return false; }
  const snap = r.snap;
  if (snapshotState === 'ready' && snap.contributors.length < contributors.size * 0.9) {
    console.log(`contributors: new snapshot has ${snap.contributors.length} people, fewer than the ${contributors.size} known, kept the old list`);
    return false;
  }
  for (const c of snap.contributors) {
    if (!c || typeof c.login !== 'string') continue;
    const k = c.login.toLowerCase();
    contributors.set(k, c);
    if (extraContrib.data[k]) delete extraContrib.data[k];
  }
  extraContrib.save();
  if (snap.total_merged_prs > totalMergedPRs) totalMergedPRs = snap.total_merged_prs;
  for (const u of users.values()) {
    if (u.npc) continue;
    const m = mergedFor(u.id);
    if (m !== u.merged) { u.merged = m; broadcast({ t: 'merged', id: u.id, merged: m }); }
  }
  snapshotState = 'ready';
  pushStats();
  return true;
}
function retrySnapshotLater() {
  if (snapshotState === 'ready') return;
  snapshotState = 'missing';
  console.log('contributors: trying again in 30 minutes; check-in keeps using live GitHub lookups');
  clearTimeout(snapshotRetry);
  snapshotRetry = setTimeout(() => refreshSnapshot('retry'), 30 * 60_000);
  snapshotRetry.unref();
}
function refreshSnapshot(why = 'daily') {
  if (snapshotChild) return;
  clearTimeout(snapshotRetry);
  let child;
  try {
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'fetch-contributors.js'), '--repo', REPO, '--out', SNAPSHOT_FILE],
      { cwd: ROOT, env: { ...process.env, LOUNGE_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.log(`contributors: could not start the rebuild: ${e.message}`);
    retrySnapshotLater();
    return;
  }
  snapshotChild = child;
  if (snapshotState !== 'ready') snapshotState = 'building';
  console.log(`contributors: rebuilding the snapshot for ${REPO} (${why})`);
  for (const s of [child.stdout, child.stderr]) readline.createInterface({ input: s }).on('line', (l) => console.log(`contributors: ${l}`));
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    snapshotChild = null;
    let ok = false;
    if (code === 0) {
      try { ok = reloadSnapshot(); } catch (e) { console.log(`contributors: reload failed: ${e.message}`); }
      if (ok) console.log(`contributors: snapshot ready · ${contributors.size} contributors · ${totalMergedPRs} merged PRs`);
    } else console.log(`contributors: rebuild failed (exit ${code})`);
    if (!ok) retrySnapshotLater();
  };
  child.on('error', (e) => { console.log(`contributors: ${e.message}`); finish(-1); });
  child.on('exit', (code) => finish(code));
}
setInterval(() => {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const day = todayLocal();
  if (hour === 4 && snapshotDay !== day) { snapshotDay = day; refreshSnapshot('daily'); }
}, 5 * 60_000).unref();
if (!bootSnap.ok) {
  console.log(`contributors: no usable snapshot in ${SNAPSHOT_FILE} (${bootSnap.why})`);
  snapshotState = 'building';
  setImmediate(() => refreshSnapshot('first run for this repo'));
} else if (process.env.REFRESH_ON_START === '1') setTimeout(() => refreshSnapshot('REFRESH_ON_START'), 5000).unref();

// Proof of GitHub ownership: a public gist containing the one-time code.
async function gistHasCode(login, code, since, alsoApi = true) {
  // 1) the public gist feed (a web page, not the rate-limited API)
  try {
    const res = await gh(`https://gist.github.com/${encodeURIComponent(login)}.atom?nocache=${now()}`);
    if (res.ok) {
      const body = await res.text();
      if (body.includes(code)) return true;
      // the feed is fresh, so the API (60 calls/hour without a token) is only a periodic second opinion
      if (!alsoApi) return false;
    }
  } catch { /* fall through */ }
  // 2) the gists API, then the raw files of anything recent
  try {
    const res = await gh(`https://api.github.com/users/${encodeURIComponent(login)}/gists?per_page=10&nocache=${now()}`, { api: true });
    if (!res.ok) return false;
    const list = await res.json();
    if (!Array.isArray(list)) return false;
    if (list.some((g) => String(g.description || '').includes(code))) return true;
    const recent = list.filter((g) => Date.parse(g.created_at) >= since - 5 * 60_000).slice(0, 3);
    for (const g of recent) {
      for (const f of Object.values(g.files || {}).slice(0, 3)) {
        if (!f.raw_url || (f.size || 0) > 20_000) continue;
        if (!/^https:\/\/gist\.githubusercontent\.com\//.test(f.raw_url)) continue;
        const r = await gh(f.raw_url);
        if (r.ok && (await r.text()).includes(code)) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// ---------------------------------------------------------------- sessions & profiles
// A challenge belongs to the browser that asked for it (by a secret nonce), not just to the login,
// so nobody else can ride along on someone's gist and walk off with their session.
const challenges = new Map(); // nonce → { key, code, created, tries }
const CHALLENGE_TTL = 30 * 60_000;
function pruneChallenges() {
  const t = now();
  for (const [n, ch] of challenges) if (t - ch.created > CHALLENGE_TTL) challenges.delete(n);
}
setInterval(pruneChallenges, 60_000).unref();
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: easy to read off one screen and type on another
function newCode() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (const x of b) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return `${CFG.codePrefix}-${s}`;
}

function createSession(login) {
  const token = crypto.randomBytes(24).toString('base64url');
  sessions.data[sha(token)] = { login: login.toLowerCase(), created: now(), lastUsed: now() };
  sessions.save();
  return token;
}
function sessionFor(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const k = sha(token);
  let s = sessions.data[k];
  if (!s && sessions.reloadIfChanged()) s = sessions.data[k];
  if (!s) return null;
  if (now() - s.lastUsed > 120 * 86400_000) { delete sessions.data[k]; sessions.save(); return null; } // unused for 120 days: check in again
  return s;
}
function revokeSessions(loginLower) {
  for (const [k, s] of Object.entries(sessions.data)) if (s.login === loginLower) delete sessions.data[k];
  sessions.flush();
}

function ensureProfile(loginLower, displayLogin) {
  let p = profiles.data[loginLower];
  if (!p) {
    p = profiles.data[loginLower] = {
      login: displayLogin || loginLower, look: defaultLook(loginLower), firstSeen: 0, lastSeen: 0,
      visits: 0, msgs: 0, customized: false,
    };
    profiles.save();
  }
  return p;
}

// ---------------------------------------------------------------- room state
const users = new Map(); // id → user
const sockets = new Map(); // id → ws
let seq = chatStore.data.seq || 0;

function mergedFor(id) {
  const c = contributors.get(id);
  return c ? c.merged : 0;
}

function tileNow(u, t = now()) {
  if (!u.path) return [u.x, u.y];
  const steps = Math.floor((t - u.pathStart) / STEP_MS);
  if (steps <= 0) return [u.x, u.y];
  if (steps >= u.path.length) return u.path[u.path.length - 1];
  return u.path[steps - 1];
}

function publicUser(u) {
  const t = now();
  let pathOut = null, from = null, elapsed = 0;
  if (u.path) {
    const steps = Math.floor((t - u.pathStart) / STEP_MS);
    if (steps < u.path.length) {
      const idx = Math.max(0, steps);
      from = idx === 0 ? [u.x, u.y] : u.path[idx - 1];
      pathOut = u.path.slice(idx);
      elapsed = (t - u.pathStart) - idx * STEP_MS;
    }
  }
  const [x, y] = tileNow(u, t);
  return {
    id: u.id, login: u.login, look: u.look, npc: !!u.npc, admin: !!u.admin, merged: u.merged,
    x, y, dir: u.dir, pose: u.pose, item: u.itemUntil > t ? u.item : null, afk: !!u.afk,
    typing: !!u.typing, from, path: pathOut, elapsed,
  };
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}
function broadcast(msg, exceptId = null) {
  const s = JSON.stringify(msg);
  for (const [id, ws] of sockets) if (id !== exceptId) send(ws, s);
}

function stats() {
  const d = rollDay();
  return {
    online: [...users.values()].filter((u) => !u.npc && !u.ghost).length,
    contributors: contributors.size,
    mergedPRs: totalMergedPRs,
    gongs: d.gongs, deploys: d.deploys, messages: d.messages, visitors: d.visitors.length,
  };
}
let statsTimer = null;
function pushStats() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => { statsTimer = null; broadcast({ t: 'stats', stats: stats() }); }, 400);
}

function addHistory(entry) {
  entry.id = ++seq;
  entry.ts = now();
  chatStore.data.seq = seq;
  chatStore.data.items.push(entry);
  if (chatStore.data.items.length > HISTORY_MAX) chatStore.data.items.splice(0, chatStore.data.items.length - HISTORY_MAX);
  chatStore.save();
  return entry;
}
function say(u, text, kind = 'say') {
  const e = addHistory({ kind, uid: u.id, login: u.login, text, npc: !!u.npc });
  broadcast({ t: 'chat', ...e });
  return e;
}
// A line in the chat from the lounge itself ("@x rang the merge gong"). store=false: shown to whoever is
// in the room now, not kept in the history (mute notices).
function system(text, store = true) {
  const e = store ? addHistory({ kind: 'system', text }) : { kind: 'system', text, id: 0, ts: now() };
  broadcast({ t: 'chat', ...e });
}

function startPath(u, path, opts = {}) {
  const t = now();
  // Continue smoothly if already walking: start from the tile being stepped into.
  let fromX = u.x, fromY = u.y, offset = 0;
  if (u.path) {
    const elapsed = t - u.pathStart;
    const steps = Math.floor(elapsed / STEP_MS);
    if (steps < u.path.length) {
      const idx = Math.max(0, steps);
      const leaving = idx === 0 ? [u.x, u.y] : u.path[idx - 1];
      const entering = u.path[idx];
      const rest = path ? path.slice() : [];
      // re-plan from the tile we're entering
      fromX = leaving[0]; fromY = leaving[1];
      offset = elapsed - idx * STEP_MS;
      path = [entering, ...rest];
    } else {
      const last = u.path[u.path.length - 1];
      u.x = last[0]; u.y = last[1];
      fromX = u.x; fromY = u.y;
    }
  }
  if (!path || !path.length) { u.path = null; return; }
  u.x = fromX; u.y = fromY;
  u.path = path;
  u.pathStart = t - offset;
  u.pose = 'stand';
  u.seat = null;
  u.target = opts.target || null;
  const first = path[0];
  u.dir = dirFrom(first[0] - fromX, first[1] - fromY);
  broadcast({ t: 'path', id: u.id, from: [fromX, fromY], path, elapsed: offset, pose: 'stand' });
}

function planFrom(u) {
  // where re-planning should start: the tile currently being entered (or standing on)
  if (!u.path) return [u.x, u.y];
  const steps = Math.floor((now() - u.pathStart) / STEP_MS);
  if (steps >= u.path.length) return u.path[u.path.length - 1];
  return u.path[Math.max(0, steps)];
}

function seatTaken(fid, exceptId, includePending = true) {
  for (const u of users.values()) {
    if (u.id === exceptId || u.ghost) continue;
    if (u.seat === fid) return true;
    if (includePending && u.path && u.target && u.target.seat === fid) return true;
  }
  return false;
}

function moveTo(u, tx, ty, opts = {}) {
  if (!Number.isInteger(tx) || !Number.isInteger(ty)) return;
  const f = furnitureAt(tx, ty);
  const [sx, sy] = planFrom(u);
  let goal = null;
  if (f && f.seat) {
    if (seatTaken(f.id, u.id)) {
      // someone's there — walk up next to it instead
      return walkNextTo(u, f, opts);
    }
    goal = { seat: f.id };
  } else if (!reachable(tx, ty)) {
    return;
  }
  if (sx === tx && sy === ty) {
    if (!u.path && goal) arrive(u, goal);
    if (u.path) startPath(u, [], {});
    return;
  }
  const p = findPath(sx, sy, tx, ty);
  if (!p) return;
  if (u.path) startPath(u, p, { target: goal });
  else startPath(u, p, { target: goal });
  if (!u.path && goal) arrive(u, goal);
}

function walkNextTo(u, f, extra = {}) {
  const [sx, sy] = planFrom(u);
  const options = approachTiles(f.x, f.y).filter(([x, y]) => reachable(x, y));
  if (!options.length) return false;
  let best = null;
  for (const [x, y] of options) {
    if (x === sx && y === sy) { best = { p: [], x, y }; break; }
    const p = findPath(sx, sy, x, y);
    if (p && (!best || p.length < best.p.length)) best = { p, x, y };
  }
  if (!best) return false;
  const goal = { face: [f.x, f.y], ...extra };
  if (!best.p.length) {
    if (u.path) startPath(u, [], {});
    arrive(u, goal);
  } else {
    startPath(u, best.p, { target: goal });
  }
  return true;
}

function arrive(u, goal) {
  if (!goal) return;
  if (goal.seat) {
    const f = FURNITURE.find((x) => x.id === goal.seat);
    if (!f) return;
    if (seatTaken(f.id, u.id, false)) {
      // beaten to it — hop off to the side
      walkNextTo(u, f);
      return;
    }
    u.seat = f.id;
    u.pose = 'sit';
    u.dir = f.dir;
    broadcast({ t: 'state', id: u.id, pose: u.pose, dir: u.dir, x: u.x, y: u.y });
    return;
  }
  if (goal.face) {
    u.dir = dirFrom(goal.face[0] - u.x, goal.face[1] - u.y);
    if (!goal.pose) broadcast({ t: 'state', id: u.id, pose: u.pose, dir: u.dir, x: u.x, y: u.y });
  }
  if (goal.pose) applyPose(u, goal.pose);
  if (goal.use) useFurniture(u, goal.use);
}

const cooldown = { gong: 0, deploy: 0 };
function useFurniture(u, fid) {
  const f = FURNITURE.find((x) => x.id === fid);
  if (!f || !f.use) return;
  const t = now();
  if (f.use === 'gong') {
    if (t < cooldown.gong) return sendTo(u, { t: 'notice', text: 'the gong is still ringing…' });
    cooldown.gong = t + 8000;
    rollDay().gongs++; daily.save();
    broadcast({ t: 'fx', kind: 'gong', fid, by: u.id });
    system(`🔔 @${u.login} rang the merge gong`);
    if (!u.npc && Math.random() < 0.5) botSay(pick(BOT.gong), 1400);
    pushStats();
  } else if (f.use === 'deploy') {
    if (t < cooldown.deploy) return sendTo(u, { t: 'notice', text: 'prod is still recovering. give it a sec.' });
    cooldown.deploy = t + 20000;
    rollDay().deploys++; daily.save();
    broadcast({ t: 'fx', kind: 'deploy', fid, by: u.id });
    system(`🚨 @${u.login} deployed to prod on a ${weekdayLocal()}`);
    if (!u.npc && Math.random() < 0.6) botSay(pick(BOT.deploy), 1800);
    pushStats();
  } else if (f.use === 'kombucha' || f.use === 'coldbrew') {
    u.item = f.use;
    u.itemUntil = t + 3 * 60_000;
    broadcast({ t: 'state', id: u.id, pose: u.pose, dir: u.dir, item: u.item, x: u.x, y: u.y });
  }
}
function sendTo(u, msg) { send(sockets.get(u.id), msg); }

// arrival + afk + item expiry tick
setInterval(() => {
  const t = now();
  for (const u of users.values()) {
    if (u.path && t - u.pathStart >= u.path.length * STEP_MS) {
      const last = u.path[u.path.length - 1];
      const prev = u.path.length > 1 ? u.path[u.path.length - 2] : [u.x, u.y];
      u.dir = dirFrom(last[0] - prev[0], last[1] - prev[1]);
      u.x = last[0]; u.y = last[1];
      u.path = null;
      const goal = u.target; u.target = null;
      arrive(u, goal);
    }
    if (u.item && u.itemUntil <= t) {
      u.item = null;
      broadcast({ t: 'state', id: u.id, pose: u.pose, dir: u.dir, item: null, x: u.x, y: u.y });
    }
    if (!u.npc && !u.ghost) {
      const afk = t - u.lastActive > 10 * 60_000;
      if (afk !== !!u.afk) { u.afk = afk; broadcast({ t: 'afk', id: u.id, afk }); }
    }
  }
}, 100).unref();

// ---------------------------------------------------------------- the resident bot (name and lines from the config)
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BOT_MENTION = new RegExp(`\\b${escRe(BOT.name)}\\b|@${escRe(BOT.name)}|\\bbot\\b.*\\?$`, 'i');
const bot = {
  // "bot:" can't appear in a GitHub login, so a person who shares the bot's name stays a person
  id: `bot:${BOT.name.toLowerCase()}`, login: BOT.name, npc: true, admin: false, merged: 0,
  look: { bot: true }, x: 8, y: 9, dir: 5, pose: 'stand', path: null, pathStart: 0,
  seat: null, item: null, itemUntil: 0, lastActive: now(), afk: false,
};
users.set(bot.id, bot);
let botLastSaid = 0;
let botQueue = Promise.resolve();
let botPending = 0;
function botSay(text, delay = 900) {
  if (botPending >= 4) return; // the bot never gets more than a few lines behind
  botPending++;
  botQueue = botQueue.then(() => new Promise((r) => setTimeout(() => {
    botPending--;
    try { say(bot, text); botLastSaid = now(); } catch { /* keep the queue moving */ }
    r();
  }, delay)));
}
function humansOnline() { return [...users.values()].filter((u) => !u.npc && !u.ghost).length; }
(function botWander() {
  setTimeout(() => {
    if (!bot.path && humansOnline() > 0) {
      const [ox, oy] = planFrom(bot);
      for (let i = 0; i < 12; i++) {
        const [x, y] = randomWalkable();
        if (Math.abs(x - ox) + Math.abs(y - oy) > 7) continue;
        const p = findPath(ox, oy, x, y, { allowGoalSeat: false });
        if (p && p.length) { startPath(bot, p); break; }
      }
    }
    if (humansOnline() > 0 && now() - botLastSaid > 25 * 60_000 && Math.random() < 0.15) {
      botSay(pick(BOT.idle), 0);
    }
    botWander();
  }, 9000 + Math.random() * 16000).unref?.();
})();

// ---------------------------------------------------------------- chat commands
const lastMsg = new Map();
function findUserByLogin(s) {
  const k = normLogin(s).toLowerCase();
  return users.get(k) || null;
}

function handleCommand(u, text) {
  const [cmdRaw, ...rest] = text.slice(1).split(/\s+/);
  const cmd = cmdRaw.toLowerCase();
  const arg = rest.join(' ');
  const note = (t) => sendTo(u, { t: 'notice', text: t });
  if (!u.actBucket.take(2)) return note('easy there — slow down a little');
  switch (cmd) {
    case 'help':
      return note('/wave /dance /sit /stand /me … /w @user … /who /stats /gong /afk' + (u.admin ? ' · admin: /announce /mute /unmute /kick /ban /unban /purge /clear' : ''));
    case 'wave': return gesture(u, 'wave');
    case 'dance': return setPose(u, u.pose === 'dance' ? 'stand' : 'dance');
    case 'sit': return setPose(u, 'sit');
    case 'stand': return setPose(u, 'stand');
    case 'afk': u.lastActive = now() - 11 * 60_000; u.afk = true; broadcast({ t: 'afk', id: u.id, afk: true }); return;
    case 'me': {
      const body = cleanText(arg);
      if (!body) return;
      if (!chatAllowed(u, body)) return;
      return say(u, body, 'me');
    }
    case 'w': case 'whisper': case 'msg': {
      const target = findUserByLogin(rest[0] || '');
      const body = cleanText(rest.slice(1).join(' '));
      if (!target || target.npc || target.ghost) return note('they are not in the lounge right now');
      if (!body) return;
      if (!chatAllowed(u, body)) return;
      const m = { t: 'chat', kind: 'whisper', id: 0, ts: now(), uid: u.id, login: u.login, to: target.login, text: body };
      sendTo(target, m);
      if (target.id !== u.id) sendTo(u, m);
      return;
    }
    case 'who': {
      const list = [...users.values()].filter((x) => !x.npc && !x.ghost).map((x) => '@' + x.login);
      return note(`${list.length} inside: ${list.join(', ')}`);
    }
    case 'stats': {
      if (!chatAllowed(u, '/stats')) return; // it makes the bot talk, so it counts as talking
      const s = stats();
      const top = Object.values(profiles.data).filter((p) => !p.test).sort((a, b) => b.msgs - a.msgs).slice(0, 3).map((p) => `@${p.login} (${p.msgs})`).join(', ');
      botSay(`📊 ${s.contributors} merged contributors · ${s.mergedPRs.toLocaleString('en-US')} merged PRs · today: ${plural(s.visitors, 'visitor')}, ${plural(s.messages, 'message')}, ${plural(s.gongs, 'gong')}, ${plural(s.deploys, 'deploy')}${top ? ' · chattiest: ' + top : ''}`, 500);
      return;
    }
    case 'gong': {
      const f = FURNITURE.find((x) => x.id === 'gong');
      walkNextTo(u, f, { use: 'gong' });
      return;
    }
  }
  if (!u.admin) return note('unknown command — try /help');
  const tKey = normLogin(rest[0] || '').toLowerCase();
  const validKey = LOGIN_RE.test(tKey);
  const target = validKey ? findUserByLogin(tKey) : null;
  // only real logins, and only profiles that actually exist (never things like "__proto__")
  const prof = validKey && Object.hasOwn(profiles.data, tKey) ? profiles.data[tKey] : null;
  switch (cmd) {
    case 'announce': {
      const body = cleanText(arg);
      if (body) { const e = addHistory({ kind: 'announce', login: u.login, text: body }); broadcast({ t: 'chat', ...e }); }
      return;
    }
    case 'mute': {
      const mins = Math.min(24 * 60, Math.max(1, parseInt(rest[1] || '10', 10) || 10));
      if (!prof) return note('no such visitor');
      prof.mutedUntil = now() + mins * 60_000; profiles.flush();
      return system(`@${prof.login} was muted for ${mins}m`, false);
    }
    case 'unmute': {
      if (!prof) return note('no such visitor');
      prof.mutedUntil = 0; profiles.flush(); note(`unmuted @${prof.login}`);
      return;
    }
    case 'kick': {
      if (!target || target.npc) return note('not in the lounge right now');
      const until = now() + 2 * 60_000;
      if (prof) { prof.kickedUntil = until; profiles.flush(); }
      send(sockets.get(target.id), { t: 'kicked', reason: 'kicked by an admin', until, retryIn: until - now() }); // retryIn: ms, immune to clock skew
      sockets.get(target.id)?.close(4001, 'kicked');
      return;
    }
    case 'ban': {
      if (!prof || ADMINS.has(tKey)) return note('cannot ban that one (never visited, or an admin)');
      prof.banned = true; profiles.flush(); revokeSessions(tKey);
      if (target) { send(sockets.get(target.id), { t: 'kicked', reason: 'banned' }); sockets.get(target.id)?.close(4003, 'banned'); }
      return note(`banned @${prof.login}`);
    }
    case 'unban': {
      if (!prof) return note('no such visitor');
      prof.banned = false; profiles.flush(); note(`unbanned @${prof.login}`);
      return;
    }
    case 'purge': {
      if (!validKey) return note('purge whom? /purge username');
      // a person's lines go by uid (a human's uid is their lower-cased login) and never the bot's, even
      // when someone shares the bot's name; their announcements carry only a login
      const gone = (e) => (e.uid === tKey && !e.npc) || (e.kind === 'announce' && !e.uid && (e.login || '').toLowerCase() === tKey);
      const before = chatStore.data.items.length;
      chatStore.data.items = chatStore.data.items.filter((e) => !gone(e));
      chatStore.save();
      broadcast({ t: 'purge', login: tKey, uid: tKey });
      return note(`removed ${plural(before - chatStore.data.items.length, 'message')}`);
    }
    case 'clear': {
      chatStore.data.items = [];
      chatStore.save();
      broadcast({ t: 'clear' });
      return;
    }
  }
  note('unknown command — try /help');
}

function cleanText(s) {
  return (typeof s === 'string' ? s : '')
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function chatAllowed(u, text) {
  const p = profiles.data[u.id];
  if (p && p.mutedUntil && p.mutedUntil > now()) {
    sendTo(u, { t: 'notice', text: `you're muted for ${ago(p.mutedUntil - now()).replace(' ago', '')}` });
    return false;
  }
  if (!u.chatBucket.take()) { sendTo(u, { t: 'notice', text: 'easy there — slow down a little' }); return false; }
  const prev = lastMsg.get(u.id);
  if (prev && prev.text === text && now() - prev.t < 20_000) {
    prev.n++;
    if (prev.n >= 3) { sendTo(u, { t: 'notice', text: 'we heard you the first time 🙂' }); return false; }
  } else lastMsg.set(u.id, { text, t: now(), n: 1 });
  return true;
}

function gesture(u, g) {
  broadcast({ t: 'gesture', id: u.id, g });
}
// A wave from someone's profile card: the person waved at gets a notice. One per pair every 10 s, so a
// wave can't be used to flood someone's screen, and none at all from someone who is muted.
// ack (optional, newer clients): the waver is told when the ping really went out, so their feed never
// says "You waved at @x" for a ping that was blocked. Older tabs don't ask and write that line themselves.
const waveCooldown = new Map();
function waveAt(u, to, ack) {
  const target = to.length <= 80 ? findUserByLogin(to) : null;
  if (!target || target.npc || target.ghost || target.id === u.id) return;
  const t = now();
  const muted = profiles.data[u.id]?.mutedUntil;
  if (muted && muted > t) {
    sendTo(u, { t: 'notice', kind: 'waveBlocked', to: target.login, text: `you're muted for ${ago(muted - t).replace(' ago', '')}, so @${target.login} didn't get a ping` });
    return;
  }
  const key = `${u.id}>${target.id}`;
  if ((waveCooldown.get(key) || 0) > t) return;
  if (waveCooldown.size > 2000) for (const [k, until] of waveCooldown) if (until <= t) waveCooldown.delete(k);
  waveCooldown.set(key, t + 10_000);
  sendTo(target, { t: 'notice', kind: 'wave', from: u.login, text: `@${u.login} waved at you 👋` });
  if (ack) sendTo(u, { t: 'notice', kind: 'waved', to: target.login, text: `You waved at @${target.login} 👋` });
}
function setPose(u, pose) {
  if (!['stand', 'sit', 'dance'].includes(pose)) return;
  if (u.path) { startPath(u, [], { target: { pose } }); return; } // finish the step, then do it
  if (u.seat && pose !== 'sit') {
    // getting up from a chair: step off it first
    const f = FURNITURE.find((x) => x.id === u.seat);
    if (f && walkNextTo(u, f, { pose })) return;
  }
  applyPose(u, pose);
}
function applyPose(u, pose) {
  if (u.seat && pose !== 'sit') u.seat = null;
  if (pose === 'sit' && !u.seat) {
    // sitting on the floor: snap diagonal directions to the nearest straight one
    if (u.dir % 2 === 0) u.dir = (u.dir + 1) % 8;
  }
  u.pose = pose;
  broadcast({ t: 'state', id: u.id, pose, dir: u.dir, x: u.x, y: u.y });
}

function onChat(u, raw) {
  const text = cleanText(raw);
  if (!text) return;
  u.lastActive = now();
  if (u.typing) { u.typing = false; broadcast({ t: 'typing', id: u.id, on: false }, u.id); }
  if (text.startsWith('/')) return handleCommand(u, text);
  if (!chatAllowed(u, text)) return;
  say(u, text);
  const p = profiles.data[u.id];
  if (p) { p.msgs = (p.msgs || 0) + 1; profiles.save(); }
  rollDay().messages++; daily.save();
  pushStats();
  if (BOT_MENTION.test(text) && now() - botLastSaid > 4000) {
    botSay(pick(BOT.mention), 1100);
  }
}

// ---------------------------------------------------------------- websocket
function onHello(ws, msg, ip) {
  const s = sessionFor(msg.token);
  if (!s) { send(ws, { t: 'auth', ok: false }); ws.close(4000, 'auth'); return null; }
  const id = s.login;
  const p = profiles.data[id] || ensureProfile(id, contributors.get(id)?.login || id);
  if (p.banned) { send(ws, { t: 'kicked', reason: 'banned' }); ws.close(4003, 'banned'); return null; }
  if (p.kickedUntil && p.kickedUntil > now()) { send(ws, { t: 'kicked', reason: 'kicked — try again in a couple of minutes', until: p.kickedUntil, retryIn: p.kickedUntil - now() }); ws.close(4001, 'kicked'); return null; }
  if (s.test && !p.test) { p.test = true; profiles.save(); }
  s.lastUsed = now(); sessions.save();

  const old = sockets.get(id);
  if (old && old !== ws) { send(old, { t: 'replaced' }); old.close(4002, 'replaced'); }

  let u = users.get(id);
  const t = now();
  const returning = p.lastSeen && t - p.lastSeen > 30 * 60_000; // away 30+ minutes: the bot says welcome back
  const firstTime = !p.firstSeen;
  // already in the room (a second tab, or back within the grace period): nobody else saw them leave
  const resumed = !!u;
  if (u && u.ghost) {
    clearTimeout(u.ghostTimer);
    u.ghost = false;
  } else if (!u) {
    u = {
      id, login: p.login, look: p.look, npc: false, admin: ADMINS.has(id), merged: mergedFor(id),
      x: DOOR.x, y: DOOR.y, dir: 3, pose: 'stand', path: null, pathStart: 0, seat: null,
      item: null, itemUntil: 0, lastActive: t, afk: false, typing: false,
      chatBucket: new Bucket(5, 0.8), actBucket: new Bucket(12, 6), // chat: 5 lines in a burst, then 0.8 a second; moves/emotes: 12, then 6 a second
    };
    users.set(id, u);
  }
  sockets.set(id, ws);
  u.lastActive = t;
  if (!p.firstSeen) p.firstSeen = t;
  const prevSeen = p.lastSeen;
  p.lastSeen = t;
  p.visits = (p.visits || 0) + (returning || firstTime ? 1 : 0);
  profiles.save();
  const d = rollDay();
  if (!d.visitors.includes(id)) { d.visitors.push(id); daily.save(); }

  send(ws, {
    t: 'welcome',
    you: { id, login: u.login, admin: u.admin, merged: u.merged, customized: !!p.customized, firstTime },
    users: [...users.values()].filter((x) => !x.ghost).map(publicUser),
    history: chatStore.data.items.slice(-HISTORY_SEND),
    historyLimit: HISTORY_SEND,
    stats: stats(),
    serverTime: t,
  });
  if (!resumed) {
    broadcast({ t: 'join', user: publicUser(u) }, id);
    pushStats();
    console.log(`join @${u.login}${firstTime ? ' (first visit)' : ''} · ${humansOnline()} inside`);
  }

  // walk in from the door
  if (u.x === DOOR.x && u.y === DOOR.y && !u.path) {
    setTimeout(() => {
      if (!users.has(id) || u.ghost || u.path || u.x !== DOOR.x || u.y !== DOOR.y) return;
      const spots = [[2, 9], [3, 8], [2, 8], [3, 9], [1, 8], [4, 9]].filter(([x, y]) => reachable(x, y));
      const [tx, ty] = pick(spots);
      moveTo(u, tx, ty);
    }, 450);
  }
  if (firstTime) botSay(fill(pick(BOT.greet), { login: u.login, merged: u.merged }), 1800);
  else if (returning) botSay(fill(pick(BOT.welcomeBack), { login: u.login, ago: ago(t - prevSeen) }), 1800);
  return u;
}

function onMessage(ws, state, data, ip) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;
  if (!state.u) {
    if (msg.t === 'hello') state.u = onHello(ws, msg, ip);
    return;
  }
  const u = state.u;
  if (sockets.get(u.id) !== ws) return;
  switch (msg.t) {
    case 'ping': return send(ws, { t: 'pong', ts: msg.ts });
    case 'move':
      if (!Number.isInteger(msg.x) || !Number.isInteger(msg.y)) return;
      if (!u.actBucket.take()) return;
      u.lastActive = now();
      return moveTo(u, msg.x, msg.y);
    case 'use': {
      if (!u.actBucket.take()) return;
      u.lastActive = now();
      const f = FURNITURE.find((x) => x.id === msg.fid);
      if (!f) return;
      if (f.seat) return moveTo(u, f.x, f.y);
      if (!f.use) return;
      return walkNextTo(u, f, { use: f.id });
    }
    case 'chat': return onChat(u, msg.text);
    case 'typing': {
      const on = !!msg.on;
      if (on !== u.typing && (!on || u.actBucket.take())) { u.typing = on; broadcast({ t: 'typing', id: u.id, on }, u.id); }
      return;
    }
    case 'emote': {
      if (!u.actBucket.take()) return;
      u.lastActive = now();
      if (msg.e === 'wave') {
        gesture(u, 'wave');
        if (typeof msg.to === 'string') waveAt(u, msg.to, msg.ack === true); // optional: a wave aimed at one person
        return;
      }
      if (msg.e === 'dance') return setPose(u, u.pose === 'dance' ? 'stand' : 'dance');
      if (msg.e === 'sit') return setPose(u, u.pose === 'sit' ? 'stand' : 'sit');
      if (msg.e === 'stand') return setPose(u, 'stand');
      return;
    }
    case 'react': {
      if (!REACTIONS.includes(msg.r) || !u.actBucket.take(3)) return;
      u.lastActive = now();
      return broadcast({ t: 'react', id: u.id, r: msg.r });
    }
    case 'look': {
      if (!u.actBucket.take(2)) return;
      const look = cleanLook(msg.look, u.id);
      u.look = look;
      const p = profiles.data[u.id];
      if (p) { p.look = look; p.customized = true; profiles.save(); }
      return broadcast({ t: 'look', id: u.id, look });
    }
  }
}

function onClose(ws, state) {
  const u = state.u;
  if (!u || sockets.get(u.id) !== ws) return;
  sockets.delete(u.id);
  u.ghost = true;
  u.typing = false;
  const p = profiles.data[u.id];
  if (p) { p.lastSeen = now(); profiles.save(); }
  // a dropped connection (a phone switching networks, a reload) gets 6 s to come back before anyone sees them leave
  u.ghostTimer = setTimeout(() => {
    if (!u.ghost) return;
    users.delete(u.id);
    broadcast({ t: 'leave', id: u.id });
    pushStats();
    console.log(`leave @${u.login} · ${humansOnline()} inside`);
  }, 6000);
  broadcast({ t: 'typing', id: u.id, on: false });
}

// ---------------------------------------------------------------- HTTP
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const fileCache = new Map();
async function serveFile(req, res, filePath) {
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new Error('nope');
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const ext = path.extname(filePath);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ETag: etag,
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (ext === '.html') {
      headers['Content-Security-Policy'] = "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com https://github.com; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'";
      headers['Referrer-Policy'] = 'no-referrer';
    }
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    let buf = fileCache.get(filePath);
    if (!buf || buf.etag !== etag) { buf = { etag, body: await fsp.readFile(filePath) }; fileCache.set(filePath, buf); }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf.body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) { size += c.length; if (size > 4096) throw Object.assign(new Error('too big'), { status: 413 }); chunks.push(c); }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

const PUBLIC = path.join(ROOT, 'public');
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const ip = clientIp(req);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const s = stats();
      return json(res, 200, { online: s.online, contributors: s.contributors, mergedPRs: s.mergedPRs, snapshot: snapshotState });
    }
    if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, PUBLIC_CONFIG);
    if (url.pathname === '/api/fame' && req.method === 'GET') {
      if (!sessionFor(bearer(req))) return json(res, 401, { ok: false });
      const online = new Set([...users.values()].filter((u) => !u.npc && !u.ghost).map((u) => u.id));
      const list = [...contributors.values()].map((c) => {
        const k = c.login.toLowerCase();
        const p = profiles.data[k];
        return { login: c.login, merged: c.merged, first: c.first, last: c.last, visited: !!(p && p.firstSeen && !p.test), online: online.has(k) };
      }).sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login));
      return json(res, 200, { total: totalMergedPRs, list });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const s = sessionFor(bearer(req));
      if (!s) return json(res, 401, { ok: false });
      const p = profiles.data[s.login];
      return json(res, 200, { ok: true, login: p?.login || s.login, merged: mergedFor(s.login), customized: !!p?.customized, look: p?.look || defaultLook(s.login) });
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const tok = bearer(req);
      if (tok) { delete sessions.data[sha(tok)]; sessions.save(); }
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/auth/start' && req.method === 'POST') {
      if (!ipAllow(ip)) return json(res, 429, { ok: false, reason: 'slow-down' });
      const body = await readBody(req);
      const r = await lookupContributor(body.login);
      if (!r.ok) return json(res, r.reason === 'bad-login' ? 400 : r.reason === 'not-contributor' ? 403 : 503, { ok: false, reason: r.reason, login: r.login });
      const key = r.c.login.toLowerCase();
      const prof = profiles.data[key];
      if (prof && prof.banned) return json(res, 403, { ok: false, reason: 'banned' });
      let nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : '';
      let ch = challenges.get(nonce);
      if (!ch || ch.key !== key || now() - ch.created > CHALLENGE_TTL) {
        if (challenges.size >= 5000) pruneChallenges();
        while (challenges.size >= 5000) challenges.delete(challenges.keys().next().value); // oldest first
        nonce = crypto.randomBytes(18).toString('base64url');
        ch = { key, code: newCode(), created: now(), tries: 0 };
        challenges.set(nonce, ch);
      }
      return json(res, 200, { ok: true, login: r.c.login, merged: r.c.merged, first: r.c.first, code: ch.code, nonce });
    }
    if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
      if (!ipAllow(ip)) return json(res, 429, { ok: false, reason: 'slow-down' });
      const body = await readBody(req);
      const login = normLogin(body.login);
      const key = login.toLowerCase();
      const nonce = typeof body.nonce === 'string' ? body.nonce : '';
      const ch = challenges.get(nonce);
      const c = memberFor(key);
      if (!ch || ch.key !== key || !c || now() - ch.created > CHALLENGE_TTL) return json(res, 400, { ok: false, reason: 'no-challenge' });
      if (++ch.tries > 40) return json(res, 429, { ok: false, reason: 'too-many-tries' });
      const ok = await gistHasCode(c.login, ch.code, ch.created, ch.tries % 4 === 0);
      if (!ok) return json(res, 200, { ok: false, reason: 'not-found-yet' });
      challenges.delete(nonce);
      // last check against GitHub itself: if this name no longer has merged PRs (say the account was
      // renamed and someone else took the old name), it doesn't get in. If GitHub is busy, let them in.
      const live = ALLOW.has(key) ? null : await liveMerged(c.login);
      if (live && live.count < MIN_PRS) return json(res, 403, { ok: false, reason: 'not-contributor' });
      if (live && live.count !== c.merged) {
        c.merged = live.count;
        if (live.last) c.last = live.last;
        if (extraContrib.data[key]) extraContrib.save();
      }
      ensureProfile(key, c.login);
      if (profiles.data[key].banned) return json(res, 403, { ok: false, reason: 'banned' });
      const token = createSession(key);
      return json(res, 200, { ok: true, token, login: c.login, merged: c.merged });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { ok: false });

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (url.pathname === '/shared/world.js') return serveFile(req, res, path.join(ROOT, 'shared', 'world.js'));
    if (url.pathname === '/shared/config.js') return serveFile(req, res, path.join(ROOT, 'shared', 'config.js'));
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.normalize(path.join(PUBLIC, rel));
    if (!full.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    if (!path.extname(full)) return serveFile(req, res, path.join(PUBLIC, 'index.html'));
    return serveFile(req, res, full);
  } catch (e) {
    if (e && e.status === 413) { if (!res.headersSent) json(res, 413, { ok: false }); return; }
    if (e && e.code === 'ERR_INVALID_URL') { if (!res.headersSent) { res.writeHead(400); res.end(); } return; }
    console.error('http error', e && e.message);
    if (!res.headersSent) json(res, 500, { ok: false });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
const perIp = new Map();
server.on('upgrade', (req, socket, head) => {
  try {
    socket.on('error', () => {});
    const pathname = String(req.url || '').split('?')[0];
    if (pathname !== '/ws') return socket.destroy();
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= (isSharedIp(ip) ? 400 : 12)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      perIp.set(ip, (perIp.get(ip) || 0) + 1);
      const state = { u: null, alive: true };
      ws.on('pong', () => { state.alive = true; });
      ws.on('message', (data) => {
        state.alive = true;
        try { onMessage(ws, state, data, ip); } catch (e) { console.error('ws message error', e && e.message); }
      });
      ws.on('close', () => {
        const n = (perIp.get(ip) || 1) - 1;
        if (n > 0) perIp.set(ip, n); else perIp.delete(ip);
        try { onClose(ws, state); } catch (e) { console.error('ws close error', e && e.message); }
      });
      ws.on('error', () => {});
      ws._state = state;
      setTimeout(() => { if (!state.u && ws.readyState === 1) ws.close(4000, 'hello timeout'); }, 15000);
    });
  } catch (e) {
    console.error('upgrade error', e && e.message);
    socket.destroy();
  }
});
setInterval(() => {
  for (const ws of wss.clients) {
    const st = ws._state;
    if (!st) continue;
    if (!st.alive) { ws.terminate(); continue; }
    st.alive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 25000).unref();

function shutdown() {
  for (const s of [profiles, sessions, chatStore, extraContrib, daily]) { try { s.flush(); } catch { /* ignore */ } }
  try { snapshotChild?.kill(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// last line of defence: log it and keep the room up rather than drop everyone (and unsaved state)
process.on('uncaughtException', (e) => {
  console.error('uncaught', e && e.stack || e);
  if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) process.exit(1);
});
process.on('unhandledRejection', (e) => console.error('unhandled rejection', e && e.stack || e));

server.listen(PORT, () => {
  console.log(`merge lounge on :${PORT} · ${REPO} · ${contributors.size} contributors (snapshot ${snapshotState}) · room ${W}x${H} · step ${STEP_MS}ms`);
});
