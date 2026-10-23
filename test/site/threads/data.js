// Ground truth for the thread pages (test/site/threads/*.html), shared by the pages (a browser module) and the scenarios
// (Node). Every random choice comes from the URL's seed, so a page and the test that reads it build the same thread.
// An item is { key, lines, ... }: lines is exactly what a reader must return for that row (its innerText, fully
// expanded, lines trimmed, empty lines dropped); the other fields only tell the page how to draw it.

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = { seed: 1, delay: '200-1200', spinner: 1, dups: 1, keys: 1, stall: 0, all: 0, marker: 1 };
const DEFAULTS = {
  dm: { n: 62, batch: 20, recycle: 0, snapback: 1 },
  'chat-reverse': { n: 60, batch: 15, keys: 0 },
  mail: { n: 16 },
  feed: { n: 60, batch: 10, virtual: 1, endless: 0 },
  comments: { n: 30, batch: 8 },
};

// The page's settings from its query string (a bare `?all` counts as 1). delayRange is [min, max] ms.
export function params(page, search = '') {
  const q = new URLSearchParams(search);
  const p = { page, ...COMMON, ...DEFAULTS[page] };
  for (const k of Object.keys(p)) {
    if (k === 'page' || !q.has(k)) continue;
    p[k] = k === 'delay' ? q.get(k) : q.get(k) === '' ? 1 : Number(q.get(k));
  }
  const [lo, hi = lo] = String(p.delay).split('-').map(Number);
  p.delayRange = [lo, hi];
  return p;
}

// The page's delays: their own stream, so how many loads ran never changes the thread.
export const delays = p => {
  const r = mulberry32(p.seed ^ 0x5bd1e995);
  return () => Math.round(p.delayRange[0] + r() * (p.delayRange[1] - p.delayRange[0]));
};

const WORDS = ('the a we you it that this for on with just about tomorrow later maybe sure think need know send call ' +
  'meeting plan trip office project draft photos link file dinner coffee weekend friday monday deadline budget invoice ' +
  'flight hotel train ticket review notes update version build launch design colors layout copy logo price quote ' +
  'client team sister brother mom dad dog cat garden kitchen car bike run gym book movie show song playlist idea ' +
  'really honestly totally probably definitely almost still already again soon now').split(' ');
const DUPS = ['ok', '❤️', 'thanks!', 'lol'];
const PEOPLE = [['Kai Moreno', 'kai'], ['Rhea Lindqvist', 'rhea.l'], ['Tomás Ferreira', 'tferreira'], ['Ada Okafor', 'adaok'],
  ['Juno Park', 'junopark'], ['Milo Hart', 'milohart']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const pick = (r, list) => list[Math.floor(r() * list.length)];
const pad = (i, w = 3) => String(i).padStart(w, '0');

function sentence(r, min, max) {
  const count = min + Math.floor(r() * (max - min + 1));
  const words = Array.from({ length: count }, () => pick(r, WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ') + pick(r, ['.', '.', '?', '!', '']);
}

function clock(minutes) {
  const m = ((Math.floor(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${(h + 11) % 12 + 1}:${pad(m % 60, 2)} ${h < 12 ? 'AM' : 'PM'}`;
}

// A DM or chat thread, oldest first: date separators, messages (some long, some with two paragraphs, some with the
// time under them), runs of byte-identical short messages, a message about money in the middle.
function conversation(p, marker) {
  const r = mulberry32(p.seed);
  const items = [];
  const key = () => String(1840000000000 + items.length * 4096 + Math.floor(r() * 4096));
  let t = 9 * 60 + Math.floor(r() * 600);
  let msg = 0;
  const labels = [];
  const separator = () => {
    const day = Math.floor(t / 1440);
    let lines = [`${day >= 6 ? 'Yesterday' : DAYS[day % 7]} ${clock(t)}`];
    if (p.dups && labels.length && r() < 0.3) lines = [pick(r, labels)];
    labels.push(lines[0]);
    items.push({ key: key(), kind: 'date', lines });
  };
  separator();
  while (items.length < p.n) {
    const gap = r() < 0.12 ? 60 + r() * 900 : r() * 3;
    t += gap;
    if (gap >= 60 && items.length < p.n - 1) separator();
    const side = r() < 0.5 ? 'in' : 'out';
    const timed = r() < 0.35;
    if (p.dups && r() < 0.1) {
      const lines = [pick(r, DUPS)];
      if (timed) lines.push(clock(t));
      for (let run = 1 + Math.floor(r() * 3); run > 0 && items.length < p.n; run--) items.push({ key: key(), kind: 'msg', side, lines: [...lines] });
      continue;
    }
    const token = `m${pad(++msg)}`;
    const kind = r();
    let lines;
    if (items.length === Math.floor(p.n / 2) || items.length === Math.floor(p.n / 2) + 1) lines = [`Also the invoice is $2,400, can you pay it by Friday? ${token}`];
    else if (kind < 0.2) lines = [`${sentence(r, 25, 60)} ${token}`];
    else if (kind < 0.3) lines = [`${sentence(r, 4, 14)} ${token}`, sentence(r, 4, 20)];
    else lines = [`${sentence(r, 1, 10)} ${token}`];
    if (timed) lines.push(clock(t));
    items.push({ key: key(), kind: 'msg', side, lines });
  }
  if (p.marker) items.unshift({ key: 'start', kind: 'marker', lines: marker });
  return items;
}

// A mail thread: per message both looks, collapsed (name, snippet, date) and expanded (name, to, date, body, late line, quote).
function mail(p) {
  const r = mulberry32(p.seed);
  const items = [];
  let day = 1 + Math.floor(r() * 10);
  for (let i = 0; i < p.n; i++) {
    const [name, handle] = PEOPLE[i % 2 === 0 ? 0 : 1 + Math.floor(r() * 2)];
    day += Math.floor(r() * 2);
    const date = `Oct ${day}, 2026, ${clock(8 * 60 + Math.floor(r() * 720))}`;
    const token = `e${pad(i + 1, 2)}`;
    // The newest message (open from the start, as in Gmail) is a long letter: more paragraphs than the thread has
    // messages shown, so its body must not be taken for the list.
    const last = i === p.n - 1 && i > 0;
    const body = last ? [`Dear ${items[i - 1].name.split(' ')[0]},`, `${sentence(r, 6, 30)} ${token}`, ...Array.from({ length: 14 }, () => sentence(r, 6, 40)), 'Best regards,', name] :
      p.dups && i > 0 && r() < 0.15 ? ['thanks!'] :
        Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => (k === 0 ? `${sentence(r, 6, 30)} ${token}` : sentence(r, 6, 40)));
    // As in Gmail, a reply quotes the whole message before it, quote and all (so the whole thread), as plain lines.
    const prev = items[i - 1];
    const quote = prev ? [`On ${prev.date}, ${prev.name} <${prev.email}> wrote:`, ...prev.body, ...prev.quote] : [];
    const snippet = body[0].length > 70 ? `${body[0].slice(0, 70).trimEnd()}…` : body[0];
    // Every fourth message gains a line a moment after it opens (a lazy footer, as Gmail grows a shown message in place).
    const late = i % 4 === 1 ? `${name.split(' ')[0]} · sent from my phone` : null;
    items.push({
      key: `msg-f:${1780000000 + i * 977}`, name, email: `${handle}@example.com`, date, body, late, quote,
      collapsed: [name, snippet, date],
      lines: [`${name} <${handle}@example.com>`, 'to me', date, ...body, ...(late ? [late] : []), ...quote],
    });
  }
  return items;
}

// What a mail thread shows when nothing is expanded: message 1 and the second newest collapsed, the newest expanded
// with its quote still trimmed.
export function mailVisible(items) {
  const last = items.at(-1);
  return [
    ...items.slice(0, Math.min(1, items.length - 1)).map(m => ({ key: m.key, lines: m.collapsed })),
    ...items.slice(Math.max(1, items.length - 2), -1).map(m => ({ key: m.key, lines: m.collapsed })),
    { key: last.key, lines: last.lines.slice(0, last.lines.length - last.quote.length) },
  ];
}

// An endless feed of posts; the page takes as many as it shows.
export function* feedPosts(p) {
  const r = mulberry32(p.seed);
  for (let i = 1; ; i++) {
    const [name, handle] = pick(r, PEOPLE);
    const age = `${1 + Math.floor(r() * 23)}h`;
    let lines;
    if (p.dups && r() < 0.12) lines = [name, `@${handle} · ${age}`, pick(r, DUPS)];
    else {
      lines = [name, `@${handle} · ${age}`, `${sentence(r, 4, r() < 0.3 ? 50 : 18)} p${pad(i)}`];
      if (r() < 0.2) lines.push(sentence(r, 4, 20));
    }
    yield { key: `post-${3000 + i * 7}`, kind: 'post', lines };
  }
}

export const FEED_END = ["You're all caught up"];

// count: how many posts an endless feed's truth holds (a finite one always has its n).
function feed(p, count = p.n) {
  const gen = feedPosts(p);
  const items = Array.from({ length: p.endless ? count : p.n }, () => gen.next().value);
  if (!p.endless) items.push({ key: 'end', kind: 'end', lines: FEED_END });
  return items;
}

// Comment threads: a comment and its replies (hidden behind "View k replies" until shown) are one item.
function comments(p) {
  const r = mulberry32(p.seed);
  const items = [];
  const person = () => pick(r, PEOPLE)[1];
  for (let i = 1; i <= p.n; i++) {
    const dup = p.dups && r() < 0.12;
    const comment = dup ? ['sam_k', '2d', pick(r, DUPS.slice(0, 2))] : [person(), `${1 + Math.floor(r() * 6)}d`, `${sentence(r, 3, r() < 0.3 ? 45 : 16)} c${pad(i)}`];
    const replies = r() < 0.35 ? Array.from({ length: 1 + Math.floor(r() * 4) }, (_, k) => [person(), `${1 + Math.floor(r() * 20)}h`, `${sentence(r, 2, 14)} c${pad(i)}.${k + 1}`]) : [];
    items.push({ key: `cm-${7000 + i * 13}`, comment, replies, lines: [...comment, ...replies.flat()] });
  }
  return items;
}

// The page's whole thread, top to bottom, fully expanded. opts.count: how many feed posts (for an endless feed).
export function truth(page, search = '', opts = {}) {
  const p = params(page, search);
  if (page === 'dm') return conversation(p, ['Joined April 2026', '935 Followers', 'View Profile']);
  if (page === 'chat-reverse') return conversation(p, ['This is the start of your conversation with Kai Moreno']);
  if (page === 'mail') return mail(p);
  if (page === 'feed') return feed(p, opts.count);
  if (page === 'comments') return comments(p);
  throw new Error(`no such thread page: ${page}`);
}

// A row's text as a reader returns it: innerText lines trimmed, empty lines dropped.
export const rowLines = text => text.split('\n').map(s => s.trim()).filter(Boolean);
