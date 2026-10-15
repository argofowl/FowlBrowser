// MCP tools. Every tab-level tool takes an explicit tab id like "helium:1834"; there is no current tab.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ACTION_TIMEOUT_MS, NAVIGATION_TIMEOUT_MS } from './browsers.mjs';
import { registerBrowserData } from './browserData.mjs';
import { cdp } from './cdp.mjs';
import { callOnShadowRef, cleanRef, closedShadowSection, focusShadowRef, isShadowRef, shadowRefCenter, shadowRefPoint } from './closedShadow.mjs';
import * as cursor from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { EXPORT_DESCRIPTION, exportShape, exportTab } from './exports.mjs';
import { registerPerf } from './perf.mjs';
import { backgroundClick, openingLines, uninstallPopups } from './popups.mjs';
import * as record from './record.mjs';
import * as takeover from './takeover.mjs';
import { callsByTab } from './turns.mjs';
import { isLocalUrl, sleep, tabInfo, within } from './util.mjs';
import { clearViewport, MAX_SIZE, MIN_SIZE, setMedia, setViewport } from './viewport.mjs';
import { cap as capText, collapseText, findInSnapshot, functionSource, mainFramePrefixes, maskFields, newRefState, numberRefs, playwrightRef, REF_PATTERN,
  shownRef, shownValue, SNAPSHOT_MAX_CHARS, SNAPSHOT_MAX_CHARS_LIMIT, snapshotChanges, textFields, urlMatcher, yamlValue } from './snapshots.mjs';

const MAX_CHARS = 40_000; // for evaluate, console and network output: like snapshots, under what Claude Code takes uncounted (snapshots.mjs)
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
const screenshotArg = z.boolean().optional().describe(
  'Also return a screenshot of the viewport once the action is done (JPEG, 1 image px = 1 CSS px): for checking how it looks, without a separate screenshot call.');
const framesArg = z.number().int().min(2).max(8).optional().describe(
  'Also return this many viewport screenshots taken while the action\'s effect plays out, from the moment its input lands, frame_ms apart: ' +
  'to check an animation or transition in motion (each costs as much as a screenshot).');
const frameMsArg = z.number().int().min(50).max(1000).optional().describe('Time between frames in ms (default 100; one capture takes about that long).');
// At most 120 s: the native host ends any request after that, and a page call cut there reads as a lost page.
const timeoutArg = z.number().int().positive().max(120_000).optional().describe(`Timeout in ms (default ${ACTION_TIMEOUT_MS} for actions, ${NAVIGATION_TIMEOUT_MS} for navigation; at most 120000).`);
const browserArg = z.string().describe(
  'Browser name from browser_list, e.g. "chrome" (Google Chrome) or "helium". Pick it on purpose: the one the user named (by app or by the name they gave it, like "Work"), and only that one, even when the site asks to sign in there (tab_handoff the sign-in); when they named none, the one where the site and their login live.');

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

// Agents open web pages only: an extension's own page runs with its powers, chrome:/devtools: pages are the browser's
// settings and tools, and app schemes (mailto:, slack:...) launch other apps. Parsed like the browser does (it drops
// tabs, newlines and leading control characters), so "fi\tle:" is file: too.
const isWebUrl = (parsed) => ['http:', 'https:', 'data:'].includes(parsed?.protocol) || (parsed?.protocol === 'about:' && parsed.pathname.toLowerCase() === 'blank');
export function refuseNonWeb(url) {
  if (!url) return url;
  const parsed = URL.parse(url);
  if (isWebUrl(parsed)) return url;
  if (parsed?.protocol === 'file:') {
    throw new Error(`${url.trim()} is a local file: local files can't be opened in the browser. Read the file from disk instead (it is on this Mac).`);
  }
  if (parsed?.protocol === 'view-source:') throw new Error(`${url.trim()}: view-source: pages can't be opened. Open the page itself instead.`);
  const instead = !parsed ? 'Pass a full address, e.g. https://example.com/ or http://localhost:3000/.'
    : parsed.protocol === 'javascript:' ? 'To run a script in a page, use evaluate.'
      : 'The browser\'s own pages, extensions and links that open other apps are the user\'s: tell them instead.';
  throw new Error(`${url.trim()} can't be opened: agents open web pages only (http:, https:, about:blank and data: URLs). ${instead}`);
}

// However a tab came to show a page that isn't a web page (history, a page's own history.back(), a link from one local
// file to another), FowlBrowser doesn't read or act in it: it may only be navigated away, released, kept or closed.
// Chrome's error page for a web address that didn't load (chrome-error:) and a site's own blob: pages are web pages too.
const localPage = (url) => (isLocalUrl(url) ? 'this tab shows a local file' : 'this tab shows a browser or extension page, not a web page') +
  ', which FowlBrowser doesn\'t read; navigate it to a web page or close it';
const isLocalPage = (url) => {
  const parsed = URL.parse(url);
  return !!parsed && !isWebUrl(parsed) && !['about:', 'chrome-error:'].includes(parsed.protocol) && !(parsed.protocol === 'blob:' && /^https?:/.test(parsed.origin));
};
function refuseLocalPage(tab) {
  if (isLocalPage(tab.page.url())) throw new Error(`Tab ${tab.id}: ${localPage(tab.page.url())}.`);
}

// Hidden files and folders (~/.ssh, ~/.aws, .env, ~/.config), ~/Library and system configuration are never uploaded,
// also not through a symlink: paths are resolved first (natively, so "~/library" is ~/Library too). iCloud Drive and the
// cloud drives (Dropbox, Google Drive, OneDrive) live in ~/Library too and stay allowed. A folder (a webkitdirectory
// input) is uploaded with everything in it, so all of that is checked too.
// The file is read by path later (after the page checks, the click and a chooser wait), so nothing on its way may be
// swappable by another account on this Mac: every folder from / down is the user's or root's, and one that others can
// write to (/tmp, /Users/Shared) only with the sticky bit and with what it holds on the way owned by the user or root.
// ids (optional Map): filled with each checked path's dev and ino, so dropFiles reads only that same file.
const MAX_FOLDER_ENTRIES = 10_000;
// Finder writes these into folders it shows: view settings, no content. A folder holding them uploads as before.
const FINDER_FILES = new Set(['.DS_Store', '.localized']);
const DATA_VOLUME = '/System/Volumes/Data/';
export function uploadPaths(paths, home = os.homedir(), ids = null) {
  // The Data volume's firmlinks name the same folders: /System/Volumes/Data/Users/me/Downloads is /Users/me/Downloads.
  const unalias = (real) => (real.startsWith(DATA_VOLUME) ? real.slice(DATA_VOLUME.length - 1) : real);
  const library = path.join(unalias(fs.realpathSync.native(home)), 'Library');
  const refusedDirs = [library, '/etc', '/private/etc', '/System', '/private/var/db', '/Library/Keychains', '/private/var/log'];
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
  const uid = process.getuid();
  const mine = (st) => st.uid === uid || st.uid === 0;
  // Could another account rename or replace `child` (its lstat) in a folder (its stat)?
  const exposed = (dirStat, childStat) => !mine(dirStat) || ((dirStat.mode & 0o022) !== 0 && (!(dirStat.mode & 0o1000) || !mine(childStat)));
  const refuseSwappable = (p, real, dir) => {
    throw new Error(`${p}${real === p ? '' : ` (${real})`} can't be uploaded: it sits in ${dir}, where another account on this Mac could swap it for a ` +
      'different file before it is read. If the user really wants it uploaded, ask them to copy it into ~/Downloads first.');
  };
  // Every folder on the way to a resolved path, from /.
  const checkWay = (p, real) => {
    let dir = path.parse(real).root;
    let dirStat = fs.statSync(dir);
    for (const part of real.split(path.sep).filter(Boolean)) {
      const child = path.join(dir, part);
      const childStat = fs.lstatSync(child);
      if (exposed(dirStat, childStat)) refuseSwappable(p, real, dir);
      [dir, dirStat] = [child, childStat];
    }
  };
  // A device (/dev/zero, /dev/stdin), pipe or socket never ends or blocks the read: the upload would hang or crash the session.
  const special = (stat) => !stat.isFile() && !stat.isDirectory();
  const refuseSpecial = (p, what) => {
    throw new Error(`${p} can't be uploaded: ${what} not a regular file or folder (a device, pipe or socket). Upload the user's files themselves.`);
  };
  // Everything in a folder, walked without following links blindly: a link is resolved and checked like a path given
  // itself, and a linked folder is walked too (once).
  const checkFolder = (p, folder) => {
    let count = 0;
    const seen = new Set([folder]);
    const walk = (dir, rel) => {
      const dirStat = fs.statSync(dir);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const shown = path.join(rel, entry.name);
        if (exposed(dirStat, dirStat.mode & 0o022 ? fs.lstatSync(full) : dirStat)) refuseSwappable(p, folder, dir);
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
          checkWay(p, real);
        }
        const stat = entry.isSymbolicLink() ? fs.statSync(real) : entry;
        if (special(stat)) refuseSpecial(p, `it holds ${shown}, which is`);
        if (stat.isDirectory() && !seen.has(real)) {
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
    checkWay(p, real);
    const stat = fs.statSync(real);
    if (special(stat)) refuseSpecial(p, 'it is');
    ids?.set(real, { dev: stat.dev, ino: stat.ino });
    if (stat.isDirectory()) checkFolder(p, real);
    return real;
  });
}

// The files a drop carries, at most DROP_MAX_BYTES in all. Each is read only if it is still the file uploadPaths checked
// (ids: its dev and ino): opened without following a link at its name, and without waiting on a pipe put in its place.
const DROP_MAX_BYTES = 40 * 1024 * 1024; // as base64 in one message to the browser, under the host's 64 MB a message
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
export function dropPayload(files, ids) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const opened = [];
  try {
    let total = 0;
    for (const file of files) {
      let fd;
      try { fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); } catch { fd = null; }
      if (fd !== null) opened.push(fd);
      const stat = fd === null ? null : fs.fstatSync(fd);
      const id = ids?.get(file);
      if (!stat?.isFile() || !id || stat.dev !== id.dev || stat.ino !== id.ino) {
        throw new Error(`${file} was not uploaded: it was replaced or changed into something else since it was checked. Call upload_files again.`);
      }
      if ((total += stat.size) > DROP_MAX_BYTES) throw new Error(`The files are over ${DROP_MAX_BYTES / 1024 / 1024} MB together, too big to drop on a page; use a file input or a file chooser instead.`);
    }
    return files.map((file, i) => ({ name: path.basename(file), type: TYPES[path.extname(file).toLowerCase()] ?? '',
      lastModified: Math.round(fs.fstatSync(opened[i]).mtimeMs), data: fs.readFileSync(opened[i]).toString('base64') }));
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
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
  // A count has no timeout of its own: on a page whose script is stuck it would hold the tab until the host's 120 s
  // limit, so each is bounded by the call's timeout.
  const timeout = args.timeout_ms ?? ACTION_TIMEOUT_MS;
  const count = (loc) => {
    let timer;
    return Promise.race([loc.count(), new Promise((resolve) => { timer = setTimeout(resolve, timeout, null); })]).finally(() => clearTimeout(timer));
  };
  for (const ref of refs) {
    const loc = locator(tab, ref);
    const deadline = Date.now() + STALE_REF_MS;
    for (let n; !(n = await count(loc));) {
      if (n === null) throw new Error(`The page did not answer within ${timeout / 1000} s (its script is busy or stuck), so nothing was done. Try again shortly, or reload it with navigate.`);
      if (Date.now() >= deadline) {
        throw new Error(`Ref ${cleanRef(ref)} is from an older snapshot: no element on the page has it now (the page changed). Call snapshot again and use its refs.`);
      }
      await sleep(100);
    }
  }
}

// The agent cursor (docs/cursor-spec.md), only in a tab the user can see: it travels to `where` (a point, or a function
// returning one) before the action, plays `cue` during it (painted before it starts; cueOnPress: from the action's
// mouse press on), and clicks when the action presses the mouse button (feedback: false when the action is no click),
// not once the action and a navigation it started are done; an action that presses none (a select) clicks at its end.
// Not shown: none of it runs.
async function pointed(tab, where, action, { feedback = true, shown, cue, cueOnPress = false, deadline = Date.now() + cursor.ARRIVAL_CAP_MS } = {}) {
  // One budget for the whole cursor path (visibility, target, travel): a slow answer means "not shown".
  shown ??= await cursor.isShown(tab);
  // A target found too late is still shown while the action runs (late: in record mode the point line says so).
  let actionDone;
  const acting = new Promise((resolve) => { actionDone = resolve; });
  let late = false;
  const target = shown ? await cursor.moveTo(tab, where, Math.max(0, deadline - Date.now()), { acting, onLate: () => { late = true; } }) : null;
  const seen = record.recording && shown ? await record.pointSeen(tab, target, () => cursor.state(tab)) : null;
  if (shown && cue && !cueOnPress) await cursor.painted(cursor.cue(tab, cue));
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
// A cue during the action is painted first (cursor.painted: CUE_WAIT_MS at most, the visibility answer included;
// not when the tab wasn't shown when last asked); the cue calls keep their order.
// follow: the cursor also shows clicks the action makes from a script (evaluate); in record mode the action waits
// (up to FOLLOW_CAP_MS) until the overlay listens, so none is missed.
const FOLLOW_CAP_MS = 300;
async function cued(tab, kind, action, { after = false, follow = false } = {}) {
  const shown = cursor.isShown(tab);
  if (!after) {
    const cueing = shown.then((yes) => yes && cursor.cue(tab, kind));
    // A tab that wasn't shown when last asked starts at once (its cue still shows if it is now).
    const painting = cursor.wasShown(tab) === false ? null : cursor.painted(cueing);
    const following = follow && shown.then((yes) => yes && cursor.follow(tab, true));
    await Promise.all([painting, following && record.recording && Promise.race([following, sleep(FOLLOW_CAP_MS)])]);
  }
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
function refPoint(tab, ref, timeout = ACTION_TIMEOUT_MS) {
  return async () => {
    if (isShadowRef(ref)) return shadowRefCenter(tab, ref);
    const loc = locator(tab, ref);
    // Main-frame refs: one round trip in the page. An iframe's box needs Playwright's frame offsets.
    // It waits as long as the action may: a page whose thread stalls past the cursor's budget (a busy Mac) holds the
    // action up too, and its answer then lands the cursor on the target while the action runs (cursor moveTo), so
    // the click is shown there instead of where the last action was.
    if (!/^f\d/.test(cleanRef(ref))) return loc.evaluate(REF_POINT_FN, Date.now() + timeout, { timeout });
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
// A page with CSS smooth scrolling only starts moving then, and the box read next is the old one: an element still out
// of the window goes there at once, centred as that scroll would leave it. until: a page that stalled past the
// action's timeout runs this late; then it scrolls nothing (the action failed, and later ones may have scrolled).
export const REF_POINT_FN = (el, until) => {
  if (until && Date.now() > until) return null;
  el.scrollIntoViewIfNeeded?.();
  let r = el.getBoundingClientRect();
  if ((r.width || r.height) && (r.top < 0 || r.left < 0 || r.bottom > globalThis.innerHeight || r.right > globalThis.innerWidth)) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  return r.width || r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height } : null;
};

// Controls whose click (or opening key) brings up the browser's or the Mac's own UI instead of acting in the page: the
// colour window (it floats over every app, with an eyedropper that takes over the mouse), a dropdown's menu, the
// system file chooser, and links that start another app (mailto:, tel:, zoommtg: ...). They pop up on the user's
// screen and hold the page until someone dismisses them, so agents never open them; the error says what to use
// instead. Runs in the page on an element, or on a point {x, y} (the element there, inside open shadow roots). A
// label stands for its control, as a click on it does. Null for anything else.
export const NATIVE_UI_FN = (target) => {
  let el = target;
  if (!target) { // the focused element, inside open shadow roots
    el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  } else if (!(target instanceof Node)) {
    el = document.elementFromPoint(target.x, target.y);
    for (let inner = el?.shadowRoot?.elementFromPoint(target.x, target.y); inner && inner !== el; inner = el.shadowRoot?.elementFromPoint(target.x, target.y)) el = inner;
  }
  if (!(el instanceof Element)) return null;
  // An iframe (a payment form, an embedded editor): the server looks inside it, at the point moved into its content box
  // (and scaled, for one drawn smaller or bigger with a CSS transform).
  if (target === null || !(target instanceof Node)) {
    if (/^(iframe|frame)$/.test(el.localName)) {
      const r = el.getBoundingClientRect();
      const sx = el.offsetWidth ? r.width / el.offsetWidth : 1;
      const sy = el.offsetHeight ? r.height / el.offsetHeight : 1;
      return { kind: 'frame', x: r.left + el.clientLeft * sx, y: r.top + el.clientTop * sy, sx, sy };
    }
  }
  // A ref's element that only wraps such a control (a button-like card around a colour input or a mail link): the click
  // lands at its centre, so the control there counts.
  if (target instanceof Node) {
    const r = el.getBoundingClientRect();
    const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
    const inner = [...el.querySelectorAll('input, select, a[href], area[href], a[*|href]')].slice(0, 50).find((c) => {
      const b = c.getBoundingClientRect();
      return b.width && b.height && b.left <= cx && cx <= b.right && b.top <= cy && cy <= b.bottom;
    });
    if (inner) el = inner;
  }
  const link = el.closest('a[href], area[href], a[*|href]');
  // An SVG link's href is an SVGAnimatedString.
  const href = link && URL.parse(typeof link.href === 'string' ? link.href : link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '', document.baseURI)?.href;
  const protocol = href && URL.parse(href)?.protocol;
  if (protocol && !['http:', 'https:', 'javascript:', 'blob:', 'data:', 'about:'].includes(protocol)) return { kind: 'app', href: href.slice(0, 200) };
  // A web link goes on to what is inside it: a colour input or dropdown in a link card still opens its own UI.
  const label = el.closest('label');
  const control = label && !el.closest('button, input, select, textarea') ? label.control : el;
  if (!control) return null;
  // A disabled one too: the click waits for it to be enabled (a form that enables it a moment later), then opens it.
  if (control instanceof HTMLInputElement && control.type === 'color') return { kind: 'color', value: control.value };
  if (control instanceof HTMLInputElement && control.type === 'file') return { kind: 'file' };
  if (control instanceof HTMLSelectElement && !control.multiple && control.size <= 1) {
    const options = [...control.options].map((o) => o.label);
    return { kind: 'select', options: options.slice(0, 12), more: Math.max(0, options.length - 12) };
  }
  return null;
};

// Keys that open each kind's own UI when it has focus (on a Mac the arrows open a dropdown's menu).
const OPENING_KEYS = { select: ['Space', ' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'], color: ['Space', ' ', 'Enter'], file: ['Space', ' ', 'Enter'], app: ['Enter'] };

// `what` names the element ("Ref e5", "The element at 120,340"); by how it is opened ("A click", "Pressing Space").
export function nativeUIError(found, what, by = 'A click') {
  const text = {
    color: `${what} is a colour picker (now ${found.value}). ${by} opens the browser's colour window over the user's screen, with an eyedropper ` +
      'that takes over their mouse, so FowlBrowser doesn\'t open it. Set the colour with type (text "#rrggbb") or fill_form instead.',
    select: `${what} is a dropdown (<select>). ${by} opens its menu on the user's screen, so FowlBrowser doesn't open it. Choose with ` +
      `select_option or fill_form instead (options: ${found.options?.join(', ')}${found.more ? `, and ${found.more} more` : ''}).`,
    file: `${what} is a file input. ${by} opens the Mac's file chooser on the user's screen, so FowlBrowser doesn't open it. Upload with ` +
      'upload_files instead (its ref and absolute paths on this Mac).',
    app: `${what} is a link to another app (${found.href}). Following it would open that app on the user's Mac, so FowlBrowser doesn't. ` +
      'Tell the user what it is for, or look for a web version (an https link).',
  }[found.kind];
  return new Error(text);
}

// The element at a point, or the focused one, inside open shadow roots (the iframe NATIVE_UI_FN found there).
const ELEMENT_AT_FN = (at) => {
  let el = at ? document.elementFromPoint(at.x, at.y) : document.activeElement;
  for (let inner = at ? el?.shadowRoot?.elementFromPoint(at.x, at.y) : el?.shadowRoot?.activeElement; inner && inner !== el;
    inner = at ? el.shadowRoot?.elementFromPoint(at.x, at.y) : el.shadowRoot?.activeElement) el = inner;
  return el;
};

// Refuses the action when the element (a ref's locator), the point or the focused element holds such a control. A
// point or focus in an iframe is followed into it (up to 3 levels, cross-site ones too). A failed check, or one with no
// answer within the action's timeout, lets the action go ahead: it is a guard, never a reason for an action to fail on
// its own. Not sooner: a page whose thread stalls for a while (a busy Mac) holds the action up just as long, and the
// action would then open the control.
// key: a key press (its last part, "Space" of "Shift+Space"), refused only if it opens that kind; by default a click.
// shadowRef: an s ref's control (in a closed shadow root, which the page's own focus and point lookups can't see into).
async function nativeUIFound(tab, { loc, point, shadowRef }, timeout) {
  if (loc) return loc.evaluate(NATIVE_UI_FN, null, { timeout });
  if (shadowRef) return callOnShadowRef(tab, shadowRef, `function () { return (${NATIVE_UI_FN})(this); }`);
  let frame = tab.page.mainFrame();
  for (let depth = 0; depth < 4; depth++) {
    const found = await frame.evaluate(NATIVE_UI_FN, point ?? null);
    if (found?.kind !== 'frame') return found;
    const handle = await frame.evaluateHandle(ELEMENT_AT_FN, point ?? null);
    const child = await handle.asElement()?.contentFrame().catch(() => null);
    handle.dispose().catch(() => {});
    if (!child) return null;
    frame = child;
    if (point) point = { x: (point.x - found.x) / (found.sx || 1), y: (point.y - found.y) / (found.sy || 1) };
  }
  return null;
}
async function refuseNativeUI(tab, { loc, point, shadowRef, what, by, key, timeout = ACTION_TIMEOUT_MS }) {
  if (key && !Object.values(OPENING_KEYS).some((keys) => keys.includes(key))) return;
  const found = await within(Promise.resolve().then(() => nativeUIFound(tab, { loc, point, shadowRef }, timeout)), timeout, null);
  if (OPENING_KEYS[found?.kind] && (!key || OPENING_KEYS[found.kind].includes(key))) throw nativeUIError(found, what, by);
}

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

// Single-page apps fire their load event before they render (an empty <div id="root">): a page whose body still holds
// next to no text gets up to CONTENT_MS for its content, until it has text and its DOM has not changed for 300 ms.
// A page with content goes on at once. Runs in the page; resolves with the ms it waited.
const CONTENT_MS = 3000;
const CONTENT_FN = ({ maxMs, quietMs }) => new Promise((resolve) => {
  const text = () => (document.body?.innerText ?? '').trim().length;
  if (text() >= 50) return resolve(0);
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  const check = () => {
    const now = performance.now();
    if ((text() >= 50 && now - last >= quietMs) || now - start >= maxMs) {
      observer.disconnect();
      resolve(Math.round(now - start));
    } else setTimeout(check, 50);
  };
  setTimeout(check, 50);
});
const contentReady = async (tab) => (isLocalPage(tab.page.url()) ? 0 : within(tab.page.evaluate(CONTENT_FN, { maxMs: CONTENT_MS, quietMs: 300 }), CONTENT_MS + 500, 0));

// Settled: loaded, then no request that renders the page in flight (the tab's own count, browsers.mjs inflight) and no
// DOM change (nodes or text) for QUIET_MS, at most `timeout`. { settled, ms, pending: [urls] }.
const QUIET_MS = 500;
const DOM_QUIET_FN = ({ quietMs, maxMs }) => new Promise((resolve) => {
  const start = performance.now();
  let last = start;
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(document, { subtree: true, childList: true, characterData: true });
  const check = () => {
    const now = performance.now();
    if (now - last >= quietMs || now - start >= maxMs) {
      observer.disconnect();
      resolve(now - last >= quietMs);
    } else setTimeout(check, 50);
  };
  setTimeout(check, 50);
});
async function pageSettled(tab, timeout) {
  const started = Date.now();
  const end = started + timeout;
  await loaded(tab.page, timeout);
  const quietNetwork = () => !tab.inflight.size && Date.now() - tab.requestAt >= QUIET_MS;
  while (Date.now() < end) {
    if (!quietNetwork()) { await sleep(100); continue; }
    // Bounded here too: a page whose script holds its main thread never runs the function's own timer.
    const left = Math.max(0, end - Date.now());
    const quiet = await within(tab.page.evaluate(DOM_QUIET_FN, { quietMs: QUIET_MS, maxMs: left }), left + 200, false);
    if (quiet && quietNetwork()) return { settled: true, ms: Date.now() - started, pending: [] };
  }
  return { settled: false, ms: Date.now() - started, pending: [...tab.inflight].map((r) => r.url()) };
}

async function header(tab) {
  if (isLocalPage(tab.page.url())) return `Browser: ${tab.browser.name} · Tab: ${tab.id} · ${tab.page.url()}`;
  return `Browser: ${tab.browser.name} · Tab: ${tab.id} · ${(await tab.currentTitle()) || '(no title)'} · ${tab.page.url()}`;
}

const cap = (body, note) => capText(body, MAX_CHARS, note);
const CUT_NOTE = 'To read them, call snapshot with ref=<eN> of a section, or with a larger max_chars';

// A password input's value never reaches the agent: not in a snapshot, find, the changes after an action, nor the tab's
// baseline they come from (the browser autofills saved passwords, and the page can read them after any click). A text
// field line (textbox, searchbox...) with a ref is checked through Playwright (all at once). Every other line showing a
// value or text is compared, as Playwright writes it (shownValue), with the password inputs' values, read once from every
// frame: a field Playwright gives no ref (no pointer events, no box), or a password input with another role (role="button").
// When that read fails (a frame didn't answer), every line with a ref is looked up through Playwright instead, and one
// without a ref that shows a value on its element's own line is masked. A text field, or a line with a ref, that can't
// be checked is masked too. mainPrefixes: see locator().
const IS_PASSWORD_FN = (el) => el.localName === 'input' && el.type === 'password';
const PASSWORD_VALUES_FN = () => {
  const values = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.localName === 'input' && el.type === 'password' && el.value) values.push(el.value);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return values;
};
async function maskPasswords(tab, yaml, mainPrefixes) {
  const fields = textFields(yaml);
  if (!fields.length) return yaml;
  // Null when a frame didn't answer.
  const passwords = (async () => {
    const lists = await Promise.all(tab.page.frames().map((frame) => within(frame.evaluate(PASSWORD_VALUES_FN), STALE_REF_MS, null)));
    return lists.includes(null) ? null : new Set(lists.flat().map(shownValue));
  })().catch(() => null);
  const secret = await Promise.all(fields.map(async ({ ref, field, own, value }) => {
    if (!ref || !field) {
      const known = await passwords;
      if (known) return known.has(yamlValue(value));
      // The scan failed: a ref'd line of any role is looked up as text fields are; a value on its element's own line
      // (an input's, whatever its role) is masked; page text (`- text:` lines) stays.
      if (!ref) return field || own;
    }
    const prefix = /^f\d+/.exec(ref)?.[0];
    const loc = prefix && mainPrefixes.has(prefix) ? tab.page.locator(`:root >> aria-ref=${ref}`) : tab.page.getByRef(ref);
    return loc.evaluate(IS_PASSWORD_FN, null, { timeout: STALE_REF_MS });
  }).map((check) => check.catch(() => true)));
  return maskFields(yaml, fields.filter((_, i) => secret[i]));
}

// Every snapshot an agent receives fits in maxChars. Each whole-page snapshot becomes the tab's baseline (the full
// text: the agent was told how to read a cut part) for `changes`: after an action on the same document and URL,
// only what changed since then is returned, unless that is not much shorter than the page.
// find: only the lines containing it, with their context (findInSnapshot); the whole page is still read and kept as
// the tab's baseline, so its refs and later changes-only results work as after any snapshot.
async function snapshotText(tab, { ref, changes = false, maxChars = SNAPSHOT_MAX_CHARS, find } = {}) {
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
    if (isLocalPage(url)) return `Snapshot unavailable: ${localPage(url)}.`;
    const target = ref ? locator(tab, ref) : tab.page;
    yaml = await target.ariaSnapshot({ mode: 'ai', timeout: ACTION_TIMEOUT_MS });
    // Before anything keeps or shows it, and while Playwright's ref table is this snapshot's.
    yaml = await maskPasswords(tab, yaml, ref ? tab.refs?.mainPrefixes ?? new Set() : new Set(mainFramePrefixes(yaml)));
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
  if (find) {
    const { text: found, matches } = findInSnapshot(yaml + shadow, find);
    if (!matches) return `${title.slice(0, -1)}: no line contains "${find}". Call snapshot without find to see the whole page.`;
    return `${title.slice(0, -1)}, only the ${matches} line${matches === 1 ? '' : 's'} with "${find}" and what they sit in:\n\`\`\`yaml\n` +
      `${capText(found, room, 'To read them, call snapshot with a narrower find, or ref=<eN> of a section')}\n\`\`\``;
  }
  // The closed-shadow part (s refs) stays when the page part is cut, unless it is large itself.
  const section = shadow && `\n${capText(shadow.slice(1), Math.floor(room / 3), 'To see them all, call snapshot with a larger max_chars')}`;
  const body = capText(yaml, room - section.length, CUT_NOTE) + section;
  return `${title}\n\`\`\`yaml\n${body}\n\`\`\``;
}

// Readable text of the ref, else of the page's <main> or <article>, else of the body, else of the root element (an SVG or
// XML file has no body) (snapshot mode "text"). early: the document has not reached its <body> yet.
const PAGE_TEXT_FN = (el) => {
  const root = el ?? document.querySelector('main, [role=main]') ?? document.querySelector('article') ?? document.body ?? document.documentElement;
  const early = !el && !document.body && document.readyState === 'loading';
  if (!root) return { name: 'html', text: '', early };
  const name = root.tagName.toLowerCase() + (root.id ? `#${root.id}` : '') + (root.getAttribute('role') === 'main' && root.tagName !== 'MAIN' ? '[role=main]' : '');
  return { name, text: root.innerText ?? root.textContent ?? '', early };
};

// The links of the ref, else of the page's <main> or <article>, else of the body (snapshot mode "links"): text and URL,
// each URL once (its first text), in page order; in-page anchors ("#top", and "#": a control a script handles) and
// javascript: links left out.
const PAGE_LINKS_FN = (el) => {
  const root = el ?? document.querySelector('main, [role=main]') ?? document.querySelector('article') ?? document.body ?? document.documentElement;
  const name = root.tagName.toLowerCase() + (root.id ? `#${root.id}` : '');
  const seen = new Set();
  const links = [];
  for (const a of root.querySelectorAll('a[href], area[href]')) {
    const url = URL.parse(a.href);
    if (!url || url.protocol === 'javascript:' || (url.href.includes('#') && url.href.split('#')[0] === location.href.split('#')[0])) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const label = (a.innerText || a.getAttribute('aria-label') || a.title || a.querySelector('img')?.alt || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    links.push(`- ${label || '(no text)'} → ${url.href}`);
  }
  return { name, links };
};

async function pageLinks(tab, { ref, maxChars = SNAPSHOT_MAX_CHARS } = {}) {
  if (tab.dialog) return 'Links unavailable while a dialog is open. Resolve it with the dialog tool.';
  refuseLocalPage(tab);
  const { name, links } = ref ? await locator(tab, ref).evaluate(PAGE_LINKS_FN, null, { timeout: ACTION_TIMEOUT_MS }) : await tab.page.evaluate(PAGE_LINKS_FN, null);
  refuseLocalPage(tab);
  return `Links of ${ref ? `${ref} (<${name}>)` : `<${name}>`} (${links.length}; text → URL, no refs; to click one, call snapshot for refs or navigate to its URL):\n` +
    capText(links.join('\n') || '(no links)', maxChars - 200, 'To read them, call snapshot with mode "links" and ref=<eN> of a section, or with a larger max_chars');
}

// Is this iframe one the page's text takes in: inside the element PAGE_TEXT_FN reads, with a box worth reading (not a
// tracker or a hidden helper)? Runs in the page, on the iframe element.
const READ_FRAME_FN = (el) => {
  const root = document.querySelector('main, [role=main]') ?? document.querySelector('article') ?? document.body;
  const r = el.getBoundingClientRect();
  return !!root?.contains(el) && r.width >= 50 && r.height >= 50 && getComputedStyle(el).visibility !== 'hidden';
};

// The text of the page's iframes that PAGE_TEXT_FN's element holds, each as a section to follow the page's own:
// innerText leaves iframes out, and a sign-in form often lives in one. At most MAX_FRAME_TEXTS; one that doesn't answer
// within FRAME_TEXT_MS (another site's frame busy in its own process) is left out.
const MAX_FRAME_TEXTS = 5;
const FRAME_TEXT_MS = 2000;
async function framesText(tab) {
  const read = async (frame) => {
    const owner = await frame.frameElement().catch(() => null);
    try {
      if (!owner || !(await owner.evaluate(READ_FRAME_FN).catch(() => false))) return null;
      const lines = collapseText((await within(frame.evaluate(PAGE_TEXT_FN, null), FRAME_TEXT_MS, null))?.text ?? '');
      return lines && `[iframe: ${URL.parse(frame.url())?.host || frame.url()}]\n${lines}`;
    } finally {
      owner?.dispose().catch(() => {});
    }
  };
  return (await Promise.all(tab.page.mainFrame().childFrames().map(read))).filter(Boolean).slice(0, MAX_FRAME_TEXTS);
}

async function pageText(tab, { ref, maxChars = SNAPSHOT_MAX_CHARS } = {}) {
  if (tab.dialog) return 'Text unavailable while a dialog is open. Resolve it with the dialog tool.';
  refuseLocalPage(tab);
  const read = () => (ref ? locator(tab, ref).evaluate(PAGE_TEXT_FN, null, { timeout: ACTION_TIMEOUT_MS }) : tab.page.evaluate(PAGE_TEXT_FN, null));
  let { name, text: raw, early } = await read();
  // A document that has only just started (a challenge page that reloads itself) is read once its body is parsed.
  if (early) {
    await tab.page.waitForLoadState('domcontentloaded', { timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    ({ name, text: raw } = await read());
  }
  const frames = ref ? [] : await framesText(tab); // the whole page's text takes in its iframes'
  refuseLocalPage(tab); // it went there while the text was read
  const body = [collapseText(raw), ...frames].filter(Boolean).join('\n') || '(no text)';
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

// screenshot: a viewport picture follows the text (the screenshot arg of actions), taken once the snapshot is read.
// afterAction: the action is done, so a snapshot that can't be read now (a page busy for longer than the read's timeout)
// is said in the result instead of failing it as if the action had not happened (the agent would do it again). A page
// that closed its own tab still fails it, for withTab to say so.
async function report(tab, { lines = [], newTabs = [], snapshot = true, ref, changes, maxChars, screenshot = false, frames, afterAction = false, find } = {}) {
  // The title and the snapshot are read together.
  const [head, snap] = await Promise.all([header(tab), snapshot && snapshotText(tab, { ref, changes, maxChars, find }).catch((error) => {
    if (!afterAction || tab.page.isClosed()) throw error;
    return `Snapshot unavailable after the action (${cleanError(error)}): the action itself was done. Call snapshot to see the page before acting again.`;
  })]);
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
  const images = [];
  if (frames?.length) {
    refuseLocalPage(tab); // it went there while they were taken
    out.push(`${frames.length} frames from the action's first input to the page, at ${frames.map((f) => `+${f.at}`).join(', ')} ms (in that order${screenshot ? ', then the screenshot once it settled' : ''}).`);
    images.push(...frames.map((f) => f.image));
  }
  if (screenshot && !tab.dialog && !isLocalPage(tab.page.url())) {
    const image = await cursor.hideForCapture(tab, () => tab.page.screenshot({ type: 'jpeg', quality: 80, scale: 'css', timeout: ACTION_TIMEOUT_MS }))
      .catch((error) => { out.push(`(The screenshot failed: ${cleanError(error)})`); return null; });
    refuseLocalPage(tab); // it went there while the screenshot was taken
    if (image) images.push(image);
  }
  const result = text(out.join('\n'));
  for (const image of images) result.content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' });
  return result;
}

// Screenshots taken while something plays out (an action's animation or transition, a running animation): `count` of
// them, `every` ms apart from now (or as fast as the browser captures), the cursor hidden throughout. A dialog (it
// holds captures; none are taken after it, even once it is answered) or a local page ends them early.
const FRAME_MS = 100;
async function filmstrip(tab, count, every = FRAME_MS, shoot = () => tab.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', timeout: ACTION_TIMEOUT_MS })) {
  const frames = [];
  const started = Date.now();
  let dialog = !!tab.dialog;
  const onDialog = () => { dialog = true; };
  tab.on('dialog', onDialog);
  try {
    await cursor.hideForCapture(tab, async () => {
      for (let i = 0; i < count; i++) {
        const wait = started + i * every - Date.now();
        if (wait > 0) await sleep(wait);
        if (dialog || tab.page.isClosed() || isLocalPage(tab.page.url())) break;
        const at = Date.now() - started;
        frames.push({ at, image: await shoot() });
      }
    });
  } finally {
    tab.off('dialog', onDialog);
  }
  return frames;
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
  // A new page that a snapshot will show (trailing) also gets its content (contentReady).
  const load = async () => {
    await loaded(tab.page, ACTION_TIMEOUT_MS);
    if (trailing) await contentReady(tab);
  };
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
// File choosers the page opens while an agent action runs, or up to CHOOSER_HOLD_MS after it (a button that clicks a
// hidden file input a moment later still has the user activation the agent's click gave it), are held by FowlBrowser
// instead of showing the Mac's file panel on the user's screen (Playwright intercepts choosers while it has a
// listener); upload_files without ref fills the held one. Later ones are the user's own. Returns the release.
const CHOOSER_HOLD_MS = 5000;
function holdChoosers(tab) {
  const hold = tab.chooserHold ??= { listener: (chooser) => { tab.fileChooser = chooser; }, on: false, timer: null };
  clearTimeout(hold.timer);
  if (!hold.on) {
    tab.page.on('filechooser', hold.listener);
    hold.on = true;
  }
  return () => {
    hold.timer = setTimeout(() => { tab.page.off('filechooser', hold.listener); hold.on = false; }, CHOOSER_HOLD_MS);
    hold.timer.unref?.();
  };
}

// Runs fn with its page evaluations acting for the user, as a click would (the relay strips that from all others,
// browserModel.mjs): only media playback (the autoplay policy wants a user gesture for sound). The agent's own evaluate
// code gets none, so nothing it runs opens a picker, a file panel, a popup or full screen.
async function withGesture(tab, fn) {
  const gestures = tab.browser.relay.model.gestures;
  if (!gestures) return fn();
  gestures.set(tab.tabId, (gestures.get(tab.tabId) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    if (gestures.get(tab.tabId) > 1) gestures.set(tab.tabId, gestures.get(tab.tabId) - 1);
    else gestures.delete(tab.tabId);
  }
}

// input: false for a wait, which sends the page no input: a chooser during it comes from the user's own click (in a
// claimed tab), and opens for them as usual. Reads hold choosers too: an evaluate right after an action still has its
// user activation (a script click on a file input opens a chooser then), and media may click the player.
async function act(tab, args, fn, { snapshot = args.snapshot !== false, mayOpenTabs = false, read = false, waited = false, input = true } = {}) {
  if (tab.dialog) throw new Error(dialogLine(tab) ?? `A dialog is open, and ${localPage(tab.page.url())}.`);
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
  const releaseChoosers = input ? holdChoosers(tab) : null;
  const blocked = new Set(); // the browser's or the Mac's own UI the page asked for and was refused (popups.mjs)
  const onBlocked = (what) => blocked.add(what);
  tab.on('blocked', onBlocked);
  // frames: from the action's first input to the page (the mouse, a key, a wheel), or from its end if it sends none,
  // while it and the page settle. Part of the action's work, so a dialog returns the call at once and holds the tab
  // until they are done.
  let lines, newTabs, frames, startFilm;
  const filmStarts = args.frames ? new Promise((resolve) => { startFilm = resolve; }) : null;
  const onFirstInput = () => startFilm();
  if (filmStarts) tab.once('input', onFirstInput);
  try {
    const work = (async () => {
      const film = filmStarts?.then(() => filmstrip(tab, args.frames, args.frame_ms));
      film?.catch(() => {});
      lines = [].concat((await fn()) ?? []);
      startFilm?.();
      await settle(tab, watch, { watchMs: snapshot ? WATCH_MS.snapshot : read ? WATCH_MS.read : WATCH_MS.action, generation, waited, trailing: snapshot,
        timeout: Math.max(args.timeout_ms ?? 0, NAVIGATION_TIMEOUT_MS) });
      if (film) frames = await film.catch((error) => { lines.push(`(The frames failed: ${cleanError(error)})`); return null; });
    })();
    work.catch(() => {}); // a dialog may win the race; the action then finishes or fails on its own
    await Promise.race([work, dialogOpened]);
    // Returning early for a dialog: the action goes on once it is resolved, so later calls on this tab
    // wait for it (the dialog tool itself skips the queue).
    if (tab.dialog) tab.keepBusy(work.catch(() => {}));
    // A tab the user's own click opened meanwhile is theirs, not one of this action's.
    const { failed, pending, users } = await openingLines(openings, POPUP_WAIT_MS);
    lines = [...(lines ?? []), ...failed, ...pending];
    for (const what of blocked) {
      lines.push(`The page tried to open ${what}, which would show on the user's screen; FowlBrowser refused it (the page sees a cancel). ` +
        'If the task needs it, hand the tab to the user with tab_handoff.');
    }
    // Told once: one this action opened, or one the page opened a moment after the last action.
    if (tab.fileChooser && tab.fileChooserTold !== tab.fileChooser) {
      tab.fileChooserTold = tab.fileChooser;
      lines.push(`The page opened a file chooser${tab.fileChooser.isMultiple() ? ' (several files allowed)' : ''}; FowlBrowser kept it off the user's screen. ` +
        'To choose files for it, call upload_files with paths and no ref.');
    }
    newTabs = await openedTabs(tab, popupIds, mapping, knownBefore, opens.length - failed.length - users, urls);
    // kept: the extension hands it back at session end, never closes it (a child of a claimed, kept or for_user tab:
    // it may be the user's own Cmd-click).
    for (const t of record.recording ? newTabs : []) {
      const info = await tabInfo(tab.browser, Number(t.id.split(':')[1])).catch(() => null);
      record.tabEvent('adopt', t.id, t.url, { kept: info?.owner === 'you' && info.kept });
    }
  } finally {
    if (filmStarts) tab.off('input', onFirstInput);
    tab.off('dialog', onDialog);
    tab.off('windowopen', onOpen);
    watch.stop();
    tab.page.off('popup', onPopup);
    releaseChoosers?.();
    tab.off('blocked', onBlocked);
  }
  return report(tab, { lines, newTabs, snapshot: snapshot && !tab.dialog, changes: true, screenshot: args.screenshot === true,
    frames: tab.dialog ? null : frames, afterAction: true });
}

// onLocalPage: the call may run on a tab showing a local file (navigate with a url, which takes it away).
// escape: it also runs on a page found stuck in a script (navigate: how the agent gets out, Tab.run).
function withTab(manager, handler, { onLocalPage = () => false, escape = false } = {}) {
  return async (args) => {
    const tab = await resolveTab(manager, args.tab);
    const started = Date.now();
    return tab.run(async () => {
      if (!onLocalPage(args)) refuseLocalPage(tab);
      await checkRefs(tab, args);
      return handler(tab, args);
    }, { escape }).catch((error) => {
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
    // A page that doesn't answer the count (stuck) goes on to the attempt, which has a timeout of its own.
    if (loc.count && !(await within(loc.count(), QUICK_MS, 1))) throw staleRef(ref);
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
      if (!(await within(loc.count(), QUICK_MS, 1))) throw staleRef(ref);
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

// The box a mouse wheel at the viewport centre moves: the innermost box under it (crossing open shadow roots) that
// scrolls that way and is not at its end there, as Chromium hands a wheel on from a box at its end to the one around
// it; an iframe there (its page gets the wheel first, the window after); null when only the page can move (runs in the page).
export const WHEEL_TARGET_FN = ({ vertical, sign }) => {
  let n = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (n?.shadowRoot) {
    const inner = n.shadowRoot.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!inner || inner === n) break;
    n = inner;
  }
  if (n?.localName === 'iframe') return n;
  for (; n && n !== document.body && n !== document.documentElement; n = n.parentElement ?? n.getRootNode().host) {
    const style = getComputedStyle(n);
    const at = vertical ? n.scrollTop : n.scrollLeft;
    const max = vertical ? n.scrollHeight - n.clientHeight : n.scrollWidth - n.clientWidth;
    if (/auto|scroll|overlay/.test(vertical ? style.overflowY : style.overflowX) && (sign > 0 ? at < max - 1 : at > 0)) return n;
  }
  return null;
};

// Where a box (null: the window) is scrolled along the axis (at, of max), the size of one of its pages, and its tag.
// For an iframe the window is read: the iframe's own page may be another site's, and a wheel it can't use (its page
// fits, or is at its end) moves the page around it (runs in the page).
const SCROLLED_FN = (el, vertical) => {
  const tag = el && `<${el.localName}${el.id ? `#${el.id}` : ''}>`;
  if (!el || el.localName === 'iframe') {
    const root = document.documentElement;
    return { tag, frame: !!el, x: Math.round(scrollX), y: Math.round(scrollY), at: Math.round(vertical ? scrollY : scrollX),
      max: vertical ? root.scrollHeight - innerHeight : root.scrollWidth - innerWidth, page: vertical ? innerHeight : innerWidth };
  }
  return { tag, at: Math.round(vertical ? el.scrollTop : el.scrollLeft), max: vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth,
    page: vertical ? el.clientHeight : el.clientWidth };
};

// Chromium applies a wheel turn after Input.dispatchMouseEvent has returned (and may animate it), so the position read
// at once is often the one from before. A box that can move that way is read until it has moved and holds still, at
// most WHEEL_LAND_MS; one at its end that way is taken as it is. waited: it could move but did not.
const WHEEL_LAND_MS = 1000;
async function wheelLanded(read, before, sign) {
  if (sign > 0 ? before.at >= before.max - 1 : before.at <= 0) return { ...before, moved: false, waited: false };
  const deadline = Date.now() + WHEEL_LAND_MS;
  for (let last = before; ;) {
    await sleep(30);
    const now = await read().catch(() => last);
    if ((now.at !== before.at && now.at === last.at) || Date.now() >= deadline) return { ...now, moved: now.at !== before.at, waited: true };
    last = now;
  }
}

// scroll without ref: turns the mouse wheel at the viewport centre by pages (80% of what it moves, so no row is
// skipped) and says what moved: the window, or the box or iframe under the centre that took the wheel (app shells
// and phone mock-ups scroll in a box while the window stays put).
async function scrollPage(tab, { direction = 'down', pages = 1 }) {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;
  const plural = `${pages} page${pages === 1 ? '' : 's'}`;
  const { w, h } = await tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const target = await tab.page.evaluateHandle(WHEEL_TARGET_FN, { vertical, sign });
  try {
    const read = () => target.evaluate(SCROLLED_FN, vertical);
    const before = await read();
    const step = sign * (before.page ?? (vertical ? h : w)) * 0.8 * pages;
    await pointed(tab, { x: w / 2, y: h / 2 }, async () => {
      await tab.page.mouse.move(w / 2, h / 2);
      await tab.page.mouse.wheel(vertical ? 0 : step, vertical ? step : 0);
    }, { feedback: false, cue: 'scroll' });
    const after = await wheelLanded(read, before, sign);
    const box = before.tag && !before.frame && `the box under the viewport centre (${before.tag})`;
    const position = box
      ? `${vertical ? 'scrollTop' : 'scrollLeft'} ${after.at} of ${after.max}${after.at <= 0 ? ' (at the start)' : after.at >= after.max - 1 ? ' (at the end)' : ''}`
      : `Window scroll position: x=${after.x} y=${after.y} (max ${vertical ? 'y' : 'x'} ${after.max})`;
    if (after.moved) return box ? `Scrolled ${box} ${direction} ${plural}: ${position}.` : `Scrolled ${direction} ${plural}. ${position}.`;
    if (before.frame) {
      return `Turned the mouse wheel ${direction} ${plural} at the viewport centre, over an iframe (${before.tag}): the window did not move, so the page in the ` +
        `iframe may have scrolled (it can't be read from here; take a screenshot to see). ${position}.`;
    }
    if (after.waited) {
      return `Turned the mouse wheel ${direction} ${plural} at the viewport centre, but ${box || 'the page'} did not move within ${WHEEL_LAND_MS / 1000} s ` +
        `(the page may use the wheel itself, as maps and slideshows do)${box ? ': ' : '. '}${position}.`;
    }
    return `Turned the mouse wheel ${direction} ${plural} at the viewport centre, but nothing moved: ` +
      `${after.max <= 0 ? 'the window does not scroll (its content fits)' : `the window is at its ${sign > 0 ? 'end' : 'start'}`} and no box under the viewport ` +
      `centre scrolls ${direction}. To scroll a box elsewhere, call scroll with its ref and direction. ${position}.`;
  } finally {
    target.dispose().catch(() => {});
  }
}

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
      const read = () => handle.evaluate(SCROLLED_FN, vertical); // the window's
      const before = await read();
      await pointed(tab, refPoint(tab, ref), async () => {
        const { x, y, width, height } = await loc.boundingBox();
        const step = sign * (vertical ? height : width) * 0.8 * pages;
        await tab.page.mouse.move(x + width / 2, y + height / 2);
        await tab.page.mouse.wheel(vertical ? 0 : step, vertical ? step : 0);
      }, { feedback: false, cue: 'scroll' });
      const pos = await wheelLanded(read, before, sign);
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

// An element's box in document CSS px (runs in the page).
const ELEMENT_BOX_FN = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: Math.round(r.width), h: Math.round(r.height) };
};

// The page's full size in CSS px, measured as Playwright's full-page screenshot measures it (runs in the page).
const FULL_PAGE_MAX_PX = 16_000;
const PAGE_SIZE_FN = () => {
  const [body, root] = [document.body, document.documentElement];
  return { w: Math.max(body?.scrollWidth ?? 0, root.scrollWidth, body?.offsetWidth ?? 0, root.offsetWidth, body?.clientWidth ?? 0, root.clientWidth),
    h: Math.max(body?.scrollHeight ?? 0, root.scrollHeight, body?.offsetHeight ?? 0, root.offsetHeight, body?.clientHeight ?? 0, root.clientHeight) };
};

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

// A failed console.assert is an error (Playwright reports its type as "assert").
const LEVELS = { error: 0, assert: 0, warning: 1, info: 2, log: 2, debug: 3 };

// wait_for text: true once some frame of the page shows the text (shown) or none does (!shown), false at the deadline.
// The snapshot shows iframes' content too while a Playwright locator looks in one frame, so every frame is read (ones
// that appear meanwhile too) every TEXT_POLL_MS. Any shown copy counts: a hidden one earlier in the page (a closed menu)
// neither hides a shown one nor makes it look gone. A frame that doesn't answer within FRAME_COUNT_MS (another site's
// frame busy in its own process), or by the deadline, is unknown (null): it shows nothing, and nor is the text gone from it.
const TEXT_POLL_MS = 100;
const FRAME_COUNT_MS = 1000;
const textCounts = (page, text, visible, ms = FRAME_COUNT_MS) => Promise.all(page.frames().map((frame) => {
  const matches = frame.getByText(text);
  return within((visible ? matches.filter({ visible: true }) : matches).count().catch(() => 0), ms, null); // a frame gone meanwhile: 0
}));
async function textShown(page, text, shown, timeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const counts = await textCounts(page, text, true, Math.min(FRAME_COUNT_MS, Math.max(100, deadline - Date.now())));
    if (shown ? counts.some((n) => n > 0) : counts.every((n) => n === 0)) return true;
    // Null: gone from every frame that answers, and only one that doesn't may still show it.
    if (Date.now() >= deadline) return !shown && counts.every((n) => !n) ? null : false;
    await sleep(TEXT_POLL_MS);
  }
}

// evaluate failed because the page left the document it ran in: say where it went instead of Playwright's wording.
// The context can die before Playwright hears of the new URL, so wait briefly for the URL to move on.
async function navigatedError(tab, error, urlBefore) {
  if (!/Execution context was destroyed|Frame was detached|Cannot find context with specified id/i.test(error?.message)) throw error;
  await tab.page.waitForURL((u) => u.href !== urlBefore, { timeout: 2000, waitUntil: 'commit' }).catch(() => {});
  throw new Error(`The page navigated while evaluate ran, so its result is lost. The tab is now at ${tab.page.url()}. ` +
    'Do things that navigate (links, buttons, form submits) with click, type or navigate: they wait for the new page.');
}

// Back or forward one history entry; false when there is none. Page.goBack never resolves when Chrome restores the page
// from its back/forward cache, so this steps through history in the page and waits for the URL or document to change.
async function historyStep(tab, action, timeout) {
  const back = action === 'back';
  const before = await tab.page.evaluate((b) => ({ url: location.href, can: b ? window.navigation?.canGoBack : window.navigation?.canGoForward }), back);
  if (before.can === false) return false;
  const changed = tab.page.waitForEvent('framenavigated', { predicate: (f) => f === tab.page.mainFrame(), timeout })
    .catch(() => tab.page.waitForURL((u) => u.href !== before.url, { timeout: 2000 }));
  await Promise.all([changed, tab.page.evaluate((b) => (b ? history.back() : history.forward()), back)]);
  return true;
}

// The browser's own shortcuts: key presses reach the page only (pages may use them), so these would do nothing. Reload,
// back and forward are done for the agent; the tab and window ones say what to use.
const BROWSER_KEYS = [
  [/^(ControlOrMeta|Meta)\+(Shift\+)?r$|^F5$/i, 'reload'], [/^(ControlOrMeta|Meta)\+\[$/i, 'back'], [/^(ControlOrMeta|Meta)\+\]$/i, 'forward'],
  [/^(ControlOrMeta|Meta)\+(Shift\+)?w$/i, 'close the tab', 'Use tab_close.'], [/^(ControlOrMeta|Meta)\+t$/i, 'open a new tab', 'Use tab_open.'],
  [/^(ControlOrMeta|Meta)\+(Shift\+)?t$/i, 'reopen a closed tab', 'Use tab_open with its URL.'],
  [/^(ControlOrMeta|Meta)\+(Shift\+)?n$/i, 'open a new window', 'Use tab_open.'], [/^(ControlOrMeta|Meta)\+l$/i, 'go to the address bar', 'Use navigate with a url.'],
  [/^(ControlOrMeta|Meta)\+[qmh]$/i, 'quit, minimize or hide the browser', 'Nothing in FowlBrowser does that; it is the user\'s.'],
];

// type: replaces the content (or appends), into the ref or whatever has focus.
// True when the element is hidden while focus sits in another text field (the page swapped the field).
const SWAPPED_FIELD_FN = (el) => {
  const hidden = !el.isConnected || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const focused = document.activeElement;
  return hidden && !!focused && focused !== el && focused.matches('input:not([type=hidden]), textarea, [contenteditable]:not([contenteditable=false])');
};

// Keys typed into a dropdown, a colour or a file input open its UI (Space, Enter, the arrows): refused. A ref's colour
// input is set by fill instead, with no keys.
async function refuseKeysInto(tab, target, what) {
  const found = await within(Promise.resolve().then(() => nativeUIFound(tab, target, ACTION_TIMEOUT_MS)), ACTION_TIMEOUT_MS, null);
  if (['select', 'color', 'file'].includes(found?.kind)) throw nativeUIError(found, what, 'Typing keys into it');
}

async function typeText(tab, args) {
  const timeout = args.timeout_ms;
  if (args.ref && isShadowRef(args.ref)) {
    await refuseKeysInto(tab, { shadowRef: args.ref }, `Ref ${cleanRef(args.ref)}`);
    // No Playwright locator here: focus over CDP, then type with the keyboard like a person.
    await focusShadowRef(tab, args.ref);
    // Keyboard select-all does nothing over CDP, so select the content in the element (as fill does).
    await callOnShadowRef(tab, args.ref, args.append ? CARET_TO_END_FN : SELECT_ALL_FN);
    if (!args.append && !args.text) await tab.page.keyboard.press('Delete');
  } else if (!args.ref) {
    await refuseKeysInto(tab, {}, 'The focused element');
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
    if (args.submit) await submit(tab);
    return;
  }
  const loc = locator(tab, args.ref);
  if (args.slowly || args.append) await refuseKeysInto(tab, { loc }, `Ref ${cleanRef(args.ref)}`);
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
  if (args.submit) await submit(tab);
}

// Enter on what has focus after typing: refused where it would open a colour window or a dropdown's menu (the colour
// input typed into, or a select the page moved focus to).
async function submit(tab) {
  await refuseNativeUI(tab, { what: 'The focused element', by: 'Pressing Enter (submit)', key: 'Enter' });
  await tab.page.keyboard.press('Enter');
}

// --- Registration ---

export function registerTools(server, manager) {
  const handlers = {}; // raw handlers by tool name, so other tools can reuse one (download clicks with click's)
  const failed = (args, message) => ({ isError: true, content: [{ type: 'text', text: `${args?.tab ? `Tab: ${args.tab}\n` : ''}Error: ${message}` }] });
  // Tools that only read: marked readOnlyHint, which is also what lets Claude Code run a batch of them at once (it runs
  // MCP tools one after another unless they say they only read). Calls on one tab still take turns here (Tab.run).
  const READ_ONLY = new Set(['browser_list', 'tab_list', 'snapshot', 'screenshot', 'wait_for', 'console', 'network', 'export', 'downloads',
    'browser_data', 'memory', 'trace_insight']);
  const tool = (name, description, shape, handler) => {
    handlers[name] = handler;
    const annotations = READ_ONLY.has(name) ? { annotations: { readOnlyHint: true } } : {};
    server.registerTool(name, { description, inputSchema: shape, ...annotations }, (args) => record.recordCall(name, args, async () => {
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
      // Installed but not connected: closing a browser's last window unloads FowlBrowser there until a window opens.
      const asleep = manager.asleep().map((b) => `- ${b.name} · browser: "${b.key}" · ` + (b.bundle
        ? 'running with FowlBrowser not connected (no window open, or its extension is off); naming it in a tool opens a window there in the background and connects it'
        : 'not running; FowlBrowser never starts a browser, so ask the user to open it if you need it'));
      const lines = browsers.length ? [`Connected browsers (${browsers.length}):`]
        : ['No browsers connected. FowlBrowser needs Google Chrome or Helium running with the FowlBrowser extension loaded.'];
      for (const b of browsers) {
        const version = [b.version, b.chromiumVersion && `Chromium ${b.chromiumVersion}`].filter(Boolean).join(', ') || 'version unknown';
        const bar = b.silentDebugger ? 'debugging bar silenced' : 'debugging bar NOT silenced (the user sees a "started debugging" notice while a tab is controlled)';
        const mine = [...b.tabs.values()].map((t) => t.id);
        lines.push(`- ${b.name} (${version}) · browser: "${b.key}" · ${bar} · tabs you control: ${mine.length ? mine.join(', ') : 'none'}`);
      }
      if (asleep.length) lines.push(`Installed but not connected (${asleep.length}):`, ...asleep);
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
    'pass for_user: true: it opens like their own tab (not in your work group, stays open after your turn, muted only while you control it), still in the background unless focus: true. ' +
    'Tabs you give the user in one turn (for_user, tab_keep) share a tab group of their own once there are two or more, say one per prototype or result; a single one stays ungrouped. ' +
    'Returns the tab id (e.g. "helium:1834") to pass to every other tool, plus the page snapshot.',
    { browser: browserArg, url: z.string().optional().describe('URL to load (default about:blank).'),
      for_user: z.boolean().optional().describe('Open the tab for the user: kept after your turn ends, out of your work group (several for the user share a group of their own, see group). You control it until then; it stays muted till then so nothing plays aloud before the user looks (tab_mute false if they asked to hear it now).'),
      focus: z.boolean().optional().describe('Bring the tab to the front once loaded. Only when the user asked to see it now.'),
      group: z.string().optional().describe('Tab group title (default: this session\'s label). With for_user, the title of the group the tabs you open for the user this turn share once there are two or more: name what they are, e.g. "Ad prototypes".'),
      muted: z.boolean().optional().describe('Mute the tab\'s audio (default true; ignored with for_user).'),
      snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    async ({ browser: key, url, for_user, focus, group, muted, snapshot, screenshot, timeout_ms }) => {
      refuseNonWeb(url);
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
            if (url && snapshot !== false) await contentReady(tab);
            if (focus) await browser.host.request('tabs.focus', { tabId: tab.tabId });
          })();
          opening.catch(() => {}); // a dialog may win the race
          await Promise.race([opening, dialogOpened]).finally(() => tab.off('dialog', onDialog));
          if (tab.dialog) tab.keepBusy(opening.catch(() => {}));
          const lines = [`Opened ${tab.id} in ${browser.name}${focus && !tab.dialog ? ' and brought it to the front' : ''}.`];
          if (for_user) lines.push(`It is the user's tab${created.groupId >= 0 ? ', in one tab group with the other tabs you opened for them this turn,' : ''} and stays open after your turn; you control it until then, and it stays muted till then so nothing plays aloud before they look (tab_mute false if they asked to hear it now).`);
          return report(tab, { lines, snapshot: snapshot !== false && !tab.dialog, screenshot: screenshot === true });
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
  // scripts leave it first (popups.mjs). escape: it also runs on a page found stuck in a script (Tab.run).
  const simpleTabCall = (method, params, done, { ends = false, check, fadeCursor = false, event, toUser = false, escape = false } = {}) => async (args) => {
    const { key, tabId } = parseTabId(args.tab);
    const browser = await manager.get(key);
    if (toUser) await browser.adopting.get(tabId); // a tab still being set up: its popup scripts are in before they are taken out
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
      await (tab ? tab.run(call, { escape }) : call());
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
    { tab: tabArg }, simpleTabCall('tabs.release', byId, 'Released. The tab stays open and is no longer controlled.', { ends: true, fadeCursor: true, event: 'release', toUser: true, escape: true }));
  // usersTab: the extension closes a parked tab only with it.
  const closeOwned = simpleTabCall('chrome.tabs.remove', (tabId, args) => (args.confirm_close_users_tab === true ? [tabId, { usersTab: true }] : [tabId]), 'Closed.',
    { ends: true, check: refuseUsersTab, event: 'close', escape: true });
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
    'Hand a tab you opened to the user now: it leaves your work group and stays open after your turn ends (agent tabs normally close then). ' +
    'Tabs you give the user in one turn (tab_keep, for_user) share a tab group of their own once there are two or more. ' +
    'You keep controlling it (no tab_claim needed) until your turn ends or you tab_release it; claim it again in a later turn. ' +
    'A muted work tab stays muted while you control it and is unmuted when control ends (tab_mute false if the user asked to hear it now). ' +
    'For a tab meant for the user from the start, use tab_open with for_user: true.',
    { tab: tabArg }, simpleTabCall('tabs.keep', byId, 'Kept: handed to the user now (out of your work group) and stays open after your turn ends. You still control it until then; ' +
      'if it was muted it stays muted till then (tab_mute false if the user asked to hear it now).',
      { event: 'keep', toUser: true, escape: true }));
  tool('tab_handoff',
    'Hand a tab to the user mid-task for something only they should do: logging in, a 2FA code, a CAPTCHA, payment or card details. ' +
    'Your cursor leaves, the tab leaves your group and is unmuted, and you stop acting in it (it is never brought to the front). ' +
    'Repeat the returned line to the user, then wait: once they say they are done, tab_claim it with resume: true and carry on; tab_release lets it go for good.',
    { tab: tabArg, reason: z.string().min(1).describe('What the user should do there, as words for them, e.g. "log in to your bank" or "enter the card details".') },
    async ({ tab: value, reason }) => {
      const tab = await resolveTab(manager, value);
      refuseLocalPage(tab);
      const title = (await tab.currentTitle()) || tab.page.url();
      await tab.run(() => takeover.handOff(tab, reason), { escape: true });
      return text(`Browser: ${tab.browser.name} · Tab: ${tab.id}\nHanded ${tab.id} to the user. Tell them: Your turn in ${tab.browser.name} tab "${title}": ${reason}, then tell me.\n` +
        'Once they say they are done, call tab_claim on it with resume: true to carry on (you get a fresh snapshot). If you no longer need it, tab_release gives it to them for good.');
    });
  tool('tab_mute',
    'Mute or unmute a tab\'s audio (the browser\'s tab mute, what the speaker icon in the tab strip shows). Agent tabs open muted unless muted: false (for_user tabs until your turn ends). ' +
    'This is separate from the page\'s own video mute (media mute/unmute).',
    { tab: tabArg, muted: z.boolean() },
    simpleTabCall('tabs.setMuted', (tabId, { muted }) => ({ tabId, muted }), ({ muted }) => (muted ? 'Tab audio muted.' : 'Tab audio unmuted.'), { escape: true }));
  tool('tab_focus', 'Bring a tab to the front and focus its window. Only when the user explicitly asks to see it; every other tool works in the background.',
    { tab: tabArg }, simpleTabCall('tabs.focus', byId, 'Focused.'));

  tool('navigate',
    'Load a URL in a tab, or go back, forward or reload. Returns the new snapshot.',
    { tab: tabArg, url: z.string().optional(), action: z.enum(['back', 'forward', 'reload']).optional(), snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, () => cued(tab, 'navigate', async () => {
      const options = { waitUntil: 'domcontentloaded', timeout: args.timeout_ms ?? NAVIGATION_TIMEOUT_MS };
      // A page found stuck in a script can't be left: Chrome holds a reload or a same-site URL until the page's thread is
      // free (only another site, in a new process, loads). Its script is stopped first: Runtime.terminateExecution runs
      // between two turns of the loop. A navigation that was sent before the page was found stuck and still waits on it
      // holds that command too, and every later navigation: only closing the tab gets out then.
      if (tab.stuckAt && !(await within(cdp(tab, 'Runtime.terminateExecution').then(() => true, () => true), 1000, false))) {
        throw new Error(`The page in ${tab.id} is stuck in a script, and a navigation sent before that was found still waits on it, so it can't be ` +
          'navigated any more. Close it with tab_close (and open a new tab).');
      }
      let response;
      if (args.url) response = await tab.page.goto(refuseNonWeb(args.url), options);
      else if (args.action === 'back' || args.action === 'forward') {
        if (!(await historyStep(tab, args.action, options.timeout))) return `No ${args.action} history entry.`;
      } else if (args.action === 'reload') response = await tab.page.reload(options);
      else throw new Error('Pass url or action.');
      await loaded(tab.page);
      if (args.snapshot !== false) await contentReady(tab);
      if (response === null && args.action && args.action !== 'reload') return `No ${args.action} history entry.`;
      return response && !response.ok() ? `HTTP ${response.status()} ${response.statusText()}` : null;
    }, { after: true }), { waited: true }), { onLocalPage: (args) => !!args.url, escape: true }));

  tool('snapshot',
    'Read the page as an accessibility snapshot (YAML). Elements carry refs like [ref=e12] that click, type and other tools take. ' +
    'Pass ref to read just one section of a large page. Always the whole page (or section), never just changes. ' +
    `Output is cut at max_chars (default ${SNAPSHOT_MAX_CHARS}); a cut snapshot ends with a line saying how much was left out. ` +
    'mode "text" returns the readable text instead (of ref, else the page\'s main content), without refs: for reading articles and lists, not for acting. ' +
    'mode "links" returns its links as text and URL, each URL once: for collecting URLs (search results, threads, listings) without the whole snapshot. ' +
    'find returns only the lines containing that text (any case), with the lines they sit in and what they hold, refs included: for finding a control on a big page.',
    { tab: tabArg, ref: refArg.optional(), find: z.string().min(1).optional().describe('Only the snapshot lines with this text, with their context and refs.'),
      mode: z.enum(['snapshot', 'text', 'links']).optional().describe('"snapshot" (default): accessibility tree with refs. "text": readable text only, no refs. "links": link texts and URLs, no refs.'),
      max_chars: z.number().int().min(1000).max(SNAPSHOT_MAX_CHARS_LIMIT).optional().describe(`Cut the output at this many characters (default ${SNAPSHOT_MAX_CHARS}, max ${SNAPSHOT_MAX_CHARS_LIMIT}).`) },
    withTab(manager, (tab, { ref, mode, max_chars: maxChars, find }) => cued(tab, 'observe', async () => (mode === 'text' || mode === 'links'
      ? text(`${await header(tab)}\n${await (mode === 'text' ? pageText : pageLinks)(tab, { ref, maxChars })}`)
      : report(tab, { ref, maxChars, find })))));

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
      snapshot: snapshotArg, screenshot: screenshotArg, frames: framesArg, frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const options = { button: args.button, modifiers: args.modifiers };
      const guarded = args.button !== 'right'; // a right click opens a context menu, never the control's own UI
      let { x, y } = args;
      if (args.ref && isShadowRef(args.ref)) {
        if (guarded) await refuseNativeUI(tab, { shadowRef: args.ref, what: `Ref ${cleanRef(args.ref)}`, timeout: args.timeout_ms });
        ({ x, y } = await shadowRefPoint(tab, args.ref));
      } else if (args.ref) {
        const loc = locator(tab, args.ref);
        if (guarded) await refuseNativeUI(tab, { loc, what: `Ref ${cleanRef(args.ref)}`, timeout: args.timeout_ms });
        const plain = !args.double && (args.button ?? 'left') === 'left' && !args.modifiers?.length;
        return pointed(tab, refPoint(tab, args.ref, args.timeout_ms), () => {
          const click = (modifiers = args.modifiers) => onRef(tab, args.ref, loc, (timeout) => (args.double
            ? loc.dblclick({ ...options, modifiers, timeout }) : loc.click({ ...options, modifiers, timeout })), args.timeout_ms, plain ? 'toggle' : undefined);
          // A popup it opens is a background tab with its opener, never activated (SPEC "Popups (session 5)").
          return plain && mayOpenPopup(tab, args.ref) ? backgroundClick(tab, loc, (args.timeout_ms ?? ACTION_TIMEOUT_MS) + 5000, click) : click();
        });
      }
      if (x === undefined || y === undefined) throw new Error('Pass ref, or both x and y.');
      if (guarded && !args.ref) await refuseNativeUI(tab, { point: { x, y }, what: `The element at ${Math.round(x)},${Math.round(y)}`, timeout: args.timeout_ms });
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

  tool('hover', 'Move the mouse over an element by ref, or a point by x,y in CSS pixels (same pixels as the screenshot image): opens hover menus, tooltips and hover cards.',
    { tab: tabArg, ref: shadowRefArg.optional(), x: z.number().optional(), y: z.number().optional(), snapshot: snapshotArg, screenshot: screenshotArg, frames: framesArg, frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (args.ref && !isShadowRef(args.ref)) {
        const loc = locator(tab, args.ref);
        return pointed(tab, refPoint(tab, args.ref, args.timeout_ms), () => quickly(tab, args.ref, loc, (timeout) => loc.hover({ timeout }), args.timeout_ms), { feedback: false });
      }
      const { x, y } = args.ref ? await shadowRefPoint(tab, args.ref) : args;
      if (x === undefined || y === undefined) throw new Error('Pass ref, or both x and y.');
      await pointed(tab, { x, y }, () => tab.page.mouse.move(x, y), { feedback: false });
    })));

  tool('type',
    'Type text into an editable element. Replaces its content unless append is true. slowly types one key at a time (for fields that react per key, like search suggestions). submit presses Enter after. ' +
    'Without ref it types into whatever has focus (e.g. after click at x,y on a canvas editor or a control the snapshot cannot show): a focused text input or textarea ' +
    'is replaced or appended to the same way; in rich text, code and canvas editors the text goes in at the caret.',
    { tab: tabArg, ref: shadowRefArg.optional(), text: z.string(), submit: z.boolean().optional(), slowly: z.boolean().optional(), append: z.boolean().optional(),
      snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, () => (args.ref
      ? pointed(tab, refPoint(tab, args.ref, args.timeout_ms), () => typeText(tab, args), { feedback: false, cue: 'text' })
      : cued(tab, 'text', () => typeText(tab, args))))));

  tool('fill_form',
    'Fill several form fields at once. value: text for textboxes, true/false for checkboxes, radios and switches, option label or value for selects and comboboxes, a number for sliders.',
    { tab: tabArg, fields: z.array(z.object({ ref: refArg, value: z.union([z.string(), z.boolean(), z.number()]) })).min(1),
      snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
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
        await pointed(tab, refPoint(tab, ref, timeout), async () => {
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
    { tab: tabArg, ref: refArg, values: z.array(z.string()).min(1), snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => actOpening(tab, args, async () => {
      const loc = locator(tab, args.ref);
      const chosen = await pointed(tab, refPoint(tab, args.ref, args.timeout_ms), () => selectOnce(tab, args.ref, loc, args.values, args.timeout_ms));
      return `Selected: ${chosen.join(', ')}`;
    })));

  tool('press_key',
    'Press a key or combo, e.g. "Enter", "Escape", "ArrowDown", "ControlOrMeta+a". With ref, focuses that element first; otherwise goes to the focused element. ' +
    'times presses it that many times (arrows through a list, Tab through a form). Keys reach the page, never the browser: its reload, back and forward ' +
    'shortcuts (Cmd+R, Cmd+[, Cmd+]) are done for you; tab and window shortcuts are refused with what to use.',
    { tab: tabArg, key: z.string(), ref: shadowRefArg.optional(), times: z.number().int().min(1).max(50).optional(), snapshot: snapshotArg, screenshot: screenshotArg, frames: framesArg, frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => {
      // A reload, back or forward shortcut is done as navigate does it and waits for its page as navigate does, so
      // act() does not wait for it a second time (waited).
      const shortcut = BROWSER_KEYS.find(([pattern]) => pattern.test(args.key.replace(/\s+/g, '')));
      const navigates = !!shortcut && !shortcut[2];
      return actOpening(tab, args, async () => {
        if (navigates) {
          const [, action] = shortcut;
          await cued(tab, 'navigate', async () => {
            for (let i = 0; i < (args.times ?? 1); i++) {
              if (action === 'reload') await tab.page.reload({ waitUntil: 'domcontentloaded', timeout: args.timeout_ms ?? NAVIGATION_TIMEOUT_MS });
              else if (!(await historyStep(tab, action, args.timeout_ms ?? NAVIGATION_TIMEOUT_MS))) throw new Error(`${args.key} is the browser's ${action} shortcut, and there is no ${action} history entry${i ? ` after ${i}` : ''}.`);
            }
            await loaded(tab.page);
            if (args.snapshot !== false) await contentReady(tab);
          }, { after: true });
          return `${args.key} is the browser's ${action} shortcut, which pages never receive: did the ${action} instead (as navigate action ${action}).`;
        }
        if (shortcut) throw new Error(`${args.key} is the browser's shortcut to ${shortcut[1]}; key presses reach the page only, so it would do nothing. ${shortcut[2]}`);
        const key = { NumpadEnter: 'Enter' }[args.key.split('+').pop()] ?? (args.key.split('+').pop() || '+');
        // Checked right before every press, on what has focus then (the page may move focus as keys go in).
        const what = args.ref ? `The focused element (after focusing ${cleanRef(args.ref)})` : 'The focused element';
        const press = async () => {
          if (args.ref && !isShadowRef(args.ref)) await locator(tab, args.ref).focus({ timeout: args.timeout_ms });
          else if (args.ref) {
            await focusShadowRef(tab, args.ref);
            // The focused-element check below stops at the closed root's host.
            await refuseNativeUI(tab, { key, by: `Pressing ${args.key} on it`, what: `Ref ${cleanRef(args.ref)}`, shadowRef: args.ref });
          }
          for (let i = 0; i < (args.times ?? 1); i++) {
            await refuseNativeUI(tab, { key, by: `Pressing ${args.key} on it`, what });
            await tab.page.keyboard.press(args.key);
          }
        };
        return args.ref ? pointed(tab, refPoint(tab, args.ref, args.timeout_ms), press, { feedback: false, cue: 'key' }) : cued(tab, 'key', press);
      }, { waited: navigates });
    }));

  tool('scroll',
    'Scroll the page (or the scrollable area under the viewport centre) by pages in a direction. With ref and direction, ' +
    'scroll the box that ref is in instead (a list, panel or table that scrolls on its own, e.g. a long or virtualized list), ' +
    'by pages of its own height. ref alone scrolls that element into view.',
    { tab: tabArg, ref: refArg.optional(), direction: z.enum(['up', 'down', 'left', 'right']).optional(), pages: z.number().positive().optional(),
      snapshot: snapshotArg, screenshot: screenshotArg, frames: framesArg, frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      if (args.ref && args.direction) return scrollBox(tab, args);
      if (args.ref) {
        await locator(tab, args.ref).scrollIntoViewIfNeeded({ timeout: args.timeout_ms });
        // The cursor follows to where the element landed.
        await pointed(tab, refPoint(tab, args.ref, args.timeout_ms), () => sleep(0), { feedback: false, cue: 'scroll' });
        return `Scrolled ${args.ref} into view.`;
      }
      return scrollPage(tab, args);
    })));

  tool('drag',
    'Drag one element onto another (from_ref, to_ref), or along points in CSS pixels (from_x, from_y to to_x, to_y; a ref and a ' +
    'point mix): sliders, timelines, canvases, sortable lists, resizing. The mouse goes down at the start, moves there in steps like a hand, and comes up at the end.',
    { tab: tabArg, from_ref: refArg.optional(), to_ref: refArg.optional(), from_x: z.number().optional(), from_y: z.number().optional(),
      to_x: z.number().optional(), to_y: z.number().optional(), snapshot: snapshotArg, screenshot: screenshotArg, frames: framesArg, frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      const end = (ref, x, y, which) => {
        if (ref) return refPoint(tab, ref, args.timeout_ms);
        if (x === undefined || y === undefined) throw new Error(`Pass ${which}_ref, or both ${which}_x and ${which}_y.`);
        return async () => ({ x, y });
      };
      const fromPoint = end(args.from_ref, args.from_x, args.from_y, 'from');
      const toPoint = end(args.to_ref, args.to_x, args.to_y, 'to');
      // One cursor budget for both ends.
      const deadline = Date.now() + cursor.ARRIVAL_CAP_MS;
      const shown = await cursor.isShown(tab);
      if (shown) await cursor.moveTo(tab, fromPoint, Math.max(0, deadline - Date.now()));
      if (args.from_ref && args.to_ref) {
        const from = locator(tab, args.from_ref);
        const to = locator(tab, args.to_ref);
        // A press on a dropdown opens its menu, and a press and release on one control clicks it.
        await refuseNativeUI(tab, { loc: from, what: `Ref ${cleanRef(args.from_ref)}`, by: 'A drag starting on it' });
        return pointed(tab, toPoint, () => from.dragTo(to, { timeout: args.timeout_ms }), { shown, feedback: false, cue: 'drag', cueOnPress: true, deadline });
      }
      // A hand's drag: the mouse goes down at the start, and only then is the end looked up (a ref scrolled into view
      // then moves the page under the held button, as a person's drag would); about one move per 15 px.
      const a = await fromPoint();
      if (!a) throw new Error('The from element has no box on the page (hidden or zero size).');
      await refuseNativeUI(tab, { point: a, what: `The element at ${Math.round(a.x)},${Math.round(a.y)}`, by: 'A drag starting on it' });
      if (shown) await cursor.painted(cursor.cue(tab, 'drag'));
      let b;
      try {
        await tab.page.mouse.move(a.x, a.y);
        await tab.page.mouse.down();
        try {
          b = await toPoint();
          if (!b) throw new Error('The to element has no box on the page (hidden or zero size).');
          if (shown) cursor.moveTo(tab, b, cursor.ARRIVAL_CAP_MS).catch(() => {});
          await tab.page.mouse.move(b.x, b.y, { steps: Math.min(40, Math.max(5, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 15))) });
        } finally {
          await tab.page.mouse.up();
        }
      } finally {
        if (shown) cursor.cueEnd(tab);
      }
      return `Dragged from ${Math.round(a.x)},${Math.round(a.y)} to ${Math.round(b.x)},${Math.round(b.y)}.`;
    })));

  // A drop zone that opens no chooser (drag files here) gets the files dropped on it: real File objects in a
  // DataTransfer, through the drag events a drop from Finder fires (dragenter, dragover, drop) on what is under the
  // element's centre. Chrome refuses file drags over an extension's debugger connection, so they are the page's own
  // events, which drop zones read the same way (dropPayload).
  const DROP_FN = (el, files) => {
    const dt = new DataTransfer();
    for (const f of files) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: f.type, lastModified: f.lastModified }));
    }
    const r = el.getBoundingClientRect();
    const [x, y] = [r.left + r.width / 2, r.top + r.height / 2];
    let target = document.elementFromPoint(x, y);
    if (!target || !(el === target || el.contains(target))) target = el;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt };
    for (const type of ['dragenter', 'dragover', 'drop']) target.dispatchEvent(new DragEvent(type, init));
  };
  const dropFiles = async (loc, files, ids) => loc.evaluate(DROP_FN, dropPayload(files, ids));
  const CHOOSER_MS = 1500; // after a click on what is no file input: how long a chooser has to open before the files are dropped instead
  tool('upload_files',
    'Upload local files: ref is a file input, a button that opens a file chooser, or a drop zone (drag files here): files are ' +
    'dropped on what opens no chooser. Without ref, fills the file chooser the last action opened (its result said so). paths are absolute paths on this Mac. ' +
    'Ask the user first before uploading a file they didn\'t name for this site.',
    { tab: tabArg, ref: refArg.optional(), paths: z.array(z.string()).min(1), snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      const ids = new Map();
      const files = uploadPaths(args.paths, undefined, ids);
      if (!args.ref) {
        const chooser = tab.fileChooser;
        if (!chooser) throw new Error('No file chooser is open in this tab. Pass ref: a file input, or a button that opens a file chooser.');
        await cued(tab, 'transfer', () => chooser.setFiles(files, { timeout: args.timeout_ms }));
        if (tab.fileChooser === chooser) tab.fileChooser = null; // kept when setFiles failed (two files for a one-file chooser): fix and retry
        return `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} into the open file chooser.`;
      }
      const loc = locator(tab, args.ref);
      const isInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', null, { timeout: args.timeout_ms });
      // What else is clicked: never a colour input, a dropdown or a link to another app (their own UI on the user's screen).
      if (!isInput) await refuseNativeUI(tab, { loc, what: `Ref ${cleanRef(args.ref)}` });
      const plural = `${files.length} file${files.length === 1 ? '' : 's'}`;
      const point = refPoint(tab, args.ref, args.timeout_ms);
      let dropped = false;
      await pointed(tab, point, async () => {
        if (isInput) return loc.setInputFiles(files, { timeout: args.timeout_ms });
        // Choosers are held (act) from before the click to well after it, however long the click takes to happen (a
        // button enabled a moment later, a busy page). The files go to one that opened during the click or opens
        // within CHOOSER_MS of it (a handler that asks its server first); one later still stays held, never shown.
        const held = tab.fileChooser;
        await loc.click({ timeout: args.timeout_ms });
        const opened = tab.fileChooser !== held ? tab.fileChooser : await tab.page.waitForEvent('filechooser', { timeout: CHOOSER_MS }).catch(() => null);
        if (opened) {
          await opened.setFiles(files);
          if (tab.fileChooser === opened) tab.fileChooser = null;
          return;
        }
        await dropFiles(loc, files, ids);
        dropped = true;
      }, { feedback: false, cue: 'transfer' });
      return dropped ? `Ref ${cleanRef(args.ref)} opened no file chooser, so the ${plural} ${files.length === 1 ? 'was' : 'were'} dropped on it (as dragged from Finder).` : `Uploaded ${plural}.`;
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
        return report(tab, { lines: [summary], snapshot: snapshot && !tab.dialog, changes: true, afterAction: true });
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
    'A url with * is matched against the whole URL, * standing for anything (also "/"), e.g. "*/wiki/Ada_*". ' +
    'With none of those, waits until the page has settled: loaded, no requests that render it in flight and no changes on it for half a second ' +
    '(at most timeout_ms, default 10 s). Prefer that, or text, to a fixed number of seconds.',
    { tab: tabArg, text: z.string().optional(), text_gone: z.string().optional(), url: z.string().optional(),
      seconds: z.number().positive().max(120).optional(), snapshot: snapshotArg, screenshot: screenshotArg, timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, () => cued(tab, 'observe', async () => {
      const page = tab.page;
      // Say what did not happen, in plain words.
      const textTimeout = args.timeout_ms ?? ACTION_TIMEOUT_MS;
      const timedOut = (what) => new Error(`${what} ${textTimeout / 1000} s. Call snapshot to see what the page shows.`);
      if (args.seconds) await page.waitForTimeout(args.seconds * 1000);
      if (args.text && !(await textShown(page, args.text, true, textTimeout))) {
        const there = (await textCounts(page, args.text, false)).some((n) => n > 0);
        throw timedOut(there ? `The text "${args.text}" is on the page but stayed hidden for` : `The text "${args.text}" did not appear on the page within`);
      }
      const gone = args.text_gone && await textShown(page, args.text_gone, false, textTimeout);
      if (gone === false) throw timedOut(`The text "${args.text_gone}" was still on the page after`);
      if (args.url) {
        const matches = urlMatcher(args.url);
        const timeout = args.timeout_ms ?? NAVIGATION_TIMEOUT_MS;
        await page.waitForURL((u) => matches(u.href), { timeout, waitUntil: 'domcontentloaded' }).catch((error) => {
          if (!/Timeout \d+ms exceeded/.test(error.message)) throw error;
          throw new Error(`The URL did not match "${args.url}" within ${timeout / 1000} s. Current URL: ${page.url()}`);
        });
      }
      if (!args.seconds && !args.text && !args.text_gone && !args.url) {
        const { settled, ms, pending } = await pageSettled(tab, args.timeout_ms ?? ACTION_TIMEOUT_MS);
        if (settled) return `The page settled after ${(ms / 1000).toFixed(1)} s.`;
        return `The page was still busy after ${(ms / 1000).toFixed(1)} s (${pending.length ? `requests in flight: ${pending.slice(0, 3).join(', ')}` : 'it kept changing'}); ` +
          'it may poll or animate. Go on with snapshot, or wait for the text you expect.';
      }
      return gone === null ? `Wait finished: "${args.text_gone}" is gone from the page, except maybe from a frame that did not answer (busy, maybe another site's).` : 'Wait finished.';
    }), { waited: true, input: false })));

  // Before a full-page capture the page is scrolled through, a screen at a time, and back: content that loads or
  // appears only once scrolled into view (lazy images, reveal-on-scroll sections) is in the picture.
  const SCROLL_THROUGH_FN = async ({ maxMs, until }) => {
    const { scrollX: x, scrollY: y } = window;
    const start = performance.now();
    const step = Math.max(200, innerHeight * 0.9);
    const frame = () => new Promise((resolve) => { requestAnimationFrame(() => setTimeout(resolve, 60)); setTimeout(resolve, 250); });
    let at = y;
    try {
      for (let top = 0, n = 0; top < document.documentElement.scrollHeight && n < 30 && performance.now() - start < maxMs && Date.now() < until; top += step, n++) {
        scrollTo({ left: x, top, behavior: 'instant' });
        at = scrollY;
        await frame();
      }
    } finally {
      // Back where it was. Past the server's wait (a stalled page: the capture went ahead without this) only if nothing
      // scrolled it since: a later scroll stays.
      if (Date.now() < until || scrollY === at) scrollTo({ left: x, top: y, behavior: 'instant' });
    }
    await frame();
  };
  tool('screenshot',
    'Screenshot the tab (or one element with ref) as JPEG. Image pixels are CSS pixels, so x,y read off a viewport screenshot work directly with click. Prefer snapshot for reading text. ' +
    'full_page first scrolls through the page and back, so content that appears on scroll is in it. ' +
    'frames takes several, frame_ms apart, to see something in motion (an animation, a loading state).',
    { tab: tabArg, full_page: z.boolean().optional(), ref: refArg.optional(),
      frames: z.number().int().min(2).max(8).optional().describe('Take this many screenshots of the viewport (or of where the ref\'s element is now) frame_ms apart, instead of one.'),
      frame_ms: frameMsArg, timeout_ms: timeoutArg },
    withTab(manager, async (tab, args) => {
      if (tab.dialog) throw new Error(`${dialogLine(tab)} Screenshots wait until it is resolved.`);
      const options = { type: 'jpeg', quality: 80, scale: 'css', timeout: args.timeout_ms ?? ACTION_TIMEOUT_MS };
      if (args.frames) {
        if (args.full_page) throw new Error('frames are taken of the viewport or an element (ref), not of the full page.');
        // An element's area as it is now, scrolled into view (an iframe's, with the iframes around it): a moving element
        // is never "stable", so it isn't waited for as an element screenshot would.
        const at = args.ref && await refPoint(tab, args.ref, options.timeout)();
        if (args.ref && !at) throw new Error(`Ref ${cleanRef(args.ref)} has no size on the page (hidden), so there is nothing to capture.`);
        const clip = at && { x: at.x - at.w / 2, y: at.y - at.h / 2, width: Math.max(1, at.w), height: Math.max(1, at.h) };
        const frames = await cued(tab, 'observe', () => filmstrip(tab, args.frames, args.frame_ms,
          () => tab.page.screenshot({ ...options, quality: 70, ...(clip && { clip }) })), { after: true });
        refuseLocalPage(tab); // it went there while they were taken
        return { content: [
          { type: 'text', text: `${await header(tab)}\n${frames.length} screenshots of the ${args.ref ? `area of element ${args.ref}` : 'viewport'} at ` +
            `${frames.map((f) => `+${f.at}`).join(', ')} ms (in that order), JPEG, 1 image px = 1 CSS px.` },
          ...frames.map((f) => ({ type: 'image', data: f.image.toString('base64'), mimeType: 'image/jpeg' })),
        ] };
      }
      // Within the call's own timeout too: a page too busy to scroll is captured as it is.
      if (args.full_page && !args.ref) {
        const waitMs = Math.min(6000, options.timeout);
        await within(tab.page.evaluate(SCROLL_THROUGH_FN, { maxMs: Math.min(4000, options.timeout), until: Date.now() + waitMs }), waitMs, null);
      }
      // Chromium draws a capture beyond the viewport as one surface of at most 16,384 px a side: a page or element taller
      // (or wider) than that never finishes its capture (or comes back garbled), so it is cut at FULL_PAGE_MAX_PX from its
      // top-left, an element (of the main frame: an iframe's box is not in page px) through a full-page capture of its box.
      const box = args.ref ? !/^f\d/.test(cleanRef(args.ref)) && await locator(tab, args.ref).evaluate(ELEMENT_BOX_FN, null, { timeout: options.timeout })
        : args.full_page && await within(tab.page.evaluate(PAGE_SIZE_FN), options.timeout, null); // a page too busy to answer: no cut
      if (box && (box.w > FULL_PAGE_MAX_PX || box.h > FULL_PAGE_MAX_PX)) {
        options.clip = { x: box.x ?? 0, y: box.y ?? 0, width: Math.min(box.w, FULL_PAGE_MAX_PX), height: Math.min(box.h, FULL_PAGE_MAX_PX) };
      }
      const image = await cued(tab, 'observe', () => cursor.hideForCapture(tab, () => (args.ref && !options.clip
        ? locator(tab, args.ref).screenshot(options)
        : tab.page.screenshot({ ...options, fullPage: !!(args.full_page || options.clip) }))), { after: true });
      refuseLocalPage(tab); // it went there while the screenshot was taken
      const cut = options.clip ? `, cut to its first ${options.clip.width.toLocaleString('en-US')}x${options.clip.height.toLocaleString('en-US')} px of ` +
        `${box.w.toLocaleString('en-US')}x${box.h.toLocaleString('en-US')} (the browser captures at most ${FULL_PAGE_MAX_PX.toLocaleString('en-US')} px a side; ` +
        'for the rest, scroll and take viewport screenshots)' : '';
      const what = `${args.ref ? `element ${args.ref}` : args.full_page ? 'full page' : 'viewport'}${cut}`;
      return { content: [
        { type: 'text', text: `${await header(tab)}\nScreenshot of the ${what}, JPEG, 1 image px = 1 CSS px.` },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
      ] };
    }));

  const sizeArg = z.number().int().min(MIN_SIZE).max(MAX_SIZE).optional();
  tool('viewport',
    'Lay the page out at another size (CSS px), like a phone or a smaller window; mobile: true also emulates a phone (meta viewport, touch). ' +
    'color_scheme and reduced_motion make the page see the user\'s dark or light mode, or reduced motion, as set here (with or without a size). ' +
    'Only when the user asks for a size, device or theme, to test a breakpoint, mobile layout, dark mode or reduced motion, or when the task can\'t be answered without it; never to make screenshots bigger. ' +
    'Snapshot, screenshot and click x,y then use this size. Reset with reset: true when done unless the user asked to keep it (releasing the tab or the end of your session or Claude Code turn resets it too).',
    { tab: tabArg, width: sizeArg.describe(`Width in CSS px (${MIN_SIZE} to ${MAX_SIZE}).`), height: sizeArg.describe(`Height in CSS px (${MIN_SIZE} to ${MAX_SIZE}).`),
      mobile: z.boolean().optional().describe('Emulate a phone: meta viewport, overlay scrollbars, touch (default false).'),
      device_scale_factor: z.number().positive().max(4).optional().describe('devicePixelRatio, e.g. 3 for a recent iPhone (default: the screen\'s own).'),
      color_scheme: z.enum(['light', 'dark']).optional().describe('The page sees prefers-color-scheme as this (its light or dark theme).'),
      reduced_motion: z.boolean().optional().describe('The page sees prefers-reduced-motion: reduce (true) or no-preference (false).'),
      reset: z.boolean().optional().describe('Back to the tab\'s real size, colour scheme and motion.'), snapshot: snapshotArg },
    withTab(manager, async (tab, args) => {
      const lines = [];
      const media = args.color_scheme !== undefined || args.reduced_motion !== undefined;
      if (args.reset) {
        lines.push((await clearViewport(tab)) ? 'Viewport reset: the page is back at the tab\'s real size, colour scheme and motion.' : 'No viewport was set on this tab; it is at its real size.');
      } else {
        const sized = args.width !== undefined || args.height !== undefined;
        if (!media && !sized) throw new Error('Pass width and height, color_scheme or reduced_motion, or reset: true.');
        if (sized && (args.width === undefined || args.height === undefined)) throw new Error('Pass both width and height.');
        // Reading the page's new size would wait for it, and an open dialog blocks the page until it is resolved.
        if (tab.dialog) throw new Error(`${dialogLine(tab)} The viewport can be set once it is resolved.`);
        if (sized) await setViewport(tab, { width: args.width, height: args.height, mobile: args.mobile === true, deviceScaleFactor: args.device_scale_factor });
        if (media) await setMedia(tab, { colorScheme: args.color_scheme, reducedMotion: args.reduced_motion });
        const page = await tab.page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches,
          still: matchMedia('(prefers-reduced-motion: reduce)').matches })).catch(() => null);
        if (sized) {
          lines.push(`Viewport set to ${args.width}x${args.height}${args.mobile ? ' (mobile)' : ''}: the page reflowed` +
            `${page ? ` (innerWidth ${page.w}, innerHeight ${page.h}, devicePixelRatio ${page.dpr})` : ''}. Snapshot, screenshot and click x,y use this size; ` +
            'reset with viewport reset: true when done.');
        }
        if (media) {
          lines.push(`The page now sees ${[args.color_scheme && `${args.color_scheme} mode`, args.reduced_motion !== undefined && (args.reduced_motion ? 'reduced motion' : 'full motion')].filter(Boolean).join(' and ')}` +
            `${page ? ` (prefers-color-scheme ${page.dark ? 'dark' : 'light'}, prefers-reduced-motion ${page.still ? 'reduce' : 'no-preference'})` : ''}; reset with viewport reset: true when done.`);
        }
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
      script: z.string().optional().describe('Same as function (either one).'),
      ref: refArg.optional(), snapshot: z.boolean().optional().describe('Also return the page snapshot (default false).'), timeout_ms: timeoutArg },
    withTab(manager, (tab, args) => act(tab, args, async () => {
      const code = args.function ?? args.expression ?? args.script;
      if (!code) throw new Error('Pass function, e.g. "() => document.title".');
      const source = functionSource(code, { withElement: !!args.ref });
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
          // Nothing stops the page function: an async loop goes on in the page after this call has ended, so say so.
          const expired = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`evaluate did not finish within ${timeout / 1000} s, so its result is lost. The function was not stopped: ` +
              'it may still be running in the page. For a slow read, pass a larger timeout_ms; do clicks, typing and waits with those tools, not in evaluate.')), timeout);
          });
          return Promise.race([run, expired]).finally(() => clearTimeout(timer));
        }, { follow: true });
      } finally {
        if (record.recording) record.scriptClicks(tab, await cursor.drainClicks(tab).catch(() => []));
      }
      // The page went to a local file while the function ran (and maybe back): its result may be read from that file.
      if (tab.localPageAt >= started) throw new Error(`Tab ${tab.id}: it showed a local file while this ran, which FowlBrowser doesn't read, so the result was discarded.`);
      const json = result === undefined ? 'undefined' : JSON.stringify(result, null, 2);
      // With its snapshot (cut at its own max) the whole result still fits what Claude Code takes.
      return `Result:\n${capText(json, args.snapshot ? MAX_CHARS - SNAPSHOT_MAX_CHARS : MAX_CHARS, 'Return less data.')}`;
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
      const started = Date.now();
      const shown = await cursor.isShown(tab);
      if (shown) await cursor.painted(cursor.cue(tab, 'observe'), started);
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await handle?.dispose().catch(() => {});
            handle = null;
            if (args.ref) {
              handle = await locator(tab, args.ref).elementHandle();
              // Never something else (its play() failing would read as refused, and the player gets clicked).
              if (!(await handle.evaluate((el) => el instanceof HTMLMediaElement))) throw new Error(`Ref ${cleanRef(args.ref)} is not a video or audio element.`);
            }
            else {
              const found = await tab.page.evaluateHandle(FIND_MEDIA_FN);
              handle = found.asElement();
              if (!handle) await found.dispose().catch(() => {});
            }
            if (!handle) throw new Error('No video or audio element on this page.');
            ({ refused, status } = await withGesture(tab, () => handle.evaluate(MEDIA_FN, { action: args.action, value: args.value })));
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
          if (status.paused) ({ refused, status } = await withGesture(tab, () => handle.evaluate(MEDIA_FN, { action: 'play' })));
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

  // Entries of the page the tab shows now, unless all_pages: what earlier pages (before a reload or navigation) logged
  // is counted in a line of its own, so stale errors are never read as the current page's.
  const allPagesArg = z.boolean().optional().describe('Also show entries from earlier pages of this tab (before its last reload or navigation).');
  const ofPage = (tab, entries, allPages) => {
    const current = allPages ? entries : entries.filter((e) => e.page === tab.documentGeneration);
    const older = entries.length - current.length;
    return { current, note: older ? `(${older} from earlier pages of this tab left out; all_pages: true shows them)` : '' };
  };
  tool('console', 'Recent console messages and uncaught errors of the page the tab shows now (captured since this session started controlling it).',
    { tab: tabArg, level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level (default info).'),
      limit: z.number().int().positive().optional().describe('Most recent N (default 50).'), all_pages: allPagesArg },
    withTab(manager, async (tab, { level = 'info', limit = 50, all_pages: allPages }) => {
      const max = LEVELS[level];
      const { current, note } = ofPage(tab, tab.console.filter((m) => (LEVELS[m.level] ?? 3) <= max), allPages);
      const lines = current.slice(-limit).map((m) => `[${m.level}] ${m.text}${m.url ? ` (${m.url})` : ''}`);
      return text([await header(tab), lines.length ? cap(lines.join('\n'), 'Lower limit.') : 'No console messages on this page.', note].filter(Boolean).join('\n'));
    }));

  tool('network', 'Recent network requests of the page the tab shows now (method, status, type, URL), captured since this session started controlling it.',
    { tab: tabArg, filter: z.string().optional().describe('Substring of the URL, or /regex/.'),
      limit: z.number().int().positive().optional().describe('Most recent N (default 50).'), all_pages: allPagesArg },
    withTab(manager, async (tab, { filter, limit = 50, all_pages: allPages }) => {
      const regex = filter?.match(/^\/(.+)\/([a-z]*)$/);
      const test = !filter ? () => true : regex ? (u) => new RegExp(regex[1], regex[2]).test(u) : (u) => u.includes(filter);
      const { current, note } = ofPage(tab, tab.network.filter((r) => test(r.url)), allPages);
      const lines = current.slice(-limit).map((r) => `${r.method} ${r.status}${r.failure ? ` ${r.failure}` : ''} ${r.type} ${r.url}`);
      return text([await header(tab), lines.length ? cap(lines.join('\n'), 'Use filter or a lower limit.') : 'No matching requests on this page.', note].filter(Boolean).join('\n'));
    }));

  tool('export', EXPORT_DESCRIPTION, exportShape(tabArg),
    withTab(manager, async (tab, args) => text(`${await header(tab)}\n${await cued(tab, 'observe', () => exportTab(tab, args))}`)));

  registerBrowserData(tool, manager, { click: (args) => handlers.click(args), parseTabId });
  registerPerf(tool, manager, { withTab: (handler) => withTab(manager, handler), header, text, tabArg });
}
