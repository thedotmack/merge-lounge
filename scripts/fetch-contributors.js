// Build the contributor snapshot: everyone with a merged PR in the repo (bots left out), written to
// STATE_DIR/contributors.json with the repo it belongs to. The server runs this by itself when it has
// no snapshot for its repo, and again once a day.
//
// Usage: node scripts/fetch-contributors.js [--repo owner/name] [--out path/to/contributors.json]
//   --repo  defaults to REPO, then lounge.config.json (or CONFIG_PATH)
//   --out   defaults to $STATE_DIR/contributors.json (STATE_DIR defaults to ./state)
// Set GITHUB_TOKEN to go about three times faster (search allows 10 requests a minute without one, 30 with).
// OFFLINE=1 makes it exit at once without calling GitHub (the tests use this).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../shared/config.js';
import { collectWindows, PER_PAGE } from './search-windows.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return '';
  const v = process.argv[i + 1];
  if (!v || v.startsWith('--')) { console.error(`${name} needs a value`); process.exit(2); }
  return v;
}
function configRepo() {
  const file = process.env.CONFIG_PATH || path.join(ROOT, 'lounge.config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  try { return resolveConfig(raw, process.env, { requireRepo: true }).config.repo; } catch { return ''; }
}

if (process.env.OFFLINE === '1') {
  console.error('OFFLINE=1 is set, so no GitHub calls: nothing built');
  process.exit(1);
}
// Started by the server: stop if the server goes away (a hard kill would otherwise leave this running).
const PARENT = Number(process.env.LOUNGE_PARENT_PID) || 0;
if (PARENT) setInterval(() => { if (process.ppid !== PARENT) { console.error('the server stopped, so the rebuild stops too'); process.exit(1); } }, 2000).unref();

const REPO = arg('--repo') || configRepo();
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(REPO)) {
  console.error(`no usable repo ("${REPO}"): pass --repo owner/name or set repo in lounge.config.json`);
  process.exit(2);
}
const OUT = path.resolve(arg('--out') || path.join(process.env.STATE_DIR || path.join(ROOT, 'state'), 'contributors.json'));
const TOKEN = process.env.GITHUB_TOKEN || '';
// Search allows 30 requests a minute with a token and 10 without. Staying near 8 (or 24) leaves room
// for the server's own live check-in lookups while a build runs.
const PAUSE = TOKEN ? 2500 : 7500;
const headers = {
  'User-Agent': `merge-lounge (${REPO} contributor lounge)`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

// One paced GET with retries: 403/429 wait for the rate limit to reset, network errors back off.
let lastCall = 0;
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + PAUSE - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt >= 6) throw new Error(`GitHub unreachable: ${e.cause?.code || e.message}`);
      console.log(`network error (${e.cause?.code || e.message}), retrying in ${attempt * 10}s`);
      await sleep(attempt * 10_000);
      continue;
    }
    const limited = res.status === 429 || (res.status === 403 && (res.headers.get('retry-after') || res.headers.get('x-ratelimit-remaining') === '0'
      || /rate limit/i.test(await res.clone().text().catch(() => ''))));
    if (limited && attempt < 6) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
      const ms = Math.min(120_000, Math.max(5_000, retryAfter || (reset > 0 ? reset + 1000 : 20_000)));
      console.log(`GitHub said ${res.status}, waiting ${Math.round(ms / 1000)}s`);
      await sleep(ms);
      continue;
    }
    return res;
  }
}

// Where to start looking: when the repo was created. If the repo endpoint can't be read, the oldest
// merged PR tells us just as well.
async function startOf() {
  const res = await get(`https://api.github.com/repos/${REPO}`);
  if (res.ok) {
    const j = await res.json();
    if (j.created_at) return Date.parse(j.created_at);
  }
  if (res.status === 404) throw new Error(`${REPO} not found (or private)`);
  if (res.status === 401) throw new Error('GitHub 401: GITHUB_TOKEN is not valid (remove it or make a new one)');
  const q = encodeURIComponent(`repo:${REPO} is:pr is:merged`);
  const r = await get(`https://api.github.com/search/issues?q=${q}&sort=created&order=asc&per_page=1`);
  if (!r.ok) throw new Error(`GitHub ${r.status} reading ${REPO}`);
  const j = await r.json();
  const first = j.items?.[0]?.created_at;
  console.log(`repo details not readable (${res.status}); starting from the oldest merged PR`);
  return first ? Date.parse(first) : Date.now();
}

async function search(from, to, page) {
  const q = `repo:${REPO} is:pr is:merged merged:${isoSec(from)}..${isoSec(to - 1000)}`;
  const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}&page=${page}`;
  // incomplete_results: GitHub's search timed out and the count may be short, which could hide a window
  // that needs splitting. Ask again with a growing pause; if it never completes, fail (the server keeps
  // the list it has) rather than write a list with people missing.
  for (let tries = 0; ; tries++) {
    const res = await get(url);
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${q}`);
    const j = await res.json();
    if (j.incomplete_results) {
      if (tries >= 3) throw new Error(`GitHub kept returning partial results for ${q}`);
      console.log(`search timed out on GitHub's side, asking again in ${(tries + 1) * 15}s`);
      await sleep((tries + 1) * 15_000);
      continue;
    }
    return { total: Number(j.total_count) || 0, items: Array.isArray(j.items) ? j.items : [] };
  }
}

async function main() {
  const t0 = Date.now();
  const start = Math.floor((await startOf()) / 1000) * 1000;
  const end = Math.ceil((Date.now() + 86400_000) / 1000) * 1000;
  console.log(`${REPO}: merged PRs from ${isoSec(start).slice(0, 10)} → ${OUT}`);
  const { items, windows } = await collectWindows(search, start, end, {
    onWindow: (w) => console.log(`${isoSec(w.from).slice(0, 10)}..${isoSec(w.to - 1000).slice(0, 10)}: ${w.got}/${w.total} PRs${w.truncated ? ' (window could not be split further; some PRs missed)' : ''}`),
  });
  const prs = new Map();
  for (const it of items) if (it && Number.isInteger(it.number)) prs.set(it.number, it);
  const by = new Map();
  for (const it of prs.values()) {
    // bots don't get a seat, nor does "ghost", GitHub's stand-in for deleted accounts (their PRs still count in the total)
    if (!it.user || it.user.type !== 'User' || String(it.user.login).toLowerCase() === 'ghost') continue;
    const login = it.user.login;
    const at = (it.pull_request && it.pull_request.merged_at) || it.closed_at || '';
    const c = by.get(login) || { login, merged: 0, first: at, last: at };
    c.merged++;
    if (at < c.first) c.first = at;
    if (at > c.last) c.last = at;
    by.set(login, c);
  }
  const contributors = [...by.values()]
    .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login))
    .map((c) => ({ login: c.login, merged: c.merged, first: c.first.slice(0, 10), last: c.last.slice(0, 10) }));
  const out = { repo: REPO, generated: new Date().toISOString(), total_merged_prs: prs.size, contributors };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.${process.pid}.tmp`; // the server's rebuild and a manual run never share a temp file
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, OUT);
  console.log(`done: ${prs.size} merged PRs, ${contributors.length} contributors, ${windows.length} search window${windows.length === 1 ? '' : 's'}, ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch((e) => { console.error(`failed: ${e.message}`); process.exit(1); });
