// read_all: reads a whole list that loads more as it is scrolled or mounts only the rows near the view (a chat or DM
// thread, an email thread, comments, a feed, an inbox): every item once, top first, and whether its ends were truly
// reached. The read loop works through a small driver (view, wheel, scrollBy, settle, click, now, sleep), so tests run
// it against a simulated list; readAll gives it the real one.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { EXPORT_DIR } from './exports.mjs';
import { privateDir, stamp } from './perf.mjs';
import { collapseText } from './snapshots.mjs';
import { sleep } from './util.mjs';

const STEP = 0.6; // of the box's height per step into unread items: views overlap by 40%
const KNOWN_PAGES = 3; // most per step through items already read
const SETTLE_MS = 6000; // after a step or click, at most: no new request, no DOM change in the box for 300 ms, no busy indicator
const QUIET_MS = 2500; // at an end: this long with nothing new, also after a nudge away and back
const BUSY_MS = 15_000; // a loading indicator stretches that wait up to this
const POLL_MS = 250;
const SNAPBACKS = 3; // steps in a row the page scrolled back by itself before that end is given up
const STUCK_STEPS = 3; // steps in a row the box did not move at all
const MAX_CLICKS = 100;
const BACKOFFS = 2; // views in a row with no overlap that back off half a step before the jump is kept as a gap
const PAGE_MS = 20_000; // one call into the page (the quiet wait inside it is at most SETTLE_MS)
const RESTARTS = 3; // times a read starts over because another element turned out to hold the items

// --- Expanders ---

// Controls read_all clicks to show more of the list, by aria-label else text (at most 60 characters). A count or a word
// like "more" before "reply" or "post" makes it a noun ("View 1 reply", "5 new posts", "Show more posts"), which stays
// allowed; "Reply", "Reply all" and "Post" are verbs and refused.
export const EXPAND_ALLOW = [
  /^(load|show|view|see|read|display) (\d+ )?(more|older|earlier|previous|newer|hidden|remaining|all|full)\b/i,
  /^(show|view|see) (\d+ )?(replies|reply|comments?|answers?|thread)\b/i,
  /^\d+ (more|older|earlier|previous|newer|hidden|new) (messages?|emails?|replies|comments?|posts?|items?|answers?)\b/i,
  /^(show|view) (trimmed|quoted) (content|text)$/i,
  /^expand all$/i,
  /^…?\s*(more|see more|read more)$/i,
];
export const EXPAND_DENY = /\b(send|forward|like|react|delete|remove|archive|report|block|mute|follow|subscribe|buy|pay|purchase|order|book|mark|spam|share|repost|retweet|vote|translate|download|accept|decline|join|leave|edit|save|sign|log ?in|log ?out|settings)|(?<!\b(\d+|more|older|earlier|previous|newer|hidden|new|all|remaining) )\b(reply|post)/i;
export const expandable = (name) => EXPAND_ALLOW.some((r) => r.test(name)) && !EXPAND_DENY.test(name);
const PATTERNS = { allow: EXPAND_ALLOW.map((r) => r.source), deny: EXPAND_DENY.source };

// --- In the page ---

// The page's main scrolling list (no ref): of the boxes that scroll vertically (overflow auto or scroll, also one whose
// content still fits: a thread that grows as it is expanded) and show at least 200x150 px in the viewport (inside open
// shadow roots too), the one with a list role (its own, else inside it), then one that overflows, then the most text;
// the window when the document scrolls and no overflowing box covers half the viewport, or when no box does.
export const FIND_BOX_FN = () => {
  const roles = '[role=log],[role=feed],[role=list],[role=grid],[role=main],main';
  let best = null, cover = 0;
  const check = (el) => {
    const style = getComputedStyle(el);
    if (!/auto|scroll|overlay/.test(style.overflowY) || style.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0), h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    if (w < 200 || h < 150) return;
    const overflows = el.scrollHeight - el.clientHeight > 50;
    if (overflows) cover = Math.max(cover, (w * h) / (innerWidth * innerHeight));
    const score = [el.matches(roles) ? 2 : el.querySelector(roles) ? 1 : 0, overflows ? 1 : 0, el.textContent.length];
    const better = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    if (!best || better(score, best.score) > 0) best = { el, score };
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el !== document.documentElement && el !== document.scrollingElement) check(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const page = document.scrollingElement ?? document.documentElement;
  return (page.scrollHeight - innerHeight > 50 && cover < 0.5) || !best ? page : best.el;
};

// Everything else read_all does in the page, in one function so its parts are shared. box: the scrolling element
// (document.scrollingElement for the window). Node ids live in a WeakMap on the window: a recycled virtual row keeps its
// node and id while its text changes. Positions count from the top, also for a flex column-reverse box.
export const READER_FN = (box, { op, ref, id, item, dy, quietMs, maxMs, allow, deny, repick = false }) => {
  const S = (window[Symbol.for('fowlbrowser.readAll')] ??= { ids: new WeakMap(), els: new Map(), next: 1, lists: new WeakMap() });
  const idOf = (el) => {
    if (!S.ids.has(el)) S.ids.set(el, S.next++);
    return S.ids.get(el);
  };
  const win = box === document.scrollingElement;
  const up = (n) => n.parentElement ?? n.getRootNode().host;
  const inside = (outer, n) => {
    for (; n; n = up(n)) if (n === outer) return true;
    return false;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const viewport = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
  const clip = (r, s = viewport) => ({ top: Math.max(r.top, s.top), bottom: Math.min(r.bottom, s.bottom), left: Math.max(r.left, s.left), right: Math.min(r.right, s.right) });
  const sight = () => (win ? viewport : clip(box.getBoundingClientRect()));
  const pos = () => {
    const max = box.scrollHeight - (win ? innerHeight : box.clientHeight);
    const style = getComputedStyle(box);
    const fromEnd = !win && /flex/.test(style.display) && style.flexDirection === 'column-reverse';
    return { at: Math.round((win ? scrollY : box.scrollTop) + (fromEnd ? max : 0)), max, page: win ? innerHeight : box.clientHeight, height: box.scrollHeight };
  };

  // The element holding the items, of those around or inside ref: a list (list role or tag) with 2+ children holding
  // text and half of the box's text, the outermost such (an open email's paragraphs, or a list inside one item, are not
  // the thread); else the one with the most children holding text, among those with half of the box's text (a quarter
  // when none has). Kept for the box while it still holds half of the text, unless repick (after an expander click).
  // share: how much of the box's text it holds (scripts and styles left out: a page's inline script can outweigh it).
  const UNSEEN = /^(script|style|noscript|template)$/;
  const related = (el) => !ref || inside(el, ref) || inside(ref, el);
  let share = 0;
  const list = () => {
    const root = win ? document.body : box;
    if (!root) return null;
    const sizes = new Map();
    const size = (el) => {
      let n = 0;
      for (const c of el.childNodes) n += c.nodeType === Node.TEXT_NODE ? c.data.trim().length : c.nodeType === Node.ELEMENT_NODE && !UNSEEN.test(c.localName) ? size(c) : 0;
      sizes.set(el, n);
      return n;
    };
    const total = size(root) || 1;
    const kept = S.lists.get(box);
    if (!repick && kept?.isConnected && inside(box, kept) && related(kept) && (sizes.get(kept) ?? 0) >= total / 2) {
      share = sizes.get(kept) / total;
      return kept;
    }
    let best = null, rank = null;
    for (const [el, n] of sizes) { // children before their parents: on a tie the outer one wins
      if (n < total / 4 || !related(el)) continue;
      let count = 0;
      for (const c of el.children) if (sizes.get(c)) count++;
      const listy = count >= 2 && (/^(log|feed|list|grid|table|rowgroup|tree)$/.test(el.getAttribute('role')) || /^(ul|ol|tbody)$/.test(el.localName));
      const r = [n >= total / 2 ? 1 : 0, listy ? 1 : 0, listy ? n : count];
      if (!rank || (r[0] - rank[0] || r[1] - rank[1] || r[2] - rank[2]) >= 0) [best, rank] = [el, r];
    }
    if (best) S.lists.set(box, best);
    share = best ? sizes.get(best) / total : 0;
    return best;
  };

  const CONTROL = 'button, [role=button], summary';
  const allows = allow.map((source) => new RegExp(source, 'i'));
  const denies = new RegExp(deny, 'i');
  const nameOf = (el) => (el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const allowed = (name) => allows.some((r) => r.test(name)) && !denies.test(name);
  const realLink = (n) => {
    for (; n; n = up(n)) if (n.localName === 'a' && n.hasAttribute('href') && !/^\s*(#|javascript:|$)/i.test(n.getAttribute('href'))) return true;
    return false;
  };
  const refused = (el) => realLink(el) || el.getAttribute('type') === 'submit' || (el.localName === 'button' && el.type === 'submit' && !!el.form) ||
    (el.hasAttribute('aria-haspopup') && el.getAttribute('aria-haspopup') !== 'false');
  // A disabled expander is listed (what it hides is not read) but never clicked.
  const disabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';
  // A collapsed item: one that expands in place (Gmail's collapsed messages): the list item (item) itself or an element
  // at most 3 levels into it with no role or a plain one, nothing interactive from it up to the item, and no aria-label
  // that acts ("Mark as unread").
  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role^=menuitem],' +
    '[role=option],[role=tab],[role=slider],[role=textbox],[role=combobox],[role=spinbutton]';
  const collapsed = (el, item) => {
    if (!item || el.getAttribute('aria-expanded') !== 'false' || denies.test(el.getAttribute('aria-label') ?? '')) return false;
    if (el.hasAttribute('role') && !/^(listitem|article|row|treeitem|group|region|none|presentation)$/.test(el.getAttribute('role'))) return false;
    for (let n = el, depth = 0; ; n = up(n), depth++) {
      if (!n || depth > 3 || n.matches(INTERACTIVE)) return false;
      if (n === item) return true;
    }
  };
  // The list item el is in (or is), in the element holding the items.
  const itemOf = (el, c = list()) => {
    while (el && up(el) !== c) el = up(el);
    return el;
  };
  // The expander's name, or null for anything read_all never clicks. item: for a collapsed item, the list item it is in.
  const expander = (el, { main = false, collapsible = false, item = null } = {}) => {
    if (refused(el) || !shown(el)) return null;
    if (collapsible) return collapsed(el, item) ? 'collapsed item' : null;
    const name = nameOf(el);
    return (main ? /^expand all$/i.test(name) : allowed(name)) ? name : null;
  };

  // A child that is a loading indicator, or only an expander ("Load more", Gmail's "13"), is no item.
  const spinner = (el, text) => el.matches('[role=progressbar],[role=status],[aria-busy=true]') || (text.length <= 40 && /^loading\b/i.test(text));
  const onlyControl = (el, text) => {
    const c = el.matches(CONTROL) ? el : el.querySelector(CONTROL);
    return !!c && c.innerText.trim() === text && allowed(nameOf(c));
  };
  // A stable key, only from attributes that name one item: data-key, data-message-id or data-*-<item kind>-<key|id|uuid>
  // (data-row-key, data-feed-item-id) on the item or 3 levels into it, else data-id, data-uuid or a hand-made id on the
  // item itself. Never another data-*-key or -id (a user, author, sender, thread or channel names many items), data-index
  // or aria-posinset (they shift when older rows are prepended) or test ids.
  const KEY = /^data-(key|([\w-]+-)?(item|message|msg|row|entry|post|comment|tweet|status|mail|email|event|record)-(key|id|uuid))$/;
  const OWN = /^(data-id|data-uuid|id)$/;
  const AUTO = /^[:«]|^(radix|react|mui|headlessui|ember|yui|rc-|ng-|_r_)|^[a-z]{0,3}[-_]?\d+$/i;
  const attrKey = (n, re) => {
    for (const a of n.attributes) {
      if (re.test(a.name) && !/test-?id/.test(a.name) && a.value && !(a.name === 'id' && AUTO.test(a.value))) return `${a.name}=${a.value}`;
    }
    return null;
  };
  const keyOf = (el) => {
    let key = attrKey(el, KEY) ?? attrKey(el, OWN);
    for (let level = [...el.children], depth = 1; !key && level.length && depth <= 3; level = level.flatMap((n) => [...n.children]), depth++) {
      for (const n of level) if ((key = attrKey(n, KEY))) break;
    }
    return key;
  };
  // An item's text, without the lines of expanders inside it (Gmail's "•••" for its trimmed content).
  const textOf = (el) => {
    const lines = el.innerText.split('\n');
    for (const c of el.querySelectorAll(CONTROL)) {
      const t = c.innerText.trim();
      const at = t && allowed(nameOf(c)) ? lines.findIndex((line) => line.trim() === t) : -1;
      if (at >= 0) lines.splice(at, 1);
    }
    return lines.join('\n');
  };
  // Items within two pages of the view, in visual order (absolute rows, column-reverse).
  const items = (c, s, page) => {
    const out = [];
    for (const el of c?.children ?? []) {
      const r = el.getBoundingClientRect();
      if (r.bottom < s.top - 2 * page || r.top > s.bottom + 2 * page || UNSEEN.test(el.localName) || getComputedStyle(el).display === 'none') continue;
      const text = el.innerText?.trim();
      if (!text || spinner(el, text) || onlyControl(el, text)) continue;
      out.push({ el, text: textOf(el), key: keyOf(el), node: idOf(el), top: r.top, bottom: r.bottom, left: r.left });
    }
    return out.sort((a, b) => a.top - b.top || a.left - b.left);
  };

  // Loading, in the box and around it: a visible progressbar, aria-busy, a running infinite animation (a spinner), or a
  // status or label saying loading that holds something visible. Not X's empty "Loading messages" slot, always there.
  const busy = (c) => {
    const root = win ? (c?.parentElement ?? document.body) : (box.parentElement ?? box.getRootNode());
    for (const el of root.querySelectorAll('[role=progressbar],[aria-busy=true]')) if (shown(el)) return true;
    const animations = root instanceof ShadowRoot ? root.getAnimations() : root.getAnimations({ subtree: true });
    if (animations.some((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity && a.effect.target instanceof Element && shown(a.effect.target))) return true;
    for (const el of root.querySelectorAll('[role=status],[aria-label]')) {
      if (!/loading/i.test(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('role') === 'status' ? el.textContent : ''}`)) continue;
      if (shown(el) && (el.innerText.trim() || [...el.querySelectorAll('svg,img,canvas')].some(shown))) return true;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t; (t = walker.nextNode());) {
      const text = t.data.trim();
      if (text.length <= 40 && /^loading\b/i.test(text) && t.parentElement && shown(t.parentElement)) return true;
    }
    return false;
  };

  // Expanders within two pages of the view, like items: controls in the box (for the window: around its list), "Expand
  // all" anywhere in the main area around it, and collapsed items. seen: in view now (only those are clicked; the loop
  // steps so the others come into view). edge: above all items (start), below them (end), else middle.
  const expanders = (c, its, s, page) => {
    const scope = win ? (c?.parentElement ?? document.body) : box;
    const first = its[0]?.top ?? Infinity, last = its.at(-1)?.bottom ?? -Infinity;
    const found = new Map();
    const near = { ...s, top: s.top - 2 * page, bottom: s.bottom + 2 * page };
    const add = (el, name, area, edge) => {
      if (!name || found.has(el)) return;
      const r = el.getBoundingClientRect();
      const [around, now] = [clip(r, area === s ? near : area), clip(r, area)];
      if (around.bottom <= around.top || around.right <= around.left) return;
      const n = idOf(el);
      S.els.set(n, new WeakRef(el));
      // owner: the item it is in (or is), which its click changes.
      let owner = el;
      while (owner && up(owner) !== c) owner = up(owner);
      // seen: 16 px of it in view (or all of it): a sliver at the box's edge has no point to click yet; a step brings it in.
      const seen = now.bottom - now.top >= Math.min(r.height, 16) && now.right - now.left >= Math.min(r.width, 16);
      found.set(el, { id: n, name, item: name === 'collapsed item', edge, seen, top: r.top, bottom: r.bottom,
        owner: owner ? idOf(owner) : null, disabled: disabled(el) });
    };
    const edgeOf = (el) => {
      const r = el.getBoundingClientRect();
      return r.bottom <= first + 1 ? 'start' : r.top >= last - 1 ? 'end' : 'middle';
    };
    for (const el of scope.querySelectorAll(CONTROL)) add(el, expander(el), s, edgeOf(el));
    let main = box;
    while (main && !main.matches?.('main,[role=main]')) main = up(main);
    for (const el of main?.querySelectorAll(CONTROL) ?? []) if (!inside(scope, el)) add(el, expander(el, { main: true }), viewport, 'middle');
    for (const it of its) {
      for (const el of [it.el, ...it.el.querySelectorAll('[aria-expanded=false]')]) add(el, expander(el, { collapsible: true, item: it.el }), s, 'middle');
    }
    return [...found.values()];
  };

  // Where to click an expander, checked again (the page may have changed it since it was listed): a point in its visible
  // part where nothing else interactive (a link, another button, a checkbox, a field) is hit or sits between the hit and
  // it. Relative to the box's top left; null when there is none.
  const point = () => {
    const el = S.els.get(id)?.deref();
    if (!el?.isConnected || disabled(el) || !expander(el, { collapsible: item, item: item && itemOf(el) })) return null;
    const r = el.getBoundingClientRect();
    const v = clip(r, inside(box, el) && !win ? sight() : viewport);
    if (v.bottom - v.top < 2 || v.right - v.left < 2) return null;
    const xs = [0.5, 0.25, 0.75].map((f) => v.left + (v.right - v.left) * f);
    const ys = item ? [v.top + Math.min(14, (v.bottom - v.top) / 2), (v.top + v.bottom) / 2] : [0.5, 0.25, 0.75].map((f) => v.top + (v.bottom - v.top) * f);
    const CLICKABLE = `${INTERACTIVE},[contenteditable=""],[contenteditable=true]`;
    for (const y of ys) {
      for (const x of xs) {
        let n = document.elementFromPoint(x, y);
        for (let inner = n?.shadowRoot?.elementFromPoint(x, y); inner && inner !== n; inner = n.shadowRoot?.elementFromPoint(x, y)) n = inner;
        if (!n || !inside(el, n)) continue;
        let clean = true;
        for (; n !== el; n = up(n)) if (n.matches(CLICKABLE)) clean = false;
        const b = box.getBoundingClientRect();
        if (clean) return { dx: x - b.left, dy: y - b.top, w: r.width, h: r.height };
      }
    }
    return null;
  };

  if (op === 'about') return { id: idOf(box), win, tag: box.localName, role: box.getAttribute('role'), label: box.getAttribute('aria-label') };
  if (op === 'pos') return pos();
  if (op === 'list') return { id: list() && idOf(list()), share };
  if (op === 'probe') {
    const c = list();
    return { ...pos(), busy: busy(c), sig: c ? `${c.children.length} ${c.textContent.length}` : '' };
  }
  if (op === 'scroll') {
    if (win) scrollBy(0, dy);
    else box.scrollBy({ top: dy, behavior: 'instant' });
    return pos();
  }
  if (op === 'point') return point();
  // The press itself is bound to the expander: right before it, the point is checked again and capture listeners on
  // the window stop any real press (pointer and mouse down and up, click) whose target is not inside the expander, so
  // a Like or Delete that moved under the point is never pressed. unguard (a moment after the press) removes them and
  // tells what was stopped.
  if (op === 'guard') {
    const at = point();
    if (!at) return null;
    S.guard?.off();
    const el = S.els.get(id).deref();
    const g = { blocked: null };
    const stop = (ev) => {
      if (!ev.isTrusted || ev.composedPath().includes(el)) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      g.blocked ??= (ev.target?.nodeType === 1 && nameOf(ev.target)) || ev.target?.localName || 'another element';
    };
    const TYPES = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    for (const type of TYPES) window.addEventListener(type, stop, true);
    g.off = () => { for (const type of TYPES) window.removeEventListener(type, stop, true); };
    S.guard = g;
    return at;
  }
  if (op === 'unguard') {
    return new Promise((resolve) => setTimeout(() => {
      const g = S.guard;
      S.guard = null;
      g?.off();
      resolve({ blocked: g?.blocked ?? null });
    }, 20));
  }
  if (op === 'quiet') {
    return new Promise((resolve) => {
      const start = performance.now();
      let last = start;
      const observer = new MutationObserver(() => { last = performance.now(); });
      observer.observe(win ? (list()?.parentElement ?? document.body) : box, { subtree: true, childList: true, characterData: true });
      const check = () => {
        const now = performance.now();
        if (now - last < quietMs && now - start < maxMs) return setTimeout(check, 50);
        observer.disconnect();
        resolve({ quiet: now - last >= quietMs, busy: busy(list()) });
      };
      setTimeout(check, 50);
    });
  }
  const c = list();
  const s = sight();
  const p = pos();
  const its = items(c, s, p.page);
  return { ...p, vtop: s.top, vbottom: s.bottom, busy: busy(c), expanders: expanders(c, its, s, p.page), items: its.map(({ el, ...rest }) => rest),
    list: c ? idOf(c) : null, share };
};

// --- Merge ---

// Puts a view (the items the page shows now, top first) into the list read so far. Anchors are items in both: equal
// keys, else the same node with the same text (a recycled row keeps its node with new text). The longest chain of
// anchors in order wins; the runs between and around them are aligned by text (LCS), positionally, never by looking a
// text up anywhere: duplicate-looking items ("ok", "❤️") stay as many as the page has. A changed text in place is an
// update (an expanded message), unmatched new items go in where they show. No anchor: a text overlap of 2 items (or 1 of
// 40+ characters) that fits in one place only; none of that either is a gap, kept only with force: the
// view goes at the end it was moving toward, with a gap marker. Returns { list, first, last, added, updated, gap }:
// first and last are where the view's first and last items are in the new list. Never changes `list` itself; its item
// objects are kept (and their text updated), so the loop can find them again.
export function merge(list, view, { toward = 0, force = false, bad = new Set() } = {}) {
  const stats = { added: 0, updated: 0, stale: 0 };
  const mapped = new Array(view.length);
  const fresh = (j) => {
    stats.added++;
    mapped[j] = { text: view[j].text, key: view[j].key ?? null, node: view[j].node };
    fresh.made.add(mapped[j]);
    return mapped[j];
  };
  fresh.made = new Set();
  const same = (item, j) => {
    delete item.removed;
    if (item.text !== view[j].text) {
      item.text = view[j].text;
      stats.updated++;
    }
    item.key = view[j].key ?? item.key;
    item.node = view[j].node;
    return (mapped[j] = item);
  };
  // A node shows one item: older items it showed (a recycled row) lose it, so they are never anchored through it again.
  // An item taken for new right next to the old item of its node (gap markers aside), reading alike and from the same
  // sender (first line), is probably that one changed in place (stale): counted. Not a row recycled from further off,
  // nor another message that quotes it (a Gmail reply quotes the whole thread).
  const done = (out, gap = false) => {
    const shown = new Set(mapped), nodes = new Map(view.map((v, j) => [v.node, j]));
    const real = out.filter((i) => !i.gap);
    const sender = (a, b) => {
      const [x, y] = [a.split('\n')[0], b.split('\n')[0]];
      return x.startsWith(y) || y.startsWith(x);
    };
    for (const item of out) {
      if (shown.has(item) || !nodes.has(item.node)) continue;
      const j = nodes.get(item.node);
      const near = Math.abs(real.indexOf(item) - real.indexOf(mapped[j])) === 1;
      if (fresh.made.has(mapped[j]) && near && sender(item.text, view[j].text) && similar(item.text, view[j].text)) stats.stale++;
      item.node = null;
    }
    return { list: out, first: out.indexOf(mapped[0]), last: out.indexOf(mapped.at(-1)), ...stats, gap };
  };
  if (!view.length) return { list: [...list], first: -1, last: -1, ...stats, gap: false };
  if (!list.some((item) => !item.gap)) return done(view.map((_, j) => fresh(j)));

  let anchors = anchorChain(list, view, bad);
  if (!anchors.length) anchors = textOverlap(list, view);
  if (!anchors.length) {
    if (!force) return { list, first: -1, last: -1, added: 0, updated: 0, stale: 0, gap: true };
    const items = view.map((_, j) => fresh(j));
    return done(toward < 0 ? [...items, { gap: true }, ...list] : [...list, { gap: true }, ...items], true);
  }

  const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  // Unmatched old items (a) and view items (js) between two matched ones. Between two anchors with as many on both
  // sides, each is an update; else old and new pair up only when the new one is the old one grown in place (see grew:
  // two messages from the same sender and time are not one; a collapsed message and its expanded self meet through
  // the clicked expander's owner, in readList's look), and the rest stay (old) or come in (new): new ones next to the
  // anchor they were seen beside.
  // Old items between two anchors the view shows next to each other are no longer on the page: kept, marked removed.
  const between = (a, js, mode) => {
    if (!js.length) {
      if (mode === 'mid') for (const item of a) item.removed = true;
      return a;
    }
    if (!a.length) return js.map(fresh);
    if (mode === 'mid' && a.length === js.length) return a.map((item, k) => same(item, js[k]));
    const out = [];
    const emit = (olds, news) => out.push(...(mode === 'trail' ? [...news.map(fresh), ...olds] : [...olds, ...news.map(fresh)]));
    let from = 0, news = [];
    for (const j of js) {
      const at = a.findIndex((item, k) => k >= from && grew(item.text, view[j].text));
      if (at < 0) {
        news.push(j);
        continue;
      }
      emit(a.slice(from, at), news);
      out.push(same(a[at], j));
      [from, news] = [at + 1, []];
    }
    emit(a.slice(from), news);
    return out;
  };
  // A run of old items against a run of view items: equal texts matched in order (from the anchor outward), the rest
  // filled in between.
  const run = (a, js, mode) => {
    if (mode === 'mid') a = a.filter((item) => !item.gap); // the view shows what lies between: no gap there now
    const pairs = lcs(a, js.map((j) => view[j]), mode === 'lead');
    const out = [];
    let x = 0, y = 0;
    for (const [px, py] of [...pairs, [a.length, js.length]]) {
      out.push(...between(a.slice(x, px), js.slice(y, py), mode));
      if (px < a.length) out.push(same(a[px], js[py]));
      [x, y] = [px + 1, py + 1];
    }
    return out;
  };

  const out = [];
  const [i0, j0] = anchors[0];
  // Before the first anchor: the view's items there sit right above it, so they meet as many of the list's last ones.
  const lead = list.slice(0, i0);
  const keep = Math.max(0, lead.length - j0);
  out.push(...lead.slice(0, keep), ...run(lead.slice(keep), range(0, j0), 'lead'));
  anchors.forEach(([i, j], k) => {
    out.push(same(list[i], j));
    const next = anchors[k + 1];
    if (next) out.push(...run(list.slice(i + 1, next[0]), range(j + 1, next[1]), 'mid'));
  });
  const [iN, jN] = anchors.at(-1);
  const trail = list.slice(iN + 1);
  const count = view.length - jN - 1;
  out.push(...run(trail.slice(0, count), range(jN + 1, view.length), 'trail'), ...trail.slice(count));
  return done(out);
}

// Pairs (list index, view index) of items that are the same: equal keys (both keyed, not with an attribute found to repeat),
// else the same node with the same text, or with the text grown in place next to an exact anchor (see grew; a recycled row showing another
// message from the same sender at the same time is no anchor; an expander's click updates its item by node before the
// merge, in readList's look), and no keys that differ; then the longest chain increasing in both. A node anchor on a text that repeats needs the first
// different item next to it (past a run of the same text) to agree too, and a view with none (only "ok"s) gives none: a
// pooled row that showed one "ok" and now shows another, or a run of "ok"s one row off, is no anchor.
function anchorChain(list, view, bad) {
  const usable = (key) => key && !bad.has(key.split('=')[0]);
  const byKey = new Map(), byNode = new Map();
  const add = (map, k, i) => map.set(k, [...(map.get(k) ?? []), i]);
  list.forEach((item, i) => {
    if (item.gap) return;
    if (usable(item.key)) add(byKey, item.key, i);
    if (item.node !== null) add(byNode, item.node, i);
  });
  // An exact anchor: the same key, else the same node with the same text.
  const exact = (i, j) => !!list[i] && !list[i].gap && !!view[j] &&
    (usable(view[j].key) ? list[i].key === view[j].key : list[i].node !== null && list[i].node === view[j].node && list[i].text === view[j].text);
  const pairs = [];
  view.forEach((v, j) => {
    const keyed = usable(v.key);
    for (const i of keyed ? byKey.get(v.key) ?? [] : []) pairs.push([i, j, true]);
    for (const i of byNode.get(v.node) ?? []) {
      const item = list[i];
      // Grown in place only with a neighbour that is an exact anchor on the same side: a pooled row now showing a
      // longer message that starts like its old one ("Hello there", then "Hello there again") has none.
      const grown = grew(item.text, v.text) && (exact(i - 1, j - 1) || exact(i + 1, j + 1));
      if ((item.text === v.text || grown) && !(keyed && usable(item.key))) pairs.push([i, j, false]);
    }
  });
  // Longest chain: by view index, then list index falling, so a view item is in it once; strictly rising list index.
  pairs.sort((a, b) => a[1] - b[1] || b[0] - a[0]);
  const tails = [], prev = [];
  pairs.forEach(([i], k) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]][0] < i) lo = mid + 1;
      else hi = mid;
    }
    prev[k] = lo ? tails[lo - 1] : -1;
    tails[lo] = k;
  });
  const chain = [];
  for (let k = tails.length ? tails.at(-1) : -1; k >= 0; k = prev[k]) chain.unshift(pairs[k]);
  const anchored = new Set(chain.map(([i, j]) => `${i} ${j}`));
  const agrees = (i, j) => list[i] && view[j] && (anchored.has(`${i} ${j}`) || (!list[i].gap && list[i].text === view[j].text));
  const counts = new Map();
  for (const item of [...list, ...view]) if (!item.gap) counts.set(item.text, (counts.get(item.text) ?? 0) + 1);
  const solid = (i, j) => {
    for (const dir of [-1, 1]) {
      let k = 1;
      while (view[j + dir * k]?.text === view[j].text) k++;
      if (view[j + dir * k] && agrees(i + dir * k, j + dir * k)) return true;
    }
    return false;
  };
  return chain.filter(([i, j, keyed]) => keyed || counts.get(view[j].text) <= 2 || solid(i, j)).map(([i, j]) => [i, j]);
}

// The view laid on the list where every overlapping item has the same text, over 2 items at least (or 1 of 40+
// characters), when that placement is the only one (a view of only "ok"s fits anywhere in a run of them: none).
function textOverlap(list, view) {
  let best = null;
  for (let o = 1 - view.length; o < list.length; o++) {
    const lo = Math.max(0, -o), hi = Math.min(view.length, list.length - o);
    let ok = hi > lo, long = false;
    for (let j = lo; j < hi && ok; j++) {
      ok = !list[o + j].gap && list[o + j].text === view[j].text;
      long ||= view[j].text.length >= 40;
    }
    if (!ok || (hi - lo < 2 && !long)) continue;
    if (best !== null) return [];
    best = o;
  }
  if (best === null) return [];
  const pairs = [];
  for (let j = Math.max(0, -best); j < Math.min(view.length, list.length - best); j++) pairs.push([best + j, j]);
  return pairs;
}

// Longest common subsequence of texts, as index pairs. fromEnd: ties go to the pairs nearest the ends (an item right
// above an anchor matches the list's item right above it).
function lcs(a, b, fromEnd = false) {
  if (fromEnd) {
    const n = a.length, m = b.length;
    return lcs([...a].reverse(), [...b].reverse()).map(([x, y]) => [n - 1 - x, m - 1 - y]).reverse();
  }
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) dp[x][y] = a[x].text === b[y].text ? dp[x + 1][y + 1] + 1 : Math.max(dp[x + 1][y], dp[x][y + 1]);
  }
  const pairs = [];
  for (let x = 0, y = 0; x < a.length && y < b.length;) {
    if (a[x].text === b[y].text) pairs.push([x++, y++]);
    else if (dp[x + 1][y] >= dp[x][y + 1]) x++;
    else y++;
  }
  return pairs;
}

// The same message grown in place by the page (a lazy footer, a late line): longer, the same first two lines, and every
// line of the old text in the new one in order, exactly or (4+ characters) as the start of a line (a snippet that grew).
// A recycled row with another short message from the same sender and time ("ok", then "lol") is not grown.
export function grew(a, b) {
  const [x, y] = [a.split('\n'), b.split('\n')];
  if (b.length <= a.length || x.slice(0, 2).join('\n') !== y.slice(0, 2).join('\n')) return false;
  let k = 0;
  for (const line of x) {
    while (k < y.length && !(y[k] === line || (line.length >= 4 && y[k].startsWith(line)))) k++;
    if (k++ >= y.length) return false;
  }
  return true;
}

// The same item shown shorter or longer (collapsed and expanded): most lines of one are lines of the other, or begin
// one (a snippet cut with "…"), counting only lines of 4+ characters, at least 2 of them or 20 characters.
export function similar(a, b) {
  if (a === undefined || b === undefined) return false;
  const lines = (t) => t.split('\n').map((l) => l.replace(/(…|\.\.\.)$/, '').trim()).filter((l) => l.length >= 4);
  const covered = (from, to) => {
    const want = lines(from), have = lines(to);
    const hits = want.filter((l) => have.some((h) => h === l || h.startsWith(l)));
    return want.length > 0 && hits.length / want.length >= 0.6 && (hits.length >= 2 || hits.join('').length >= 20);
  };
  return covered(a, b) || covered(b, a);
}

// The view's items as merge takes them: texts collapsed, empty ones dropped, and no key from an attribute that repeats
// within one view (a data-user-id is no item's own): such attributes are noted in bad for the rest of the read.
export function viewItems(items, bad) {
  const seen = new Set();
  for (const item of items) {
    if (!item.key) continue;
    if (seen.has(item.key)) bad.add(item.key.split('=')[0]);
    seen.add(item.key);
  }
  return items.map((item) => ({ ...item, text: collapseText(item.text), key: item.key && !bad.has(item.key.split('=')[0]) ? item.key : null }))
    .filter((item) => item.text);
}

// --- The read ---

export const newState = (extra = {}) => ({ list: [], ends: {}, expanded: new Map(), blocked: new Map(), clicked: new Map(), open: new Map(), expandOff: false, bad: new Set(),
  scripted: false, container: undefined, restarts: 0, mixed: false, share: 1, stale: 0, ...extra });

const MARKER = /this is the beginning|^joined \w+ \d{4}$|^view profile$|you['’]re all caught up|^no more\b|^end of\b/i;

// Reads the list through driver d to the ends asked for, into state s (kept on the tab for continue: its items, and the
// ends it reached). d: view({ repick }) -> { items, list (the element holding them), share (of the box's text), at, max, page, height, vtop, vbottom, busy, expanders: [{ id, name, item,
// edge, seen, top, bottom, owner, disabled }] }, probe() -> { at, max, height, busy, sig: changes when the list does,
// pending }, pending() -> loads the read's scrolling or clicks started still in flight, wheel(dy) -> { moved, at, max },
// scrollBy(dy) -> the same, settle(ms) -> { busy }, click(expander) -> true when pressed, { blocked } when the press met
// another element and was stopped, else false; now(), sleep(ms).
export async function readList(d, s, { direction = 'both', expand = true, maxItems = 2000, maxSeconds = 100 } = {}) {
  const deadline = d.now() + maxSeconds * 1000;
  const over = () => d.now() >= deadline;
  const budget = `stopped after ${maxSeconds} s`;
  let v, at = { top: null, bottom: null, added: 0 }; // the last view, and its first and last items in the list
  let clicks = 0, backoffs = 0, halve = false;
  let grown = 0; // items added by views that met the list: a view kept with a gap (only "ok"s) is no news at an end
  const edge = (sign) => (sign < 0 ? v.at <= 1 : v.at >= v.max - 1); // 1 px either way: fractional positions
  const stop = (end, why) => (s.ends[end] = { reached: false, why });

  // owners: nodes of items an expander click just changed: their entries take the new text first, so they stay one item.
  const look = async (toward = 0, repick = false, owners = []) => {
    v = await d.view({ repick });
    note();
    // Another element holds the items now (the first pick was an open email's paragraphs): what was read is no list.
    if (v.list !== undefined && v.list !== s.container) {
      if (s.container !== undefined && s.list.length && s.restarts < RESTARTS) {
        [s.list, s.ends, at] = [[], {}, { top: null, bottom: null, added: 0 }];
        s.restarts++;
      } else if (s.container !== undefined) s.mixed = true;
      s.container = v.list;
    }
    s.share = v.share ?? 1;
    const items = viewItems(v.items, s.bad);
    for (const node of owners) {
      const [entry, now] = [s.list.find((i) => i.node === node), items.find((i) => i.node === node)];
      if (entry && now) entry.text = now.text;
    }
    let r = merge(s.list, items, { toward, bad: s.bad });
    if (r.gap && toward && backoffs < BACKOFFS) {
      backoffs++;
      halve = true;
      await d.wheel(-toward * v.page * STEP / 2);
      await d.settle(SETTLE_MS);
      return look(toward);
    }
    if (r.gap) r = merge(s.list, items, { toward, bad: s.bad, force: true });
    else {
      backoffs = 0;
      grown += r.added;
    }
    s.list = r.list;
    s.stale += r.stale;
    at = { top: s.list[r.first] ?? at.top, bottom: s.list[r.last] ?? at.bottom, added: r.added, updated: r.updated };
    return r;
  };

  // A control may be clicked again only when its last click brought new items (a "Load more" that stays): a toggle that
  // only changes text ("Show trimmed content") is clicked once. One whose click found no safe point, or whose press was
  // stopped, is not tried again in this call (failed), and stays not opened; a disabled one is never clicked.
  const failed = new Set();
  const clickable = (e) => {
    const k = `${e.id} ${e.name}`, c = s.clicked.get(k);
    return !e.disabled && !failed.has(k) && (!c || c.added);
  };
  // Expanders not opened (s.open, by id and name, kept once they unmount): any seen that is not clicked yet, still
  // brings more or is disabled, and one whose click showed no effect. One clicked that is gone while its item shows is
  // opened; one whose load was still running after its click only once its item shows another text than then.
  const note = () => {
    const listed = new Set();
    for (const e of v.expanders) {
      const k = `${e.id} ${e.name}`;
      listed.add(k);
      if (clickable(e) || e.disabled || s.open.has(k)) s.open.set(k, { ...s.open.get(k), name: e.name, owner: e.owner, disabled: e.disabled });
    }
    const texts = new Map(v.items.map((i) => [i.node, i.text]));
    for (const [k, o] of s.open) {
      const c = s.clicked.get(k);
      if (c?.ok && !listed.has(k) && texts.has(o.owner) && (!c.loading || texts.get(o.owner) !== c.text)) s.open.delete(k);
    }
  };
  // first: before the first view is merged, only "Expand all" and collapsed items, so the read starts from the
  // expanded thread (a collapsed message and its expanded self never meet in a merge).
  const expandHere = async (toward, { first = false } = {}) => {
    while (expand && clicks < MAX_CLICKS && !over()) {
      const next = v.expanders.filter((e) => e.seen && clickable(e) && (!first || e.item || /^expand all$/i.test(e.name)))
        .sort((a, b) => /^expand all$/i.test(b.name) - /^expand all$/i.test(a.name))[0];
      if (!next) return;
      const count = s.list.length, k = `${next.id} ${next.name}`, before = v.expanders.map((e) => `${e.id} ${e.name}`);
      const ownerText = () => v.items.find((i) => i.node === next.owner)?.text;
      const was = ownerText();
      clicks++;
      const pressed = await d.click(next);
      if (pressed !== true) {
        failed.add(k);
        if (pressed?.blocked) s.blocked.set(next.name, (s.blocked.get(next.name) ?? 0) + 1);
        continue;
      }
      const record = { added: false, ok: true };
      s.clicked.set(k, record);
      await d.settle(SETTLE_MS);
      // A load the click started (a collapsed message's body) is waited for before its expansion counts.
      for (const start = d.now(); d.pending() && d.now() - start < BUSY_MS && !over();) await d.sleep(POLL_MS);
      if (first) {
        v = await d.view({ repick: true });
        note();
      } else await look(toward, true, next.owner ? [next.owner] : []);
      // What the click made go away ("Expand all" opens the collapsed items and "13 older messages") is opened by it.
      const after = new Set(v.expanders.map((e) => `${e.id} ${e.name}`));
      for (const b of before) if (b !== k && !after.has(b)) s.open.delete(b);
      record.added = s.list.length > count;
      // Opened only with an effect: the control gone (renamed, no longer collapsed) while its item shows, its item's
      // text changed, or items added; and no load it started still running.
      const now = ownerText();
      const effect = record.added || (was !== undefined && now !== undefined && now !== was) || (!after.has(k) && (next.owner == null || now !== undefined));
      if (d.pending()) Object.assign(record, { loading: true, text: now });
      if (effect && !record.loading) {
        s.open.delete(k);
        s.expanded.set(next.name, (s.expanded.get(next.name) ?? 0) + 1);
      } else s.open.set(k, { name: next.name, owner: next.owner, why: record.loading ? 'still loading' : 'clicked, nothing opened' });
      if (record.added) note(); // to be clicked again: not opened yet
    }
  };

  // Nothing new for QUIET_MS while at that end; a loading indicator, or a load the read's scrolling started still in
  // flight, stretches it up to BUSY_MS. Polled with a cheap probe; the view is read again only when the list's children
  // or text change.
  const quiet = async (sign) => {
    const start = d.now(), count = grown, height = v.height;
    let calm = start, sig = (await d.probe()).sig;
    for (;;) {
      if (over()) return budget;
      await d.sleep(POLL_MS);
      const p = await d.probe();
      if (p.sig !== sig) {
        sig = p.sig;
        await look(sign);
      } else Object.assign(v, p);
      if (grown > count || v.height !== height || !edge(sign)) return 'changed';
      if (p.busy || p.pending) {
        calm = d.now();
        if (d.now() - start >= BUSY_MS) {
          return p.busy ? `a loading indicator was still showing after ${BUSY_MS / 1000} s` : `a request the page started there was still loading after ${BUSY_MS / 1000} s`;
        }
      } else if (d.now() - calm >= QUIET_MS) return 'quiet';
    }
  };
  const evidence = (end) => {
    const item = end === 'start' ? s.list.find((i) => !i.gap) : s.list.findLast((i) => !i.gap);
    const marker = item?.text.split('\n').find((line) => MARKER.test(line));
    return `the ${end === 'start' ? 'top' : 'bottom'} of the list; nothing more loaded within ${QUIET_MS / 1000} s, also after scrolling away and back` +
      (marker ? `; the ${end === 'start' ? 'first' : 'last'} item reads "${marker}"` : '');
  };
  // At an end for now: reached once a wheel turn toward it doesn't move, nothing new comes, also after a nudge away and
  // back, and no expander is left there. null: something came; read on.
  const endCheck = async (sign) => {
    const end = sign < 0 ? 'start' : 'end';
    const count = grown;
    const turned = await d.wheel(sign * v.page * STEP);
    await d.settle(SETTLE_MS);
    await look(sign);
    if (Math.abs(turned.moved) >= 2 || !edge(sign) || grown > count) return null;
    for (const nudged of [false, true]) {
      if (nudged) {
        await d.wheel(-sign * v.page * STEP / 2);
        await d.settle(SETTLE_MS);
        await look(sign);
        await d.wheel(sign * v.page * STEP);
        await d.settle(SETTLE_MS);
        await look(sign);
        if (grown > count || !edge(sign)) return null;
      }
      const q = await quiet(sign);
      if (q === 'changed') return null;
      if (q !== 'quiet') return stop(end, q);
    }
    const left = v.expanders.filter((e) => e.edge === end);
    if (left.length) {
      if (!expand) return stop(end, `a "${left[0].name}" control is left there and expand is off`);
      if (clicks >= MAX_CLICKS) return stop(end, `stopped at ${MAX_CLICKS} expander clicks`);
      if (left.some(clickable)) return null;
      return stop(end, `a "${left[0].name}" control is ${left[0].disabled ? 'disabled there' : 'still there after clicking it'}`);
    }
    return (s.ends[end] = { reached: true, text: evidence(end) });
  };

  // How far one step goes: STEP of a page past what the view already holds beyond its edge; through items already read,
  // up to KNOWN_PAGES as long as the next view still overlaps them; never past an expander ahead not clicked yet (it
  // comes to the middle of the view).
  const step = (sign) => {
    const tops = v.items.map((i) => i.top), bottoms = v.items.map((i) => i.bottom);
    const ahead = Math.max(0, Math.min(2 * v.page, sign < 0 ? v.vtop - Math.min(v.vtop, ...tops) : Math.max(v.vbottom, ...bottoms) - v.vbottom));
    let px = v.page * (halve ? STEP / 2 : STEP) + ahead;
    if (!at.added && !halve && v.items.length) {
      const beyond = sign < 0 ? s.list.indexOf(at.top) : s.list.length - 1 - s.list.indexOf(at.bottom);
      const height = (Math.max(...bottoms) - Math.min(...tops)) / v.items.length;
      px = Math.max(px, Math.min(KNOWN_PAGES * v.page, ahead + Math.max(0, beyond) * height + v.page * STEP));
    }
    const mid = (v.vtop + v.vbottom) / 2;
    for (const e of expand ? v.expanders : []) {
      const centre = (e.top + e.bottom) / 2;
      if (!e.seen && clickable(e) && (centre - mid) * sign > 0) px = Math.min(px, Math.max(20, Math.abs(centre - mid)));
    }
    halve = false;
    return px;
  };

  const toEnd = async (sign) => {
    const end = sign < 0 ? 'start' : 'end';
    let snaps = 0, stuck = 0;
    for (;;) {
      if (over()) return stop(end, budget);
      await expandHere(sign);
      if (over()) return stop(end, budget);
      if (s.list.filter((i) => !i.gap).length >= maxItems) return stop(end, `stopped at max_items (${maxItems})`);
      if (edge(sign)) {
        if (await endCheck(sign)) return;
        continue;
      }
      const was = sign < 0 ? at.top : at.bottom;
      const px = step(sign);
      let landed = await d.wheel(sign * px);
      // The wheel didn't move it, though it isn't at that end: scrolled by script instead.
      if (Math.abs(landed.moved) < 2 && !(sign < 0 ? landed.at <= 1 : landed.at >= landed.max - 1)) {
        landed = await d.scrollBy(sign * px);
        s.scripted = true;
      }
      stuck = Math.abs(landed.moved) < 2 ? stuck + 1 : 0;
      if (stuck >= STUCK_STEPS) return stop(end, 'the list would not scroll any further, neither by wheel nor by script');
      await d.settle(SETTLE_MS);
      const r = await look(sign);
      // Scrolled back by the page: once settled, the box went back over half the step, or the view's leading item is
      // behind where it was; not when items came in (a prepend with scroll anchoring moves the position too).
      const before = was ? s.list.indexOf(was) : -1;
      const now = s.list.indexOf(sign < 0 ? at.top : at.bottom);
      const back = (v.at - landed.at) * sign < -Math.abs(landed.moved) / 2 || (before >= 0 && now >= 0 && (sign < 0 ? now > before : now < before));
      if (!r.gap && !r.added && Math.abs(landed.moved) >= 2 && back) {
        if (++snaps >= SNAPBACKS) return stop(end, 'the page kept scrolling itself back');
      } else snaps = 0;
    }
  };

  s.ends = {}; // continue: both ends are checked again, also one reached before (the list may have grown there)
  s.expandOff = !expand;
  if (!s.list.length) {
    v = await d.view();
    note();
    await expandHere(0, { first: true });
  }
  await look(0);
  const order = direction === 'up' ? [-1] : direction === 'down' ? [1] : edge(1) && !edge(-1) ? [1, -1] : [-1, 1];
  // A restart (another element holds the items) clears the ends reached, so they are read again.
  for (let pass = 0; pass <= RESTARTS && order.some((sign) => !s.ends[sign < 0 ? 'start' : 'end']); pass++) {
    for (const sign of order) if (!s.ends[sign < 0 ? 'start' : 'end']) await toEnd(sign);
  }
  return s;
}

// --- Result ---

const GAP_LINE = '[gap: the list jumped here; items may be missing]';
const asked = (direction) => (direction === 'up' ? ['start'] : direction === 'down' ? ['end'] : ['start', 'end']);
const howOn = (why) => (/^stopped after/.test(why) ? 'call read_all again with continue: true and a larger max_seconds'
  : /max_items/.test(why) ? 'call read_all again with continue: true and a larger max_items'
    : /loading indicator|still loading/.test(why) ? 'the page was still loading; call read_all again with continue: true in a moment'
      : /expand is off/.test(why) ? 'call read_all again with continue: true and expand: true'
        : /expander clicks/.test(why) ? 'call read_all again with continue: true'
          : 'tell the user the list could not be read to its end there');

// The summary lines and the item blocks of a read.
export function layout(s, { what, direction, note }) {
  const count = s.list.filter((i) => !i.gap).length;
  const lines = [`Read ${what}: ${count} item${count === 1 ? '' : 's'}, top first.`];
  if (note) lines.push(note);
  for (const end of ['start', 'end']) {
    const label = end === 'start' ? 'Start' : 'End';
    const e = s.ends[end];
    lines.push(e?.reached ? `${label}: reached (${e.text}).`
      : e ? `${label}: not reached (${e.why}). More may exist ${end === 'start' ? 'above' : 'below'}.`
        : `${label}: not read (direction "${direction}").`);
  }
  const clicks = [...s.expanded.values()].reduce((a, b) => a + b, 0);
  const kinds = [...s.expanded].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  const stopped = [...(s.blocked ?? new Map())].map(([name, n]) => `"${name}"${n > 1 ? ` ×${n}` : ''}`);
  if (clicks || stopped.length) {
    lines.push(`Expanded: ${clicks}${clicks ? ` (${[...kinds.slice(0, 10), ...(kinds.length > 10 ? [`and ${kinds.length - 10} more kinds`] : [])].join('; ')})` : ''}` +
      `${stopped.length ? `; presses stopped because another element was under the pointer, nothing was clicked there: ${stopped.slice(0, 5).join(', ')}` +
        `${stopped.length > 5 ? ` and ${stopped.length - 5} more` : ''}` : ''}.`);
  }
  if (s.scripted) lines.push('Where the mouse wheel did not move this list, it was scrolled by script.');
  const open = asked(direction).filter((end) => !s.ends[end]?.reached);
  const gaps = s.list.some((i) => i.gap);
  const partial = s.mixed || s.share < 0.5; // the items hold under half of the box's text, or their element kept changing
  if (partial) lines.push(`The items read hold ${Math.round(s.share * 100)}% of the text in what was read${s.mixed ? ', and the element holding them kept changing' : ''}: they may be parts of the real items, or miss some.`);
  if (s.stale) lines.push(`${s.stale} item${s.stale === 1 ? '' : 's'} may be an older copy of another one (the page changed ${s.stale === 1 ? 'it' : 'them'} in place while ${s.stale === 1 ? 'it was' : 'they were'} read).`);
  const removed = s.list.filter((i) => i.removed).length;
  if (removed) lines.push(`${removed} item${removed === 1 ? '' : 's'} read earlier ${removed === 1 ? 'is' : 'are'} no longer shown between ${removed === 1 ? 'its' : 'their'} neighbours.`);
  const shut = [...s.open.values()].map((o) => `"${o.name}"${o.disabled ? ' (disabled)' : o.why ? ` (${o.why})` : ''}`);
  if (shut.length) {
    lines.push(`${shut.length} control${shut.length === 1 ? '' : 's'} ${s.expandOff ? 'left collapsed (expand: false)' : 'not opened'}: ${shut.slice(0, 5).join(', ')}` +
      `${shut.length > 5 ? ` and ${shut.length - 5} more` : ''}; what ${shut.length === 1 ? 'it hides' : 'they hide'} is missing.`);
  }
  if (!open.length && !gaps && !partial && !s.stale && !removed && !shut.length) lines.push('Complete: yes.');
  else {
    const where = [...open.map((end) => (end === 'start' ? 'items above the first one' : 'items below the last one')), ...(gaps ? ['items where a [gap] line is'] : []),
      ...(partial ? ['items outside the element read'] : []), ...(s.stale || removed ? ['the newest text of some items'] : []), ...(shut.length ? ['what the controls not opened hide'] : [])];
    const hows = [...new Set([...open.map((end) => howOn(s.ends[end]?.why ?? '')),
      ...(gaps ? ['the list jumped while it was read; call read_all again without continue to read it once more'] : []),
      ...(partial ? ['call snapshot, then read_all with ref of one item of the list'] : []),
      ...(s.stale || removed ? ['call read_all again without continue'] : []),
      ...(shut.length ? [s.expandOff ? 'call read_all again with continue: true and expand: true' : 'call read_all again with continue: true, or tell the user what they hide was not read'] : [])])];
    const sentence = where.join(' and ');
    lines.push(`Complete: NO. ${sentence[0].toUpperCase()}${sentence.slice(1)} may be missing; ${hows.join('; ')}.`);
  }
  let n = 0;
  return { lines, blocks: s.list.map((i) => (i.gap ? GAP_LINE : `[${++n}] ${i.text}`)) };
}

// The result text, within maxChars: when longer, the whole of it goes to file (written by save) and the first items
// that fit are shown, with a line saying where the rest is. A summary too long for maxChars by itself is cut short
// before its last line (Complete); the line about the file always stays.
export async function fit(head, { lines, blocks }, maxChars, save) {
  const full = [head, ...lines, '', blocks.join('\n\n')].join('\n');
  if (full.length <= maxChars) return full;
  const file = await save(full);
  const total = blocks.filter((b) => b !== GAP_LINE).length;
  const note = (shown) => `All ${total.toLocaleString('en-US')} items (${full.length.toLocaleString('en-US')} chars) are in ${file}; shown here: ` +
    `${shown ? `items 1–${shown}` : 'none'}. Read the file before answering about the whole list.`;
  let top = [head, ...lines].join('\n');
  const over = top.length + note(total).length + 1 - maxChars;
  if (over > 0) {
    const last = lines.at(-1);
    top = `${top.slice(0, Math.max(0, top.length - last.length - 1 - over - 1))}…\n${last}`;
  }
  let room = maxChars - top.length - note(total).length - 3;
  const shown = [];
  for (const block of blocks) {
    if (block.length + 2 > room) break;
    shown.push(block);
    room -= block.length + 2;
  }
  const count = shown.filter((b) => b !== GAP_LINE).length;
  return count ? [top, note(count), '', shown.join('\n\n')].join('\n') : [top, note(0)].join('\n');
}

async function saveRead(tab, body) {
  privateDir(EXPORT_DIR);
  const file = path.join(await fs.mkdtemp(path.join(EXPORT_DIR, 'read-all-')), `${tab.id.replace(':', '-')}-${stamp()}.txt`);
  await fs.writeFile(file, body, { mode: 0o600 });
  return file;
}

// --- The tool ---

export const READ_ALL_DESCRIPTION =
  'Read a whole list, every item once, top first: a chat or DM thread, an email thread, comments, a feed, search results or an inbox that ' +
  'loads more as you scroll or shows only the rows near the view: snapshot and scroll show only part of such a list. It turns the mouse ' +
  'wheel over the list to its start and its end, waits for what loads, and says whether each end was truly reached. With expand (default) ' +
  'it also clicks controls that show more of the list ("Load more", "13 older messages", "View 3 replies", "Show trimmed content", ' +
  '"Expand all", collapsed messages), never links or anything that sends, likes, deletes or changes settings. ' +
  'If the result says Complete: NO, tell the user what may be missing.';

export const readAllShape = (tabArg) => ({
  tab: tabArg,
  ref: z.string().optional().describe('Ref of the list, or of any element in it (e.g. one message), from the latest snapshot. Default: the page\'s main scrolling list.'),
  direction: z.enum(['both', 'up', 'down']).optional().describe('"up": from here to the start only; "down": from here to the end only; "both" (default): both ends.'),
  expand: z.boolean().optional().describe('Click controls that show more of the list (default true). They never send, like, delete or change anything.'),
  max_items: z.number().int().min(10).max(10_000).optional().describe('Stop after this many items (default 2000).'),
  max_seconds: z.number().positive().max(600).optional().describe('Stop after this many seconds (default 100, at most 600).'),
  max_chars: z.number().int().min(1000).max(200_000).optional().describe('Most characters returned (default 40000); a longer result is saved to a file whose path is given.'),
  continue: z.boolean().optional().describe('Resume an earlier incomplete read_all of the same list in this tab: its items are kept, and both ends are checked again.'),
});

const describeBox = ({ tag, role, label }) => (role ? `${role}${label ? ` "${label}"` : ''}` : label ? `<${tag}> "${label}"` : `<${tag}>`);

// deps (from tools.mjs): header, locator, pointed, wheelLanded, boxPoint, refuseBlockedPage, SCROLL_TARGET_FN.
export async function readAll(tab, args, deps) {
  const { header, locator, pointed, wheelLanded, boxPoint, refuseBlockedPage, SCROLL_TARGET_FN } = deps;
  const generation = tab.documentGeneration;
  const url = tab.page.url();
  const before = tab.blockedPageAt;
  const handles = [];
  // Loads the read started: xhr and fetch requests that begin within 1.5 s of a wheel turn, scroll or expander click,
  // kept until their body is in or they fail (not at their response headers) whatever later inputs do. An end is not
  // reached, and a click's expansion does not count, while one is in flight.
  let turned = -Infinity;
  const loads = new Set();
  const onRequest = (r) => { if (/^(xhr|fetch)$/.test(r.resourceType()) && Date.now() - turned <= 1500) loads.add(r); };
  const onDone = (r) => loads.delete(r);
  tab.page.on('request', onRequest);
  tab.page.on('requestfinished', onDone);
  tab.page.on('requestfailed', onDone);
  const held = (h) => {
    handles.push(h);
    return h.asElement();
  };
  try {
    const ref = args.ref ? held(await locator(tab, args.ref).elementHandle()) : null;
    let box = ref ? held(await ref.evaluateHandle(SCROLL_TARGET_FN, true)) : held(await tab.page.evaluateHandle(FIND_BOX_FN));
    if (!box && ref) box = held(await ref.evaluateHandle(() => document.scrollingElement ?? document.documentElement));
    const call = async (op, extra = {}) => {
      if (tab.dialog) throw new Error('A dialog opened while the list was read. Resolve it with the dialog tool, then call read_all again with continue: true.');
      const gone = () => new Error(`The page navigated away while the list was read (now ${tab.page.url()}), so it was not read to the end.`);
      if (tab.documentGeneration !== generation) throw gone();
      let timer;
      const late = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The page did not answer for ${PAGE_MS / 1000} s while the list was read (its script is busy or stuck). Try again shortly.`)), PAGE_MS);
      });
      try {
        return await Promise.race([box.evaluate(READER_FN, { op, ref, ...PATTERNS, ...extra }), late]);
      } catch (error) {
        throw tab.documentGeneration !== generation ? gone() : error;
      } finally {
        clearTimeout(timer);
      }
    };

    // Only requests that start after an input count: long polls and streams the page keeps open don't hold every step.
    let since = new Set(tab.inflight);
    const fresh = () => [...tab.inflight].some((r) => !since.has(r));
    const pending = () => loads.size;
    const d = {
      now: () => Date.now(),
      sleep,
      pending,
      view: ({ repick } = {}) => call('view', { repick }),
      probe: async () => ({ ...(await call('probe')), pending: pending() }),
      async wheel(dy) {
        since = new Set(tab.inflight);
        const read = () => call('pos');
        const start = await read();
        // Not over something covering the box: the wheel would scroll that instead (the loop scrolls by script then).
        const p = await boxPoint(box);
        if (!p?.reached) return { ...start, moved: 0 };
        await tab.page.mouse.move(p.x, p.y);
        turned = Date.now();
        await tab.page.mouse.wheel(0, dy);
        const landed = await wheelLanded(read, start, Math.sign(dy));
        return { ...landed, moved: landed.at - start.at };
      },
      async scrollBy(dy) {
        since = new Set(tab.inflight);
        const start = await call('pos');
        turned = Date.now();
        const end = await call('scroll', { dy });
        return { ...end, moved: end.at - start.at };
      },
      async settle(ms) {
        const end = Date.now() + ms;
        let busy = false;
        while (Date.now() < end) {
          if (fresh() || pending()) {
            await sleep(100);
            continue;
          }
          const q = await call('quiet', { quietMs: 300, maxMs: Math.max(0, end - Date.now()) });
          busy = q.busy;
          if (q.quiet && !busy && !fresh() && !pending()) break;
        }
        return { busy };
      },
      async click(e) {
        since = new Set(tab.inflight);
        const p = await call('point', { id: e.id, item: e.item });
        const b = p && await box.boundingBox();
        if (!b) return false;
        // Checked once more after the cursor's travel, right before the press, and the press guarded in the page: the
        // page may have moved it meanwhile, or move it during the press.
        let blocked = null;
        const pressed = await pointed(tab, { x: b.x + p.dx, y: b.y + p.dy, w: p.w, h: p.h }, async () => {
          const q = await call('guard', { id: e.id, item: e.item });
          if (!q) return false;
          try {
            const c = await box.boundingBox();
            if (!c) return false;
            turned = Date.now();
            await tab.page.mouse.click(c.x + q.dx, c.y + q.dy);
            return true;
          } finally {
            ({ blocked } = (await call('unguard').catch(() => null)) ?? {});
          }
        });
        if (!pressed) return false;
        if (blocked) return { blocked };
        if (tab.documentGeneration !== generation || tab.page.url() !== url) {
          throw new Error(`Clicking "${e.name}" to show more of the list changed the page (now ${tab.page.url()}), so the read stopped. Call snapshot to see where it went.`);
        }
        return true;
      },
    };

    const about = await call('about');
    const prior = tab.readAll;
    const resume = args.continue && prior?.generation === generation && prior.box === about.id;
    const s = resume ? prior : newState({ generation, box: about.id });
    tab.readAll = s;
    const direction = args.direction ?? 'both';
    await readList(d, s, { direction, expand: args.expand !== false, maxItems: args.max_items ?? 2000, maxSeconds: args.max_seconds ?? 100 });
    refuseBlockedPage(tab, before); // it went there while the list was read
    if (!s.list.length) {
      throw new Error(`No list found: ${args.ref ? `nothing around ${args.ref}` : 'nothing on this page'} holds items with text. If the list is there, pass ref ` +
        'of one of its items from a snapshot.');
    }
    const what = about.win ? (args.ref ? `the page (nothing around ${args.ref} scrolls on its own)` : 'the page')
      : args.ref ? `the box around ${args.ref} (${describeBox(about)})` : `the scrolling list <${about.tag}>${about.role || about.label ? ` (${describeBox(about)})` : ''}`;
    const note = args.continue && !resume ? 'There was no earlier read of this list on this page to continue, so it was read from the start.' : null;
    return fit(await header(tab), layout(s, { what, direction, note }), args.max_chars ?? 40_000, (body) => saveRead(tab, body));
  } finally {
    tab.page.off('request', onRequest);
    tab.page.off('requestfinished', onDone);
    tab.page.off('requestfailed', onDone);
    for (const h of handles) h.dispose().catch(() => {});
  }
}
