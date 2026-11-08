// The date-window splitter behind scripts/fetch-contributors.js, driven by a fake search (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectWindows, halve } from '../scripts/search-windows.js';

const DAY = 86400_000;
const T0 = Date.UTC(2025, 0, 1);

// A fake GitHub search over PRs with merge times. Like the real one: total_count is the full count,
// pages hold 100 items, and nothing past the 1,000th result is ever returned.
function fakeSearch(times) {
  const calls = [];
  const search = async (from, to, page) => {
    calls.push({ from, to, page });
    assert.ok(page >= 1 && page <= 10, `page ${page} is past the search cap`);
    const hits = times.map((t, i) => ({ number: i + 1, t })).filter((x) => x.t >= from && x.t < to);
    return { total: hits.length, items: hits.slice((page - 1) * 100, page * 100).slice(0, Math.max(0, 1000 - (page - 1) * 100)) };
  };
  return { search, calls };
}
const spread = (n, from, span) => Array.from({ length: n }, (_, i) => from + Math.floor((i * span) / n));

test('a window under the cap is paged through, not split', async () => {
  const { search, calls } = fakeSearch(spread(250, T0, 100 * DAY));
  const { items, windows } = await collectWindows(search, T0, T0 + 200 * DAY);
  assert.equal(items.length, 250);
  assert.equal(windows.length, 1);
  assert.deepEqual(calls.map((c) => c.page), [1, 2, 3]);
});

test('a window over 1,000 results is cut in half until every piece fits', async () => {
  const times = [...spread(2600, T0, 30 * DAY), ...spread(400, T0 + 100 * DAY, 50 * DAY)];
  const { search, calls } = fakeSearch(times);
  const { items, windows } = await collectWindows(search, T0, T0 + 365 * DAY);
  const numbers = new Set(items.map((x) => x.number));
  assert.equal(numbers.size, 3000, 'every PR is collected exactly once');
  assert.equal(items.length, 3000, 'windows do not overlap');
  for (const w of windows) assert.ok(w.total <= 1000 && !w.truncated, `window ${w.from}..${w.to} has ${w.total}`);
  // the first call covered the whole range and saw too many, so the next call is its first half
  assert.equal(calls[0].from, T0);
  assert.equal(calls[0].to, T0 + 365 * DAY);
  assert.equal(calls[1].from, T0);
  assert.equal(calls[1].to, halve(T0, T0 + 365 * DAY));
  assert.ok(windows.some((w) => w.depth >= 3), 'the dense month needed several halvings');
  // windows tile the range with no gaps
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  assert.equal(sorted[0].from, T0);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i].from, sorted[i - 1].to);
  assert.equal(sorted[sorted.length - 1].to, T0 + 365 * DAY);
});

test('halves land on whole seconds inside the window', () => {
  const mid = halve(T0, T0 + 7 * DAY + 1234);
  assert.equal(mid % 1000, 0);
  assert.ok(mid > T0 && mid < T0 + 7 * DAY + 1234);
  assert.equal(halve(T0, T0 + 1000), null, 'a one-second window cannot be split');
});

test('more than 1,000 PRs in the same second: stops splitting and reports the shortfall', async () => {
  const { search } = fakeSearch(Array.from({ length: 1500 }, () => T0 + 5 * DAY));
  const seen = [];
  const { items, windows } = await collectWindows(search, T0, T0 + 10 * DAY, { onWindow: (w) => seen.push(w) });
  assert.equal(items.length, 1000);
  assert.ok(windows.some((w) => w.truncated && w.total === 1500));
  assert.equal(seen.length, windows.length);
});

test('an empty repo is one call', async () => {
  const { search, calls } = fakeSearch([]);
  const { items } = await collectWindows(search, T0, T0 + DAY);
  assert.equal(items.length, 0);
  assert.equal(calls.length, 1);
});
