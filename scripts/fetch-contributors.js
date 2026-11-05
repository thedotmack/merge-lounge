// Rebuild data/contributors.json: everyone with a merged PR in the repo (bots excluded).
// Uses the public GitHub search API (10 requests/minute without a token), so it paces itself.
// Usage: node scripts/fetch-contributors.js   (set GITHUB_TOKEN to go faster)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.REPO || 'thedotmack/claude-mem';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'contributors.json');
const headers = { 'User-Agent': 'merge-lounge', Accept: 'application/vnd.github+json' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const pause = process.env.GITHUB_TOKEN ? 2200 : 6500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);

async function search(q) {
  const items = [];
  let total = 0;
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
    let res;
    for (let attempt = 0; attempt < 6; attempt++) {
      res = await fetch(url, { headers });
      if (res.status === 403 || res.status === 429) { await sleep(20000); continue; }
      break;
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${q}`);
    const j = await res.json();
    total = j.total_count;
    items.push(...j.items);
    await sleep(pause);
    if (j.items.length < 100 || items.length >= total) break;
  }
  return { total, items };
}

const start = new Date(Date.UTC(2025, 7, 1));
const end = new Date(Date.now() + 86400000);
const prs = new Map();
for (let d = new Date(start); d < end;) {
  const mid = new Date(d.getTime() + 14 * 86400000);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  for (const [a, b] of [[d, mid], [mid, next]]) {
    const last = new Date(b.getTime() - 86400000);
    const { total, items } = await search(`repo:${REPO} is:pr is:merged created:${iso(a)}..${iso(last)}`);
    for (const it of items) prs.set(it.number, it);
    console.log(iso(a), total, items.length);
  }
  d = next;
}
const by = new Map();
for (const it of prs.values()) {
  if (it.user.type !== 'User') continue;
  const login = it.user.login;
  const at = (it.pull_request && it.pull_request.merged_at) || it.closed_at;
  const c = by.get(login) || { login, merged: 0, first: at, last: at };
  c.merged++;
  if (at < c.first) c.first = at;
  if (at > c.last) c.last = at;
  by.set(login, c);
}
const contributors = [...by.values()]
  .sort((a, b) => b.merged - a.merged || a.login.localeCompare(b.login))
  .map((c) => ({ login: c.login, merged: c.merged, first: c.first.slice(0, 10), last: c.last.slice(0, 10) }));
const out = { generated: new Date().toISOString(), total_merged_prs: prs.size, contributors };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT + '.tmp', JSON.stringify(out));
fs.renameSync(OUT + '.tmp', OUT);
console.log(`done: ${prs.size} merged PRs, ${contributors.length} contributors`);
