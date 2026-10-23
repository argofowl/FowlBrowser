// read_all's reader: the merge of each view into the list read so far, the read loop against a simulated list (on a
// virtual clock: lazy loads with and without a spinner, a virtual window of rows, a page that scrolls itself back, a
// load-more button, an endless feed, a spinner that never stops), the expander names it clicks, and the result text.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { EXPAND_ALLOW, EXPAND_DENY, expandable, fit, grew, layout, merge, newState, READER_FN, readAll, readList, similar, viewItems } from '../src/reader.mjs';

// --- merge ---

let nodes = 0;
const row = (text, { node = ++nodes, key = null } = {}) => ({ text, key, node });
const texts = (list) => list.map((i) => (i.gap ? '[gap]' : i.text));
// Reads `page` (an array of texts) through views [from, to) in order, each with fresh nodes unless kept.
function readViews(page, windows, { keys = false, keepNodes = false, toward = -1 } = {}) {
  const ids = page.map(() => ++nodes);
  let list = [];
  for (const [from, to] of windows) {
    const view = page.slice(from, to).map((text, k) => row(text, { node: keepNodes ? ids[from + k] : undefined, key: keys ? `data-key=k${from + k}` : null }));
    const r = merge(list, view, { toward, force: true });
    list = r.list;
  }
  return list;
}

test('merge: a view overlapping the end of the list adds what follows', () => {
  const list = ['a', 'b', 'c', 'd'].map((t) => row(t));
  const view = [list[2], list[3]].map((i) => row(i.text, { node: i.node })).concat([row('e'), row('f')]);
  const r = merge(list, view);
  assert.deepEqual(texts(r.list), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(r.added, 2);
  assert.equal(r.first, 2);
  assert.equal(r.last, 5);
});

test('merge: scrolling up prepends older items, also when every row is a new node (text overlap)', () => {
  const page = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10'];
  assert.deepEqual(texts(readViews(page, [[6, 10], [3, 7], [0, 4]], { keepNodes: true })), page);
  assert.deepEqual(texts(readViews(page, [[6, 10], [3, 8], [0, 5]])), page);
  assert.deepEqual(texts(readViews(page, [[0, 4], [2, 7], [5, 10]], { toward: 1 })), page);
  // One short item in common is no overlap: a gap.
  assert.deepEqual(texts(readViews(page, [[6, 10], [3, 7]])), ['m04', 'm05', 'm06', 'm07', '[gap]', 'm07', 'm08', 'm09', 'm10']);
});

test('merge: duplicate-looking items in a row and apart stay as many as the page has', () => {
  const page = ['Yesterday 10:46 PM', 'ok', 'ok', 'ok', 'm1 hello', 'ok', '❤️', 'm2 there', 'Yesterday 10:46 PM', '❤️', 'ok', 'ok', 'm3 end'];
  for (const keepNodes of [true, false]) {
    for (const windows of [[[8, 13], [5, 10], [2, 7], [0, 4]], [[9, 13], [6, 11], [3, 8], [0, 5]], [[7, 13], [3, 9], [0, 5]]]) {
      assert.deepEqual(texts(readViews(page, windows, { keepNodes })), page, JSON.stringify({ keepNodes, windows }));
    }
    assert.deepEqual(texts(readViews(page, [[0, 5], [3, 8], [6, 11], [9, 13]], { keepNodes, toward: 1 })), page);
  }
  // Re-reading known territory changes nothing.
  const list = readViews(page, [[8, 13], [4, 9], [0, 5]], { keepNodes: true });
  const again = merge(list, list.slice(2, 7).map((i) => ({ ...i })));
  assert.deepEqual(texts(again.list), page);
  assert.equal(again.added, 0);
});

test('merge: a recycled row (same node, new text) is no anchor', () => {
  const list = [row('a', { node: 1 }), row('b', { node: 2 }), row('c', { node: 3 }), row('d', { node: 4 })];
  // The pool's nodes now show later items: node 1 holds c, node 2 holds d.
  const view = [row('c', { node: 1 }), row('d', { node: 2 }), row('e', { node: 3 }), row('f', { node: 4 })];
  const r = merge(list, view, { toward: 1 });
  assert.deepEqual(texts(r.list), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('merge: keyed rows whose nodes and data-index change are matched by key', () => {
  const page = Array.from({ length: 12 }, (_, i) => `msg ${i}`);
  assert.deepEqual(texts(readViews(page, [[8, 12], [5, 9], [2, 6], [0, 3]], { keys: true })), page);
  // A key that repeats within one view (a user id) is not an item's own: it is dropped for the rest of the read.
  const bad = new Set();
  const items = viewItems([{ text: 'a', key: 'data-user-id=7', node: 1 }, { text: 'b', key: 'data-user-id=7', node: 2 }, { text: 'c', key: 'data-key=c', node: 3 }], bad);
  assert.deepEqual(items.map((i) => i.key), [null, null, 'data-key=c']);
  assert.ok(bad.has('data-user-id'));
  const list = [row('old', { key: 'data-user-id=7' })];
  assert.equal(merge(list, [row('new', { key: 'data-user-id=7' })], { bad, toward: 1, force: true }).gap, true, 'no anchor through a bad key');
});

test('merge: an expanded item is updated in place', () => {
  const collapsed = 'Alice\nOct 3\nHi there, just wanted to follow up…';
  const expanded = 'Alice\n<alice@example.com>\nOct 3, 2026, 10:00 AM\nto me\nHi there, just wanted to follow up on the order we discussed.\nThanks, Alice';
  // Keyed.
  let list = [row('Bob\nOct 1\nfirst', { key: 'data-key=1' }), row(collapsed, { key: 'data-key=2' }), row('Carol\nOct 5\nlast', { key: 'data-key=3' })];
  let r = merge(list, [row(list[0].text, { key: 'data-key=1' }), row(expanded, { key: 'data-key=2' }), row(list[2].text, { key: 'data-key=3' })]);
  assert.deepEqual(texts(r.list), [list[0].text, expanded, list[2].text]);
  assert.equal(r.updated, 1);
  // No keys, same nodes around it: the run between two anchors is updated one for one.
  list = [row('Bob\nOct 1\nfirst'), row(collapsed), row('Carol\nOct 5\nlast')];
  r = merge(list, [row(list[0].text, { node: list[0].node }), row(expanded), row(list[2].text, { node: list[2].node })]);
  assert.deepEqual(texts(r.list), [list[0].text, expanded, list[2].text]);
  assert.equal(r.added, 0);
  // At the view's edge, the expanded one is matched by its lines (not taken for a new item).
  r = merge(list, [row(expanded), row(list[2].text, { node: list[2].node })], { toward: -1 });
  assert.deepEqual(texts(r.list), [list[0].text, expanded, list[2].text]);
  // "Expand all": every row changes at once (collapsed, then loading, then open), on the same nodes, no keys.
  const rows = [['Bob Ito', 'Oct 1, 2026, 9:00 AM', 'Shipping is on the way for your order'], ['Alice Wu', 'Oct 3, 2026, 10:00 AM', 'Hi there, just wanted to follow up'],
    ['Carol Diaz', 'Oct 5, 2026, 4:12 PM', 'Thanks, all good on my side then']];
  list = rows.map(([from, date, body]) => row(`${from}\n${body}…\n${date}`));
  const loading = rows.map(([from, date], k) => row(`${from} <${from.split(' ')[0].toLowerCase()}@example.com>\nto me\n${date}\nLoading…`, { node: list[k].node }));
  // Merge alone takes no node whose text changed for the same item: that comes through the click's owner (readList's
  // look), or a run between two anchors.
  assert.equal(merge(list, loading).gap, true);
  list.forEach((item, k) => { item.text = loading[k].text; });
  r = merge(list, loading);
  assert.deepEqual(texts(r.list), texts(loading));
  assert.equal(r.added, 0);
  assert.ok(similar(collapsed, expanded));
  assert.ok(!similar('Alice\nOct 3\nHi there, just wanted to follow up…', 'Alice\nOct 4\nSomething else entirely, a new message'));
});

test('merge: a message the page grew in place (a late line, no click) keeps its node anchor', () => {
  const head = 'Argo Fowl <argo@example.com>\nFri, 26 Jan 2024, 15:13\nAdd reaction\nReply';
  const old = `${head}\nHi all, the long letter starts here and goes on for a while.\nSecond paragraph of it.`;
  const now = `${head}\nHi all, the long letter starts here and goes on for a while.\nArgo · sent from my phone\nSecond paragraph of it.`;
  assert.ok(grew(old, now));
  // A tall message at the top edge, the next one below it on the same node with the same text: no text overlap.
  const list = [row(old, { node: 2 }), row('Rhea Lindqvist <rhea.l@example.com>\nSat, 27 Jan\nThanks!', { node: 3 })];
  const r = merge(list, [row(now, { node: 2 }), row(list[1].text, { node: 3 })], { toward: -1, force: true });
  assert.deepEqual(texts(r.list), [now, list[1].text]);
  assert.deepEqual([r.added, r.updated, r.stale, r.gap], [0, 1, 0, false]);
  // Grown text alone, with no neighbour that is an exact anchor, anchors nothing.
  assert.equal(merge([row(old, { node: 2 }), row(list[1].text, { node: 3 })], [row(now, { node: 2 })], { toward: -1 }).gap, true);
  // Another message on a recycled node is not grown: one of its old lines is missing, or its first two lines differ.
  assert.ok(!grew('Alice Smith\n10:00 AM\nMessage 0', 'Alice Smith\n10:00 AM\nMessage 6'));
  assert.ok(!grew('Alice Smith\n10:00 AM\nok', 'Alice Smith\n10:00 AM\nlol'));
  assert.ok(!grew(old, `Rhea Lindqvist <rhea.l@example.com>\nSat, 27 Jan\n${old}`));
});

test('merge: a leftover old row and a leftover view row from the same sender and time are two messages, not one updated', () => {
  const [m3, m4, x] = ['Alice Smith\n10:00 AM\nMessage 3', 'Alice Smith\n10:00 AM\nMessage 4', 'Bob Ito\n9:00 AM\nhello there'];
  assert.ok(similar(m3, m4) && !grew(m3, m4));
  // A pooled node showed m3 and now shows m4, next to an anchor: below it (trail) and above it (lead).
  for (const [list, view, toward] of [[[row(x, { node: 9 }), row(m3, { node: 1 })], [row(x, { node: 9 }), row(m4, { node: 1 })], 1],
    [[row(m3, { node: 1 }), row(x, { node: 9 })], [row(m4, { node: 1 }), row(x, { node: 9 })], -1]]) {
    const r = merge(list, view, { toward });
    assert.deepEqual([...texts(r.list)].sort(), [m3, m4, x].sort(), `toward ${toward}`);
    assert.equal(r.updated, 0, `toward ${toward}`);
    assert.equal(r.stale, 1, `toward ${toward}: the old row is flagged`);
  }
});

test('merge: rows revealed between known ones go in between', () => {
  const list = [row('m1 first', { key: 'data-key=1' }), row('m15', { key: 'data-key=15' }), row('m16', { key: 'data-key=16' })];
  const middle = Array.from({ length: 13 }, (_, i) => row(`m${i + 2}`, { key: `data-key=${i + 2}` }));
  const r = merge(list, [row('m1 first', { key: 'data-key=1' }), ...middle, row('m15', { key: 'data-key=15' })]);
  assert.deepEqual(texts(r.list), ['m1 first', ...middle.map((i) => i.text), 'm15', 'm16']);
});

test('merge: no overlap is a gap, kept with a marker at the end it moved toward', () => {
  const list = [row('a'), row('b'), row('c')];
  const view = [row('x'), row('y')];
  assert.equal(merge(list, view, { toward: -1 }).gap, true);
  assert.deepEqual(texts(merge(list, view, { toward: -1, force: true }).list), ['x', 'y', '[gap]', 'a', 'b', 'c']);
  assert.deepEqual(texts(merge(list, view, { toward: 1, force: true }).list), ['a', 'b', 'c', '[gap]', 'x', 'y']);
  // One long item is enough overlap.
  const long = 'a message long enough to be its own anchor, over forty chars';
  assert.deepEqual(texts(merge([row('p'), row(long)], [row(long), row('q')], { toward: 1 }).list), ['p', long, 'q']);
  // The view later shows what lies between: the gap closes.
  const gapped = merge(list, view, { toward: 1, force: true }).list;
  const bridge = [gapped[2], gapped[4]].map((i) => row(i.text, { node: i.node }));
  const closed = merge(gapped, [bridge[0], row('c2'), bridge[1]]);
  assert.deepEqual(texts(closed.list), ['a', 'b', 'c', 'c2', 'x', 'y']);
});

// --- The loop, against a simulated list ---

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The truth: messages with unique tokens, plus duplicate-looking rows (byte-identical) in a row and apart, and repeated
// date separators.
function thread(n, rand) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const r = rand();
    const text = r < 0.08 ? 'ok' : r < 0.12 ? '❤️' : r < 0.16 ? 'Yesterday 10:46 PM' : `m${String(i).padStart(3, '0')} ${'word '.repeat(1 + Math.floor(rand() * 12)).trim()}`;
    out.push({ text, key: `k${out.length}` });
    if (text === 'ok' && rand() < 0.5) out.push({ text: 'ok', key: `k${out.length}` });
  }
  return out.slice(0, n);
}

// A box `page` px tall over rows 40-120 px tall. Loaded rows are [lo, hi); reverse lists load `batch` older rows when
// within 400 px of the top (keeping the visible rows still), forward ones newer rows near the bottom (or on a "Load more"
// click); each load takes a random delay, showing a spinner unless silent. virtual: only rows within `overscan` rows of
// the view are mounted, each mount a new node (recycle: a pool whose nodes take whatever row sits in their slot).
// snapback: 'script' puts back a scroll that came by script 25 ms later, 'all' every scroll.
// text(i): the rows' texts instead of thread's; pool: how many nodes a recycled pool has; late: the newest rows of a
// reverse list arrive only when arrive() is called; middle: an expander in every `every`th row ({ name, item, works:
// its click finds a point, stays: it is still there after its click, grows: its click adds a line to its row, disabled
// }); expandAll: an "Expand all" in view opens every one of those; pending: a load in flight counts as one the read
// started (the real driver's request tracking).
function sim({ n = 60, seed = 1, batch = 15, delay = [200, 2500], spinner = true, reverse = true, virtual = true, overscan = 2, keys = true, recycle = false,
  snapback = null, loadMore = false, endless = false, stall = false, page = 600, text = null, pool = 16, late = 0, middle = null, expandAll = false } = {}) {
  const rand = mulberry32(seed);
  const truth = text ? Array.from({ length: n }, (_, i) => ({ text: text(i), key: `k${i}` })) : thread(endless ? 10_000 : n, rand);
  const heights = truth.map(() => 40 + Math.floor(rand() * 80));
  let t = 0, lo = reverse ? Math.max(0, n - late - batch) : 0, hi = reverse ? n - late : Math.min(n, batch), at = 0;
  const opened = new Set(), grown = new Set();
  let loading = null;
  const events = [];
  const mounted = new Map(); // row index -> node
  let nextNode = 1;
  const top = (i) => heights.slice(lo, i).reduce((a, b) => a + b, 0);
  const height = () => top(hi) + (loadMore && hi < n ? 40 : 0);
  const max = () => Math.max(0, height() - page);
  const clamp = () => { at = Math.min(Math.max(at, 0), max()); };
  const later = (ms, fn) => { events.push({ at: t + ms, fn }); events.sort((a, b) => a.at - b.at); };
  const load = (older) => {
    if (loading) return;
    loading = { spinner };
    if (stall) return;
    later(delay[0] + Math.floor(rand() * (delay[1] - delay[0])), () => {
      loading = null;
      if (older) {
        const from = Math.max(0, lo - batch);
        at += heights.slice(from, lo).reduce((a, b) => a + b, 0);
        lo = from;
      } else hi = endless ? hi + batch : Math.min(n, hi + batch);
      check();
    });
  };
  const check = () => {
    if (reverse && lo > 0 && at < 400) load(true);
    if (!reverse && !loadMore && (endless || hi < n) && at > max() - 400) load(false);
  };
  const advance = (ms) => {
    const end = t + ms;
    while (events.length && events[0].at <= end) {
      const e = events.shift();
      t = e.at;
      e.fn();
    }
    t = end;
  };
  const scrolled = (dy, byScript) => {
    const start = at;
    at += dy;
    clamp();
    if (snapback === 'all' || (snapback === 'script' && byScript)) later(25, () => { at = max(); });
    check();
    return { moved: at - start, at, max: max() };
  };
  at = reverse ? max() : 0;
  const driver = {
    now: () => t,
    sleep: async (ms) => advance(ms),
    async view() {
      const items = [], expanders = [];
      const near = (i) => !virtual || (top(i + 1) >= at - overscan * 80 && top(i) <= at + page + overscan * 80);
      for (const i of [...mounted.keys()]) if (i < lo || i >= hi || !near(i)) mounted.delete(i);
      let slot = 0;
      for (let i = lo; i < hi; i++) {
        if (!near(i)) continue;
        if (!mounted.has(i)) mounted.set(i, nextNode++);
        const node = recycle ? 10_000 + (slot++ % pool) : mounted.get(i);
        const it = { text: truth[i].text + (grown.has(i) ? '\n(trimmed content shown)' : ''), key: keys ? `data-key=${truth[i].key}` : null, node, top: top(i) - at, bottom: top(i + 1) - at };
        items.push(it);
        if (middle && !(i % middle.every) && !opened.has(i)) {
          expanders.push({ id: 50_000 + i, name: middle.name ?? 'View 1 reply', item: !!middle.item, edge: 'middle', seen: it.top >= 0 && it.bottom <= page, top: it.top,
            bottom: it.bottom, owner: node, disabled: !!middle.disabled });
        }
      }
      if (expandAll && !opened.has('all')) expanders.push({ id: 2, name: 'Expand all', edge: 'middle', item: false, seen: true, top: 0, bottom: 20 });
      if (loadMore && hi < n && height() - at <= page + 40) {
        expanders.push({ id: 1, name: 'Load more comments', edge: 'end', item: false, seen: true, top: height() - at - 40, bottom: height() - at });
      }
      return { items, at, max: max(), page, height: height(), vtop: 0, vbottom: page, busy: !!loading?.spinner, expanders };
    },
    async probe() {
      const v = await driver.view();
      return { at: v.at, max: v.max, height: v.height, busy: v.busy, pending: driver.pending(), sig: `${lo} ${hi} ${v.items.length}` };
    },
    pending: () => !!loading,
    async wheel(dy) {
      advance(50);
      return scrolled(dy, false);
    },
    async scrollBy(dy) {
      return scrolled(dy, true);
    },
    async settle(ms) {
      const end = t + ms;
      advance(300);
      while (loading && t < end) advance(100);
      return { busy: !!loading?.spinner };
    },
    async click(e) {
      if (e.name === 'Load more comments') load(false);
      if (e.name === 'Expand all') for (const i of ['all', ...truth.keys()]) opened.add(i);
      if (e.id >= 50_000) {
        if (middle.works === false) return false;
        if (!middle.stays) opened.add(e.id - 50_000);
        if (middle.grows) grown.add(e.id - 50_000);
      }
      return true;
    },
  };
  const arrive = () => { hi = n; };
  return { driver, arrive, truth: truth.slice(0, endless ? Infinity : n), state: () => ({ lo, hi, at }) };
}

const read = async (list, opts = {}, state = newState()) => {
  const s = await readList(list.driver, state, opts);
  return { s, items: s.list.filter((i) => !i.gap).map((i) => i.text), result: layout(s, { what: 'the list', direction: opts.direction ?? 'both' }).lines.join('\n') };
};

test('read: a reverse infinite list with random 200-2500 ms loads and a spinner, virtualized, is read whole', async () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const list = sim({ n: 90, seed });
    const { items, result } = await read(list);
    assert.deepEqual(items, list.truth.map((i) => i.text), `seed ${seed}`);
    assert.match(result, /^Start: reached \(the top of the list/m);
    assert.match(result, /^End: reached/m);
    assert.match(result, /^Complete: yes\.$/m);
  }
});

test('read: silent loads (no spinner) under 2 s are waited for at the top', async () => {
  for (const seed of [6, 7, 8]) {
    const list = sim({ n: 80, seed, spinner: false, delay: [200, 1900] });
    const { items, result } = await read(list);
    assert.deepEqual(items, list.truth.map((i) => i.text), `seed ${seed}`);
    assert.match(result, /^Complete: yes\.$/m);
  }
});

test('read: a virtual window of 12 rows, recycled nodes, with or without keys', async () => {
  for (const keys of [true, false]) {
    for (const seed of [9, 10, 11]) {
      const list = sim({ n: 70, seed, recycle: true, keys, overscan: 1 });
      const view = await list.driver.view();
      assert.ok(view.items.length <= 14, `${view.items.length} rows mounted`);
      const { items } = await read(list);
      assert.deepEqual(items, list.truth.map((i) => i.text), `keys ${keys}, seed ${seed}`);
    }
  }
});

test('read: a page that puts scripted scrolls back does not stop the wheel; one that puts every scroll back is reported', async () => {
  const list = sim({ n: 60, seed: 12, snapback: 'script' });
  const { items, result } = await read(list);
  assert.deepEqual(items, list.truth.map((i) => i.text));
  assert.match(result, /^Complete: yes\.$/m);

  const stubborn = sim({ n: 60, seed: 13, snapback: 'all' });
  const back = await read(stubborn);
  assert.match(back.result, /^Start: not reached \(the page kept scrolling itself back\)\. More may exist above\.$/m);
  assert.match(back.result, /^Complete: NO\. Items above the first one may be missing; tell the user/m);
});

test('read: a load-more button at the end is clicked until the list is whole', async () => {
  const list = sim({ n: 50, seed: 14, reverse: false, loadMore: true, batch: 10 });
  const { items, result } = await read(list);
  assert.deepEqual(items, list.truth.map((i) => i.text));
  assert.match(result, /^Expanded: 4 \(Load more comments ×4\)\.$/m);
  assert.match(result, /^Complete: yes\.$/m);
  // With expand off, the button left there means the end is not reached.
  const off = await read(sim({ n: 50, seed: 14, reverse: false, loadMore: true, batch: 10 }), { expand: false });
  assert.match(off.result, /^End: not reached \(a "Load more comments" control is left there and expand is off\)\. More may exist below\.$/m);
});

test('read: an endless feed stops at max_seconds and says more may exist below; continue goes on from there', async () => {
  const list = sim({ seed: 15, reverse: false, endless: true, batch: 10, delay: [200, 800] });
  const first = await read(list, { maxSeconds: 20 });
  assert.match(first.result, /^End: not reached \(stopped after 20 s\)\. More may exist below\.$/m);
  assert.match(first.result, /^Complete: NO\. Items below the last one may be missing; call read_all again with continue: true and a larger max_seconds\.$/m);
  assert.deepEqual(first.items, list.truth.slice(0, first.items.length).map((i) => i.text));
  const more = await read(list, { maxSeconds: 20 }, first.s);
  assert.ok(more.items.length > first.items.length);
  assert.deepEqual(more.items, list.truth.slice(0, more.items.length).map((i) => i.text));
  assert.match(more.result, /^Start: reached/m, 'the start reached before is kept');
});

test('read: a spinner that never stops is reported after 15 s', async () => {
  const list = sim({ n: 60, seed: 16, stall: true });
  const { result, items } = await read(list);
  assert.match(result, /^Start: not reached \(a loading indicator was still showing after 15 s\)\. More may exist above\.$/m);
  assert.match(result, /^End: reached/m);
  assert.deepEqual(items, list.truth.slice(60 - 15).map((i) => i.text));
});

test('read: direction "up" reads only to the start; max_items stops early', async () => {
  const up = await read(sim({ n: 60, seed: 17 }), { direction: 'up' });
  assert.match(up.result, /^End: not read \(direction "up"\)\.$/m);
  assert.match(up.result, /^Complete: yes\.$/m);
  const few = await read(sim({ n: 200, seed: 18 }), { maxItems: 40 });
  assert.match(few.result, /^Start: not reached \(stopped at max_items \(40\)\)\. More may exist above\.$/m);
  assert.match(few.result, /larger max_items/);
});

// Never a wrong Complete: yes: complete reads hold exactly the truth.
const honest = ({ items, result }, truth, what) => {
  if (/^Complete: yes\.$/m.test(result)) assert.deepEqual(items, truth.map((i) => i.text), `${what}: Complete: yes with other items`);
  else assert.match(result, /^Complete: NO\. /m, what);
};

test('read: recycled rows without keys whose messages share sender and time lines, or all read "ok", are never read wrong as complete', async () => {
  for (const seed of [21, 22, 23]) {
    for (const pool of [12, 16]) {
      const alike = sim({ n: 30, seed, recycle: true, keys: false, pool, text: (i) => `Alice Smith\n10:00 AM\nMessage ${i}` });
      honest(await read(alike), alike.truth, `alike, seed ${seed}, pool ${pool}`);
      const oks = sim({ n: 30, seed, recycle: true, keys: false, pool, text: () => 'ok' });
      const r = await read(oks);
      honest(r, oks.truth, `oks, seed ${seed}, pool ${pool}`);
      assert.match(r.result, /^Complete: NO\. Items where a \[gap\] line is may be missing/m, `oks, seed ${seed}, pool ${pool}`);
    }
  }
  // A pooled row now showing a longer message that starts like its old one is no message grown in place.
  for (const seed of [1, 2, 3]) {
    const again = sim({ n: 30, batch: 30, reverse: false, seed, keys: false, recycle: true, pool: 16, text: (i) => `Alice Smith\n10:00 AM\nHello there ${'again '.repeat(i)}`.trim() });
    honest(await read(again), again.truth, `again, seed ${seed}`);
  }
});

test('read: a load the scrolling started that takes 30 s, with no spinner, leaves the start not reached', async () => {
  const list = sim({ n: 60, seed: 24, spinner: false, delay: [30_000, 30_001] });
  const { result } = await read(list);
  assert.match(result, /^Start: not reached \(a request the page started there was still loading after 15 s\)\. More may exist above\.$/m);
  assert.match(result, /^Complete: NO\. Items above the first one may be missing; the page was still loading; call read_all again with continue: true in a moment\.$/m);
});

test('read: an expander inside the list that is not opened makes the read incomplete', async () => {
  // Its click finds no safe point.
  let r = await read(sim({ n: 40, seed: 25, middle: { every: 9, works: false } }));
  assert.match(r.result, /^5 controls not opened: "View 1 reply", "View 1 reply", "View 1 reply", "View 1 reply", "View 1 reply"; what they hide is missing\.$/m);
  assert.match(r.result, /^Complete: NO\. What the controls not opened hide may be missing; call read_all again with continue: true, or tell the user/m);
  // expand: false.
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9 } }), { expand: false });
  assert.match(r.result, /^5 controls left collapsed \(expand: false\): /m);
  assert.match(r.result, /call read_all again with continue: true and expand: true/);
  // A collapsed item still collapsed after its click; a toggle clicked once is done.
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9, item: true, stays: true, name: 'collapsed item' } }));
  assert.match(r.result, /^5 controls not opened: "collapsed item" \(clicked, nothing opened\), /m);
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9, stays: true, grows: true, name: 'Show trimmed content' } }));
  assert.match(r.result, /^Expanded: 5 \(Show trimmed content ×5\)\.$/m);
  assert.match(r.result, /^Complete: yes\.$/m);
  // A "View 1 reply" whose click opens nothing (still there, its item unchanged) is not opened.
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9, stays: true, name: 'View 1 reply' } }));
  assert.doesNotMatch(r.result, /^Expanded:/m);
  assert.match(r.result, /^5 controls not opened: "View 1 reply" \(clicked, nothing opened\), /m);
  assert.match(r.result, /^Complete: NO\. What the controls not opened hide may be missing/m);
  // A disabled one is never clicked and stays not opened.
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9, disabled: true, name: 'View 3 replies' } }));
  assert.doesNotMatch(r.result, /^Expanded:/m);
  assert.match(r.result, /^5 controls not opened: "View 3 replies" \(disabled\), /m);
  assert.match(r.result, /^Complete: NO\. /m);
  // "Expand all" opens the collapsed items in view along with the rest: they are done too.
  r = await read(sim({ n: 40, seed: 25, expandAll: true, middle: { every: 3, item: true, name: 'collapsed item' } }));
  assert.match(r.result, /^Expanded: 1 \(Expand all\)\.$/m);
  assert.match(r.result, /^Complete: yes\.$/m);
  // Opened ones are done.
  r = await read(sim({ n: 40, seed: 25, middle: { every: 9 } }));
  assert.match(r.result, /^Expanded: 5 \(View 1 reply ×5\)\.$/m);
  assert.match(r.result, /^Complete: yes\.$/m);
  // Past 100 clicks, the rest are left.
  r = await read(sim({ n: 130, seed: 26, middle: { every: 1 } }));
  assert.match(r.result, /^Expanded: 100 /m);
  assert.match(r.result, /^30 controls not opened: .* and 25 more; what they hide is missing\.$/m);
});

test('read: continue checks an end reached before again: rows that came there since are read', async () => {
  const list = sim({ n: 60, seed: 27, late: 5, delay: [1500, 2500] });
  const first = await read(list, { maxSeconds: 15 });
  assert.match(first.result, /^End: reached/m);
  assert.match(first.result, /^Start: not reached \(stopped after 15 s\)/m);
  list.arrive();
  const more = await read(list, {}, first.s);
  assert.deepEqual(more.items, list.truth.map((i) => i.text));
  assert.match(more.result, /^Complete: yes\.$/m);
});

test('read: continue, where an item read earlier was removed between its neighbours, is not complete', async () => {
  const s = newState();
  s.list = ['A first message', 'B second message', 'C third message'].map((text, k) => ({ text, key: `data-key=${'abc'[k]}`, node: k + 1 }));
  let t = 0;
  const v = { items: [{ text: 'A first message', key: 'data-key=a', node: 11, top: 0, bottom: 80 }, { text: 'C third message', key: 'data-key=c', node: 13, top: 80, bottom: 160 }],
    at: 0, max: 0, page: 600, height: 160, vtop: 0, vbottom: 600, busy: false, expanders: [] };
  const still = { moved: 0, at: 0, max: 0 };
  const d = { now: () => t, sleep: async (ms) => { t += ms; }, pending: () => 0, view: async () => v, probe: async () => ({ ...v, pending: 0, sig: 'same' }),
    wheel: async () => still, scrollBy: async () => still, settle: async () => { t += 300; return { busy: false }; }, click: async () => false };
  await readList(d, s);
  const { lines, blocks } = layout(s, { what: 'the list', direction: 'both' });
  assert.equal(blocks.length, 3);
  assert.ok(lines.includes('1 item read earlier is no longer shown between its neighbours.'), lines.join('\n'));
  assert.match(lines.at(-1), /^Complete: NO\. The newest text of some items may be missing; call read_all again without continue\.$/);
});

// readAll's own driver over a stand-in page and box, on mocked timers. A reverse list of n rows 100 px tall in a 600 px
// box, the first `older` of them loaded by the fetch a wheel turn near the top starts; row `collapsed` is a collapsed
// message whose click shows its header at once and fetches its body. A fetch's response headers come after headersMs
// (the tab drops it from inflight then, as browsers.mjs does), its body after bodyMs.
function fakeTab({ n = 12, older = 0, collapsed = -1, headersMs = 500, bodyMs = 30_000 }) {
  const handlers = new Map();
  const emit = (type, r) => { for (const f of handlers.get(type) ?? []) f(r); };
  const H = 100, PAGE = 600;
  let lo = older, open = false, body = false, asked = false;
  const max = () => Math.max(0, (n - lo) * H - PAGE);
  let at = max();
  const pos = () => ({ at, max: max(), page: PAGE, height: (n - lo) * H });
  const tab = { id: 'chrome:1', documentGeneration: 1, inflight: new Set(), dialog: null, blockedPageAt: 0 };
  const request = (done) => {
    const r = { resourceType: () => 'fetch' };
    tab.inflight.add(r);
    emit('request', r);
    setTimeout(() => tab.inflight.delete(r), headersMs);
    setTimeout(() => { done(); emit('requestfinished', r); }, bodyMs);
  };
  const text = (i) => (i !== collapsed ? `m${i} message number ${i}` : open ? `Kai Moreno <kai@example.com>\nto me\nOct 3${body ? '\nHi there, the whole letter.' : ''}` : 'Kai Moreno\nOct 3\nHi there…');
  const view = () => {
    const items = [];
    for (let i = lo; i < n; i++) items.push({ text: text(i), key: null, node: i + 1, top: (i - lo) * H - at, bottom: (i - lo + 1) * H - at, left: 0 });
    const top = (collapsed - lo) * H - at;
    const expanders = collapsed >= lo && !open ? [{ id: 900, name: 'collapsed item', item: true, edge: 'middle', seen: true, top, bottom: top + H, owner: collapsed + 1, disabled: false }] : [];
    return { ...pos(), vtop: 0, vbottom: PAGE, busy: false, expanders, items, list: 1, share: 1 };
  };
  const point = () => ({ dx: 10, dy: 10, w: 100, h: 20 });
  const ops = { about: () => ({ id: 1, win: false, tag: 'div', role: 'log', label: null }), pos, view, point, guard: point, unguard: () => ({ blocked: null }),
    probe: () => ({ ...pos(), busy: false, sig: `${lo} ${open} ${body}` }), quiet: () => ({ quiet: true, busy: false }) };
  const wheel = (dy) => {
    at = Math.min(Math.max(at + dy, 0), max());
    if (at < 400 && lo > 0 && !asked) {
      asked = true;
      request(() => { at += lo * H; lo = 0; });
    }
  };
  const box = { asElement: () => box, evaluate: async (fn, args) => ops[args.op](args), boundingBox: async () => ({ x: 0, y: 0, width: 400, height: PAGE }), dispose: async () => {} };
  tab.page = { url: () => 'http://localhost/thread', evaluateHandle: async () => box,
    on: (type, f) => handlers.set(type, [...(handlers.get(type) ?? []), f]), off: (type, f) => handlers.set(type, (handlers.get(type) ?? []).filter((g) => g !== f)),
    mouse: { move: async () => {}, wheel: async (x, dy) => wheel(dy), click: async () => { open = true; request(() => { body = true; }); } } };
  return { tab, handlers };
}
const DEPS = { header: async () => 'Browser: Chrome · Tab: chrome:1', locator: null, pointed: (tab, where, action) => action(), wheelLanded: (read) => read(),
  boxPoint: async () => ({ reached: true, x: 200, y: 300 }), refuseBlockedPage: () => {}, SCROLL_TARGET_FN: null };
async function onMockedClock(fn) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    let done = false, out, error;
    fn().then((r) => { out = r; }, (e) => { error = e; }).finally(() => { done = true; });
    while (!done) {
      await new Promise((resolve) => setImmediate(resolve));
      mock.timers.tick(50);
    }
    if (error) throw error;
    return out;
  } finally {
    mock.timers.reset();
  }
}

test('readAll: a list fetch whose headers come at 500 ms and body later, with no spinner, is waited for; still loading, that end is not reached', async () => {
  // The body at 10 s: waited for (once the headers were in, the end used to be taken as reached without its rows).
  let { tab, handlers } = fakeTab({ n: 26, older: 6, bodyMs: 10_000 });
  let result = await onMockedClock(() => readAll(tab, {}, DEPS));
  assert.match(result, /^Read the scrolling list <div> \(log\): 26 items, top first\.$/m);
  assert.match(result, /^Complete: yes\.$/m);
  for (const type of ['request', 'requestfinished', 'requestfailed']) assert.equal(handlers.get(type).length, 0, type);
  // The body at 30 s: still loading when the wait ends.
  ({ tab } = fakeTab({ n: 26, older: 6, bodyMs: 30_000 }));
  result = await onMockedClock(() => readAll(tab, {}, DEPS));
  assert.match(result, /^Start: not reached \(a request the page started there was still loading after 15 s\)\. More may exist above\.$/m);
  assert.match(result, /^Complete: NO\. /m);
});

test('readAll: a collapsed message whose click fetches its body for 300 s is not counted as opened', async () => {
  const { tab } = fakeTab({ n: 12, collapsed: 9, bodyMs: 300_000 });
  const result = await onMockedClock(() => readAll(tab, {}, DEPS));
  assert.doesNotMatch(result, /^Expanded:/m);
  assert.match(result, /^1 control not opened: "collapsed item" \(still loading\); what it hides is missing\.$/m);
  assert.match(result, /^Complete: NO\. /m);
});

// --- Expanders and the result ---

test('expanders: only controls that show more of the list, never verbs that act', () => {
  for (const name of ['Load more', 'Load more comments', '13 older messages', 'Show older comments', 'View 3 replies', 'View 1 reply', 'Show 1 more reply',
    'See more', '…more', 'Read more', 'Show trimmed content', 'Expand all', 'Show 5 more posts', '5 new posts', 'View all comments', 'Show replies']) {
    assert.ok(expandable(name), name);
  }
  for (const name of ['Reply', 'Reply all', 'Forward', 'Like', 'Delete', 'Archive', 'Mark as unread', 'Post', 'Share', 'Show reply settings', 'Send',
    'View profile', 'Show translation', 'Download all', 'Load more and subscribe', 'Show more like this']) {
    assert.ok(!expandable(name), name);
  }
});

test('result: the summary lines, the item blocks and a gap line', async () => {
  const s = newState();
  s.list = [{ text: 'first\nline two' }, { gap: true }, { text: 'second' }];
  s.ends = { start: { reached: true, text: 'the top of the list' }, end: { reached: false, why: 'stopped after 100 s' } };
  s.expanded = new Map([['13 older messages', 1], ['Show trimmed content', 2]]);
  const { lines, blocks } = layout(s, { what: 'the page', direction: 'both' });
  assert.deepEqual(lines, [
    'Read the page: 2 items, top first.',
    'Start: reached (the top of the list).',
    'End: not reached (stopped after 100 s). More may exist below.',
    'Expanded: 3 (13 older messages; Show trimmed content ×2).',
    'Complete: NO. Items below the last one and items where a [gap] line is may be missing; call read_all again with continue: true and a larger ' +
      'max_seconds; the list jumped while it was read; call read_all again without continue to read it once more.',
  ]);
  assert.deepEqual(blocks, ['[1] first\nline two', '[gap: the list jumped here; items may be missing]', '[2] second']);

  const full = await fit('Browser: Helium · Tab: helium:1', { lines, blocks }, 100_000, () => assert.fail('no file'));
  assert.ok(full.endsWith('\n\n[1] first\nline two\n\n[gap: the list jumped here; items may be missing]\n\n[2] second'));

  const many = { lines: ['Read the page: 300 items, top first.', 'Complete: yes.'], blocks: Array.from({ length: 300 }, (_, i) => `[${i + 1}] ${'x'.repeat(50)}`) };
  let saved;
  const cut = await fit('Browser: Helium · Tab: helium:1', many, 2000, async (body) => { saved = body; return '/tmp/x/read.txt'; });
  assert.ok(cut.length <= 2000, `${cut.length}`);
  assert.ok(saved.includes('[300] '));
  assert.match(cut, /^All 300 items \([\d,]+ chars\) are in \/tmp\/x\/read\.txt; shown here: items 1–\d+\. Read the file before answering about the whole list\.$/m);
  const shown = Number(/items 1–(\d+)/.exec(cut)[1]);
  assert.ok(cut.includes(`[${shown}] `) && !cut.includes(`[${shown + 1}] `));
});

test('result: 100 kinds of expanders and a small max_chars: 10 kinds named, the text within max_chars, the file line kept', async () => {
  const s = newState();
  s.list = Array.from({ length: 50 }, (_, i) => ({ text: `message ${i} ${'x'.repeat(40)}` }));
  s.ends = { start: { reached: true, text: 'the top of the list' }, end: { reached: true, text: 'the bottom of the list' } };
  s.expanded = new Map(Array.from({ length: 100 }, (_, i) => [`Show ${i + 1} more messages`, 1]));
  const out = layout(s, { what: 'the page', direction: 'both' });
  assert.ok(out.lines.includes(`Expanded: 100 (${Array.from({ length: 10 }, (_, i) => `Show ${i + 1} more messages`).join('; ')}; and 90 more kinds).`));
  let saved;
  for (const max of [1000, 1200, 3000]) {
    const text = await fit('Browser: Helium · Tab: helium:1', out, max, async (body) => { saved = body; return '/tmp/x/read.txt'; });
    assert.ok(text.length <= max, `${text.length} > ${max}`);
    assert.match(text, /^All 50 items \([\d,]+ chars\) are in \/tmp\/x\/read\.txt; shown here: (none|items 1–\d+)\. Read the file/m);
    assert.match(text, /^Complete: yes\.$/m);
  }
  assert.ok(saved.includes('[50] message 49'));
  // A summary longer than max_chars by itself is cut short, keeping its Complete line.
  const long = { lines: [...out.lines.slice(0, -1), ...Array.from({ length: 20 }, (_, i) => `Note ${i}: ${'y'.repeat(80)}`), out.lines.at(-1)], blocks: out.blocks };
  const cut = await fit('Browser: Helium · Tab: helium:1', long, 1000, async () => '/tmp/x/read.txt');
  assert.ok(cut.length <= 1000, `${cut.length}`);
  assert.match(cut, /…\nComplete: yes\.\nAll 50 items .* shown here: none\./);
});

// --- Which element holds the items (READER_FN in a stand-in DOM) ---

// Elements with attributes, simple selectors ("tag[attr=value],[attr^=value]"), innerText (a line per child) and a
// rect (their own, else their parent's); run calls READER_FN on box (a scrolling box, not the window).
function dom() {
  const doc = {};
  const matches = (e, selector) => selector.split(',').some((part) => {
    const [, tag, attrs] = /^([a-z]*)((?:\[[^\]]*\])*)$/.exec(part.trim());
    return (!tag || e.localName === tag) && [...attrs.matchAll(/\[([\w-]+)(?:(\^?=)"?([^"\]]*)"?)?\]/g)].every(([, name, op, value]) => {
      const a = e.getAttribute(name);
      return op === '=' ? a === value : op === '^=' ? !!a?.startsWith(value) : a !== null;
    });
  });
  const below = (e) => e.children.flatMap((c) => [c, ...below(c)]);
  const el = (tag, attrs = {}, kids = []) => {
    const e = { nodeType: 1, localName: tag, childNodes: [], parentElement: null, isConnected: true, rect: null,
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), getAttribute: (n) => attrs[n] ?? null, hasAttribute: (n) => n in attrs,
      getRootNode: () => doc, matches: (sel) => matches(e, sel), querySelectorAll: (sel) => below(e).filter((c) => matches(c, sel)),
      querySelector: (sel) => below(e).find((c) => matches(c, sel)) ?? null, getAnimations: () => [],
      get innerText() { return e.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.innerText)).filter(Boolean).join('\n'); },
      get textContent() { return e.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); },
      getBoundingClientRect() {
        const r = e.rect ?? e.parentElement?.getBoundingClientRect() ?? { top: 0, bottom: 600, left: 0, right: 400 };
        return { ...r, width: r.right - r.left, height: r.bottom - r.top };
      } };
    for (const k of kids) {
      const c = typeof k === 'string' ? { nodeType: 3, data: k } : k;
      e.childNodes.push(c);
      if (c.nodeType === 1) c.parentElement = e;
    }
    e.children = e.childNodes.filter((c) => c.nodeType === 1);
    return e;
  };
  const run = (box, args, { body = box } = {}) => {
    const globals = { document: Object.assign(doc, { scrollingElement: body === box ? el('html') : box, body, querySelectorAll: (sel) => box.querySelectorAll(sel),
      getAnimations: () => [], createTreeWalker: () => ({ nextNode: () => null }), elementFromPoint: () => run.hit }),
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, NodeFilter: { SHOW_TEXT: 4 }, ShadowRoot: class {}, Element: Object, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ overflowY: 'auto', visibility: 'visible', display: 'block', flexDirection: 'column' }) };
    const saved = globalThis.window;
    Object.assign(globalThis, globals);
    globalThis.window = run.window ??= {};
    Object.assign(box, { scrollTop: 0, scrollHeight: 600, clientHeight: 600 });
    try {
      return READER_FN(box, args);
    } finally {
      for (const key of Object.keys(globals)) delete globalThis[key];
      if (saved) globalThis.window = saved;
    }
  };
  const pick = (box, { repick = false, body = box } = {}) => {
    const { share } = run(box, { op: 'list', repick, ...PATTERNS_FOR_TEST }, { body });
    return { el: run.window[Symbol.for('fowlbrowser.readAll')].lists.get(box), share };
  };
  return { el, run, pick };
}
const PATTERNS_FOR_TEST = { allow: [], deny: 'x^' };

test('list: an email thread whose open message has more paragraphs than the thread shows rows is still the thread', () => {
  const { el, pick } = dom();
  const para = (k) => el('div', {}, [`Paragraph ${k} of the newest letter, long enough to weigh a fair bit in the thread's text.`]);
  const body = el('div', { class: 'body' }, Array.from({ length: 16 }, (_, k) => para(k)));
  const thread = el('div', { role: 'list' }, [
    el('div', { role: 'listitem', 'aria-expanded': 'false' }, [el('div', {}, ['Kai Moreno']), el('div', {}, ['Hi, about the order…']), el('div', {}, ['Oct 3'])]),
    el('div', { class: 'older' }, [el('span', { role: 'button' }, ['13'])]),
    el('div', { role: 'listitem', 'aria-expanded': 'true' }, [el('div', {}, ['Rhea Lindqvist <rhea.l@example.com>']), body]),
  ]);
  const box = el('div', {}, [el('h2', {}, ['Re: Your NuPhy order']), thread, el('div', {}, [el('button', {}, ['Reply'])])]);
  assert.equal(pick(box).el, thread);
});

test('list: an inline script does not count as text; a kept element is picked again once it holds under half', () => {
  const { el, pick } = dom();
  const cells = el('div', { class: 'cells' }, Array.from({ length: 8 }, (_, k) => el('div', {}, [`Post ${k} with a little text`])));
  const body = el('body', {}, [el('div', {}, ['Home']), el('main', {}, [cells, el('div', { class: 'loader' })]), el('script', {}, ['x'.repeat(5000)])]);
  const page = el('html', {}, [body]);
  const first = pick(page, { body });
  assert.equal(first.el, cells);
  // Later most of the text is elsewhere (the list grew in another element): the kept one gives way.
  const other = el('div', { class: 'cells' }, Array.from({ length: 30 }, (_, k) => el('div', {}, [`Another post ${k} with a little more text`])));
  body.childNodes.push(other);
  body.children.push(other);
  other.parentElement = body;
  const again = pick(page, { body });
  assert.equal(again.el, other);
  assert.ok(again.share > 0.5);
});

const PATTERNS = { allow: EXPAND_ALLOW.map((r) => r.source), deny: EXPAND_DENY.source };
// A box holding a list of rows 80 px tall, and its view as READER_FN reads it.
function rows(make) {
  const { el, run } = dom();
  const items = make(el);
  items.forEach((r, k) => { r.rect = { top: k * 80, bottom: k * 80 + 80, left: 0, right: 400 }; });
  const box = el('div', {}, [el('div', { role: 'list' }, items)]);
  box.rect = { top: 0, bottom: 600, left: 0, right: 400 };
  return { box, run, view: () => run(box, { op: 'view', ...PATTERNS }) };
}

test('keys: only attributes that name one item; a sender, thread or channel id is none', () => {
  // A virtualized conversation of seven alternating senders: the 6 rows in view have different user ids.
  let { view } = rows((el) => Array.from({ length: 6 }, (_, k) => el('div', { 'data-user-id': String((k + 7) % 7), 'data-index': String(k + 7) },
    [el('div', {}, [`Sender ${k % 7}`]), el('div', {}, [`Message ${k + 7}`])])));
  assert.deepEqual(view().items.map((i) => i.key), [null, null, null, null, null, null]);
  ({ view } = rows((el) => ['data-author-id', 'data-thread-id', 'data-conversation-id', 'data-channel-id'].map((name, k) => el('div', { [name]: `v${k}` }, [`Row ${k}`]))));
  assert.deepEqual(view().items.map((i) => i.key), [null, null, null, null]);
  // Nor any other data-*-key: six rows in view with data-user-key=(i % 7), and sender, thread and chat keys inside them.
  ({ view } = rows((el) => Array.from({ length: 6 }, (_, k) => el('div', { 'data-user-key': String((k + 7) % 7) },
    [el('div', { [['data-author-key', 'data-sender-key', 'data-thread-key'][k % 3]]: `v${k}` }, [`Message ${k + 7}`])]))));
  assert.deepEqual(view().items.map((i) => i.key), [null, null, null, null, null, null]);
  ({ view } = rows((el) => [el('div', { 'data-message-id': 'm1' }, ['a']), el('div', {}, [el('div', { 'data-legacy-message-id': 'm2' }, ['b'])]),
    el('div', { 'data-item-id': 'i3' }, ['c']), el('div', { 'data-feed-item-id': 'i4' }, ['d']), el('div', { 'data-key': 'k5' }, ['e']),
    el('div', { 'data-row-key': 'k6' }, ['f']), el('div', { 'data-uuid': 'u7' }, ['g']), el('div', { id: 'message-7f3a' }, ['h'])]));
  assert.deepEqual(view().items.map((i) => i.key), ['data-message-id=m1', 'data-legacy-message-id=m2', 'data-item-id=i3', 'data-feed-item-id=i4', 'data-key=k5',
    'data-row-key=k6', 'data-uuid=u7', 'id=message-7f3a']);
});

test('collapsed items: only the item or a plain element in it, never a control, one inside a control or one whose name acts', () => {
  let star, sender;
  const { box, view, run } = rows((el) => [
    el('div', { role: 'listitem', 'aria-expanded': 'false' }, [(sender = el('div', {}, ['Kai Moreno'])), (star = el('span', { role: 'checkbox' }, ['☆'])), el('div', {}, ['Hi there…'])]),
    el('div', { role: 'listitem' }, [el('div', { role: 'checkbox', 'aria-expanded': 'false', 'aria-label': 'Mark as unread' }, ['Rhea']), el('div', {}, ['Body'])]),
    el('div', { role: 'listitem' }, [el('a', { href: '/m/3' }, [el('div', { 'aria-expanded': 'false' }, ['Tomás: lunch?'])])]),
    el('div', { role: 'listitem' }, [el('div', { 'aria-expanded': 'false', 'aria-label': 'Archive' }, ['Ada: invoice'])]),
    el('div', { role: 'listitem' }, [el('div', { role: 'menuitemcheckbox', 'aria-expanded': 'false' }, ['Juno: photos'])]),
    el('div', { role: 'listitem' }, [el('div', {}, [el('div', { role: 'article', 'aria-expanded': 'false' }, ['Milo: notes'])])]),
    el('div', { role: 'listitem' }, [el('div', { role: 'button' }, [el('div', { 'aria-expanded': 'false' }, ['Kai: call later'])])]),
  ]);
  const found = view().expanders;
  assert.deepEqual(found.map((e) => [e.name, e.top]), [['collapsed item', 0], ['collapsed item', 400]]);
  // The click point: never where a control in the item is hit.
  const point = () => run(box, { op: 'point', id: found[0].id, item: true, ...PATTERNS });
  run.hit = star;
  assert.equal(point(), null);
  run.hit = sender;
  assert.ok(point());
});

test('expanders: a disabled one is listed and never given a click point, and its label is left out of its item', () => {
  let off;
  const { box, view, run } = rows((el) => {
    off = el('button', {}, ['View 3 replies']);
    off.disabled = true;
    return [el('div', {}, [el('div', {}, ['Kai: lunch?']), off]), el('div', {}, [el('div', {}, ['Rhea: sure']), el('div', { role: 'button', 'aria-disabled': 'true' }, ['Show 2 more replies'])])];
  });
  const v = view();
  assert.deepEqual(v.items.map((i) => i.text), ['Kai: lunch?', 'Rhea: sure']);
  assert.deepEqual(v.expanders.map((e) => [e.name, e.disabled]), [['View 3 replies', true], ['Show 2 more replies', true]]);
  run.hit = off;
  assert.equal(run(box, { op: 'point', id: v.expanders[0].id, item: false, ...PATTERNS }), null);
});

test('click guard: the target changes between the check and the press (a Like moved under the point): the Like never gets it', async () => {
  let reply, like;
  const { box, view, run } = rows((el) => {
    [reply, like] = [el('button', {}, ['View 1 reply']), el('button', {}, ['Like'])];
    return [el('div', {}, [el('div', {}, ['Kai: lunch?']), reply, like])];
  });
  const listeners = new Map();
  // The window the reader's state lives on (the one run leaves global, also for unguard's timer).
  run.window = Object.assign(globalThis.window ?? {}, { addEventListener: (type, f) => listeners.set(type, [...(listeners.get(type) ?? []), f]),
    removeEventListener: (type, f) => listeners.set(type, (listeners.get(type) ?? []).filter((g) => g !== f)) });
  // A real press: pointer and mouse down and up, then click, each through the window's capture listeners first.
  const handled = [];
  const press = (target) => {
    const path = [];
    for (let n = target; n; n = n.parentElement) path.push(n);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      let stopped = false;
      const ev = { type, target, isTrusted: true, composedPath: () => path, preventDefault() {}, stopImmediatePropagation() { stopped = true; } };
      for (const f of listeners.get(type) ?? []) if (!stopped) f(ev);
      if (!stopped) handled.push(`${type} ${target.innerText}`);
    }
  };
  const e = view().expanders.find((x) => x.name === 'View 1 reply');
  run.hit = reply;
  assert.ok(run(box, { op: 'guard', id: e.id, item: false, ...PATTERNS }));
  press(like);
  assert.deepEqual(handled, []);
  assert.deepEqual(await run(box, { op: 'unguard', ...PATTERNS }), { blocked: 'Like' });
  // A press on the expander goes through; with the guard off, the page's own presses do too.
  run(box, { op: 'guard', id: e.id, item: false, ...PATTERNS });
  press(reply);
  assert.deepEqual(await run(box, { op: 'unguard', ...PATTERNS }), { blocked: null });
  assert.equal(handled.filter((h) => h.endsWith('View 1 reply')).length, 5);
  press(like);
  assert.equal(handled.filter((h) => h.endsWith('Like')).length, 5);
});

test('result: a press stopped by the guard is named on the Expanded line', () => {
  const s = newState();
  s.list = [{ text: 'a' }];
  s.ends = { start: { reached: true, text: 'the top' }, end: { reached: true, text: 'the bottom' } };
  s.expanded = new Map([['View 1 reply', 2]]);
  s.blocked = new Map([['View 1 reply', 1]]);
  s.open = new Map([['5 View 1 reply', { name: 'View 1 reply', owner: 3 }]]);
  const { lines } = layout(s, { what: 'the list', direction: 'both' });
  assert.ok(lines.includes('Expanded: 2 (View 1 reply ×2); presses stopped because another element was under the pointer, nothing was clicked there: "View 1 reply".'),
    lines.join('\n'));
  assert.match(lines.at(-1), /^Complete: NO\. /);
});

test('result: a probable stale copy, or items holding under half of the text, is never Complete: yes', () => {
  const s = newState();
  s.list = [{ text: 'Kai Moreno\nOct 3\nHi there…' }, { text: 'Kai Moreno <kai@example.com>\nto me\nOct 3\nHi there, all of it.' }];
  s.ends = { start: { reached: true, text: 'the top' }, end: { reached: true, text: 'the bottom' } };
  // A collapsed row taken for new while its node shows the expanded one is counted by merge.
  const list = [{ text: s.list[0].text, key: 'data-key=old', node: 7 }];
  const r = merge(list, [{ text: s.list[1].text, key: 'data-key=new', node: 7 }], { toward: 1, force: true });
  assert.equal(r.stale, 1);
  // Another message that quotes it (a Gmail reply quotes the whole thread) is no older copy.
  const reply = 'Rhea Lindqvist <rhea.l@example.com>\nto me\nOct 4\nSounds good, see you then.\nOn Oct 3, Kai Moreno wrote:\nHi there, all of it.\nKai Moreno <kai@example.com>';
  assert.ok(similar(s.list[1].text, reply));
  assert.equal(merge([{ text: s.list[1].text, key: null, node: 8 }], [{ text: reply, key: null, node: 8 }], { toward: 1, force: true }).stale, 0);
  s.stale = r.stale;
  let { lines } = layout(s, { what: 'the list', direction: 'both' });
  assert.ok(lines.includes('1 item may be an older copy of another one (the page changed it in place while it was read).'));
  assert.match(lines.at(-1), /^Complete: NO\. The newest text of some items may be missing; call read_all again without continue\.$/);
  Object.assign(s, { stale: 0, share: 0.3 });
  ({ lines } = layout(s, { what: 'the list', direction: 'both' }));
  assert.match(lines.at(-1), /^Complete: NO\. Items outside the element read may be missing; call snapshot, then read_all with ref of one item of the list\.$/);
});
