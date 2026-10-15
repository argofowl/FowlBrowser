// The on-page agent cursor (docs/cursor-spec.md): shows the user where an agent is about to act, only in a tab they can
// see. The overlay (overlay.js) lives in an isolated world of the tab's top frame, injected through the tab's
// debugger session once per document. Everything here is best effort: errors only go to debug(), and no call
// delays an action beyond ARRIVAL_CAP_MS plus LAND_CAP_MS, plus CUE_WAIT_MS for an action shown with a cue.
import fs from 'node:fs';
import { LABEL } from '../browsers.mjs';
import { debug } from '../debug.mjs';
import { recording } from '../record.mjs';

const SOURCE = fs.readFileSync(new URL('./overlay.js', import.meta.url), 'utf8');
const WORLD = 'fowlbrowser-cursor';
export const ARRIVAL_CAP_MS = 900; // the longest move is 850 ms (overlay.js MAX_MOVE_MS)
const LAND_CAP_MS = 150;
export const CUE_WAIT_MS = 120; // an action waits this long at most for its cue to be painted (painted())
const SHOWN_CAP_MS = 700;
const HIDE_CAP_MS = 400;
const REMOVE_CAP_MS = 400; // exit animation (200 ms) plus a round trip
const DRAIN_CAP_MS = 300;
const ARRIVAL_MARGIN_MS = 60; // the overlay arrives this much before the cap, so its reply is back in time

const states = new Map(); // Tab -> { generation, world: Promise<contextId>, last: {x, y} | null }
const capturing = new Map(); // Tab -> screenshots under way: no cursor may appear meanwhile

function send(tab, method, params = {}) {
  return tab.browser.host.request('chrome.debugger.sendCommand', [{ tabId: tab.tabId }, method, params]);
}

function capped(promise, ms) {
  let timer;
  return Promise.race([promise.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
}

// Whether the user can see the tab: the active tab of a normal, non-minimized window. Older extensions don't know
// the command; then nothing is shown.
const lastShown = new WeakMap(); // Tab -> the last answer isShown got
export async function isShown(tab) {
  if (recording) return true; // record mode: every tab this session controls, background tabs too
  let shown = false;
  try {
    // A slow answer (window change, busy extension) counts as not shown, so the cursor never holds up an action.
    const answer = tab.browser.host.request('tabs.isShown', { tabId: tab.tabId });
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, SHOWN_CAP_MS, null); });
    shown = (await Promise.race([answer, late]).finally(() => clearTimeout(timer)))?.shown === true;
  } catch (error) {
    debug('cursor: isShown failed', error.message);
  }
  lastShown.set(tab, shown);
  return shown;
}

// Whether the tab was shown when last asked (undefined: never asked). A tab that wasn't doesn't wait for its answer
// before an action: a background tab costs nothing.
export const wasShown = (tab) => (recording ? true : lastShown.get(tab));

// The isolated world of the tab's current document, with the overlay evaluated in it (created once per document).
function world(tab, { create = true } = {}) {
  let state = states.get(tab);
  if (state?.generation === tab.documentGeneration && state.world) return state.world;
  if (!create) return null;
  const generation = tab.documentGeneration;
  if (!state) tab.page.once('close', () => states.delete(tab));
  state = { last: state?.last ?? null, generation };
  state.world = (async () => {
    const { frameTree } = await send(tab, 'Page.getFrameTree');
    const { executionContextId } = await send(tab, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD });
    const result = await send(tab, 'Runtime.evaluate', { expression: SOURCE, contextId: executionContextId });
    if (result?.exceptionDetails) throw new Error(`overlay failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return executionContextId;
  })();
  state.world.catch(() => { if (states.get(tab) === state) state.world = null; });
  states.set(tab, state);
  return state.world;
}

// Gets the overlay's world ready for the tab's current document (a tab coming under control, a new document in it),
// only where the cursor would show, so the first action on a page finds it there. Shows nothing. Fire and forget.
export function prepare(tab) {
  isShown(tab).then((shown) => { if (shown) world(tab); });
}

// The browser's zoom for the page (the user's Cmd-minus or Cmd-plus; 0.8 at 80%): the overlay draws the cursor that much
// bigger or smaller, so it keeps its size on screen. Asked at most every 2 s per tab, alongside the target lookup.
const ZOOM_TTL_MS = 2000;
const zooms = new Map(); // Tab -> { at, value: Promise<number> }
function zoomOf(tab) {
  const known = zooms.get(tab);
  if (known && Date.now() - known.at < ZOOM_TTL_MS) return known.value;
  const value = send(tab, 'Page.getLayoutMetrics').then((m) => m?.cssVisualViewport?.zoom || 1, () => 1);
  if (!known) tab.page.once('close', () => zooms.delete(tab));
  zooms.set(tab, { at: Date.now(), value });
  return value;
}

// Calls __fbCursor.<expression> in the overlay's world. A document that went away under us (the navigation
// event not seen yet) gets a fresh world once.
async function call(tab, expression, { create = true, wait = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const contextId = await world(tab, { create });
    if (contextId === undefined || contextId === null) return undefined;
    try {
      const reply = await send(tab, 'Runtime.evaluate', { expression: `globalThis.__fbCursor.${expression}`, contextId, awaitPromise: wait, returnByValue: true });
      if (reply?.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
      return reply?.result?.value;
    } catch (error) {
      if (attempt || !create || !/context|not found|destroyed|navigated|closed/i.test(error.message)) throw error;
      const state = states.get(tab);
      if (state) state.world = null;
    }
  }
}

// Moves the cursor to a viewport point (CSS px) and waits for it to arrive, at most ARRIVAL_CAP_MS in all, then
// lands it (overlay land(): tip on the target, fully shown) within LAND_CAP_MS.
// `where` is a point, optionally with the target's box size {x, y, w, h}, or a function returning one (null:
// nothing to point at). Returns the point the cursor was sent to, else null.
// A target found after the budget is shown at once (no travel) while `acting` (the action's promise) is unsettled;
// onLate(point) then hears of it. Without `acting` it is dropped.
export async function moveTo(tab, where, budgetMs = ARRIVAL_CAP_MS, { acting, onLate } = {}) {
  if (capturing.get(tab)) return null;
  // The overlay fits its travel into the time left (page and server share the wall clock).
  const until = Date.now() + budgetMs - ARRIVAL_MARGIN_MS;
  let late = false; // the action has gone ahead without the cursor
  let over = false; // ... and is done: a target found now is not shown
  acting?.finally(() => { over = true; }).catch(() => {});
  let sent = null;
  world(tab); // made while the target is looked up
  const zooming = zoomOf(tab); // and the browser's zoom
  const work = (async () => {
    const point = typeof where === 'function' ? await where() : where;
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const opts = { label: LABEL, from: states.get(tab)?.last ?? null, w: point.w, h: point.h, until, zoom: await zooming };
    if (late) {
      if (!acting || over || capturing.get(tab)) return;
      onLate?.(point);
      states.get(tab).last = { x: point.x, y: point.y };
      await call(tab, `land(${point.x}, ${point.y}, ${JSON.stringify(opts)})`);
      return;
    }
    sent = point;
    const arrived = call(tab, `move(${point.x}, ${point.y}, ${JSON.stringify(opts)})`, { wait: true });
    states.get(tab).last = { x: point.x, y: point.y };
    await arrived;
  })();
  work.catch((error) => debug('cursor: move failed', tab.id, error.message));
  await capped(work, budgetMs);
  late = true;
  // Busy page: travel or the appear fade may be behind. Runs in the page before the action's input events.
  if (sent && !capturing.get(tab)) await capped(call(tab, `land(${sent.x}, ${sent.y}, ${JSON.stringify({ label: LABEL })})`), LAND_CAP_MS);
  return sent;
}

// Record mode: what the overlay shows now (overlay.js state()), and the script clicks it showed since the last drain.
export function state(tab) {
  return call(tab, 'state()', { create: false });
}

export async function drainClicks(tab) {
  return (await capped(call(tab, 'drainClicks()', { create: false }), DRAIN_CAP_MS)) ?? [];
}

// Shows the cursor where it last was (or at its rest point) with an action cue beside the tip: observe, scroll,
// text, key, navigate, drag, transfer. Looping cues run until cueEnd. Resolves once the overlay has painted the word
// (it answers two frames after the call, within 100 ms), never rejects; callers that don't wait for it ignore it.
// A tab's cue calls go out one after another, in the order they were made: a cue waits for the zoom, and an end
// sent before an earlier cue arrived would end the next one instead.
const cues = new WeakMap(); // Tab -> the last cue call on its way
const inTurn = (tab, send, failed) => {
  const next = Promise.resolve(cues.get(tab)).then(send).catch((error) => debug(failed, tab.id, error.message));
  cues.set(tab, next);
  return next;
};
export function cue(tab, kind) {
  if (capturing.get(tab)) return Promise.resolve(false); // a late cue of an earlier action would land in the screenshot
  world(tab); // made while the zoom is read
  const zoom = zoomOf(tab);
  return inTurn(tab, async () => {
    const opts = { label: LABEL, from: states.get(tab)?.last ?? null, zoom: await zoom };
    if (!capturing.get(tab)) return call(tab, `cue(${JSON.stringify(kind)}, ${JSON.stringify(opts)})`, { wait: true });
  }, 'cursor: cue failed');
}

// An action shown with a cue starts once the cue is painted, so the word is on screen before an action that keeps the
// page's main thread busy (a snapshot of a big page) holds back every frame; at most CUE_WAIT_MS after `since`.
export function painted(cueing, since = Date.now()) {
  return capped(cueing, CUE_WAIT_MS - (Date.now() - since));
}

// While on, the overlay shows clicks a page script makes (an agent's evaluate) as cursor travel and clicks, and in
// record mode keeps them for drainClicks. Resolves once the overlay has the call.
export function follow(tab, on) {
  if (on ? capturing.get(tab) : !world(tab, { create: false })) return;
  return call(tab, `follow(${on === true}, ${recording})`, { create: on === true }).catch((error) => debug('cursor: follow failed', tab.id, error.message));
}

export function cueEnd(tab) {
  if (!world(tab, { create: false })) return;
  inTurn(tab, () => call(tab, 'cueEnd()', { create: false }), 'cursor: cue end failed');
}

// Click feedback where the cursor was last sent (it jumps there if it hasn't arrived). Fire and forget.
export function click(tab) {
  if (!world(tab, { create: false })) return;
  const at = states.get(tab)?.last;
  call(tab, at ? `click(${at.x}, ${at.y})` : 'click()', { create: false }).catch((error) => debug('cursor: click failed', tab.id, error.message));
}

// Runs fn (an agent screenshot) with the overlay hidden, so the capture shows only the page.
export async function hideForCapture(tab, fn) {
  capturing.set(tab, (capturing.get(tab) ?? 0) + 1);
  try {
    return await hideDuring(tab, fn);
  } finally {
    if (capturing.get(tab) > 1) capturing.set(tab, capturing.get(tab) - 1);
    else capturing.delete(tab);
  }
}

async function hideDuring(tab, fn) {
  if (!world(tab, { create: false })) return fn();
  // A slow hide must not hold up the capture: after HIDE_CAP_MS it goes ahead (the cursor may then be in it).
  const hidden = await capped(call(tab, 'capture(true)', { create: false }).catch((error) => {
    debug('cursor: hide for capture failed', tab.id, error.message);
    return false;
  }), HIDE_CAP_MS);
  try {
    return await fn();
  } finally {
    // Also after a late hide: it lands before this call, so the cursor never stays hidden. Not while another capture
    // of this tab still runs (one held by a dialog, then the next call's): the last one shows it.
    if (hidden !== false && !(capturing.get(tab) > 1)) call(tab, 'capture(false)', { create: false }).catch((error) => debug('cursor: show after capture failed', tab.id, error.message));
  }
}

// Plays the exit animation and removes the overlay (tab released or closed, session ending).
export async function remove(tab, { wait = true } = {}) {
  const had = world(tab, { create: false });
  states.delete(tab);
  if (!had) return;
  const removing = (async () => {
    const contextId = await had;
    await send(tab, 'Runtime.evaluate', { expression: 'globalThis.__fbCursor.hide()', contextId, awaitPromise: true });
  })();
  removing.catch((error) => debug('cursor: remove failed', tab.id, error.message));
  if (wait) await capped(removing, REMOVE_CAP_MS);
}

// Session end: every overlay this process showed goes away.
export function removeAll() {
  return Promise.all([...states.keys()].map((tab) => remove(tab)));
}
