// MCP tools. Every tab-level tool takes an explicit tab id like "helium:1834"; there is no current tab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './browsers.mjs';
import { registerBrowserData } from './browserData.mjs';
import { callOnShadowRef, cleanRef, closedShadowSection, focusShadowRef, isShadowRef, shadowRefCenter, shadowRefPoint } from './closedShadow.mjs';
import * as cursor from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { EXPORT_DESCRIPTION, exportShape, exportTab } from './exports.mjs';
import { registerPerf } from './perf.mjs';
import { backgroundClick, openingLines, uninstallPopups } from './popups.mjs';
import * as record from './record.mjs';
import * as takeover from './takeover.mjs';
import { callsByTab } from './turns.mjs';
import { sleep, tabInfo, within } from './util.mjs';
import { clearViewport, MAX_SIZE, MIN_SIZE, setViewport } from './viewport.mjs';
import { cap as capText, collapseText, functionSource, newRefState, numberRefs, playwrightRef, REF_PATTERN, shownRef, SNAPSHOT_MAX_CHARS, SNAPSHOT_MAX_CHARS_LIMIT,
  snapshotChanges, urlMatcher } from './snapshots.mjs';

const MAX_CHARS = 80_000; // ~20k tokens, for evaluate, console and network output
const POPUP_WAIT_MS = 2000; // after an action the page asked for a new tab: how long to wait for the extension to announce it
// Tools that still work on a parked tab (taken over by the user, or handed to them); every other one gets its notice.
const ON_PARKED_TABS = new Set(['tab_claim', 'tab_release', 'tab_close', 'tab_focus']);

// --- Schemas shared by many tools ---

const tabArg = z.string().describe(
  'Tab id "<browser>:<id>", e.g. "helium:1834" or "chrome:52", from tab_open, tab_claim or tab_list. The prefix is the browser the tab lives in.');
const refArg = z.string().describe('Element ref from the latest snapshot of this tab, e.g. "e12" (shown as [ref=e12]).');
const shadowRefArg = z.string().describe('Element ref from the latest snapshot of this tab, e.g. "e12" (shown as [ref=e12]), or "s3" for a control inside a closed shadow root.');
const snapshotArg = z.boolean().optional().describe(
  'Return the page snapshot after the action (default true): on the same page only what changed since the tab\'s previous snapshot, else the whole page. Pass false to save tokens.');
const timeoutArg = z.number().int().positive().optional().describe(`Timeout in ms (default ${ACTION_TIMEOUT_MS} for actions, ${NAVIGATION_TIMEOUT_MS} for navigation).`);
const browserArg = z.string().describe(
  'Browser name from browser_list, e.g. "chrome" (Google Chrome) or "helium". Pick it on purpose: the one the user named (by app or by the name they gave it, like "Work"), or the one where the site and their login live.');

// --- Helpers ---

function parseTabId(value) {
  const match = /^([a-z0-9][a-z0-9-]*):(\d+)$/i.exec(String(value).trim());
  if (!match) throw new Error(`"${value}" is not a tab id. Tab ids look like "helium:1834" (browser:number); get them from tab_list.`);
  return { key: match[1].toLowerCase(), tabId: Number(match[2]) };
}

async function resolveTab(manager, value) {
  const { key, tabId } = parseTabId(value);
  const browser = await manager.get(key);
  if (!browser.relay.model.hasTab(tabId) && !browser.tabs.has(tabId)) {
    // Control also ends when the browser's connection to FowlBrowser restarts (extension reload): the tab is the user's again.
    const info = await tabInfo(browser, tabId).catch(() => null);
    if (info?.owner === null) {
      throw new Error(`Tab ${key}:${tabId} is not controlled by this session: it is the user's tab (never yours, released, or control ended when the browser's ` +
        'FowlBrowser connection restarted). To work in it, tab_claim it.');
    }
    throw new Error(`Tab ${key}:${tabId} is not controlled by this session. Open one with tab_open, or claim one of the user's tabs with tab_claim (tab_list shows them).`);
  }
  return browser.waitForTab(tabId);
}

// Parsed like the browser does (it drops tabs, newlines and leading control characters), so "fi\tle:" is file: too.
export function refuseLocalFile(url) {
  const protocol = URL.parse(url ?? '')?.protocol;
  if (protocol === 'file:') {
    throw new Error(`${url.trim()} is a local file: local files can't be opened in the browser. Read the file from disk instead (it is on this Mac).`);
  }
  if (protocol === 'view-source:') throw new Error(`${url.trim()}: view-source: pages can't be opened. Open the page itself instead.`);
  return url;
}

// However a tab came to show a local file (history, a page's own history.back(), a link from one local file to another),
// FowlBrowser doesn't read or act in it: it may only be navigated away, released, kept or closed.
const LOCAL_PAGE = 'this tab shows a local file, which FowlBrowser doesn\'t read; navigate it to a web page or close it';
const isLocalPage = (url) => ['file:', 'view-source:'].includes(URL.parse(url)?.protocol);
function refuseLocalPage(tab) {
  if (isLocalPage(tab.page.url())) throw new Error(`Tab ${tab.id}: ${LOCAL_PAGE}.`);
}

// Hidden files and folders (~/.ssh, ~/.aws, .env, ~/.config), ~/Library and system configuration are never uploaded,
// also not through a symlink: paths are resolved first (natively, so "~/library" is ~/Library too). iCloud Drive and the
// cloud drives (Dropbox, Google Drive, OneDrive) live in ~/Library too and stay allowed. A folder (a webkitdirectory
// input) is uploaded with everything in it, so all of that is checked too.
const MAX_FOLDER_ENTRIES = 10_000;
// Finder writes these into folders it shows: view settings, no content. A folder holding them uploads as before.
const FINDER_FILES = new Set(['.DS_Store', '.localized']);
const DATA_VOLUME = '/System/Volumes/Data/';
export function uploadPaths(paths, home = os.homedir()) {
  // The Data volume's firmlinks name the same folders: /System/Volumes/Data/Users/me/Downloads is /Users/me/Downloads.
  const unalias = (real) => (real.startsWith(DATA_VOLUME) ? real.slice(DATA_VOLUME.length - 1) : real);
  const library = path.join(unalias(fs.realpathSync.native(home)), 'Library');
  const refusedDirs = [library, '/etc', '/private/etc', '/System', '/private/var/db'];
  const cloudDirs = [path.join(library, 'Mobile Documents'), path.join(library, 'CloudStorage')];
  const inside = (real, d) => real === d || real.startsWith(d + path.sep);
  // Why a resolved path can't be uploaded, or null.
  const refusal = (real) => {
    real = unalias(real);
    const dir = cloudDirs.some((d) => inside(real, d)) ? null : refusedDirs.find((d) => inside(real, d));
    return real.split(path.sep).some((part) => part.startsWith('.')) ? 'it is hidden (a file or folder name starts with ".")'
      : dir ? `it is inside ${dir}` : null;
  };
  const refuse = (p, real, why) => {
    throw new Error(`${p}${real === p ? '' : ` (${real})`} can't be uploaded: ${why}, where keys, passwords and app data live. ` +
      'If the user really wants it uploaded, ask them to move or copy it somewhere like ~/Downloads first.');
  };
  // Everything in a folder, walked without following links blindly: a link is resolved and checked like a path given
  // itself, and a linked folder is walked too (once).
  const checkFolder = (p, folder) => {
    let count = 0;
    const seen = new Set([folder]);
    const walk = (dir, rel) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const shown = path.join(rel, entry.name);
        if (++count > MAX_FOLDER_ENTRIES) {
          throw new Error(`${p} can't be uploaded: it holds more than ${MAX_FOLDER_ENTRIES.toLocaleString('en-US')} files and folders. ` +
            'Upload the files the page needs, or a smaller folder.');
        }
        if (entry.name.startsWith('.') && !(FINDER_FILES.has(entry.name) && entry.isFile())) refuse(p, folder, `it holds ${shown}, which is hidden (its name starts with ".")`);
        let real = full;
        if (entry.isSymbolicLink()) {
          try { real = fs.realpathSync.native(full); } catch { continue; } // a broken link carries nothing
          const why = refusal(real);
          if (why) refuse(p, folder, `it holds ${shown}, a link to ${real}: ${why}`);
        }
        if ((entry.isDirectory() || (entry.isSymbolicLink() && fs.statSync(real).isDirectory())) && !seen.has(real)) {
          seen.add(real);
          walk(real, shown);
        }
      }
    };
    walk(folder, '');
  };
  return paths.map((p) => {
    const real = fs.realpathSync.native(path.resolve(p));
    const why = refusal(real);
    if (why) refuse(p, real, why);
    if (fs.statSync(real).isDirectory()) checkFolder(p, real);
    return real;
  });
}

function locator(tab, ref) {
  if (isShadowRef(ref)) throw new Error(`Ref ${cleanRef(ref)} is inside a closed shadow root; only click, type, hover and press_key take s refs.`);
  // Refs agents see are unique in the tab (numberRefs), so a ref from an earlier page is refused rather than acting
  // on whatever element of the new page Playwright numbered the same.
  const shown = cleanRef(ref);
  if (!REF_PATTERN.test(shown)) throw new Error(`"${shown}" is not a ref from a snapshot. Refs look like e12 (or f3e12, s4); call snapshot and use its refs.`);
  const target = playwrightRef(tab.refs, shown, tab.documentGeneration, tab.frameGeneration);
  if (target === null) {
    if (!tab.refs?.max && !tab.refs?.frames.size) throw new Error(`Ref ${shown} is not from a snapshot of this tab. Call snapshot and use its refs.`);
    if (tab.refs.frames.get(/^f\d+/.exec(shown)?.[0])?.generation === tab.documentGeneration) {
      throw new Error(`Ref ${shown} is from an earlier page of an iframe in this tab: an iframe has loaded a new page since. Call snapshot again and use its refs.`);
    }
    throw new Error(`Ref ${shown} is from an earlier page of this tab: it has loaded a new page since (${tab.page.url()}). ` +
      'Call snapshot again and use its refs.');
  }
  // A main-frame ref with an old frame prefix (back/forward cache, see newRefState) makes Playwright jump to a frame it
  // no longer has. Not leading the selector skips that jump: the main frame looks the ref up itself.
  const prefix = /^f\d+/.exec(target)?.[0];
  return prefix && tab.refs.mainPrefixes.has(prefix) ? tab.page.locator(`:root >> aria-ref=${target}`) : tab.page.getByRef(target);
}

// A ref whose element is gone (the page re-rendered) fails within STALE_REF_MS instead of the whole action timeout.
// Elements that exist but aren't actionable yet keep Playwright's normal wait.
const STALE_REF_MS = 1000;
async function checkRefs(tab, args) {
  if (tab.dialog) return;
  const refs = [args.ref, args.from_ref, args.to_ref, ...(args.fields ?? []).map((f) => f.ref)].filter((ref) => ref !== undefined && !isShadowRef(ref));
  for (const ref of refs) {
    const loc = locator(tab, ref);
    const deadline = Date.now() + STALE_REF_MS;
    while (!(await loc.count())) {
      if (Date.now() >= deadline) {
        throw new Error(`Ref ${cleanRef(ref)} is from an older snapshot: no element on the page has it now (the page changed). Call snapshot again and use its refs.`);
      }
      await sleep(100);
    }
  }
}

// The agent cursor (docs/cursor-spec.md), only in a tab the user can see: it travels to `where` (a point, or a function
// returning one) before the action, plays `cue` during it (cueOnPress: from the action's mouse press on), and clicks
// when the action presses the mouse button (feedback: false when the action is no click), not once the action and a
// navigation it started are done; an action that presses none (a select) clicks at its end. Not shown: none of it runs.
async function pointed(tab, where, action, { feedback = true, shown, cue, cueOnPress = false, deadline = Date.now() + cursor.ARRIVAL_CAP_MS } = {}) {
  // One budget for the whole cursor path (visibility, target, travel): a slow answer means "not shown".
  shown ??= await cursor.isShown(tab);
  // A target found too late is still shown while the action runs (late: in record mode the point line says so).
  let actionDone;
  const acting = new Promise((resolve) => { actionDone = resolve; });
  let late = false;
  const target = shown ? await cursor.moveTo(tab, where, Math.max(0, deadline - Date.now()), { acting, onLate: () => { late = true; } }) : null;
  const seen = record.recording && shown ? await record.pointSeen(tab, target, () => cursor.state(tab)) : null;
  if (shown && cue && !cueOnPress) cursor.cue(tab, cue);
  let pressed = false;
  const onInput = (method, params) => {
    if (pressed || method !== 'Input.dispatchMouseEvent' || params?.type !== 'mousePressed') return;
    pressed = true;
    if (cueOnPress) cursor.cue(tab, cue);
    if (feedback) cursor.click(tab);
  };
  const listening = shown && (feedback || cueOnPress);
  if (listening) tab.on('input', onInput);
  let failed = null;
  try {
    const result = await action();
    if (shown && feedback && !pressed) cursor.click(tab);
    return result;
  } catch (error) {
    failed = error;
    throw error;
  } finally {
    if (listening) tab.off('input', onInput);
    actionDone();
    if (shown && cue && (!cueOnPress || pressed)) cursor.cueEnd(tab);
    if (seen) record.pointDone(late ? { ...seen, late: true } : seen, failed);
  }
}

// The cursor for an action with no point (reading, waiting, typing into the focused element): it shows where it
// last was with the action's cue, during the action (after: once it is done, for navigations and screenshots).
// Never delays the action: visibility is asked alongside it, and the cue calls keep their order.
// follow: the cursor also shows clicks the action makes from a script (evaluate); in record mode the action waits
// (up to FOLLOW_CAP_MS) until the overlay listens, so none is missed.
const FOLLOW_CAP_MS = 300;
async function cued(tab, kind, action, { after = false, follow = false } = {}) {
  const shown = cursor.isShown(tab);
  const following = after ? null : shown.then((yes) => { if (yes) { cursor.cue(tab, kind); if (follow) return cursor.follow(tab, true); } });
  if (follow && following && record.recording) await Promise.race([following, sleep(FOLLOW_CAP_MS)]);
  try {
    const result = await action();
    if (after) shown.then((yes) => { if (yes) { cursor.cue(tab, kind); cursor.cueEnd(tab); } });
    return result;
  } finally {
    if (!after) shown.then((yes) => { if (yes) { if (follow) cursor.follow(tab, false); cursor.cueEnd(tab); } });
  }
}

// Where the cursor points for a ref: the centre of its box, scrolled into view first (the action scrolls there too).
const POINT_TIMEOUT_MS = 700;
function refPoint(tab, ref) {
  return async () => {
    if (isShadowRef(ref)) return shadowRefCenter(tab, ref);
    const loc = locator(tab, ref);
    // Main-frame refs: one round trip in the page. An iframe's box needs Playwright's frame offsets.
    if (!/^f\d/.test(cleanRef(ref))) return loc.evaluate(REF_POINT_FN, null, { timeout: POINT_TIMEOUT_MS });
    // Scrolling inside a cross-origin iframe doesn't move the page around it: bring its iframes into view first,
    // outermost first, so the box is where the action will find it.
    const handle = await loc.elementHandle({ timeout: POINT_TIMEOUT_MS }).catch(() => null);
    const frames = [];
    for (let frame = await handle?.ownerFrame(); frame?.parentFrame(); frame = frame.parentFrame()) frames.unshift(frame);
    handle?.dispose().catch(() => {});
    for (const frame of frames) {
      const owner = await frame.frameElement().catch(() => null);
      await owner?.scrollIntoViewIfNeeded({ timeout: POINT_TIMEOUT_MS }).catch(() => {});
      owner?.dispose().catch(() => {});
    }
    await loc.scrollIntoViewIfNeeded({ timeout: POINT_TIMEOUT_MS }).catch(() => {});
    const box = await loc.boundingBox({ timeout: POINT_TIMEOUT_MS });
    return box && { x: box.x + box.width / 2, y: box.y + box.height / 2, w: box.width, h: box.height };
  };
}

// Scrolls the element into view if needed (Chromium's, the same alignment as the DOM.scrollIntoViewIfNeeded the
// action uses) and returns its box centre and size in viewport CSS px; null for an element with no box (runs in the page).
export const REF_POINT_FN = (el) => {
  el.scrollIntoViewIfNeeded?.();
  const r = el.getBoundingClientRect();
  return r.width || r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
};

// Puts the caret at the end of an input, textarea or editable element (runs in the page).
const CARET_TO_END_FN = function (el) {
  el = el ?? this;
  if (typeof el.value === 'string' && el.setSelectionRange) {
    try { el.setSelectionRange(el.value.length, el.value.length); return; } catch {}
  }
  const selection = getSelection();
  selection.selectAllChildren(el);
  selection.collapseToEnd();
};

const SELECT_ALL_FN = function (el) {
  el = el ?? this;
  if (typeof el.select === 'function') el.select();
  else getSelection().selectAllChildren(el);
};

// The focused element (inside open shadow roots too) if it is a text field or editable element the user can see; null
// for anything else, and for editors that take keys through a hidden or tiny field (code and canvas editors).
const FOCUSED_FIELD_FN = () => {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  // Only text inputs and textareas: in an editable area (rich text, a code editor) select-all would take the whole document.
  const field = el?.matches('textarea, input') && !/^(button|submit|reset|checkbox|radio|file|image|range|color|hidden|date|datetime-local|month|week|time)$/.test(el.type);
  if (!field) return null;
  const r = el.getBoundingClientRect();
  return r.width >= 4 && r.height >= 4 && getComputedStyle(el).opacity !== '0' ? el : null;
};

// Waits for the page's load event (up to 5 s by default), unless the document is complete already: a page restored
// from the back/forward cache never fires it again. The check and the wait share the timeout (a busy page's script
// holds the check up).
async function loaded(page, timeout = 5000) {
  const end = Date.now() + timeout;
  if (await within(page.evaluate(() => document.readyState === 'complete'), timeout, false)) return;
  await page.waitForLoadState('load', { timeout: Math.max(1, end - Date.now()) }).catch(() => {});
}

async function header(tab) {
  if (isLocalPage(tab.page.url())) return `Browser: ${tab.browser.name} · Tab: ${tab.id} · ${tab.page.url()}`;
  return `Browser: ${tab.browser.name} · Tab: ${tab.id} · ${(await tab.currentTitle()) || '(no title)'} · ${tab.page.url()}`;
}

const cap = (body, note) => capText(body, MAX_CHARS, note);
const CUT_NOTE = 'To read them, call snapshot with ref=<eN> of a section, or with a larger max_chars';

// Every snapshot an agent receives fits in maxChars. Each whole-page snapshot becomes the tab's baseline (the full
// text: the agent was told how to read a cut part) for `changes`: after an action on the same document and URL,
// only what changed since then is returned, unless that is not much shorter than the page.
async function snapshotText(tab, { ref, changes = false, maxChars = SNAPSHOT_MAX_CHARS } = {}) {
  if (tab.dialog) return 'Snapshot unavailable while a dialog is open. Resolve it with the dialog tool.';
  // A navigation (or URL change) while the snapshot is read would mix two documents: read it once more, and never
  // number or keep a mixed one.
  // An iframe that loads a new page meanwhile only voids iframe refs: they are stamped with the iframes' generation
  // from before the read, so they are refused until the next snapshot.
  let yaml, shadow, generation, frameGeneration, url;
  for (let attempt = 0; ; attempt++) {
    generation = tab.documentGeneration;
    frameGeneration = tab.frameGeneration;
    url = tab.page.url();
    if (isLocalPage(url)) return `Snapshot unavailable: ${LOCAL_PAGE}.`;
    const target = ref ? locator(tab, ref) : tab.page;
    yaml = await target.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
    // Playwright resolves refs through its last snapshot's table, a section's only of the section: the whole page is read
    // again (text unused), so the refs shown before outside it keep working.
    if (ref) await tab.page.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS }).catch((error) => debug('ref table restore failed', error.message));
    shadow = ref ? '' : await closedShadowSection(tab).catch((error) => { debug('closed shadow scan failed', error.message); return ''; });
    if (tab.documentGeneration === generation && tab.page.url() === url) break;
    if (attempt) return `Snapshot unavailable: the page kept navigating while it was read (now ${tab.page.url()}). Call snapshot again.`;
  }
  yaml = numberRefs(tab.refs ??= newRefState(), yaml, generation, { whole: !ref, frameGeneration });
  const room = maxChars - 60; // title and fences
  let title = `Snapshot of ${ref}:`;
  if (!ref) {
    // Whole-page snapshots are numbered per tab, so an agent sharing the tab can tell what a changes-only result is relative to.
    const number = tab.snapshotCount = (tab.snapshotCount ?? 0) + 1;
    title = `Snapshot ${number} of this tab:`;
    const last = tab.snapshotBaseline;
    tab.snapshotBaseline = { text: yaml + shadow, generation, url, number };
    if (changes && last?.generation === generation && last.url === url) {
      const diff = snapshotChanges(last.text, tab.snapshotBaseline.text, { since: last.number, number });
      if (diff) return capText(diff, maxChars, CUT_NOTE);
    }
  }
  // The closed-shadow part (s refs) stays when the page part is cut, unless it is large itself.
  const section = shadow && `\n${capText(shadow.slice(1), Math.floor(room / 3), 'To see them all, call snapshot with a larger max_chars')}`;
  const body = capText(yaml, room - section.length, CUT_NOTE) + section;
  return `${title}\n\`\`\`yaml\n${body}\n\`\`\``;
}

// Readable text of the ref, else of the page's <main> or <article>, else of the body (snapshot mode "text").
const PAGE_TEXT_FN = (el) => {
  const root = el ?? document.querySelector('main, [role=main]') ?? document.querySelector('article') ?? document.body;
  const name = root.tagName.toLowerCase() + (root.id ? `#${root.id}` : '') + (root.getAttribute('role') === 'main' && root.tagName !== 'MAIN' ? '[role=main]' : '');
  return { name, text: root.innerText ?? '' };
};

async function pageText(tab, { ref, maxChars = SNAPSHOT_MAX_CHARS } = {}) {
  if (tab.dialog) return 'Text unavailable while a dialog is open. Resolve it with the dialog tool.';
  refuseLocalPage(tab);
  const { name, text: raw } = ref ? await locator(tab, ref).evaluate(PAGE_TEXT_FN, null, { timeout: ACTION_TIMEOUT_MS }) : await tab.page.evaluate(PAGE_TEXT_FN, null);
  refuseLocalPage(tab); // it went there while the text was read
  const body = collapseText(raw) || '(no text)';
  return `Text of ${ref ? `${ref} (<${name}>)` : `<${name}>`} (readable text only, no refs; to act on the page, call snapshot without mode for refs):\n` +
    capText(body, maxChars - 150, 'To read them, call snapshot with mode "text" and ref=<eN> of a section, or with a larger max_chars');
}

function dialogLine(tab) {
  const d = tab.dialog;
  if (!d || isLocalPage(tab.page.url())) return null;
  const prompt = d.type() === 'prompt' ? ` (default value "${d.defaultValue()}")` : '';
  return `Dialog open: ${d.type()} "${d.message()}"${prompt}. The page is blocked until you resolve it with the dialog tool.`;
}

const text = (body) => ({ content: [{ type: 'text', text: body }] });

async function report(tab, { lines = [], newTabs = [], snapshot = true, ref, changes, maxChars } = {}) {
  // The title and the snapshot are read together.
  const [head, snap] = await Promise.all([header(tab), snapshot && snapshotText(tab, { ref, changes, maxChars })]);
  const out = [head];
  const dialog = dialogLine(tab);
  if (dialog) out.push(dialog);
  for (const t of newTabs) {
    out.push(t.loading
      ? `New tab opened by this action (loading): ${t.id}${t.url ? ` · ${t.url}` : ''}. You control it; tools on it wait until its page is ready.`
      : `New tab opened by this action (you control it): ${t.id} · ${t.url}`);
  }
  out.push(...lines.filter(Boolean));
  if (snapshot) out.push(snap);
  return text(out.join('\n'));
}

// After an action: wait for a navigation it started to commit and load, or for the requests it fired to finish.
// An action that committed a new document itself (a link whose commit Playwright's click waited for) only waits for its
// load; `waited` (navigate, wait_for: the action waited for its own condition) nothing more. Else it watches for such a
// start until the first request that counts, at most 300 ms when a snapshot will be returned; without one (snapshot:
// false) nothing returned depends on the page settling, so 100 ms after an action and 50 ms after a read (evaluate, media).
const WATCH_MS = { snapshot: 300, action: 100, read: 50 };
const TRAILING_MS = 100;
const WATCHED = new Set(['document', 'xhr', 'fetch', 'script', 'stylesheet']);

// The page's requests from now on; `first` settles with the first one that counts.
function watchRequests(page) {
  const requests = [];
  let started;
  const first = new Promise((resolve) => { started = resolve; });
  const onRequest = (r) => {
    requests.push(r);
    if (WATCHED.has(r.resourceType())) started();
  };
  page.on('request', onRequest);
  return { requests, first, stop: () => page.off('request', onRequest) };
}

async function settle(tab, { requests, first }, { watchMs = WATCH_MS.snapshot, generation, waited = false, trailing = true, timeout = NAVIGATION_TIMEOUT_MS } = {}) {
  const load = () => loaded(tab.page, ACTION_TIMEOUT_MS);
  if (waited) return; // navigate also waited for its load already, at most 5 s
  if (tab.documentGeneration !== generation) return load();
  await within(first, watchMs);
  const main = tab.page.mainFrame();
  // Requests that start while earlier ones finish (a fetch answered, then another, then a redirect) are followed too,
  // all within one 3 s budget, and a navigation any of them started is waited for.
  const deadline = Date.now() + 3000;
  const seen = new Set();
  for (;;) {
    const navigation = requests.find((r) => r.isNavigationRequest() && r.frame() === main);
    if (navigation) {
      await committed(tab, navigation, generation, timeout);
      return load();
    }
    const pending = requests.filter((r) => WATCHED.has(r.resourceType()) && !seen.has(r));
    if (!pending.length || Date.now() >= deadline) return;
    for (const r of pending) seen.add(r);
    await within(Promise.all(pending.map((r) => r.response().then((response) => response?.finished()).catch(() => {}))), deadline - Date.now());
    await sleep(trailing ? TRAILING_MS : 0);
  }
}

// Until a navigation's new document commits, the old one still counts as loaded: wait for the commit, or for the
// request (at the end of its redirects) to end without one: a download, a 204, an error. Not committing in time is an
// error, never a silent success on the departing page.
async function committed(tab, request, generation, timeout) {
  const ended = new WeakSet();
  const checked = new WeakSet();
  const deadline = Date.now() + timeout;
  for (;;) {
    if (tab.documentGeneration !== generation) return;
    let last = request;
    while (last.redirectedTo()) last = last.redirectedTo();
    if (last.failure() || ended.has(last)) return;
    if (!checked.has(last)) {
      checked.add(last);
      last.response().then((response) => {
        if (!response || [204, 205].includes(response.status()) || /attachment/i.test(response.headers()['content-disposition'] ?? '')) ended.add(last);
      }, () => ended.add(last));
    }
    if (Date.now() >= deadline) {
      throw new Error(`The action was done and the page began loading ${last.url()}, but the new page had not replaced the old one after ` +
        `${Math.round(timeout / 1000)} s. Check the tab with snapshot before going on.`);
    }
    await sleep(25);
  }
}

// Tabs this action opened: Playwright popups of the acting page, plus tabs the extension handed to this session
// as children of it (the extension stamps the authoritative source tab as openerTabId; Helium's own openerTabId
// is unreliable). The extension announces a child as soon as it exists, while Playwright's popup event waits for
// the child's first response, so on slow sites a child is reported while still loading.
async function openedTabs(tab, popupIds, mapping, knownBefore, opens, urls) {
  const { browser } = tab;
  const children = () => [...browser.relay.model._knownTabs.values()].filter((t) => !knownBefore.has(t.id)
    && t.openerTabId === tab.tabId);
  const found = () => new Set([...popupIds, ...children().map((t) => t.id)]);
  const deadline = Date.now() + POPUP_WAIT_MS;
  while (found().size < opens && Date.now() < deadline) await sleep(100);
  await Promise.all(mapping);
  const info = new Map(children().map((t) => [t.id, t]));
  // A popup given back to the user meanwhile is theirs: their own input opened it (takeover.mjs).
  return [...found()].filter((tabId) => !takeover.wasGivenBack(`${browser.key}:${tabId}`)).map((tabId) => {
    const id = `${browser.key}:${tabId}`;
    const mapped = browser.tabs.get(tabId);
    // A popup the extension opened for the page starts blank (popups.mjs openChild).
    if (mapped) return { id, url: mapped.page.url() === 'about:blank' ? urls.get(tabId) ?? 'about:blank' : mapped.page.url() };
    const child = info.get(tabId);
    return { id, url: child?.pendingUrl || child?.url || '', loading: true };
  });
}

const actOpening = (tab, args, fn, options) => act(tab, args, fn, { ...options, mayOpenTabs: true });

// Runs fn on the tab, returns early if it opens a dialog, and reports new tabs plus the snapshot.
// New tabs are the acting page's own children only, never tabs other agents of this session open meanwhile.
async function act(tab, args, fn, { snapshot = args.snapshot !== false, mayOpenTabs = false, read = false, waited = false } = {}) {
  if (tab.dialog) throw new Error(dialogLine(tab) ?? `A dialog is open, and ${LOCAL_PAGE}.`);
  // A tab this action opens from the user's claimed tab is adopted (ours, in the background) instead of being the user's.
  // Only for actions that can open tabs (a shorter window means fewer chances to catch the user's own Cmd-click, and
  // such a tab is handed back to them, never closed). Older extensions don't know the command; that only loses
  // the adoption. Waited for: the extension reads the tab's window and group state for a popup of this action first.
  if (mayOpenTabs) {
    await tab.browser.host.request('tabs.expectChild', { tabId: tab.tabId, ms: 3000 }).catch((error) => {
      if (!/unknown method/i.test(error.message)) debug('tabs.expectChild failed', error.message);
    });
  }
  const knownBefore = new Set(tab.browser.relay.model._knownTabs.keys());
  const generation = tab.documentGeneration;
  const opens = []; // URLs the page asked to open in a new tab or window during this action
  const openings = []; // of those, the ones the extension opens (popups.mjs): { url, opening }
  const urls = new Map(); // tab id -> URL of a popup the extension opened
  const popupIds = new Set();
  const onOpen = (url, opening, created) => {
    opens.push(url);
    if (opening) {
      created.then(({ tabId }) => urls.set(tabId, url), () => {});
      openings.push({ url, opening });
    }
  };
  const mapping = []; // popups being mapped to their tabs
  const onPopup = (page) => mapping.push(tab.browser.tabFor(page).then((t) => t && popupIds.add(t.tabId)));
  tab.on('windowopen', onOpen);
  tab.page.on('popup', onPopup);
  const watch = watchRequests(tab.page);
  let onDialog;
  const dialogOpened = new Promise((resolve) => { onDialog = resolve; tab.once('dialog', onDialog); });
  let lines, newTabs;
  try {
    const work = (async () => {
      lines = [].concat((await fn()) ?? []);
      await settle(tab, watch, { watchMs: snapshot ? WATCH_MS.snapshot : read ? WATCH_MS.read : WATCH_MS.action, generation, waited, trailing: snapshot,
        timeout: Math.max(args.timeout_ms ?? 0, NAVIGATION_TIMEOUT_MS) });
    })();
    work.catch(() => {}); // a dialog may win the race; the action then finishes or fails on its own
    await Promise.race([work, dialogOpened]);
    // Returning early for a dialog: the action goes on once it is resolved, so later calls on this tab
    // wait for it (the dialog tool itself skips the queue).
    if (tab.dialog) tab.keepBusy(work.catch(() => {}));
    // A tab the user's own click opened meanwhile is theirs, not one of this action's.
    const { failed, pending, users } = await openingLines(openings, POPUP_WAIT_MS);
    lines = [...(lines ?? []), ...failed, ...pending];
    newTabs = await openedTabs(tab, popupIds, mapping, knownBefore, opens.length - failed.length - users, urls);
    // kept: the extension hands it back at session end, never closes it (a child of a claimed, kept or for_user tab:
    // it may be the user's own Cmd-click).
    for (const t of record.recording ? newTabs : []) {
      const info = await tabInfo(tab.browser, Number(t.id.split(':')[1])).catch(() => null);
      record.tabEvent('adopt', t.id, t.url, { kept: info?.owner === 'you' && info.kept });
    }
  } finally {
    tab.off('dialog', onDialog);
    tab.off('windowopen', onOpen);
    watch.stop();
    tab.page.off('popup', onPopup);
  }
  return report(tab, { lines, newTabs, snapshot: snapshot && !tab.dialog, changes: true });
}

// onLocalPage: the call may run on a tab showing a local file (navigate with a url, which takes it away).
function withTab(manager, handler, { onLocalPage = () => false } = {}) {
  return async (args) => {
    const tab = await resolveTab(manager, args.tab);
    const started = Date.now();
    return tab.run(async () => {
      if (!onLocalPage(args)) refuseLocalPage(tab);
      await checkRefs(tab, args);
      return handler(tab, args);
    }).catch((error) => {
      const closed = closedItself(tab, started);
      if (closed) return closed;
      // Playwright names the ref it was given; the agent knows it by the number it was shown.
      if (typeof error?.message === 'string') error.message = error.message.replace(/aria-ref=(\w+)/g, (_, r) => `aria-ref=${shownRef(tab.refs, r)}`);
      throw error;
    });
  };
}

// A call that failed because the page closed its own tab since `started` (popups.mjs heard its window.close()) reports
// that instead: it is what happened, not a failure. Null otherwise.
function closedItself(tab, started) {
  if (!(tab.closedByPageAt >= started) || !tab.page.isClosed()) return null;
  return text(`Browser: ${tab.browser.name} · Tab: ${tab.id}\nThe page closed this tab itself (window.close(), as sign-in and payment popups do ` +
    'once they are done) during this call; the tab is gone.');
}

export function cleanError(error) {
  const message = String(error?.message ?? error);
  // A ref no element has any more: Playwright says so, or waits for it until the timeout without ever finding it.
  const ref = /aria-ref=(\w+)/.exec(message)?.[1];
  if (ref && (/does not match any element/.test(message) || (/Timeout \d+ms exceeded/.test(message) && !/locator resolved to/.test(message)))) {
    return `Ref ${ref} is from an older snapshot: no element on the page has it now (the page changed). Call snapshot again and use its refs.`;
  }
  if (ref && /Invalid frame in aria-ref selector/.test(message)) {
    return `Ref ${ref} is in an iframe that has reloaded or gone since that snapshot. Call snapshot again and use its refs.`;
  }
  // Playwright appends a long call log; the first lines say what went wrong.
  return message.split('\nCall log:')[0].slice(0, 2000);
}

const callLog = (message) => String(message).replace(/\x1b\[[0-9;]*m/g, '').split('\nCall log:')[1]?.split('\n') ?? [];

// Did the action happen before the timeout? 'done': Playwright logged "<action> action done" after its last
// "performing" line, so only the wait for a navigation the click started ran out. 'started': it was performing the
// input when time ran out, so it may or may not have happened. null: not performed (or retried after it).
export function performed(message) {
  const lines = callLog(message);
  const last = lines.findLastIndex((line) => /performing \w+ action/.test(line));
  if (last < 0 || lines.slice(last).some((line) => /retrying/.test(line))) return null;
  return lines.slice(last).some((line) => /\w+ action done/.test(line)) ? 'done' : 'started';
}

// Why Playwright keeps retrying a pointer action, from its call log: the last covered / disabled / hidden line.
export function blockedState(message) {
  const lines = callLog(message);
  for (const line of lines.reverse()) {
    const cover = /(<.*) intercepts pointer events/.exec(line);
    if (cover) return { kind: 'covered', by: cover[1].replace(/ from (<.+>) subtree$/, ' in $1') };
    if (/element is not enabled|option being selected is not enabled/.test(line)) return { kind: 'disabled' };
    if (/element is not visible|element is outside of the viewport/.test(line)) return { kind: 'hidden' };
  }
  return null;
}

// What covers the element's centre: the nearest fixed or sticky box around the hit (a banner, a sticky bar, a modal),
// else the hit itself; null if the element (or something inside it) is on top there.
const COVER_FN = (el) => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  if (!hit || hit === el || el.contains(hit)) return null;
  for (let n = hit; n && n !== document.body && !n.contains(el); n = n.parentElement) {
    if (/fixed|sticky/.test(getComputedStyle(n).position)) return n;
  }
  return hit;
};
const DESCRIBE_FN = (el) => {
  const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
  const name = el.getAttribute('aria-label') ?? '';
  return { tag: `<${el.localName}${el.id ? `#${el.id}` : ''}${classes}>`, name, text: (el.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) };
};

// "<div#cookies.cookies> "Cookie notice" (ref e58) "We use cookies…"", or Playwright's own description.
export async function describeCover(tab, loc, fallback) {
  const handle = await loc.evaluateHandle(COVER_FN, null, { timeout: LOOKUP_MS }).catch(() => null);
  const cover = handle?.asElement();
  if (!cover) return fallback;
  try {
    const { tag, name, text: shown } = await cover.evaluate(DESCRIBE_FN);
    // Its ref, if the last snapshot shows it: lines quoting its name or the start of its text, checked by identity.
    const key = (name || shown).slice(0, 30);
    let ref = null;
    if (key && tab.snapshotBaseline?.generation === tab.documentGeneration) {
      const candidates = tab.snapshotBaseline.text.split('\n').filter((l) => l.includes(`"${key}`)).map((l) => /\[ref=(\w+)\]/.exec(l)?.[1]).filter(Boolean);
      for (const candidate of candidates.slice(0, 5)) {
        // locator() throws at once for s refs and refs of a reloaded iframe: just not this candidate.
        const same = await Promise.resolve().then(() => locator(tab, candidate).evaluate((el, c) => el === c, cover, { timeout: LOOKUP_MS })).catch(() => false);
        if (same) { ref = candidate; break; }
      }
    }
    return [tag, name && `"${name}"`, ref && `(ref ${ref})`, shown && shown !== name && `"${shown}${shown.length === 60 ? '…' : ''}"`].filter(Boolean).join(' ');
  } finally {
    handle.dispose().catch(() => {});
  }
}

// Playwright retries a pointer action on a covered, disabled or hidden element until the whole timeout, then says
// only "Timeout exceeded". Unless the call set timeout_ms, the action first gets QUICK_MS; if its log shows one of
// those states the call fails then, saying why, else it goes on for the rest of the normal timeout.
const QUICK_MS = 1000;
const LOOKUP_MS = 300; // reading what covers it, or its label
const staleRef = (ref) => new Error(`Ref ${cleanRef(ref)} is from an older snapshot: no element on the page has it now (the page changed). Call snapshot again and use its refs.`);

async function blockedError(tab, ref, loc, blocked) {
  const name = `Ref ${cleanRef(ref)}`;
  const message = {
    covered: async () => `${name} is covered by ${await describeCover(tab, loc, blocked.by)}: a click there would hit that instead. ` +
      'Dismiss or close it first (snapshot it for its buttons), or act on another visible control for the same thing (its label or card).',
    disabled: async () => `${name} is disabled. Do what enables it first (e.g. fill the required fields, read to the end), then retry; ` +
      'or pass timeout_ms to wait for it.',
    hidden: async () => `${name} is not visible (hidden, zero size or clipped). Click its visible label or card, or the control that reveals it.`,
  }[blocked.kind];
  return Object.assign(new Error(await message()), { blocked: blocked.kind });
}

export async function quickly(tab, ref, loc, attempt, timeout) {
  if (timeout !== undefined) return attempt(timeout);
  // While a trace records, the page runs slower (JS sampling) and a slow handler is the point: no quick verdict.
  if (tab.trace?.startedAt) return attempt(ACTION_TIMEOUT_MS);
  const started = Date.now();
  try {
    return await attempt(QUICK_MS);
  } catch (error) {
    if (!/Timeout \d+ms exceeded/.test(error?.message)) throw error;
    const state = performed(error.message);
    if (state === 'done') return undefined; // act() waits for the navigation itself
    if (state === 'started') {
      throw new Error(`The action on ${cleanRef(ref)} started but did not finish within ${QUICK_MS} ms, so it may or may not have happened. ` +
        'Call snapshot to check before trying again.');
    }
    // Gone meanwhile (the page re-rendered it, e.g. a virtualized row scrolled into view): waiting won't bring it back.
    if (loc.count && !(await loc.count())) throw staleRef(ref);
    const blocked = blockedState(error.message);
    if (!blocked) return attempt(ACTION_TIMEOUT_MS - (Date.now() - started));
    throw await blockedError(tab, ref, loc, blocked);
  }
}

// Why a select can't be chosen now, read without changing anything: 'disabled', 'hidden' or null.
const SELECT_STATE_FN = (el, values) => {
  if (el.matches(':disabled')) return 'disabled';
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || !el.checkVisibility({ visibilityProperty: true })) return 'hidden';
  const wanted = [...(el.options ?? [])].filter((o) => values.includes(o.value) || values.includes(o.label));
  return wanted.some((o) => o.disabled) ? 'disabled' : null;
};

// A select changes in one step with no call log line saying it happened, so a timeout can't tell whether the change
// (and the page's change handler) already ran: it is never tried twice. A short read-only check first gives the
// disabled / hidden / gone errors fast, then selectOption runs once with the normal timeout.
export async function selectOnce(tab, ref, loc, values, timeout) {
  if (timeout === undefined) {
    const blocked = await loc.evaluate(SELECT_STATE_FN, values, { timeout: QUICK_MS }).catch(async (error) => {
      if (!/Timeout \d+ms exceeded/.test(error?.message)) throw error;
      if (!(await loc.count())) throw staleRef(ref);
      return null; // a busy page: selectOption waits for it
    });
    if (blocked) throw await blockedError(tab, ref, loc, { kind: blocked });
  }
  return loc.selectOption(values, { timeout });
}

// The label's point nearest its input (2 px inside the label), else the label's centre: in the viewport for the
// cursor, and from the label's padding box for Playwright's click position. Runs in the page. The label is centred
// first: the failed attempts on the input may have left it at an edge under a fixed bar or banner, where
// Playwright's click would scroll again and land away from the cursor.
const LABEL_POINT_FN = (label, input) => {
  label.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const l = label.getBoundingClientRect();
  const i = input.getBoundingClientRect();
  const near = (v, start, size) => Math.min(Math.max(v, start + Math.min(2, size / 2)), start + size - Math.min(2, size / 2));
  const x = i.width || i.height ? near(i.left + i.width / 2, l.left, l.width) : l.left + l.width / 2;
  const y = i.width || i.height ? near(i.top + i.height / 2, l.top, l.height) : l.top + l.height / 2;
  return { x, y, w: l.width, h: l.height, position: { x: x - l.left - label.clientLeft, y: y - l.top - label.clientTop } };
};

// A pointer action on a ref, failing fast as above. A radio or checkbox that is hidden or covered (by its own label or
// card, as custom ones are) gets its label clicked instead, like a person would, when `want` says what the click
// must leave: 'toggle' (a plain click: a radio checked, a checkbox flipped) or true/false (fill_form). Undefined:
// no fallback (right, middle, double or modified clicks mean something else on a label). The result then says so.
export async function onRef(tab, ref, loc, attempt, timeout, want) {
  try {
    return await quickly(tab, ref, loc, attempt, timeout);
  } catch (error) {
    if (want === undefined || (error.blocked !== 'covered' && error.blocked !== 'hidden')) throw error;
    const handle = await loc.evaluateHandle((el) => (el instanceof HTMLInputElement && /^(radio|checkbox)$/.test(el.type) ? el.labels?.[0] ?? null : null),
      null, { timeout: LOOKUP_MS }).catch(() => null);
    const label = handle?.asElement();
    if (!label) throw error;
    try {
      const read = () => loc.evaluate((el) => ({ type: el.type, checked: el.checked }), null, { timeout: LOOKUP_MS }).catch(() => null);
      const before = await read();
      const input = await loc.elementHandle({ timeout: LOOKUP_MS }).catch(() => null);
      const point = input && await label.evaluate(LABEL_POINT_FN, input).catch(() => null);
      input?.dispose().catch(() => {});
      const { position, ...where } = point ?? {};
      // The cursor goes to the label too (and record mode notes that point); its click feedback comes from the caller.
      await pointed(tab, point && where, () => quickly(tab, ref, label, (t) => label.click({ position, timeout: t }), timeout), { feedback: false });
      const after = await read();
      const kind = before?.type ?? 'control';
      const expected = want === 'toggle' ? (before?.type === 'radio' || !before?.checked) : want;
      if (after?.checked !== expected) {
        const now = after ? `is still ${after.checked ? 'checked' : 'unchecked'}` : 'could not be read after it (the page may have navigated)';
        throw new Error(`Clicked the label of ${cleanRef(ref)} but the ${kind} ${now} (the label may hold a link or stop the click). ` +
          'Call snapshot to see what happened, then click the visible control that sets it.');
      }
      return `Clicked the label of ${cleanRef(ref)} (the ${kind} itself is hidden under it).`;
    } finally {
      handle.dispose().catch(() => {});
    }
  }
}

// The box a scroll by ref moves: the element if it scrolls in that axis, else its nearest scrolling ancestor (crossing
// shadow roots); null if only the page scrolls there.
export const SCROLL_TARGET_FN = (el, vertical) => {
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement ?? n.getRootNode().host) {
    const style = getComputedStyle(n);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const room = vertical ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
    if (room > 0 && /auto|scroll|overlay/.test(overflow)) return n;
  }
  return null;
};

// scroll with ref and direction: moves that box by pages of its own height (80% of it, like page scrolls, so no row
// is skipped). With no such box it turns the mouse wheel over the ref (the page, or a scroller driven by wheel events).
async function scrollBox(tab, { ref, direction, pages = 1 }) {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const plural = `${pages} page${pages === 1 ? '' : 's'}`;
  const loc = locator(tab, ref);
  const handle = await loc.evaluateHandle(SCROLL_TARGET_FN, vertical);
  const box = handle.asElement();
  try {
    if (!box) {
      await pointed(tab, refPoint(tab, ref), async () => {
        const { x, y, width, height } = await loc.boundingBox();
        const step = sign * (vertical ? height : width) * 0.8 * pages;
        await tab.page.mouse.move(x + width / 2, y + height / 2);
        await tab.page.mouse.wheel(vertical ? 0 : step, vertical ? step : 0);
      }, { feedback: false, cue: 'scroll' });
      const pos = await tab.page.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY) }));
      return `Nothing around ${cleanRef(ref)} scrolls on its own; turned the mouse wheel ${direction} ${plural} of its height over it. Window scroll position: x=${pos.x} y=${pos.y}.`;
    }
    await box.scrollIntoViewIfNeeded({ timeout: POINT_TIMEOUT_MS }).catch(() => {});
    const where = async () => {
      const b = await box.boundingBox();
      return b && { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
    };
    const { tag, at, max } = await pointed(tab, where, () => box.evaluate((el, { vertical, step }) => {
      el.scrollBy({ [vertical ? 'top' : 'left']: step * (vertical ? el.clientHeight : el.clientWidth), behavior: 'instant' });
      return {
        tag: `<${el.localName}${el.id ? `#${el.id}` : ''}>`,
        at: Math.round(vertical ? el.scrollTop : el.scrollLeft),
        max: vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth,
      };
    }, { vertical, step: sign * 0.8 * pages }), { feedback: false, cue: 'scroll' });
    const end = at <= 0 ? ' (at the start)' : at >= max - 1 ? ' (at the end)' : '';
    return `Scrolled the box around ${cleanRef(ref)} (${tag}) ${direction} ${plural}: ${vertical ? 'scrollTop' : 'scrollLeft'} ${at} of ${max}${end}.`;
  } finally {
    handle.dispose().catch(() => {});
  }
}

// On YouTube the player's own API is used, so its controls (volume icon, mute state, settings) match.
const MEDIA_FN = async (el, { action, value }) => {
  const player = el.closest('#movie_player');
  const yt = player && ['mute', 'unMute', 'isMuted', 'setVolume', 'getVolume', 'seekTo', 'playVideo', 'pauseVideo', 'setPlaybackRate']
    .every((f) => typeof player[f] === 'function') ? player : null;
  const status = () => ({
    element: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
    ...(yt && { player: 'youtube' }),
    src: (el.currentSrc || el.src || '').slice(0, 200),
    paused: el.paused, ended: el.ended,
    currentTime: Math.round(el.currentTime * 10) / 10,
    duration: Number.isFinite(el.duration) ? Math.round(el.duration * 10) / 10 : el.duration,
    volume: yt ? yt.getVolume() / 100 : el.volume, muted: yt ? yt.isMuted() : el.muted,
    playbackRate: el.playbackRate, readyState: el.readyState,
  });
  const play = async () => {
    try {
      if (yt) yt.playVideo();
      else await Promise.race([el.play(), new Promise((r) => setTimeout(r, 3000))]);
    } catch (error) {
      return error.name;
    }
    // Some players (YouTube) pause again right away when the page has no user activation.
    await new Promise((r) => setTimeout(r, 1000));
    return el.paused ? 'PausedByPage' : null;
  };
  const pause = () => (yt ? yt.pauseVideo() : el.pause());
  const volume = Math.min(1, Math.max(0, Number(value) > 1 ? Number(value) / 100 : Number(value)));
  let refused = null;
  switch (action) {
    case 'status': break;
    case 'play': refused = await play(); break;
    case 'pause': pause(); break;
    case 'toggle': if (el.paused) refused = await play(); else pause(); break;
    case 'seek': if (yt) yt.seekTo(Number(value), true); else el.currentTime = Number(value); break;
    case 'volume': if (yt) yt.setVolume(Math.round(volume * 100)); else el.volume = volume; break;
    case 'rate': if (yt) yt.setPlaybackRate(Number(value)); else el.playbackRate = Number(value); break;
    case 'mute': if (yt) yt.mute(); else el.muted = true; break;
    case 'unmute': if (yt) yt.unMute(); else el.muted = false; break;
  }
  if (action !== 'status') await new Promise((r) => setTimeout(r, 300)); // the player reacting
  return { refused, status: status() };
};

const FIND_MEDIA_FN = () => {
  const all = [...document.querySelectorAll('video, audio')];
  const area = (m) => { const r = m.getBoundingClientRect(); return r.width * r.height; };
  return all.filter((m) => area(m) > 0).sort((a, b) => area(b) - area(a))[0] ?? all[0] ?? null;
};

const LEVELS = { error: 0, warning: 1, info: 2, log: 2, debug: 3 };

// evaluate failed because the page left the document it ran in: say where it went instead of Playwright's wording.
// The context can die before Playwright hears of the new URL, so wait briefly for the URL to move on.
async function navigatedError(tab, error, urlBefore) {
  if (!/Execution context was destroyed|Frame was detached|Cannot find context with specified id/i.test(error?.message)) throw error;
  await tab.page.waitForURL((u) => u.href !== urlBefore, { timeout: 2000, waitUntil: 'commit' }).catch(() => {});
  throw new Error(`The page navigated while evaluate ran, so its result is lost. The tab is now at ${tab.page.url()}. ` +
    'Do things that navigate (links, buttons, form submits) with click, type or navigate: they wait for the new page.');
}

// type: replaces the content (or appends), into the ref or whatever has focus.
// True when the element is hidden while focus sits in another text field (the page swapped the field).
const SWAPPED_FIELD_FN = (el) => {
  const hidden = !el.isConnected || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const focused = document.activeElement;
  return hidden && !!focused && focused !== el && focused.matches('input:not([type=hidden]), textarea, [contenteditable]:not([contenteditable=false])');
};

async function typeText(tab, args) {
  const timeout = args.timeout_ms;
  if (args.ref && isShadowRef(args.ref)) {
    // No Playwright locator here: focus over CDP, then type with the keyboard like a person.
    await focusShadowRef(tab, args.ref);
    // Keyboard select-all does nothing over CDP, so select the content in the element (as fill does).
    await callOnShadowRef(tab, args.ref, args.append ? CARET_TO_END_FN : SELECT_ALL_FN);
    if (!args.append && !args.text) await tab.page.keyboard.press('Delete');
  } else if (!args.ref) {
    // A focused text input or textarea is replaced or appended to like a ref's; elsewhere (rich text, code or canvas editors) the text goes in at the caret.
    const handle = await tab.page.evaluateHandle(FOCUSED_FIELD_FN);
    const field = handle.asElement();
    try {
      if (field) await field.evaluate(args.append ? CARET_TO_END_FN : SELECT_ALL_FN);
    } finally {
      handle.dispose().catch(() => {});
    }
    if (field && !args.append && !args.text) await tab.page.keyboard.press('Delete');
  }
  if (!args.ref || isShadowRef(args.ref)) {
    if (args.slowly) await tab.page.keyboard.type(args.text, { delay: 50 });
    else await tab.page.keyboard.insertText(args.text);
    if (args.submit) await tab.page.keyboard.press('Enter');
    return;
  }
  const loc = locator(tab, args.ref);
  // Search boxes (Wikipedia, many big sites) swap in another field when clicked: the old one is hidden and focus is in
  // the new one. Say so at once instead of waiting the whole timeout for the hidden field.
  const swapped = await loc.evaluate(SWAPPED_FIELD_FN, null, { timeout: 1000 }).catch(() => false);
  if (swapped) {
    throw new Error(`Ref ${args.ref} is hidden now and the keyboard focus is in another text field (the page replaced the field ` +
      'when it was clicked). Call type without ref to type into the focused field, or call snapshot for its ref.');
  }
  if (args.append) {
    await loc.focus({ timeout });
    await loc.evaluate(CARET_TO_END_FN);
    if (args.slowly) await tab.page.keyboard.type(args.text, { delay: 50 });
    else await tab.page.keyboard.insertText(args.text);
  } else if (args.slowly) {
    await loc.fill('', { timeout });
    await loc.pressSequentially(args.text, { delay: 50, timeout: Math.max(timeout ?? ACTION_TIMEOUT_MS, args.text.length * 100) });
  } else {
    await loc.fill(args.text, { timeout });
  }
  // Enter goes to whatever has focus after typing, without resolving the ref again: sites like Wikipedia swap
  // the input for a new element while you type, so the old ref can be gone. act's settle() waits for the page.
  if (args.submit) await tab.page.keyboard.press('Enter');
}

// --- Registration ---

export function registerTools(server, manager) {
  const handlers = {}; // raw handlers by tool name, so other tools can reuse one (download clicks with click's)
  const failed = (args, message) => ({ isError: true, content: [{ type: 'text', text: `${args?.tab ? `Tab: ${args.tab}\n` : ''}Error: ${message}` }] });
  const tool = (name, description, shape, handler) => {
    handlers[name] = handler;
    server.registerTool(name, { description, inputSchema: shape }, (args) => record.recordCall(name, args, async () => {
      const started = Date.now();
      debug('tool >', name, args);
      // Turn-end cleanup leaves a tab alone while any call names it (keyed "<browser>:<id>", as turns.mjs reads it).
      let tabKey = null;
      try { if (typeof args?.tab === 'string') { const { key, tabId } = parseTabId(args.tab); tabKey = `${key}:${tabId}`; } } catch {}
      if (tabKey) callsByTab.set(tabKey, (callsByTab.get(tabKey) ?? 0) + 1);
      let result;
      try {
        // A parked tab (taken over by the user, or handed to them) refuses everything but resuming or letting it go, at once.
        const parked = tabKey && !ON_PARKED_TABS.has(name) && takeover.notice(tabKey);
        if (parked) throw new Error(parked);
        result = await takeover.inCall({ tabKey, onParked: ON_PARKED_TABS.has(name) }, () => handler(args));
        debug('tool <', name, `${Date.now() - started} ms`);
      } catch (error) {
        debug('tool !', name, `${Date.now() - started} ms`, String(error?.message ?? error));
        result = failed(args, cleanError(error));
      } finally {
        if (tabKey && callsByTab.get(tabKey) > 1) callsByTab.set(tabKey, callsByTab.get(tabKey) - 1);
        else if (tabKey) callsByTab.delete(tabKey);
      }
      // The user took the tab over while this call ran on it: that, not the call's own outcome, is what the agent needs.
      const takenOver = tabKey && takeover.takenOverSince(tabKey, started);
      return takeover.withNotices(takenOver ? failed(args, takenOver) : result, tabKey);
    }));
  };

  tool('browser_list',
    'List the browsers FowlBrowser can drive right now: the user\'s own Google Chrome and Helium (their real profiles, logins and tabs). ' +
    'Each browser profile with the extension is listed on its own ("chrome", "chrome-2"), named after the label the user gave it ("Chrome (Work)"). ' +
    'Call this first and choose the browser on purpose; every other tool names its browser through the tab id prefix ("chrome:52", "helium:1834").',
    {},
    async () => {
      const browsers = await manager.all();
      if (!browsers.length) {
        return text('No browsers connected. FowlBrowser needs Google Chrome or Helium running with the FowlBrowser extension loaded.');
      }
      const lines = [`Connected browsers (${browsers.length}):`];
      for (const b of browsers) {
        const version = [b.version, b.chromiumVersion && `Chromium ${b.chromiumVersion}`].filter(Boolean).join(', ') || 'version unknown';
        const bar = b.silentDebugger ? 'debugging bar silenced' : 'debugging bar NOT silenced (the user sees a "started debugging" notice while a tab is controlled)';
        const mine = [...b.tabs.values()].map((t) => t.id);
        lines.push(`- ${b.name} (${version}) · browser: "${b.key}" · ${bar} · tabs you control: ${mine.length ? mine.join(', ') : 'none'}`);
      }
      return text(lines.join('\n'));
    });

  tool('tab_list',
    'List tabs. scope "all" (default) shows every tab in the browser, including the user\'s own tabs with their owner, so you can tab_claim one; ' +
    'scope "mine" shows only tabs this session controls. Omit browser to list every connected browser.',
    { browser: browserArg.optional(), scope: z.enum(['all', 'mine']).optional() },
    async ({ browser, scope = 'all' }) => {
      const browsers = browser ? [await manager.get(browser)] : await manager.all();
      if (!browsers.length) return text('No browsers connected.');
      const out = [];
      for (const b of browsers) {
        const tabs = (await b.host.request('tabs.listAll', {})).filter((t) => scope === 'all' || t.owner === 'you');
        out.push(`Browser: ${b.name} ("${b.key}") · ${tabs.length} tab${tabs.length === 1 ? '' : 's'}${scope === 'mine' ? ' controlled by you' : ''}`);
        for (const t of tabs) {
          const parkedAs = { takeover: '; taken over by the user', handoff: '; handed to the user' }[t.parked] ?? '';
          const owner = t.owner === 'you' ? `you (${t.origin === 'user' ? 'claimed from the user' : 'agent tab'}${parkedAs})`
            : t.owner === 'other' ? 'another agent (do not touch)' : 'user (claimable)';
          const flags = [t.active && 'active', t.pinned && 'pinned', t.audible && 'playing audio', t.muted && 'muted', t.groupTitle && `group "${t.groupTitle}"`].filter(Boolean);
          out.push(`- ${b.key}:${t.id} · ${t.title || '(no title)'} · ${t.url} · owner: ${owner}${flags.length ? ` · ${flags.join(', ')}` : ''}`);
        }
      }
      return text(out.join('\n'));
    });

  tool('tab_open',
    'Open a new tab in the named browser and control it. By default it is a work tab: in the background (never focused), muted, inside a tab group, ' +
    'closed when your session ends (in Claude Code at the end of your turn), so the user is not disturbed. When the tab is for the user (they asked you to open something for them to use, watch or read), ' +
    'pass for_user: true: it opens like their own tab (not grouped, stays open after your turn, muted only while you control it), still in the background unless focus: true. ' +
    'Returns the tab id (e.g. "helium:1834") to pass to every other tool, plus the page snapshot.',
    { browser: browserArg, url: z.string().optional().describe('URL to load (default about:blank).'),
      for_user: z.boolean().optional().describe('Open the tab for the user: not grouped, kept after your turn ends. You control it until then; it stays muted till then so nothing plays aloud before the user looks (tab_mute false if they asked to hear it now).'),
      focus: z.boolean().optional().describe('Bring the tab to the front once loaded. Only when the user asked to see it now.'),
      group: z.string().optional().describe('Tab group title (default: this session\'s label). Ignored with for_user.'),
      muted: z.boolean().optional().describe('Mute the tab\'s audio (default true; ignored with for_user).'),
      snapshot: snapshotArg, timeout_ms: timeoutArg },
    async ({ browser: key, url, for_user, focus, group, muted, snapshot, timeout_ms }) => {
      refuseLocalFile(url);
      const browser = await manager.get(key);
      await browser.playwright();
      const created = await browser.host.request('tabs.open', { group, muted, forUser: for_user === true });
      record.tabEvent('open', `${key}:${created.id}`, url ?? 'about:blank', { forUser: for_user === true });
      try {
        // Like a navigation, it may take a while when the browser is busy (its debugger attach alone can take seconds).
        const tab = await browser.waitForTab(created.id, timeout_ms ?? NAVIGATION_TIMEOUT_MS);
        return await tab.run(async () => {
          // A dialog the page opens while it loads holds the load up: it is reported at once, as act() does for navigate,
          // and the load goes on once it is resolved (later calls on the tab wait for that).
          let onDialog;
          const dialogOpened = new Promise((resolve) => { onDialog = resolve; tab.once('dialog', onDialog); });
          const opening = (async () => {
            if (url) await tab.page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeout_ms ?? NAVIGATION_TIMEOUT_MS });
            await loaded(tab.page);
            if (focus) await browser.host.request('tabs.focus', { tabId: tab.tabId });
          })();
          opening.catch(() => {}); // a dialog may win the race
          await Promise.race([opening, dialogOpened]).finally(() => tab.off('dialog', onDialog));
          if (tab.dialog) tab.keepBusy(opening.catch(() => {}));
          const lines = [`Opened ${tab.id} in ${browser.name}${focus && !tab.dialog ? ' and brought it to the front' : ''}.`];
          if (for_user) lines.push('It is the user\'s tab (not grouped) and stays open after your turn; you control it until then, and it stays muted till then so nothing plays aloud before they look (tab_mute false if they asked to hear it now).');
          return report(tab, { lines, snapshot: snapshot !== false && !tab.dialog });
        });
      } catch (error) {
        // The tab exists and is ours either way: name it so it can be used or closed instead of piling up.
        throw new Error(`Tab ${key}:${created.id} was opened and is controlled by this session (use it, or close it with tab_close), but: ${cleanError(error)}`);
      }
    });

  tool('tab_claim',
    'Take control of one of the user\'s existing tabs (ids from tab_list scope "all", owner user) to work inside it. It stays where it is and is never focused, ' +
    'but claiming wakes a background tab (a video in it may start playing), so claim only to read or act in the page. ' +
    'To close the user\'s tabs, call tab_close with confirm_close_users_tab: true; no claim needed. ' +
    'Release it with tab_release when done so the user gets it back untouched; it goes back to them when your session ends anyway (in Claude Code at the end of your turn; claim it again in a later turn). ' +
    'resume: true takes back a tab the user took over or you handed to them (tab_handoff), once they said in the conversation that you may carry on.',
    { tab: tabArg, snapshot: snapshotArg,
      resume: z.boolean().optional().describe('Resume a tab the user took over or you handed to them. Only after the user said so in the conversation.') },
    async ({ tab: value, snapshot, resume }) => {
      const { key, tabId } = parseTabId(value);
      const id = `${key}:${tabId}`;
      // A takeover still parking the tab: resume what it parked, not before. Checked again after the setup (a takeover
      // meanwhile); one after that is refused by the extension, which un-parks only with resume.
      const check = async () => {
        await takeover.settled(id);
        const parked = takeover.parked(id);
        if (parked && (!resume || parked.gone)) throw new Error(takeover.notice(id));
        return parked;
      };
      await check();
      const browser = await manager.get(key);
      await browser.playwright();
      const parked = await check();
      const claimed = await browser.host.request('tabs.claim', { tabId, resume: resume === true });
      // If the debugger isn't attached (an earlier attach failed), announce the tab again so a retry really retries.
      if (!browser.relay.model.isAttached(tabId)) browser.relay.model.onTabCreated(claimed);
      let tab;
      try {
        tab = await browser.waitForTab(tabId, NAVIGATION_TIMEOUT_MS);
      } catch (error) {
        // A resume that did not get the tab back leaves it with the user, parked as before (its notice stays).
        if (parked) await browser.host.request('tabs.park', { tabId, kind: parked.kind }).catch(() => {});
        throw error;
      }
      record.tabEvent(parked ? 'resume' : 'claim', tab.id, tab.page.url());
      if (parked) takeover.forget(id);
      const line = parked
        ? `Resumed ${tab.id}: you control it again. The user may have changed it meanwhile, so go by this snapshot.`
        : `Claimed ${tab.id}. Release it with tab_release when done.`;
      // A resumed tab always gets its snapshot: the page is not what the agent last saw.
      return tab.run(() => report(tab, { lines: [line], snapshot: !!parked || snapshot !== false }));
    });

  const byId = (tabId) => ({ tabId });
  // `ends`: the call ends our control of the tab. Then it leaves this session's model even if the extension's
  // event never comes (a tab closing during its release), so no ghost tab stays behind.
  // The cursor overlay leaves with our control: released tabs see its exit animation, closing ones don't wait.
  // event: the record mode tab line for it (release, close, keep). toUser: the tab goes back to the user, so the popup
  // scripts leave it first (popups.mjs).
  const simpleTabCall = (method, params, done, { ends = false, check, fadeCursor = false, event, toUser = false } = {}) => async (args) => {
    const { key, tabId } = parseTabId(args.tab);
    const browser = await manager.get(key);
    await browser.adopting.get(tabId); // a tab still being set up: its popup scripts are in before toUser takes them out
    const tab = browser.tabs.get(tabId);
    const url = tab?.page.url();
    const call = async () => {
      await check?.(browser, tabId, args); // in the tab's queue: a takeover or handover while earlier calls ran counts
      if (ends) takeover.markEnding(`${key}:${tabId}`); // its removal is ours, not the user closing it
      if (ends && tab) tab.ending = true; // its page closing now is ours, not "found gone" (record mode)
      if (event === 'release' && tab) await clearViewport(tab, 'release').catch(() => {});
      if (ends && tab) await cursor.remove(tab, { wait: fadeCursor });
      if (toUser && tab) await uninstallPopups(tab);
      const result = await browser.host.request(method, params(tabId, args));
      // An adoption that started meanwhile may have looked the tab up before this request took effect.
      const late = toUser && ((await browser.adopting.get(tabId)) ?? browser.tabs.get(tabId));
      if (late) await uninstallPopups(late);
      return result;
    };
    try {
      await (tab ? tab.run(call) : call());
    } catch (error) {
      if (ends) {
        const info = await tabInfo(browser, tabId).catch(() => undefined);
        if (info !== undefined && info?.owner !== 'you') browser.forget(tabId); // gone, or no longer ours
      }
      throw error;
    }
    if (ends) {
      browser.forget(tabId);
      takeover.forget(`${key}:${tabId}`);
    }
    if (event) record.tabEvent(event, `${key}:${tabId}`, url);
    return text(`Browser: ${browser.name} · Tab: ${key}:${tabId}\n${typeof done === 'function' ? done(args) : done}`);
  };

  // A claimed tab is the user's own, and so is one handed over or taken over: closing it needs their explicit request.
  const refuseUsersTab = async (browser, tabId, args) => {
    if (args.confirm_close_users_tab === true) return;
    const info = await tabInfo(browser, tabId);
    if (takeover.parked(`${browser.key}:${tabId}`) || (info?.owner === 'you' && (info.origin === 'user' || info.handedOver))) {
      throw new Error(`Tab ${browser.key}:${tabId} is the user's own tab (you claimed it, handed it to them, or they took it over), so it was not closed. Give it back with tab_release. ` +
        'Close it only if the user asked you to close it: call tab_close again with confirm_close_users_tab: true.');
    }
  };

  tool('tab_release', 'Give a claimed or opened tab back to the user: stop controlling it and leave it open.',
    { tab: tabArg }, simpleTabCall('tabs.release', byId, 'Released. The tab stays open and is no longer controlled.', { ends: true, fadeCursor: true, event: 'release', toUser: true }));
  // usersTab: the extension closes a parked tab only with it.
  const closeOwned = simpleTabCall('chrome.tabs.remove', (tabId, args) => (args.confirm_close_users_tab === true ? [tabId, { usersTab: true }] : [tabId]), 'Closed.', { ends: true, check: refuseUsersTab, event: 'close' });
  tool('tab_close',
    'Close a tab. Your own tabs close directly. The user\'s tabs (claimed or not) close only when the user asked for it, with confirm_close_users_tab: true; ' +
    'to close the user\'s tabs, do not claim them first (claiming wakes them and starts their media): call tab_close on the ids from tab_list. ' +
    'A claimed tab you are done with goes back with tab_release instead.',
    { tab: tabArg, confirm_close_users_tab: z.boolean().optional().describe('Required to close one of the user\'s tabs (claimed or not). Pass true only when the user asked for that tab to be closed.') },
    async (args) => {
      const { key, tabId } = parseTabId(args.tab);
      const browser = await manager.get(key);
      // One this session controls closes as ours (refuseUsersTab looks it up, in its queue); any other is looked up here.
      if (browser.tabs.has(tabId)) return closeOwned(args);
      const info = await tabInfo(browser, tabId);
      if (!info || info.owner !== null) return closeOwned(args);
      if (args.confirm_close_users_tab !== true) {
        throw new Error(`Tab ${key}:${tabId} is the user's own tab, so it was not closed. Close it only if the user asked you to: ` +
          'call tab_close again with confirm_close_users_tab: true (no claim needed).');
      }
      await browser.host.request('tabs.closeUnowned', { tabId });
      record.tabEvent('close', `${key}:${tabId}`, info.url);
      return text(`Browser: ${browser.name} · Tab: ${key}:${tabId}\nClosed the user's tab (without claiming it, so it never woke up).`);
    });
  tool('tab_keep',
    'Hand a tab you opened to the user now: it leaves your tab group and stays open after your turn ends (agent tabs normally close then). ' +
    'You keep controlling it (no tab_claim needed) until your turn ends or you tab_release it; claim it again in a later turn. ' +
    'A muted work tab stays muted while you control it and is unmuted when control ends (tab_mute false if the user asked to hear it now). ' +
    'For a tab meant for the user from the start, use tab_open with for_user: true.',
    { tab: tabArg }, simpleTabCall('tabs.keep', byId, 'Kept: handed to the user now (ungrouped) and stays open after your turn ends. You still control it until then; ' +
      'if it was muted it stays muted till then (tab_mute false if the user asked to hear it now).',
      { event: 'keep', toUser: true }));
  tool('tab_handoff',
    'Hand a tab to the user mid-task for something only they should do: logging in, a 2FA code, a CAPTCHA, payment or card details. ' +
    'Your cursor leaves, the tab leaves your group and is unmuted, and you stop acting in it (it is never brought to the front). ' +
    'Repeat the returned line to the user, then wait: once they say they are done, tab_claim it with resume: true and carry on; tab_release lets it go for good.',
    { tab: tabArg, reason: z.string().min(1).describe('What the user should do there, as words for them, e.g. "log in to your bank" or "enter the card details".') },
    async ({ tab: value, reason }) => {
      const tab = await resolveTab(manager, value);
      refuseLocalPage(tab);
      const title = (await tab.currentTitle()) || tab.page.url();
      await tab.run(() => takeover.handOff(tab, reason));
      return text(`Browser: ${tab.browser.name} · Tab: ${tab.id}\nHanded ${tab.id} to the user. Tell them: Your turn in ${tab.browser.name} tab "${title}": ${reason}, then tell me.\n` +
        'Once they say they are done, call tab_claim on it with resume: true to carry on (you get a fresh snapshot). If you no longer need it, tab_release gives it to them for good.');
    });
  tool('tab_mute',
    'Mute or unmute a tab\'s audio (the browser\'s tab mute, what the speaker icon in the tab strip shows). Agent tabs open muted unless muted: false (for_user tabs until your turn ends). ' +
    'This is separate from the page\'s own video mute (media mute/unmute).',
    { tab: tabArg, muted: z.boolean() },
    simpleTabCall('tabs.setMuted', (tabId, { muted }) => ({ tabId, muted }), ({ muted }) => (muted ? 'Tab audio muted.' : 'Tab audio unmuted.')));
  tool('tab_focus', 'Bring a tab to the front and focus its window. Only when the user explicitly asks to see it; every other tool works in the background.',
    { tab: tabArg }, simpleTabCall('tabs.focus', byId, 'Focused.'));

  tool('navigate',
    'Load a URL in a tab, or go back, forward or reload. Returns the new snapshot.',
    { tab: tabArg, url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional(), snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, () => cued(tab, 'navigate', async () => {
      const options = { waitUntil: 'domcontentloaded', timeout: args.timeout_ms ?? NAVIGATION_TIMEOUT_MS };
      let response;
      if (args.url) response = await tab.page.goto(refuseLocalFile(args.url), options);
      else if (args.action === 'back' || args.action === 'forward') {
        // Page.goBack never resolves when Chrome restores the page from its back/forward cache, so step
        // through history in the page and wait for the URL or document to change instead.
        const back = args.action === 'back';
        const before = await tab.page.evaluate((b) => ({ url: location.href, can: b ? window.navigation?.canGoBack : window.navigation?.canGoForward }), back);
        if (before.can === false) return `No ${args.action} history entry.`;
        const changed = tab.page.waitForEvent('framenavigated', { predicate: (f) => f === tab.page.mainFrame(), timeout: options.timeout })
          .catch(() => tab.page.waitForURL((u) => u.href !== before.url, { timeout: 2000 }));
        await Promise.all([changed, tab.page.evaluate((b) => (b ? history.back() : history.forward()), back)]);
      } else if (args.action === 'reload') response = await tab.page.reload(options);
      else throw new Error('Pass url or action.');
      await loaded(tab.page);
      if (response === null && args.action && args.action !== 'reload') return `No ${args.action} history entry.`;
      return response && !response.ok() ? `HTTP ${response.status()} ${response.statusText()}` : null;
    }, { after: true }), { waited: true }), { onLocalPage: (args) => !!args.url }));

  tool('snapshot',
    'Read the page as an accessibility snapshot (YAML). Elements carry refs like [ref=e12] that click, type and other tools take. ' +
    'Pass ref to read just one section of a large page. Always the whole page (or section), never just changes. ' +
    `Output is cut at max_chars (default ${SNAPSHOT_MAX_CHARS}); a cut snapshot ends with a line saying how much was left out. ` +
    'mode "text" returns the readable text instead (of ref, else the page\'s main content), without refs: for reading articles and lists, not for acting.',
    { tab: tabArg, ref: refArg.optional(),
      mode: z.enum(['snapshot', 'text']).optional().describe('"snapshot" (default): accessibility tree with refs. "text": readable text only, no refs.'),
      max_chars: z.number().int().min(1000).max(SNAPSHOT_MAX_CHARS_LIMIT).optional().describe(`Cut the output at this many characters (default ${SNAPSHOT_MAX_CHARS}, max ${SNAPSHOT_MAX_CHARS_LIMIT}).`) },
    withTab(manager, (tab, { ref, mode, max_chars: maxChars }) => cued(tab, 'observe', async () => (mode === 'text'
      ? text(`${await header(tab)}\n${await pageText(tab, { ref, maxChars })}`)
      : report(tab, { ref, maxChars })))));

  // A main-frame ref the last snapshot doesn't show as a link, field, toggle or row: worth asking the page whether its
  // click may carry the hidden new-tab modifier (BACKGROUND_CLICK_FN decides; this only saves its round trip).
  const mayOpenPopup = (tab, ref) => {
    const shown = cleanRef(ref);
    if (/^f\d/.test(shown)) return false;
    if (tab.snapshotBaseline?.generation !== tab.documentGeneration) return true;
    const line = tab.snapshotBaseline.text.split('\n').find((l) => l.includes(`[ref=${shown}]`));
    return !/^\s*- (link|checkbox|radio|switch|textbox|searchbox|combobox|listbox|option|slider|spinbutton|menuitemcheckbox|menuitemradio|row|gridcell|treeitem)\b/.test(line ?? '');
  };
  const modifiersArg = z.array(z.enum(['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'])).optional();
  tool('click',
    'Click an element by ref, or a point by x,y in CSS pixels (same pixels as the screenshot image). Works in the background tab. ' +
    'A ref that is covered (e.g. by a cookie banner), disabled or hidden fails within about a second saying why and what covers it; ' +
    'a hidden radio or checkbox is clicked through its label.',
    { tab: tabArg, ref: shadowRefArg.optional(), x: z.number().optional(), y: z.number().optional(),
      button: z.enum(['left', 'right', 'middle']).optional(), double: z.boolean().optional(), modifiers: modifiersArg,
      snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const options = { button: args.button, modifiers: args.modifiers };
      let { x, y } = args;
      if (args.ref && isShadowRef(args.ref)) ({ x, y } = await shadowRefPoint(tab, args.ref));
      else if (args.ref) {
        const loc = locator(tab, args.ref);
        const plain = !args.double && (args.button ?? 'left') === 'left' && !args.modifiers?.length;
        return pointed(tab, refPoint(tab, args.ref), () => {
          const click = (modifiers = args.modifiers) => onRef(tab, args.ref, loc, (timeout) => (args.double
            ? loc.dblclick({ ...options, modifiers, timeout }) : loc.click({ ...options, modifiers, timeout })), args.timeout_ms, plain ? 'toggle' : undefined);
          // A popup it opens is a background tab with its opener, never activated (SPEC "Popups (session 5)").
          return plain && mayOpenPopup(tab, args.ref) ? backgroundClick(tab, loc, (args.timeout_ms ?? ACTION_TIMEOUT_MS) + 5000, click) : click();
        });
      }
      if (x === undefined || y === undefined) throw new Error('Pass ref, or both x and y.');
      await pointed(tab, { x, y }, async () => {
        const mods = args.modifiers ?? [];
        for (const m of mods) await tab.page.keyboard.down(m);
        try {
          await tab.page.mouse.click(x, y, { button: args.button, clickCount: args.double ? 2 : 1 });
        } finally {
          for (const m of [...mods].reverse()) await tab.page.keyboard.up(m);
        }
      });
    })));

  tool('hover', 'Move the mouse over an element (opens hover menus, tooltips).',
    { tab: tabArg, ref: shadowRefArg, snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (!isShadowRef(args.ref)) {
        const loc = locator(tab, args.ref);
        return pointed(tab, refPoint(tab, args.ref), () => quickly(tab, args.ref, loc, (timeout) => loc.hover({ timeout }), args.timeout_ms), { feedback: false });
      }
      const { x, y } = await shadowRefPoint(tab, args.ref);
      await pointed(tab, { x, y }, () => tab.page.mouse.move(x, y), { feedback: false });
    })));

  tool('type',
    'Type text into an editable element. Replaces its content unless append is true. slowly types one key at a time (for fields that react per key, like search suggestions). submit presses Enter after. ' +
    'Without ref it types into whatever has focus (e.g. after click at x,y on a canvas editor or a control the snapshot cannot show): a focused text input or textarea ' +
    'is replaced or appended to the same way; in rich text, code and canvas editors the text goes in at the caret.',
    { tab: tabArg, ref: shadowRefArg.optional(), text: z.string(), submit: z.boolean().optional(), slowly: z.boolean().optional(), append: z.boolean().optional(),
      snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, () => (args.ref
      ? pointed(tab, refPoint(tab, args.ref), () => typeText(tab, args), { feedback: false, cue: 'text' })
      : cued(tab, 'text', () => typeText(tab, args))))));

  tool('fill_form',
    'Fill several form fields at once. value: text for textboxes, true/false for checkboxes, radios and switches, option label or value for selects and comboboxes, a number for sliders.',
    { tab: tabArg, fields: z.array(z.object({ ref: refArg, value: z.union([z.string(), z.boolean(), z.number()]) })).min(1),
      snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const timeout = args.timeout_ms;
      const shown = await cursor.isShown(tab);
      const notes = []; // radios and checkboxes set through their label
      for (const { ref, value } of args.fields) {
        const loc = locator(tab, ref);
        const kind = await loc.evaluate((el) => {
          const role = el.getAttribute('role');
          if (el.tagName === 'SELECT') return 'select';
          if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) return 'check';
          if (el.tagName === 'INPUT' && el.type === 'range') return 'range';
          if (['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role)) return 'check';
          return 'text';
        }, null, { timeout });
        const typing = kind === 'text';
        await pointed(tab, refPoint(tab, ref), async () => {
          if (kind === 'check') {
            const on = value === true || ['true', 'on', 'yes', 'checked', '1'].includes(String(value).toLowerCase());
            const viaLabel = await onRef(tab, ref, loc, (t) => loc.setChecked(on, { timeout: t }), timeout, on);
            if (viaLabel) notes.push(viaLabel);
          } else if (kind === 'select') await selectOnce(tab, ref, loc, [String(value)], timeout);
          else if (kind === 'range') {
            await loc.evaluate((el, v) => {
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }, String(value));
          } else await loc.fill(String(value), { timeout });
        }, { shown, feedback: !typing, cue: typing ? 'text' : undefined });
      }
      return [`Filled ${args.fields.length} field${args.fields.length === 1 ? '' : 's'}.`, ...notes];
    })));

  tool('select_option', 'Choose option(s) in a <select> by label or value.',
    { tab: tabArg, ref: refArg, values: z.array(z.string()).min(1), snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const loc = locator(tab, args.ref);
      const chosen = await pointed(tab, refPoint(tab, args.ref), () => selectOnce(tab, args.ref, loc, args.values, args.timeout_ms));
      return `Selected: ${chosen.join(', ')}`;
    })));

  tool('press_key',
    'Press a key or combo, e.g. "Enter", "Escape", "ArrowDown", "ControlOrMeta+a". With ref, focuses that element first; otherwise goes to the focused element.',
    { tab: tabArg, key: z.string(), ref: shadowRefArg.optional(), snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const press = async () => {
        if (args.ref && !isShadowRef(args.ref)) await locator(tab, args.ref).focus({ timeout: args.timeout_ms });
        else if (args.ref) await focusShadowRef(tab, args.ref);
        await tab.page.keyboard.press(args.key);
      };
      return args.ref ? pointed(tab, refPoint(tab, args.ref), press, { feedback: false, cue: 'key' }) : cued(tab, 'key', press);
    })));

  tool('scroll',
    'Scroll the page (or the scrollable area under the viewport centre) by pages in a direction. With ref and direction, ' +
    'scroll the box that ref is in instead (a list, panel or table that scrolls on its own, e.g. a long or virtualized list), ' +
    'by pages of its own height. ref alone scrolls that element into view.',
    { tab: tabArg, ref: refArg.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), pages: z.number().positive().optional(),
      snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (args.ref && args.direction) return scrollBox(tab, args);
      if (args.ref) {
        await locator(tab, args.ref).scrollIntoViewIfNeeded({ timeout: args.timeout_ms });
        // The cursor follows to where the element landed.
        await pointed(tab, refPoint(tab, args.ref), () => sleep(0), { feedback: false, cue: 'scroll' });
        return `Scrolled ${args.ref} into view.`;
      }
      const direction = args.direction ?? 'down';
      const pages = args.pages ?? 1;
      const { w, h } = await tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      const step = (direction === 'up' || direction === 'down' ? h : w) * 0.8 * pages;
      const sign = direction === 'up' || direction === 'left' ? -1 : 1;
      await pointed(tab, { x: w / 2, y: h / 2 }, async () => {
        await tab.page.mouse.move(w / 2, h / 2);
        await tab.page.mouse.wheel(direction === 'left' || direction === 'right' ? sign * step : 0, direction === 'up' || direction === 'down' ? sign * step : 0);
      }, { feedback: false, cue: 'scroll' });
      const pos = await tab.page.evaluate(() => ({ x: Math.round(scrollX), y: Math.round(scrollY), max: document.documentElement.scrollHeight - innerHeight }));
      return `Scrolled ${direction} ${pages} page${pages === 1 ? '' : 's'}. Window scroll position: x=${pos.x} y=${pos.y} (max y ${pos.max}).`;
    })));

  tool('drag', 'Drag one element onto another.',
    { tab: tabArg, from_ref: refArg, to_ref: refArg, snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      const from = locator(tab, args.from_ref);
      const to = locator(tab, args.to_ref);
      // One cursor budget for both ends.
      const deadline = Date.now() + cursor.ARRIVAL_CAP_MS;
      const shown = await cursor.isShown(tab);
      if (shown) await cursor.moveTo(tab, refPoint(tab, args.from_ref), Math.max(0, deadline - Date.now()));
      await pointed(tab, refPoint(tab, args.to_ref), () => from.dragTo(to, { timeout: args.timeout_ms }), { shown, feedback: false, cue: 'drag', cueOnPress: true, deadline });
    })));

  tool('upload_files',
    'Upload local files: ref is a file input, or a button that opens a file chooser. paths are absolute paths on this Mac.',
    { tab: tabArg, ref: refArg, paths: z.array(z.string()).min(1), snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      const loc = locator(tab, args.ref);
      const files = uploadPaths(args.paths);
      const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', null, { timeout: args.timeout_ms });
      await pointed(tab, refPoint(tab, args.ref), async () => {
        if (isInput) await loc.setInputFiles(files, { timeout: args.timeout_ms });
        else {
          const [chooser] = await Promise.all([tab.page.waitForEvent('filechooser', { timeout: args.timeout_ms }), loc.click({ timeout: args.timeout_ms })]);
          await chooser.setFiles(files);
        }
      }, { feedback: false, cue: 'transfer' });
      return `Uploaded ${files.length} file${files.length === 1 ? '' : 's'}.`;
    })));

  tool('dialog',
    'Resolve the open JavaScript dialog (alert, confirm, prompt, beforeunload) on a tab. Results of other tools say when one is open.',
    { tab: tabArg, accept: z.boolean(), text: z.string().optional().describe('Text to enter for a prompt dialog.'), snapshot: snapshotArg },
    // Not queued: the action that opened the dialog may still hold this tab's queue until the dialog is resolved.
    async (args) => {
      const tab = await resolveTab(manager, args.tab);
      refuseLocalPage(tab);
      const started = Date.now();
      const dialog = tab.dialog;
      if (!dialog) throw new Error('No dialog is open on this tab.');
      tab.dialog = null;
      const summary = `${args.accept ? 'Accepted' : 'Dismissed'} ${dialog.type()} "${dialog.message()}".`;
      const snapshot = args.snapshot !== false;
      const answer = async () => {
        // What the page does once it goes on (a navigation a confirm allowed, a request) is waited for like after an action.
        const watch = watchRequests(tab.page);
        try {
          const generation = tab.documentGeneration;
          if (args.accept) await dialog.accept(args.text);
          else await dialog.dismiss();
          await settle(tab, watch, { watchMs: snapshot ? WATCH_MS.snapshot : WATCH_MS.action, generation, trailing: snapshot }).catch(() => {});
        } finally {
          watch.stop();
        }
        return report(tab, { lines: [summary], snapshot: snapshot && !tab.dialog, changes: true });
      };
      // A popup that closes itself once its alert is answered, maybe before the answer's own reply comes back.
      return answer().catch((error) => {
        const closed = closedItself(tab, started);
        if (closed) return closed;
        throw error;
      });
    });

  tool('wait_for',
    'Wait until text appears (text), disappears (text_gone), the URL contains a string (url), or for a number of seconds. ' +
    'A url with * is matched against the whole URL, * standing for anything (also "/"), e.g. "*/wiki/Ada_*".',
    { tab: tabArg, text: z.string().optional(), text_gone: z.string().optional(), url: z.string().optional(),
      seconds: z.number().positive().max(120).optional(), snapshot: snapshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, () => cued(tab, 'observe', async () => {
      const page = tab.page;
      if (args.seconds) await page.waitForTimeout(args.seconds * 1000);
      if (args.text) await page.getByText(args.text).first().waitFor({ state: 'visible', timeout: args.timeout_ms });
      if (args.text_gone) await page.getByText(args.text_gone).first().waitFor({ state: 'hidden', timeout: args.timeout_ms });
      if (args.url) {
        const matches = urlMatcher(args.url);
        const timeout = args.timeout_ms ?? NAVIGATION_TIMEOUT_MS;
        await page.waitForURL((u) => matches(u.href), { timeout, waitUntil: 'domcontentloaded' }).catch((error) => {
          if (!/Timeout \d+ms exceeded/.test(error.message)) throw error;
          throw new Error(`The URL did not match "${args.url}" within ${timeout / 1000} s. Current URL: ${page.url()}`);
        });
      }
      if (!args.seconds && !args.text && !args.text_gone && !args.url) throw new Error('Pass text, text_gone, url or seconds.');
      return 'Wait finished.';
    }), { waited: true })));

  tool('screenshot',
    'Screenshot the tab (or one element with ref) as JPEG. Image pixels are CSS pixels, so x,y read off a viewport screenshot work directly with click. Prefer snapshot for reading text.',
    { tab: tabArg, full_page: z.boolean().optional(), ref: refArg.optional(), timeout_ms: timeoutArg },
    withTab(manager, async (tab, args) => {
      if (tab.dialog) throw new Error(`${dialogLine(tab)} Screenshots wait until it is resolved.`);
      const options = { type: 'jpeg', quality: 80, scale: 'css', timeout: args.timeout_ms ?? ACTION_TIMEOUT_MS };
      const image = await cued(tab, 'observe', () => cursor.hideForCapture(tab, () => (args.ref
        ? locator(tab, args.ref).screenshot(options)
        : tab.page.screenshot({ ...options, fullPage: !!args.full_page }))), { after: true });
      refuseLocalPage(tab); // it went there while the screenshot was taken
      const what = args.ref ? `element ${args.ref}` : args.full_page ? 'full page' : 'viewport';
      return { content: [
        { type: 'text', text: `${await header(tab)}\nScreenshot of the ${what}, JPEG, 1 image px = 1 CSS px.` },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
      ] };
    }));

  const sizeArg = z.number().int().min(MIN_SIZE).max(MAX_SIZE).optional();
  tool('viewport',
    'Lay the page out at another size (CSS px), like a phone or a smaller window; mobile: true also emulates a phone (meta viewport, touch). ' +
    'Only when the user asks for a size or device, to test a breakpoint or mobile layout, or when the task can\'t be answered without it; never to make screenshots bigger. ' +
    'Snapshot, screenshot and click x,y then use this size. Reset with reset: true when done unless the user asked to keep it (releasing the tab or the end of your session or Claude Code turn resets it too).',
    { tab: tabArg, width: sizeArg.describe(`Width in CSS px (${MIN_SIZE} to ${MAX_SIZE}).`), height: sizeArg.describe(`Height in CSS px (${MIN_SIZE} to ${MAX_SIZE}).`),
      mobile: z.boolean().optional().describe('Emulate a phone: meta viewport, overlay scrollbars, touch (default false).'),
      device_scale_factor: z.number().positive().max(4).optional().describe('devicePixelRatio, e.g. 3 for a recent iPhone (default: the screen\'s own).'),
      reset: z.boolean().optional().describe('Back to the tab\'s real size.'), snapshot: snapshotArg },
    withTab(manager, async (tab, args) => {
      const lines = [];
      if (args.reset) {
        lines.push((await clearViewport(tab)) ? 'Viewport reset: the page is back at the tab\'s real size.' : 'No viewport was set on this tab; it is at its real size.');
      } else {
        if (args.width === undefined || args.height === undefined) throw new Error('Pass width and height, or reset: true.');
        await setViewport(tab, { width: args.width, height: args.height, mobile: args.mobile === true, deviceScaleFactor: args.device_scale_factor });
        const page = await tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })).catch(() => null);
        lines.push(`Viewport set to ${args.width}x${args.height}${args.mobile ? ' (mobile)' : ''}: the page reflowed` +
          `${page ? ` (innerWidth ${page.w}, innerHeight ${page.h}, devicePixelRatio ${page.dpr})` : ''}. Snapshot, screenshot and click x,y use this size; ` +
          'reset with viewport reset: true when done.');
        const info = await tabInfo(tab.browser, tab.tabId).catch(() => null);
        if (info && (info.origin === 'user' || info.kept || info.handedOver)) {
          lines.push('This is the user\'s tab: they see it resized too until you reset it or release it.');
        }
      }
      return report(tab, { lines, snapshot: args.snapshot !== false });
    }));

  tool('evaluate',
    'Run a JavaScript function in the page and return its JSON result, e.g. "() => document.title" or, with ref, "(el) => el.outerHTML". ' +
    'For reading page state only: to click, type, select or press keys use those tools (real input, waits for what the action starts, ' +
    'and the user sees each action), not el.click() or loops in here. A plain expression such as "document.title" also works (as expression or function). ' +
    'To read a page\'s text, snapshot with mode "text" is usually simpler.',
    { tab: tabArg, function: z.string().optional().describe('A function expression, e.g. "() => document.title", or a plain expression.'),
      expression: z.string().optional().describe('Same as function (either one).'),
      ref: refArg.optional(), snapshot: z.boolean().optional().describe('Also return the page snapshot (default false).'), timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (!args.function && !args.expression) throw new Error('Pass function, e.g. "() => document.title".');
      const source = functionSource(args.function ?? args.expression, { withElement: !!args.ref });
      const urlBefore = tab.page.url();
      const started = Date.now();
      // A page function that never settles must not hold this tab's queue for the rest of the session.
      const timeout = args.timeout_ms ?? ACTION_TIMEOUT_MS;
      let result;
      try {
        result = await cued(tab, 'observe', () => {
          // Async, so even a function that doesn't parse becomes a rejection the race below sees.
          const run = (async () => (args.ref
            // eslint-disable-next-line no-new-func
            ? locator(tab, args.ref).evaluate(new Function('el', `return (${source})(el);`), null, { timeout })
            : tab.page.evaluate(`(${source})()`)))().catch((error) => navigatedError(tab, error, urlBefore));
          run.catch(() => {});
          let timer;
          const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`evaluate did not finish within ${timeout} ms`)), timeout); });
          return Promise.race([run, expired]).finally(() => clearTimeout(timer));
        }, { follow: true });
      } finally {
        if (record.recording) record.scriptClicks(tab, await cursor.drainClicks(tab).catch(() => []));
      }
      // The page went to a local file while the function ran (and maybe back): its result may be read from that file.
      if (tab.localPageAt >= started) throw new Error(`Tab ${tab.id}: it showed a local file while this ran, which FowlBrowser doesn't read, so the result was discarded.`);
      const json = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
      return `Result:\n${cap(json, 'Return less data.')}`;
    }, { snapshot: args.snapshot === true, read: true })));

  tool('media',
    'Control the page\'s video or audio player (the largest visible one, or ref): status, play, pause, toggle, seek (value = seconds), volume (0-1), rate (playback speed), mute, unmute. ' +
    'On YouTube it uses YouTube\'s own player, so its controls show the change. mute/unmute always mean the video player\'s own mute, never the tab\'s audio: ' +
    'agent tabs open with tab audio muted unless tab_open had muted: false (for_user tabs until your turn ends); change tab audio with tab_mute.',
    { tab: tabArg, action: z.enum(['status', 'play', 'pause', 'toggle', 'seek', 'volume', 'rate', 'mute', 'unmute']),
      value: z.number().optional(), ref: refArg.optional(), snapshot: z.boolean().optional().describe('Also return the page snapshot (default false).') },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (['seek', 'volume', 'rate'].includes(args.action) && args.value === undefined) throw new Error(`${args.action} needs value.`);
      let handle, refused, status;
      // Players often build their <video> after load (YouTube is a single-page app).
      if (!args.ref) await tab.page.locator('video, audio').first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
      const shown = await cursor.isShown(tab);
      if (shown) cursor.cue(tab, 'observe');
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await handle?.dispose().catch(() => {});
            handle = null;
            if (args.ref) handle = await locator(tab, args.ref).elementHandle();
            else {
              const found = await tab.page.evaluateHandle(FIND_MEDIA_FN);
              handle = found.asElement();
              if (!handle) await found.dispose().catch(() => {});
            }
            if (!handle) throw new Error('No video or audio element on this page.');
            ({ refused, status } = await handle.evaluate(MEDIA_FN, { action: args.action, value: args.value }));
            break;
          } catch (error) {
            // Players like YouTube navigate in place while loading; try again on the new document.
            if (attempt >= 2 || !/context was destroyed|not attached to the DOM/i.test(error.message)) throw error;
            await loaded(tab.page);
          }
        }
        if (refused) {
          // Autoplay policy wants a user gesture: a real (CDP) click on the player counts as one.
          // On players that toggle on click (YouTube) the click itself may already start playback.
          await handle.click({ timeout: ACTION_TIMEOUT_MS });
          await sleep(500);
          ({ refused, status } = await handle.evaluate(MEDIA_FN, { action: 'status' }));
          if (status.paused) ({ refused, status } = await handle.evaluate(MEDIA_FN, { action: 'play' }));
        }
      } finally {
        await handle?.dispose().catch(() => {});
        if (shown) cursor.cueEnd(tab);
      }
      const info = await tabInfo(tab.browser, tab.tabId);
      const lines = [`Media ${args.action}${refused ? ` (play refused: ${refused})` : ''}: ${JSON.stringify(status)}`];
      if (info?.muted) lines.push('Note: the tab\'s audio is muted (agent tabs open muted), so the user hears nothing whatever the player says; tab_mute with muted: false changes that.');
      return lines;
    }, { snapshot: args.snapshot === true, read: true })));

  tool('console', 'Recent console messages and uncaught errors of a tab (captured since this session started controlling it).',
    { tab: tabArg, level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level (default info).'),
      limit: z.number().int().positive().optional().describe('Most recent N (default 50).') },
    withTab(manager, async (tab, { level = 'info', limit = 50 }) => {
      const max = LEVELS[level];
      const entries = tab.console.filter((m) => (LEVELS[m.level] ?? 3) <= max).slice(-limit);
      const lines = entries.map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ''}`);
      return text(`${await header(tab)}\n${lines.length ? cap(lines.join('\n'), 'Lower limit.') : 'No console messages.'}`);
    }));

  tool('network', 'Recent network requests of a tab (method, status, type, URL), captured since this session started controlling it.',
    { tab: tabArg, filter: z.string().optional().describe('Substring of the URL, or /regex/.'),
      limit: z.number().int().positive().optional().describe('Most recent N (default 50).') },
    withTab(manager, async (tab, { filter, limit = 50 }) => {
      const regex = filter?.match(/^\/(.+)\/([a-z]*)$/);
      const test = !filter ? () => true : regex ? (u) => new RegExp(regex[1], regex[2]).test(u) : (u) => u.includes(filter);
      const entries = tab.network.filter((r) => test(r.url)).slice(-limit);
      const lines = entries.map((r) => `${r.method} ${r.status}${r.failure ? ` ${r.failure}` : ''} ${r.type} ${r.url}`);
      return text(`${await header(tab)}\n${lines.length ? cap(lines.join('\n'), 'Use filter or a lower limit.') : 'No matching requests.'}`);
    }));

  tool('export', EXPORT_DESCRIPTION, exportShape(tabArg),
    withTab(manager, async (tab, args) => text(`${await header(tab)}\n${await cued(tab, 'observe', () => exportTab(tab, args))}`)));

  registerBrowserData(tool, manager, { click: (args) => handlers.click(args), parseTabId });
  registerPerf(tool, manager, { withTab: (handler) => withTab(manager, handler), header, text, tabArg });
}
