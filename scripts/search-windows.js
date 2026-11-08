// Collect every result of a date-ranged GitHub search without running into its cap.
// GitHub search returns at most 1,000 results per query, so any window that reports more than that
// is cut in half (and those halves again) until every piece fits. No network code here: the caller
// passes `search(fromMs, toMs, page)` → { total, items }, which keeps this easy to test.

export const PER_PAGE = 100;
export const SEARCH_CAP = 1000;

// Windows are half-open [from, to) in milliseconds, cut on whole seconds.
export function halve(from, to) {
  const mid = Math.floor((from + to) / 2 / 1000) * 1000;
  return mid > from && mid < to ? mid : null;
}

export async function collectWindows(search, from, to, { cap = SEARCH_CAP, perPage = PER_PAGE, onWindow } = {}) {
  const items = [];
  const windows = [];
  async function walk(a, b, depth) {
    const first = await search(a, b, 1);
    const mid = first.total > cap ? halve(a, b) : null;
    if (mid !== null) {
      await walk(a, mid, depth + 1);
      await walk(mid, b, depth + 1);
      return;
    }
    const got = [...first.items];
    const want = Math.min(first.total, cap);
    let last = first.items.length;
    for (let page = 2; got.length < want && last >= perPage && page <= Math.ceil(cap / perPage); page++) {
      const r = await search(a, b, page);
      got.push(...r.items);
      last = r.items.length;
    }
    const w = { from: a, to: b, depth, total: first.total, got: got.length, truncated: got.length < first.total };
    windows.push(w);
    onWindow?.(w);
    items.push(...got);
  }
  await walk(from, to, 0);
  return { items, windows };
}
