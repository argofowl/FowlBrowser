// read_all reads every thread page (test/site/threads) completely: each variant opens a page with a random seed (its
// delays come from the seed too, so a failing seed replays exactly), calls read_all and compares the items with
// data.js's truth in order. Nothing dangerous may be clicked and the page must not navigate. Incomplete reads (an
// endless feed on a short budget, a load that never ends) must say so. test/read-all-runs.mjs runs these many times.
import { mailVisible, mulberry32, rowLines, truth } from '../site/threads/data.js';
import { firstDiff } from './thread-pages.mjs';

// delay: the slowest load range; a run picks its upper end between the middle and this.
// expect: 'complete' (all of the truth), 'end' (an endless feed: a prefix, the end not reached), 'start' (a load that
// never ends: the newest rows, the start not reached), 'visible' (mail with expand: false: what shows unexpanded).
export const VARIANTS = [
  { name: 'dm', page: 'dm', delay: [200, 1200] },
  { name: 'dm-recycle', page: 'dm', query: 'recycle=1', delay: [200, 1200] },
  { name: 'dm-nokeys', page: 'dm', query: 'keys=0&dups=1', delay: [200, 1200] },
  { name: 'dm-silent', page: 'dm', query: 'spinner=0', delay: [200, 1800] },
  { name: 'dm-slow', page: 'dm', delay: [200, 2500] },
  { name: 'chat-reverse', page: 'chat-reverse', delay: [200, 1200] },
  { name: 'mail', page: 'mail', delay: [200, 1200] },
  { name: 'mail-noexpand', page: 'mail', delay: [200, 1200], args: { expand: false }, expect: 'visible' },
  { name: 'feed', page: 'feed', query: 'virtual=1', delay: [200, 1200] },
  { name: 'comments', page: 'comments', delay: [200, 1200] },
  { name: 'feed-endless', page: 'feed', query: 'endless=1', delay: [200, 1200], args: { max_seconds: 12 }, expect: 'end' },
  { name: 'dm-stall', page: 'dm', query: 'stall=1', delay: [200, 1200], expect: 'start' },
];

// read_all's result: the three status lines, whether a gap was marked, and the items' lines.
export function parseRead(text) {
  const at = text.search(/^\[\d+\] /m);
  const blocks = at < 0 ? [] : text.slice(at).trimEnd().split(/\n\n(?=\[\d+\] )/);
  return {
    start: /^Start: (reached|not reached|not read)/m.exec(text)?.[1],
    end: /^End: (reached|not reached|not read)/m.exec(text)?.[1],
    complete: /^Complete: (yes|NO)\./m.exec(text)?.[1],
    gap: /^\[gap: /m.test(text),
    numbers: blocks.map(b => Number(/^\[(\d+)\] /.exec(b)[1])),
    items: blocks.map(b => b.replace(/^\[\d+\] /, '').split('\n').filter(line => line && !/^\[gap: /.test(line))),
  };
}

// The first differing item, and how many of the truth's items are missing or doubled.
function compare(got, want) {
  const diff = firstDiff(got, want);
  if (!diff) return null;
  const count = list => list.reduce((m, x) => m.set(JSON.stringify(x), (m.get(JSON.stringify(x)) ?? 0) + 1), new Map());
  const [g, w] = [count(got), count(want)];
  let missing = 0, doubled = 0;
  for (const [k, n] of w) missing += Math.max(0, n - (g.get(k) ?? 0));
  for (const [k, n] of g) doubled += Math.max(0, n - (w.get(k) ?? 0));
  return `${diff}; ${missing} missing, ${doubled} extra or doubled`;
}

export async function readVariant(t, v, seed) {
  const r = mulberry32(seed);
  const [lo, hi] = v.delay;
  const query = new URLSearchParams(v.query);
  query.set('seed', seed);
  query.set('delay', `${lo}-${Math.round(lo + (hi - lo) * (0.5 + r() / 2))}`);
  const search = `?${query}`;
  const url = new URL(`${t.site}/threads/${v.page}.html${search}`).href;
  const say = msg => `${v.name} ${search}: ${msg}`;
  t.step(`${v.name} ${search}`);
  const tab = await t.open(url);
  await t.until(() => t.eval(tab, '() => !!window.__rows?.().length'), say('first rows'));
  const res = await t.call('read_all', { tab, max_chars: 200000, ...v.args }, 300_000);
  const read = parseRead(res.text);
  const head = res.text.slice(0, res.text.search(/^\[\d+\] /m) >>> 0).slice(0, 700);
  const status = `${say('')}result head:\n${head}`;
  t.eq(read.numbers, read.items.map((_, i) => i + 1), say('items numbered 1..n'));

  const expect = v.expect ?? 'complete';
  let want = truth(v.page, search, { count: read.items.length }).map(x => x.lines);
  if (expect === 'complete') {
    t.ok(read.complete === 'yes' && read.start === 'reached' && read.end === 'reached' && !read.gap, `complete read expected; ${status}`);
  } else if (expect === 'end') {
    t.ok(read.complete === 'NO' && read.end === 'not reached' && /More may exist below/.test(res.text), `End: not reached expected; ${status}`);
  } else if (expect === 'start') {
    t.ok(read.complete === 'NO' && read.start === 'not reached', `Start: not reached expected; ${status}`);
    want = want.slice(-read.items.length || want.length);
  } else want = mailVisible(truth(v.page, search)).map(x => x.lines);
  const diff = compare(read.items.map(lines => rowLines(lines.join('\n'))), want);
  t.ok(!diff, say(diff));

  t.eq(await t.eval(tab, '() => window.__danger'), [], say('nothing dangerous clicked'));
  t.eq(await t.eval(tab, '() => location.href'), url, say('the page did not navigate'));
  await t.close(tab);
}

export default {
  name: 'read-all',
  async run(t) {
    for (const v of VARIANTS) await readVariant(t, v, Math.floor(Math.random() * 1e6));
  },
};
