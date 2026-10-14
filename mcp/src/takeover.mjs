// Taking a tab back and handing a tab over (SPEC "Taking a tab back, handing a tab over, viewport (session 5)").
// Only what ends control takes a tab over: the debugger taken away (the debugging bar's Cancel, a browser page) and the
// tab closed. The user's clicks, typing, scrolling and navigations in a tab the agent controls don't: the agent keeps
// working, as in Codex's own extension. Their input is still told from the agent's, since only the server knows when
// the agent acted (every Input.* command the relay forwards for a tab is an agent window; a read, a wait or a queued
// call is none): the extension hears of the user's (tabs.userInput), so a popup their click opens is theirs.
// A taken-over or handed-off tab is parked (extension tabs.park): still this session's, but the user's until the
// agent resumes it with tab_claim {resume: true}. Notices for the agent live here too.
import { AsyncLocalStorage } from 'node:async_hooks';
import { cdp } from './cdp.mjs';
import * as cursor from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { uninstallPopups } from './popups.mjs';
import { tabEvent } from './record.mjs';
import { sleep, tabInfo } from './util.mjs';
import { clearViewport } from './viewport.mjs';

const BEFORE_MS = 50; // an agent window starts this much before its command was sent (clock skew)
const AFTER_MS = 250; // and ends this much after its reply (the page's own handlers, timers)
const SETTLE_MS = 300; // a target_closed detach is judged this much later (a closing tab's removal comes first)
const USER_SETTLED_MS = 500; // a popup waits at most this long for the user's input to be judged (userSettled)
const KEEP_MS = 5000; // finished agent windows kept this long
const CLOSED_BY_PAGE_MS = 3000;
const APP_LINK_MS = 1000; // a link for another app the page asked for this shortly before a detach explains it
const CRASH_MS = 5000;
const ENDING_MS = 30_000;
const THROTTLE_MS = 250;

export const USER_WORLD = 'fowlbrowser-user';
export const USER_BINDING = '__fowlbrowserUserInput';

// Runs in an isolated world of every same-process frame of a controlled tab, from document start (page listeners can't
// hide events from a capture listener on window registered first). Reports trusted input, at most one per type per
// 250 ms, as {type, at}: `at` on the page's wall clock. Cross-origin frames are other processes: a click into one shows
// up as the top window's blur with an iframe focused.
export const USER_SCRIPT = `(() => {
  if (globalThis.__fowlbrowserUser) return;
  globalThis.__fowlbrowserUser = true;
  const last = {};
  const report = (type, event) => {
    if (!event.isTrusted || performance.now() - (last[type] ?? -1e9) < ${THROTTLE_MS}) return;
    last[type] = performance.now();
    // Some synthesized OS events arrive with timeStamp 0 (the page's start): then the handler's own time is the event's.
    const at = event.timeStamp > 0 ? performance.timeOrigin + event.timeStamp : Date.now();
    globalThis.${USER_BINDING}?.(JSON.stringify({ type, at }));
  };
  const modifiers = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);
  const options = { capture: true, passive: true };
  addEventListener('pointerdown', (e) => report('pointerdown', e), options);
  // With Cmd too: Cmd+Enter on a link opens it in a new tab.
  addEventListener('keydown', (e) => { if (!modifiers.has(e.key)) report('keydown', e); }, options);
  if (window !== top) return;
  addEventListener('blur', (e) => setTimeout(() => { if (document.activeElement?.tagName === 'IFRAME') report('frame', e); }), options);
})();`;

// Times the agent acted on a tab: [start, end] per window, end Infinity while it runs.
export class Activity {
  windows = [];

  begin() {
    const window = [Date.now(), Infinity];
    this.windows.push(window);
    return () => {
      window[1] = Date.now();
      this.windows = this.windows.filter(([, end]) => end > window[1] - KEEP_MS);
    };
  }

  covers(at) {
    return this.windows.some(([start, end]) => at >= start - BEFORE_MS && at <= end + AFTER_MS);
  }
}

const inputs = new Map(); // "chrome:52" -> Activity of the relay's Input.* commands for that tab
const records = new Map(); // "chrome:52" -> { kind: 'takeover'|'handoff', at, tabId, how?, reason?, gone? } of parked tabs
const unseen = new Set(); // takeovers no result has told the agent about yet
const ending = new Map(); // "chrome:52" -> when this session started closing or releasing it
const crashed = new Map(); // "chrome:52" -> when its renderer died
const downloaded = new Map(); // "chrome:52" -> when its page last started a download (a new tab then closes for it)
const lastTabs = new Map(); // "chrome:52" -> the Tab it was when its debugger went (its page may close first)
const parking = new Map(); // "chrome:52" -> its takeover's park, or its handoff's cleanup and park, until done
const judging = new WeakMap(); // Tab -> reports of input in it still being judged (onReport), for userSettled
const givenBack = new Set(); // "chrome:52" popups the extension gave back to the user who opened them, for KEEP_MS
const usersInput = new Map(); // "chrome:52" -> when the user's latest input in it was (onReport)
const appLinks = new Map(); // "chrome:52" -> { url, at } of the page's latest navigation to a link for another app
const reattached = new Map(); // "chrome:52" -> notice: attached again after a link for another app, not told yet
const recovering = new Map(); // "chrome:52" -> a detach after a link for another app, until judged and attached again
const calls = new AsyncLocalStorage(); // the tool call code runs for: { tabKey, onParked } (see inCall)

const keyOf = (browser, tabId) => `${browser.key}:${tabId}`;
const recently = (map, key, ms) => Date.now() - (map.get(key) ?? -Infinity) <= ms;
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

// Whether input in the page around `at` was the agent's: an Input.* command the relay forwarded for the tab (clicks,
// keys, Playwright's fill and insertText, the keyboard on closed-shadow refs) was in flight then.
export function agentInput(browser, tabId, at) {
  return !!inputs.get(keyOf(browser, tabId))?.covers(at);
}

// Whether the extension just gave this tab back to the user who opened it (no action of the agent's opened it).
export const wasGivenBack = (key) => givenBack.has(key);

// Resolves once every report of input in the tab still being judged is done (the extension has heard of the user's
// by then), at most USER_SETTLED_MS later: a popup asks the extension whose it is only after that (popups.mjs).
export async function userSettled(tab) {
  const pending = judging.get(tab);
  if (!pending?.size) return;
  let timer;
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => { timer = setTimeout(resolve, USER_SETTLED_MS); })])
    .finally(() => clearTimeout(timer));
}

// --- Notices ---

export function notice(key) {
  const record = records.get(key);
  if (!record) return null;
  if (record.kind === 'handoff') {
    return `You handed ${key} to the user at ${clock(record.at)} (${record.reason}); wait until they say they are done, then tab_claim it with resume: true.`;
  }
  return `The user took over ${key} at ${clock(record.at)} (${record.how}). Stop working in that tab, tell the user where you got to, and ask before going on.` +
    (record.gone ? '' : ' If they say to carry on there, call tab_claim on it with resume: true.');
}

export const parked = (key) => records.get(key) ?? null;

// Whether this session has a tab in that browser parked, or being parked.
export const hasParked = (browserKey) => [...records.keys(), ...parking.keys()].some((key) => key.startsWith(`${browserKey}:`));

// A takeover of this tab that happened after `since` (a call running on it then gets the notice instead of its result).
export function takenOverSince(key, since) {
  const record = records.get(key);
  return record?.kind === 'takeover' && record.at >= since ? notice(key) : null;
}

// The start of the next result of any other tool tells the agent about takeovers it has not heard of, once each
// (calls naming the taken-over tab get its notice anyway, every time). A tab attached again after a link for another
// app is told about once, in the next result of any tool.
export function withNotices(result, tabKey) {
  const keys = [...unseen].filter((key) => key !== tabKey);
  if (!keys.length && !reattached.size) return result;
  for (const key of keys) unseen.delete(key);
  const first = result.content?.find((c) => c.type === 'text');
  const lines = [...keys.map(notice), ...reattached.values()].filter(Boolean);
  reattached.clear();
  if (!lines.length) return result;
  if (first) first.text = `${lines.join('\n')}\n${first.text}`;
  else result.content = [{ type: 'text', text: lines.join('\n') }, ...(result.content ?? [])];
  return result;
}

// Resolves once every detach after a link for another app is judged and its tab attached and mapped again (or taken
// over): a turn end waits for them, else it would find the tab unmapped and leave this turn's work tab open. Null when
// none is under way.
// { keys, done } of the app-link recoveries under way now, or null.
export const recoveries = () => (recovering.size ? { keys: [...recovering.keys()], done: Promise.allSettled([...recovering.values()]) } : null);

// Waits for a park in progress (a resume must not reach the extension before it).
export async function settled(key) {
  await parking.get(key)?.catch(() => {});
}

// Runs a tool call's handler; `onParked`: the tool still works on a parked tab (tools.mjs ON_PARKED_TABS).
export const inCall = (call, fn) => calls.run(call, fn);

// Tab.run, right before a queued call starts: one queued before its tab was parked fails with the notice now.
export const currentCall = () => calls.getStore();
export function refuseParked(tab, call = currentCall()) {
  const parked = call?.tabKey === tab.id && !call.onParked && notice(tab.id);
  if (parked) throw new Error(parked);
}

// Chrome swapped the tab for another id (prerender, back/forward cache): a parked one stays parked under it, a handoff
// still under way parks the new id (record.tabId), and nothing attaches the new id while a park is under way (heldBack).
function moveRecord(from, to, toId) {
  const record = records.get(from);
  if (!record) return;
  records.set(to, record);
  records.delete(from);
  record.tabId = toId;
  if (unseen.delete(from)) unseen.add(to);
  if (parking.has(from)) {
    parking.set(to, parking.get(from));
    parking.delete(from);
  }
}

// The extension announcing a tab whose park is still under way (a swapped one): the relay must not attach it.
export const heldBack = (browser, tabId) => parking.has(keyOf(browser, tabId));

// Control ended (released, closed, resumed): the tab's parked state and notice go.
export function forget(key) {
  records.delete(key);
  unseen.delete(key);
}

// This session is closing or releasing the tab: its removal is ours, not the user's.
export function markEnding(key) {
  ending.set(key, Date.now());
}

// --- Parking ---

// The user took the tab over (its debugger went, or it closed): noted at once (so every later signal and call sees it),
// parked, journaled. Nothing is cleaned up in the page: without the debugger nothing reaches it (the cursor overlay
// fades on its own idle timer, the popup scripts switch themselves off).
export async function takeOver(browser, tabId, how, { tab = browser.tabs.get(tabId), gone = false } = {}) {
  const key = keyOf(browser, tabId);
  if (records.has(key) || browser.host.closed) return;
  records.set(key, { kind: 'takeover', at: Date.now(), tabId, how, gone });
  unseen.add(key);
  debug('takeover', key, how);
  const url = tab?.page.url();
  if (!gone) {
    await park(key, () => browser.host.request('tabs.park', { tabId, kind: 'takeover' }))
      .catch((error) => debug('park failed', key, error.message));
  }
  tabEvent('takeover', key, url, { how });
}

// tab_handoff: the cursor fades, a viewport override goes, then the tab is parked for the user. Runs in the tab's queue.
export async function handOff(tab, reason) {
  const key = tab.id;
  const record = { kind: 'handoff', at: Date.now(), tabId: tab.tabId, reason };
  records.set(key, record);
  try {
    await park(key, async () => {
      await cursor.remove(tab, { wait: true });
      await uninstallPopups(tab);
      await clearViewport(tab, 'handoff').catch(() => {});
      await tab.browser.host.request('tabs.park', { tabId: record.tabId, kind: 'handoff' });
    });
  } catch (error) {
    // A park can fail after it took effect (an ungroup refused while the user drags a tab): then the record stays.
    const now = await tabInfo(tab.browser, record.tabId).catch(() => null);
    if (!now?.parked && records.get(key) === record) records.delete(key);
    throw error;
  }
  tabEvent('handoff', key, tab.page.url(), { reason });
}

// Runs a tab's way to being parked, which a resume waits for (settled).
function park(key, work) {
  const done = work().finally(() => { for (const [k, p] of parking) if (p === done) parking.delete(k); });
  parking.set(key, done);
  return done;
}

// --- Signals ---

// Installs the page listener in a tab that came under control (Browser._adopt).
export async function watchUserInput(tab) {
  tab.on('binding', (name, payload) => {
    if (name !== USER_BINDING) return;
    if (!judging.has(tab)) judging.set(tab, new Set());
    const pending = judging.get(tab);
    const judged = onReport(tab, payload).catch((e) => debug('user input', e.message)).finally(() => pending.delete(judged));
    pending.add(judged);
  });
  await cdp(tab, 'Runtime.addBinding', { name: USER_BINDING, executionContextName: USER_WORLD });
  await cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: USER_SCRIPT, worldName: USER_WORLD, runImmediately: true });
}

// Input the user made in the tab goes to the extension (tabs.userInput), which then knows that a popup it opens is
// theirs. The tab stays the agent's.
async function onReport(tab, payload) {
  let report;
  try { report = JSON.parse(payload); } catch { return; }
  const { browser, tabId } = tab;
  if (records.has(tab.id) || agentInput(browser, tabId, report.at)) return;
  // Focus moving into an iframe has no Input.* command behind it when the agent's fill or focus moves it (through the DOM):
  // while a call runs on the tab, that one signal is the agent's. Clicks, keys and wheel are judged by input alone.
  if (report.type === 'frame' && tab.busy) return;
  // Agent input is trusted too; only input in the tab the user is looking at, in the window they are in, can be theirs.
  const seen = await browser.host.request('tabs.isShown', { tabId }).catch(() => null);
  if (!seen?.shown || !seen.focused || agentInput(browser, tabId, report.at)) return;
  usersInput.set(tab.id, Math.max(usersInput.get(tab.id) ?? 0, Math.min(Number(report.at) || Date.now(), Date.now())));
  await browser.host.request('tabs.userInput', { tabId, at: report.at }).catch((error) => {
    if (!/unknown method/i.test(error.message)) debug('tabs.userInput failed', error.message); // an older extension
  });
}

// Extension events of a browser. Registered before the relay's handler, so the tab is still known to the model when
// its removal comes in.
export function watchTakeovers(browser) {
  browser.relay.onInput = (tabId, method, params) => {
    const key = keyOf(browser, tabId);
    if (!inputs.has(key)) inputs.set(key, new Activity());
    const done = inputs.get(key).begin();
    browser.tabs.get(tabId)?.emit('input', method, params); // as it is sent: the cursor's click feedback (tools.mjs pointed)
    return done;
  };
  browser.host.on('event', (method, params) => {
    if (browser.host.closed) return; // drained after the connection ended: its tabs are no longer this session's
    if (method === 'chrome.debugger.onDetach') onDetach(browser, params?.[0]?.tabId, params?.[1]).catch((e) => debug('takeover: detach', e.message));
    else if (method === 'chrome.tabs.onRemoved') onRemoved(browser, params?.[0], params?.[1]).catch((e) => debug('takeover: removed', e.message));
    else if (method === 'chrome.debugger.onEvent') {
      const [source, cdpMethod, cdpParams] = params ?? [];
      if (!source?.sessionId && cdpMethod === 'Inspector.targetCrashed') crashed.set(keyOf(browser, source?.tabId), Date.now());
      else if (!source?.sessionId && cdpMethod === 'Page.downloadWillBegin') downloaded.set(keyOf(browser, source?.tabId), Date.now());
      else if (!source?.sessionId && cdpMethod === 'Page.frameRequestedNavigation' && appLink(cdpParams?.url)) {
        appLinks.set(keyOf(browser, source?.tabId), { url: cdpParams.url, at: Date.now() });
      }
    }
  });
  // The connection ended (the browser quit, the extension reloaded): none of its tabs is this session's any more, and a
  // browser restart numbers tabs from the start again, so its records must not hold a new tab of the same id.
  browser.host.on('close', () => {
    for (const map of [records, unseen, parking, ending, inputs, crashed, downloaded, lastTabs, givenBack, usersInput, appLinks, reattached]) {
      for (const key of map.keys()) if (key.startsWith(`${browser.key}:`)) map.delete(key);
    }
  });
}

const BROWSER_PAGE = /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|brave|about):/;
// A link the browser hands to another app (mailto:, tel:, zoommtg:, slack:...): neither a web page nor a browser page.
const appLink = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url ?? '') && !BROWSER_PAGE.test(url)
  && !/^(https?|data|blob|javascript|file|filesystem|view-source|wss?):/i.test(url);

async function onDetach(browser, tabId, reason) {
  const key = keyOf(browser, tabId);
  if (reason === 'parked' || records.has(key)) return;
  const detachedAt = Date.now();
  const tab = browser.tabs.get(tabId);
  const url = tab?.page.url();
  const link = Date.now() - (appLinks.get(key)?.at ?? -Infinity) <= APP_LINK_MS ? appLinks.get(key).url : null;
  appLinks.delete(key);
  lastTabs.set(key, tab);
  setTimeout(() => lastTabs.delete(key), CLOSED_BY_PAGE_MS).unref();
  if (reason === 'canceled_by_user') return takeOver(browser, tabId, 'pressed Cancel on the browser\'s debugging bar', { tab });
  // target_closed: the tab closed (onRemoved follows), its renderer died, it went to a page the debugger may not stay
  // on, or its page asked for a link for another app (the browser lets the debugger go as that navigation starts,
  // though it never leaves the page).
  if (reason !== 'target_closed' || recently(crashed, key, CRASH_MS)) return;
  const judged = (async () => {
    await sleep(SETTLE_MS);
    if (records.has(key)) return;
    const info = await tabInfo(browser, tabId).catch(() => null);
    if (info?.owner !== 'you' || info.parked) return;
    // The page's link for another app, on the same page, with no input of the user's behind it: still the agent's tab.
    // Input reports still being judged (their tabs.isShown can be slow) are waited for; one still unjudged then counts
    // as the user's.
    if (link && url && info.url === url) {
      await userSettled(tab);
      if (records.has(key)) return;
      // The user's input near the detach, however long the checks above took.
      if (!judging.get(tab)?.size && !((usersInput.get(key) ?? -Infinity) >= detachedAt - KEEP_MS) && await reattach(browser, tabId, link, url, tab)) return;
    }
    const how = BROWSER_PAGE.test(info.url) && info.url !== 'about:blank' ? `opened a browser page (${info.url.slice(0, 60)})` : 'took the tab out of the agent\'s control';
    await takeOver(browser, tabId, how, { tab });
  })();
  if (link) {
    recovering.set(key, judged);
    judged.catch(() => {}).finally(() => { if (recovering.get(key) === judged) recovering.delete(key); });
  }
  await judged;
}

// Attached again (a new page for Playwright, so refs start over), told once in the next result. False when it does
// not come back: then it is a takeover as any other detach.
// old: the Tab from before the detach, whose page log carries over.
async function reattach(browser, tabId, link, url, old) {
  const key = keyOf(browser, tabId);
  try {
    await browser.relay.model.reattach(tabId);
  } catch (error) {
    debug('reattach failed', key, error.message);
    return false;
  }
  debug('reattached', key, link);
  reattached.set(key, `The page in ${key} opened ${link.slice(0, 80)}, a link for another app (if one is installed), and the browser let go ` +
    'of the tab for it. FowlBrowser attached again: the tab is still yours, on the same page, but refs from before are void, so call snapshot.');
  tabEvent('reattach', key, url, { link });
  const next = await browser.waitForTab(tabId).catch(() => null); // mapped again (recoveries)
  // The same page: what it logged and loaded before is still this page's (console, network), and older pages' stay older.
  if (old && next && next !== old) {
    const restamp = (entries) => entries.map((e) => ({ ...e, page: e.page === old.documentGeneration ? next.documentGeneration : -1 }));
    next.console = [...restamp(old.console), ...next.console];
    next.network = [...restamp(old.network), ...next.network];
  }
  return true;
}

async function onRemoved(browser, tabId, removeInfo) {
  const key = keyOf(browser, tabId);
  const tab = browser.tabs.get(tabId) ?? lastTabs.get(key);
  // Only a tab this session controlled: a popup announced but closed before it was attached and mapped (Chrome closes a
  // new tab whose first navigation became a download) was never the agent's to take back.
  const known = !!tab;
  const ours = recently(ending, key, ENDING_MS);
  // Chrome closes a new tab whose first navigation became a download (it never showed a page), and the extension a
  // tabs.openChild child likewise.
  const download = recently(downloaded, key, CLOSED_BY_PAGE_MS) && ['', 'about:blank'].includes(tab?.page.url());
  for (const map of [inputs, ending, crashed, downloaded, usersInput, appLinks, reattached]) map.delete(key);
  if (removeInfo?.usersPopup) { // still open: a popup the extension gave back to the user who opened it
    givenBack.add(key);
    setTimeout(() => givenBack.delete(key), KEEP_MS).unref();
    return;
  }
  if (removeInfo?.replacedBy !== undefined) return moveRecord(key, keyOf(browser, removeInfo.replacedBy), removeInfo.replacedBy);
  if (records.get(key)?.kind === 'handoff') return forget(key); // the user closed what they were handed
  if (!known || records.has(key) || ours || download) return;
  if (Date.now() - (tab?.closedByPageAt ?? -Infinity) <= CLOSED_BY_PAGE_MS) return; // the page closed itself
  await takeOver(browser, tabId, 'closed the tab', { tab, gone: true });
}
