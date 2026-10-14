// Pure text helpers for what agents read: size caps, ref numbering, changes-only snapshots, page text, evaluate source, URL patterns.

export const SNAPSHOT_MAX_CHARS = 12_000; // default cap of every snapshot an agent receives
// Claude Code takes an MCP result of up to 50,000 characters without counting it (it estimates characters / 4) and counts
// a larger one against 25,000 tokens, which a snapshot (under 2.4 characters per token) passes at about 58,000: so the
// largest snapshot, with its header lines, stays under 50,000.
export const SNAPSHOT_MAX_CHARS_LIMIT = 40_000;
const DIFF_SHARE = 0.6; // a changes-only result larger than this share of the full snapshot is replaced by the full one
const REMOVED_SHOWN = 40;

// Cuts text at a line boundary so the result, including the closing note line, is at most max characters.
export function cap(text, max, note) {
  if (text.length <= max) return text;
  const total = text.split('\n').length;
  const footer = (omitted) => `... [${omitted} more line${omitted === 1 ? '' : 's'} not shown. ${note}]`;
  const budget = Math.max(0, max - footer(total).length - 1);
  const cut = text.lastIndexOf('\n', budget);
  const kept = cut > 0 ? text.slice(0, cut) : '';
  const omitted = total - (kept ? kept.split('\n').length : 0);
  return `${kept}${kept ? '\n' : ''}${footer(omitted)}`;
}

// --- Refs agents see ---
// Playwright numbers refs per document (e1, e2, ... again on every page; after the first navigation from a real page
// the main frame's refs carry a frame prefix, f3e1), so a ref from an older page could name an element of the new
// one. Agents see main-frame refs as e<N + base>, unique in the tab: each document's numbers start above every
// number shown before (base = highest so far). The first page keeps base 0, so its refs are Playwright's own.
// Iframe refs keep their prefix: f<seq>e<N + base>. Playwright keeps a frame's seq when the iframe loads a new
// document, whose numbers restart at e1, so each prefix has its own base, raised the same way when the main page
// or any iframe (frameGeneration, tab-wide) has loaded a new document since that prefix was last numbered.
const REF_TOKEN = /\[ref=(f\d+)?e(\d+)\]/g;
export const REF_PATTERN = /^(f\d+)?e\d+$/;

// mainPrefixes: every prefix seen outside iframe subtrees. A page restored from the back/forward cache keeps the refs
// Playwright gave its elements on the earlier visit, whose prefix names a main frame number Playwright has retired.
export const newRefState = () => ({ generation: null, base: 0, max: 0, main: null, mainPrefixes: new Set(), frames: new Map() });

// Prefixes of the refs outside iframe subtrees, in order. An iframe's own line belongs to its parent frame.
function mainFramePrefixes(text) {
  const prefixes = [];
  let iframeLevel = null;
  for (const line of text.split('\n')) {
    const level = indent(line);
    if (iframeLevel !== null && level > iframeLevel) continue;
    iframeLevel = /^\s*- iframe\b/.test(line) ? level : null;
    const ref = /\[ref=(f\d+)?e\d+\]/.exec(line);
    if (ref) prefixes.push(ref[1] ?? '');
  }
  return prefixes;
}

// Rewrites the refs of a snapshot of document `generation`, read while the tab's iframes were at `frameGeneration`.
// whole: a whole-page snapshot, whose first ref outside an iframe tells the main frame's prefix.
export function numberRefs(state, text, generation, { whole = true, frameGeneration = 0 } = {}) {
  if (state.generation !== generation) Object.assign(state, { generation, base: state.max, main: null, mainPrefixes: new Set() });
  if (whole) {
    const prefixes = mainFramePrefixes(text);
    if (state.main === null && prefixes.length) state.main = prefixes[0];
    for (const prefix of prefixes) state.mainPrefixes.add(prefix);
  }
  return text.replace(REF_TOKEN, (token, prefix = '', n) => {
    if (prefix !== state.main) {
      let frame = state.frames.get(prefix);
      if (!frame) state.frames.set(prefix, frame = { generation, frameGeneration, base: 0, max: 0 });
      if (frame.generation !== generation || frame.frameGeneration !== frameGeneration) {
        Object.assign(frame, { generation, frameGeneration, base: frame.max });
      }
      const shown = Number(n) + frame.base;
      frame.max = Math.max(frame.max, shown);
      return `[ref=${prefix}e${shown}]`;
    }
    const shown = Number(n) + state.base;
    state.max = Math.max(state.max, shown);
    return `[ref=e${shown}]`;
  });
}

// The Playwright ref for a ref an agent passed, or null when it is from an earlier page of the tab or of its iframe
// (or the tab has no snapshot of its current page yet). Anything else (not a ref, never shown) goes to Playwright as it is.
export function playwrightRef(state, ref, generation, frameGeneration = 0) {
  const match = /^(f\d+)?e(\d+)$/.exec(ref);
  if (!match) return ref;
  if (!state || state.generation !== generation) return null;
  const [, prefix, n] = match;
  if (prefix) {
    const frame = state.frames.get(prefix);
    if (!frame || frame.generation !== generation || frame.frameGeneration !== frameGeneration || Number(n) <= frame.base) return null;
    return `${prefix}e${Number(n) - frame.base}`;
  }
  if (Number(n) <= state.base) return null;
  return `${state.main ?? ''}e${Number(n) - state.base}`;
}

// The ref the agent saw for a Playwright ref (to name it in errors).
export function shownRef(state, ref) {
  const match = /^(f\d+)?e(\d+)$/.exec(ref);
  if (!state || !match) return ref;
  const prefix = match[1] ?? '';
  if (prefix === state.main) return `e${Number(match[2]) + state.base}`;
  const frame = state.frames.get(prefix);
  return frame ? `${prefix}e${Number(match[2]) + frame.base}` : ref;
}

// --- Changes-only snapshots ---

const indent = (line) => line.length - line.trimStart().length;

// Each line's key is the line plus its ancestors (by indentation). An ancestor with a ref is known by its ref (so a
// parent whose name or state changes, like [active], keeps its children unchanged), one without by its own key.
// Interned in `ids` so both texts share them.
function keyLines(lines, ids) {
  const stack = [];
  return lines.map((line) => {
    if (!line.trim()) return null;
    const level = indent(line);
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    const key = `${stack.at(-1)?.id ?? ''}|${line}`;
    const ref = /\[ref=(\w+)\]/.exec(line)?.[1];
    const identity = ref ? `[ref=${ref}]` : key;
    if (!ids.has(identity)) ids.set(identity, ids.size);
    stack.push({ level, id: ids.get(identity) });
    return key;
  });
}

// Lines of `next` that are not in `previous` under the same ancestors (a multiset of lines keyed by their ancestor
// chain, so a changed name or state, or a move to another parent, is a removal plus an addition), each shown with
// its ancestor lines for context, and the removed lines. since/number: the snapshot numbers of previous and next.
// Returns null when the changes are not much smaller than the full text, or when lines kept their place in the
// tree but changed order (reordered siblings): a diff cannot show that, the full snapshot can.
export function snapshotChanges(previous, next, { since, number } = {}) {
  const ids = new Map();
  const before = previous.split('\n');
  const unmatched = new Map(); // key -> indices in previous not matched yet, in order
  keyLines(before, ids).forEach((key, i) => {
    if (key === null) return;
    if (!unmatched.has(key)) unmatched.set(key, []);
    unmatched.get(key).push(i);
  });
  const lines = next.split('\n');
  const added = new Set();
  let last = -1;
  for (const [i, key] of keyLines(lines, ids).entries()) {
    if (key === null) continue;
    const match = unmatched.get(key)?.shift();
    if (match === undefined) added.add(i);
    else if (match < last) return null;
    else last = match;
  }
  const removed = [...unmatched.values()].flat().sort((a, b) => a - b).map((i) => before[i].trim());
  if (!added.size && !removed.length) return `No changes since snapshot ${since} of this tab; this is snapshot ${number}.`;
  // Ancestors: walking up, every line indented less than the last one kept.
  const shown = new Set(added);
  for (const i of added) {
    let level = indent(lines[i]);
    for (let j = i - 1; j >= 0 && level > 0; j--) {
      if (!lines[j].trim() || indent(lines[j]) >= level) continue;
      level = indent(lines[j]);
      if (shown.has(j)) break; // its ancestors are in already
      shown.add(j);
    }
  }
  const out = [`Changes since snapshot ${since} of this tab; this is snapshot ${number} (call snapshot for the whole page).`,
    'Lines starting with + are new or changed (use their refs); the other lines are their parent elements, for context.'];
  if (added.size) out.push(...[...shown].sort((a, b) => a - b).map((i) => `${added.has(i) ? '+ ' : '  '}${lines[i]}`));
  else out.push('No new or changed lines.');
  if (removed.length) {
    out.push(`Removed (${removed.length} line${removed.length === 1 ? '' : 's'}, no longer on the page):`);
    out.push(...removed.slice(0, REMOVED_SHOWN).map((line) => `- ${line}`));
    if (removed.length > REMOVED_SHOWN) out.push(`... and ${removed.length - REMOVED_SHOWN} more removed lines.`);
  }
  const result = out.join('\n');
  return result.length > next.length * DIFF_SHARE ? null : result;
}

// innerText, whitespace collapsed within each line, empty lines dropped.
export function collapseText(text) {
  return text.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// evaluate's source as a function expression to call (with the element for a ref): the source is evaluated as an
// expression and, if that gives a function, it is called. So "() => 1", "(function () {...})", "el => el.id" and
// "document.title" all work. Newlines keep a trailing // comment from swallowing the closing parenthesis.
export function functionSource(source, { withElement = false } = {}) {
  const expression = source.trim().replace(/;\s*$/, '');
  const arg = withElement ? 'el' : '';
  return `(${arg}) => { const value$ = (\n${expression}\n); return typeof value$ === 'function' ? value$(${arg}) : value$; }`;
}

// wait_for url: with a *, a glob over the whole URL where * matches anything (also "/"); otherwise a substring.
export function urlMatcher(pattern) {
  if (!pattern.includes('*')) return (url) => url.includes(pattern);
  const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return (url) => regex.test(url);
}

// The lines of a snapshot that contain `query` (any case), each with the lines it sits in (its ancestors, for
// context) and what it holds (up to `subtree` lines below it), in snapshot order; "# …" marks lines left out.
// { text, matches }. For finding a control on a big page without reading all of it (snapshot find).
export function findInSnapshot(text, query, { subtree = 12 } = {}) {
  const lines = text.split('\n');
  const indent = (line) => line.length - line.trimStart().length;
  const q = query.toLowerCase();
  const keep = new Set();
  let matches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(q)) continue;
    matches++;
    keep.add(i);
    for (let j = i - 1, level = indent(lines[i]); j >= 0 && level > 0; j--) {
      if (lines[j].trim() && indent(lines[j]) < level) {
        keep.add(j);
        level = indent(lines[j]);
      }
    }
    for (let j = i + 1, n = 0; j < lines.length && indent(lines[j]) > indent(lines[i]) && n < subtree; j++, n++) keep.add(j);
  }
  const out = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`${' '.repeat(indent(lines[i]))}# …`);
    out.push(lines[i]);
    last = i;
  }
  if (out.length && last < lines.length - 1) out.push('# …');
  return { text: out.join('\n'), matches };
}
