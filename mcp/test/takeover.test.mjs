// Takeover and handoff (src/takeover.mjs and the tools around it) against doubles: the user's input told from the
// agent's (it only goes to the extension; the tab stays the agent's), the signals that still take a tab over (detach,
// close), the notices agents get, tab_handoff, tab_claim with resume, tab_list and turn end.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Browser, Tab } from '../src/browsers.mjs';
import { installPopups, POPUP_BINDING } from '../src/popups.mjs';
import { Activity, agentInput, markEnding, USER_BINDING, userSettled, wasGivenBack, watchTakeovers, watchUserInput } from '../src/takeover.mjs';
import { registerTools } from '../src/tools.mjs';
import { endTurn } from '../src/turns.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (at) => new Date(at).toTimeString().slice(0, 5);

function fakePage(url = 'https://shop.example/checkout') {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => url, isClosed: () => false,
    mainFrame: () => page, ariaSnapshot: async () => '- button "Pay now" [ref=e1]',
  });
  return page;
}

let browsers = 0;
// A browser (its own key per test: takeover state is per "<browser>:<id>") with mapped tabs `ids`, whose extension
// answers isShown with `seen` and tabs.listAll with `listed`, and other methods with `answers` (method -> fn(params)).
// `hold`: requests (by method, or CDP method for sendCommand) wait on these promises before they are answered.
async function fakeBrowser({ ids = [1], seen = { shown: true, focused: true }, listed = () => [], hold = {}, answers = {} } = {}) {
  const requests = [];
  const host = Object.assign(new EventEmitter(), {
    async request(method, params) {
      requests.push([method, params]);
      await hold[method === 'chrome.debugger.sendCommand' ? params[1] : method];
      if (answers[method]) return answers[method](params);
      if (method === 'tabs.isShown') return seen;
      if (method === 'tabs.listAll') return listed();
      if (method === 'tabs.info') return listed().find((t) => t.id === params.tabId) ?? null;
      if (method === 'tabs.claim') return { id: params.tabId };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Checkout' } };
      if (method === 'chrome.debugger.sendCommand' && params[1] !== 'Runtime.addBinding' && params[1] !== 'Page.addScriptToEvaluateOnNewDocument'
        && params[1] !== 'Emulation.clearDeviceMetricsOverride') throw new Error('not in this double');
      return {};
    },
  });
  const known = new Set(ids);
  const browser = {
    key: `chrome-t${++browsers}`, name: 'Chrome', host, tabs: new Map(), adopting: new Map(), requests,
    relay: { viewports: new Map(), model: { hasTab: (id) => known.has(id), isAttached: () => true, onTabCreated() {}, _knownTabs: new Map() } },
    async playwright() {}, async waitForTab(id) { return this.tabs.get(id); }, forget(id) { known.delete(id); this.tabs.delete(id); },
  };
  watchTakeovers(browser);
  for (const id of ids) {
    const tab = new Tab(browser, id, fakePage());
    browser.tabs.set(id, tab);
    await watchUserInput(tab);
  }
  return browser;
}

function toolsFor(browser) {
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name](args);
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return call;
}

const parks = (browser) => browser.requests.filter(([m]) => m === 'tabs.park').map(([, p]) => p);
const userInputs = (browser) => browser.requests.filter(([m]) => m === 'tabs.userInput').map(([, p]) => p);
const report = (tab, type, at) => tab.emit('binding', USER_BINDING, JSON.stringify({ type, at }));
const detach = (browser, tabId, reason = 'canceled_by_user') => browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId }, reason]);

test('agent windows: relayed input covers [sent - 50, replied + 250] ms', async () => {
  const activity = new Activity();
  const done = activity.begin();
  const start = Date.now();
  assert.ok(activity.covers(start - 40) && activity.covers(start + 60_000), 'while it runs');
  assert.ok(!activity.covers(start - 80));
  await sleep(20);
  done();
  const end = activity.windows[0][1];
  assert.ok(activity.covers(end + 240) && !activity.covers(end + 270));

  const browser = await fakeBrowser({ ids: [4] });
  const input = browser.relay.onInput(4, 'Input.dispatchKeyEvent', { type: 'keyDown' });
  assert.ok(agentInput(browser, 4, Date.now()));
  input();
  assert.ok(!agentInput(browser, 4, Date.now() + 400));
  assert.ok(!agentInput(browser, 5, Date.now()), 'other tabs are not covered');
});

test('the user\'s input in the page goes to the extension outside the input the agent sends, in the shown tab of the focused window; the tab stays the agent\'s', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const tab = browser.tabs.get(1);
  const input = browser.relay.onInput(1, 'Input.dispatchMouseEvent', { type: 'mousePressed' });
  report(tab, 'pointerdown', Date.now());
  await sleep(10);
  assert.deepEqual(userInputs(browser), [], 'during the agent\'s input');
  input();
  report(tab, 'pointerdown', Date.now() + 100);
  await sleep(10);
  assert.deepEqual(userInputs(browser), [], 'right after it');

  const unfocused = await fakeBrowser({ ids: [1], seen: { shown: true, focused: false } });
  report(unfocused.tabs.get(1), 'keydown', Date.now() - 5000);
  const background = await fakeBrowser({ ids: [1], seen: { shown: false, focused: false } });
  report(background.tabs.get(1), 'pointerdown', Date.now() - 5000);
  await sleep(10);
  assert.deepEqual(userInputs(unfocused), [], 'window not focused');
  assert.deepEqual(userInputs(background), [], 'a background tab');

  const at = Date.now() + 1000;
  for (const type of ['keydown', 'frame']) report(tab, type, at);
  await sleep(10);
  assert.deepEqual(userInputs(browser), [{ tabId: 1, at }, { tabId: 1, at }]);
  assert.deepEqual(parks(browser), [], 'no takeover');
  const result = await toolsFor(browser)('console', { tab: `${browser.key}:1` });
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /took over/);
  assert.ok(!browser.requests.some(([m, p]) => m === 'chrome.debugger.sendCommand' && p[1] === 'Emulation.clearDeviceMetricsOverride'), 'the viewport stays');
});

test('a read or wait running on the tab, or calls queued behind it, do not make the user\'s input the agent\'s; nothing fails', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const tab = browser.tabs.get(1);
  const call = toolsFor(browser);
  let finish;
  const waiting = tab.run(() => new Promise((resolve) => { finish = resolve; })); // e.g. wait_for seconds: 120
  const queued = call('console', { tab: `${browser.key}:1` });
  await sleep(10);
  const at = Date.now();
  report(tab, 'pointerdown', at);
  await sleep(10);
  assert.deepEqual(userInputs(browser), [{ tabId: 1, at }], 'the user\'s while the call ran');
  finish();
  await waiting;
  const result = await queued;
  assert.equal(result.error, false, result.text);
  assert.deepEqual(parks(browser), []);
});

test('an older extension without tabs.userInput changes nothing; userSettled waits for input still being judged, at most 500 ms', async () => {
  const old = await fakeBrowser({ ids: [1], answers: { 'tabs.userInput': () => { throw new Error('Unknown method: tabs.userInput'); } } });
  report(old.tabs.get(1), 'pointerdown', Date.now());
  await userSettled(old.tabs.get(1));
  assert.equal(userInputs(old).length, 1);
  assert.equal((await toolsFor(old)('console', { tab: `${old.key}:1` })).error, false);

  const [judged, judge] = gate();
  const browser = await fakeBrowser({ ids: [1, 2], hold: { 'tabs.isShown': judged } });
  const tab = browser.tabs.get(1);
  await userSettled(tab); // nothing to wait for
  report(tab, 'pointerdown', Date.now());
  let settled = false;
  const settling = userSettled(tab).then(() => { settled = true; });
  await sleep(20);
  assert.equal(settled, false, 'its report is still being judged');
  await userSettled(browser.tabs.get(2)); // other tabs have nothing to wait for
  judge();
  await settling;
  assert.equal(userInputs(browser).length, 1, 'the extension heard of it first');

  const stuck = await fakeBrowser({ ids: [1], hold: { 'tabs.isShown': new Promise(() => {}) } });
  report(stuck.tabs.get(1), 'pointerdown', Date.now());
  const started = Date.now();
  await userSettled(stuck.tabs.get(1));
  const waited = Date.now() - started;
  assert.ok(waited >= 450 && waited < 1000, `capped: ${waited} ms`);
});

test('notices: once at the start of the next result of any other tool, and on every call of the taken-over tab', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  const call = toolsFor(browser);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'takeover' }]);
  const notice = `The user took over ${browser.key}:1 at ${clock(Date.now())} (pressed Cancel on the browser's debugging bar).`;
  assert.equal((await call('console', { tab: `${browser.key}:1` })).error, true, 'a call on the tab itself first');
  const other = await call('console', { tab: `${browser.key}:2` });
  assert.equal(other.error, false);
  assert.ok(other.text.startsWith(notice), other.text);
  assert.ok(!(await call('console', { tab: `${browser.key}:2` })).text.includes('took over'), 'only once');
  for (let i = 0; i < 2; i++) {
    const again = await call('console', { tab: `${browser.key}:1` });
    assert.equal(again.error, true);
    assert.equal(again.text.split('took over').length, 2, 'the notice once per result');
  }
  // The parked tab's own detach and input change nothing.
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'parked']);
  report(browser.tabs.get(1), 'pointerdown', Date.now() + 1000);
  await sleep(10);
  assert.deepEqual(userInputs(browser), []);
  assert.equal(parks(browser).length, 1);
});

test('a call running on the tab when the user takes it over returns the notice instead of its result', async () => {
  const browser = await fakeBrowser({ ids: [3] });
  const tab = browser.tabs.get(3);
  const call = toolsFor(browser);
  let finish;
  const blocker = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  const running = call('console', { tab: `${browser.key}:3` });
  await sleep(10);
  detach(browser, 3);
  await sleep(10);
  finish();
  await blocker;
  const result = await running;
  assert.equal(result.error, true);
  assert.match(result.text, /took over .*:3 at .* \(pressed Cancel on the browser's debugging bar\)/);
});

test('detaches: Cancel and a browser page are takeovers; a crash and a closing tab are not', async () => {
  let listed = [];
  const browser = await fakeBrowser({ ids: [1, 2, 3], listed: () => listed });
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Inspector.targetCrashed', {}]);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'target_closed']);
  listed = [{ id: 1, owner: 'you', url: 'https://shop.example/' }, { id: 2, owner: 'you', url: 'chrome://settings/' }];
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 2 }, 'target_closed']);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 3 }, 'target_closed']); // closing: not listed
  await sleep(400);
  assert.deepEqual(parks(browser), [{ tabId: 2, kind: 'takeover' }]);
  const text = (await toolsFor(browser)('console', { tab: `${browser.key}:2` })).text;
  assert.match(text, /\(opened a browser page \(chrome:\/\/settings\/\)\)/);
});

// Measured on a test Mac (Chrome 155, Helium 0.19, 2026-10-14): a page navigating to zoommtg:, mailto: or a scheme no app
// handles sends Page.frameRequestedNavigation with that URL, then its debugger detaches (target_closed) as the
// navigation starts, though the tab never leaves its page.
test('a link for another app (mailto:, zoommtg:) is no takeover: the tab is attached again and the agent hears it once', async () => {
  const page = 'https://shop.example/checkout';
  const listed = () => [1, 2, 3, 4].map((id) => ({ id, owner: 'you', url: id === 3 ? 'https://chromewebstore.google.com/detail/x' : page }));
  const browser = await fakeBrowser({ ids: [1, 2, 3, 4], listed });
  const again = [];
  browser.relay.model.reattach = async (tabId) => { again.push(tabId); if (tabId === 4) throw new Error('Cannot access a chrome:// URL'); };
  const asks = (tabId, url) => browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId }, 'Page.frameRequestedNavigation', { frameId: 'MAIN', reason: 'anchorClick', url, disposition: 'currentTab' }]);
  asks(1, 'zoommtg://zoom.us/join?confno=1');
  detach(browser, 1, 'target_closed');
  // Not when the user's input came first, the tab went elsewhere (a page the debugger may not stay on), or it does not come back.
  report(browser.tabs.get(2), 'pointerdown', Date.now());
  await sleep(10);
  asks(2, 'mailto:someone@example.com');
  detach(browser, 2, 'target_closed');
  asks(3, 'mailto:someone@example.com');
  detach(browser, 3, 'target_closed');
  asks(4, 'slack://open');
  detach(browser, 4, 'target_closed');
  await sleep(400);
  assert.deepEqual(again, [1, 4]);
  assert.deepEqual(parks(browser).map((p) => p.tabId).sort(), [2, 3, 4]);

  const call = toolsFor(browser);
  const first = await call('tab_list', { scope: 'mine' });
  assert.match(first.text, new RegExp(`The page in ${browser.key}:1 opened zoommtg://zoom\\.us/join\\?confno=1, a link for another app \\(if one is installed\\), ` +
    'and the browser let go of the tab for it\\. FowlBrowser attached again: the tab is still yours, on the same page, but refs from before are void, so call snapshot\\.'));
  assert.ok(!(await call('tab_list', { scope: 'mine' })).text.includes('a link for another app'), 'told once');
  assert.equal((await call('console', { tab: `${browser.key}:1` })).error, false, 'the tab works');
});

test('a link for another app right after input still being judged (a slow tabs.isShown) is no reattach: the tab is taken over', async () => {
  let shown;
  const page = 'https://shop.example/checkout';
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ id: 1, owner: 'you', url: page }], hold: { 'tabs.isShown': new Promise((resolve) => { shown = resolve; }) } });
  const again = [];
  browser.relay.model.reattach = async (tabId) => { again.push(tabId); };
  report(browser.tabs.get(1), 'pointerdown', Date.now()); // the user's click on a mailto: link; its check is slow
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.frameRequestedNavigation', { frameId: 'MAIN', reason: 'anchorClick', url: 'mailto:a@example.com' }]);
  detach(browser, 1, 'target_closed');
  await sleep(1000);
  shown();
  await sleep(10);
  assert.deepEqual(again, [], 'not attached again');
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'takeover' }]);
});

test('the user\'s click on an app link just before it is still theirs when the tab\'s checks are slow (a busy browser)', async () => {
  let answer;
  const page = 'https://shop.example/checkout';
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ id: 1, owner: 'you', url: page }] });
  const again = [];
  browser.relay.model.reattach = async (tabId) => { again.push(tabId); };
  report(browser.tabs.get(1), 'pointerdown', Date.now() - 4900); // judged at once, nearly 5 s before the link
  await sleep(10);
  const request = browser.host.request.bind(browser.host);
  browser.host.request = (method, params) => (method === 'tabs.info' ? new Promise((resolve) => { answer = () => resolve(request(method, params)); }) : request(method, params));
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.frameRequestedNavigation', { frameId: 'MAIN', reason: 'anchorClick', url: 'mailto:a@example.com' }]);
  detach(browser, 1, 'target_closed');
  await sleep(600);
  answer();
  await sleep(50);
  assert.deepEqual(again, [], 'not attached again');
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'takeover' }]);
});

test('closing: the user closing a tab is a takeover with no resume; our own closes, the page closing itself, swaps and popups given back to the user are not', async () => {
  const browser = await fakeBrowser({ ids: [1, 2, 3, 4, 5] });
  const removed = (tabId, info = {}) => browser.host.emit('event', 'chrome.tabs.onRemoved', [tabId, { windowId: 1, isWindowClosing: false, ...info }]);
  markEnding(`${browser.key}:2`);
  browser.tabs.get(3).closedByPageAt = Date.now();
  removed(1);
  removed(2);
  removed(3);
  removed(4, { replacedBy: 9 });
  removed(5, { usersPopup: true }); // still open, the user's (extension giveBack)
  removed(77); // never ours
  await sleep(10);
  assert.deepEqual(parks(browser), [], 'a closed tab is not parked');
  const call = toolsFor(browser);
  const text = (await call('console', { tab: `${browser.key}:1` })).text;
  assert.match(text, /The user took over .*:1 at .* \(closed the tab\)\. Stop working in that tab, tell the user where you got to, and ask before going on\.$/);
  assert.match((await call('tab_claim', { tab: `${browser.key}:1`, resume: true })).text, /closed the tab/);
  for (const id of [2, 3, 4, 5]) assert.ok(!(await call('console', { tab: `${browser.key}:${id}` })).text.includes(`took over ${browser.key}:${id} `));
  assert.ok(wasGivenBack(`${browser.key}:5`) && !wasGivenBack(`${browser.key}:4`), 'the given-back popup is left out of the running action\'s new tabs');
});

test('the user\'s navigations take nothing over: the address bar, a bookmark, Back, Forward and Reload (also from an older extension that still reports commits)', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const commit = (url, transitionType, transitionQualifiers = []) => browser.host.emit('event', 'tabs.committed', { tabId: 1, url, transitionType, transitionQualifiers });
  commit('https://a.example/', 'typed', ['from_address_bar']);
  commit('https://b.example/', 'auto_bookmark');
  commit('https://a.example/', 'typed', ['forward_back']);
  commit('https://b.example/', 'typed', ['forward_back']);
  commit('https://b.example/', 'reload');
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.frameRequestedNavigation', { frameId: 'MAIN-1', url: 'https://a.example/' }]);
  await sleep(400);
  assert.deepEqual(parks(browser), []);
  const result = await toolsFor(browser)('console', { tab: `${browser.key}:1` });
  assert.equal(result.error, false);
  assert.doesNotMatch(result.text, /took over/);
});

test('tab_handoff parks the tab and returns the line for the user; calls on it get the handoff notice; resume brings it back', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const call = toolsFor(browser);
  const id = `${browser.key}:1`;
  browser.tabs.get(1).viewport = { width: 390, height: 844, mobile: false }; // a phone-size override the user must not inherit
  const handed = await call('tab_handoff', { tab: id, reason: 'enter the card details' });
  assert.equal(handed.error, false);
  assert.match(handed.text, /Your turn in Chrome tab "Checkout": enter the card details, then tell me\./);
  assert.match(handed.text, /tab_claim on it with resume: true/);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'handoff' }]);
  assert.ok(browser.requests.some(([m, p]) => m === 'chrome.debugger.sendCommand' && p[1] === 'Emulation.clearDeviceMetricsOverride'));
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.focus'), 'never focused');

  const blocked = await call('console', { tab: id });
  assert.equal(blocked.error, true);
  assert.match(blocked.text, new RegExp(`You handed ${id} to the user at \\d\\d:\\d\\d \\(enter the card details\\); wait until they say they are done, then tab_claim it with resume: true\\.`));
  assert.equal((await call('tab_claim', { tab: id })).error, true, 'a plain claim is refused');
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim'));

  const resumed = await call('tab_claim', { tab: id, resume: true, snapshot: false });
  assert.equal(resumed.error, false, resumed.text);
  assert.match(resumed.text, /Resumed .*: you control it again/);
  assert.match(resumed.text, /Pay now/, 'a fresh snapshot even with snapshot: false');
  assert.equal((await call('console', { tab: id })).error, false);
});

test('tab_list says in words which tabs are parked', async () => {
  const browser = await fakeBrowser({ ids: [], listed: () => [
    { id: 1, url: 'https://shop.example/', title: 'Shop', owner: 'you', origin: 'agent', parked: 'handoff' },
    { id: 2, url: 'https://mail.example/', title: 'Mail', owner: 'you', origin: 'user', parked: 'takeover' },
    { id: 3, url: 'https://news.example/', title: 'News', owner: 'you', origin: 'agent', parked: null },
  ] });
  const { text } = await toolsFor(browser)('tab_list', { scope: 'mine' });
  assert.match(text, /:1 · Shop · https:\/\/shop\.example\/ · owner: you \(agent tab; handed to the user\)/);
  assert.match(text, /:2 · Mail · https:\/\/mail\.example\/ · owner: you \(claimed from the user; taken over by the user\)/);
  assert.match(text, /:3 · News · https:\/\/news\.example\/ · owner: you \(agent tab\)$/m);
});

test('turn end leaves parked tabs alone', async () => {
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ id: 1, owner: 'you', origin: 'agent', kept: true, handedOver: true, parked: 'handoff' }] });
  const result = await endTurn({ browsers: new Map([[browser.key, browser]]) });
  assert.deepEqual(result, { closed: [], released: [], skipped: [`${browser.key}:1`] });
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.release' || m === 'chrome.tabs.remove'));
});

const gate = () => { let open; const promise = new Promise((resolve) => { open = resolve; }); return [promise, open]; };
const agentTab = (id) => ({ id, owner: 'you', origin: 'agent', kept: false, handedOver: false, parked: null, url: 'https://shop.example/' });

test('a resume whose attach fails parks the tab again and keeps its notice', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const call = toolsFor(browser);
  const id = `${browser.key}:1`;
  await call('tab_handoff', { tab: id, reason: 'log in' });
  browser.waitForTab = async () => { throw new Error('Timed out waiting for the tab'); };
  assert.equal((await call('tab_claim', { tab: id, resume: true })).error, true);
  assert.deepEqual(parks(browser), [{ tabId: 1, kind: 'handoff' }, { tabId: 1, kind: 'handoff' }]);
  assert.match((await call('console', { tab: id })).text, /You handed .*:1 to the user/);
});

test('turn end leaves a tab alone whose takeover is noted but not parked yet, also when it comes during the cleanup', async () => {
  const [parking, park] = gate();
  const early = await fakeBrowser({ ids: [1], listed: () => [agentTab(1)], hold: { 'tabs.park': parking } });
  early.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  assert.deepEqual((await endTurn({ browsers: new Map([[early.key, early]]) })).skipped, [`${early.key}:1`]);
  park();

  const [clearing, clear] = gate();
  const late = await fakeBrowser({ ids: [1], listed: () => [agentTab(1)], hold: { 'Emulation.clearDeviceMetricsOverride': clearing } });
  late.tabs.get(1).viewport = { width: 390, height: 844, mobile: false };
  const ending = endTurn({ browsers: new Map([[late.key, late]]) });
  await sleep(10);
  late.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  clear();
  assert.deepEqual((await ending).skipped, [`${late.key}:1`]);
  for (const browser of [early, late]) assert.ok(!browser.requests.some(([m]) => m === 'chrome.tabs.remove' || m === 'tabs.release'));
});

test('calls queued before a handoff fail with its notice when their turn comes; release still works', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const tab = browser.tabs.get(1);
  const call = toolsFor(browser);
  const id = `${browser.key}:1`;
  let finish;
  const blocker = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  const handoff = call('tab_handoff', { tab: id, reason: 'log in' });
  await sleep(10);
  const mute = call('tab_mute', { tab: id, muted: true });
  const release = call('tab_release', { tab: id });
  finish();
  await blocker;
  assert.equal((await handoff).error, false);
  const muted = await mute;
  assert.equal(muted.error, true);
  assert.match(muted.text, /You handed .*:1 to the user/);
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.setMuted'));
  assert.equal((await release).error, false);
});

test('a resume waits for the takeover\'s parking', async () => {
  const [parking, park] = gate();
  const browser = await fakeBrowser({ ids: [1], hold: { 'tabs.park': parking } });
  const call = toolsFor(browser);
  detach(browser, 1);
  await sleep(10);
  const resumed = call('tab_claim', { tab: `${browser.key}:1`, resume: true });
  await sleep(10);
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim'), 'not before the park');
  park();
  assert.equal((await resumed).error, false);
  const order = browser.requests.map(([m]) => m).filter((m) => m === 'tabs.park' || m === 'tabs.claim');
  assert.deepEqual(order, ['tabs.park', 'tabs.claim']);
});

test('the page listener reports input only: no navigations, nothing about the target', async () => {
  const vm = await import('node:vm');
  const { USER_SCRIPT } = await import('../src/takeover.mjs');
  for (const top of [true, false]) {
    const types = [];
    const navigations = [];
    const reports = [];
    const listeners = {};
    const context = { addEventListener: (type, fn) => { types.push(type); listeners[type] = fn; }, performance,
      navigation: { addEventListener: (type) => navigations.push(type) }, [USER_BINDING]: (payload) => reports.push(JSON.parse(payload)) };
    context.window = context.globalThis = context;
    context.top = top ? context : {};
    vm.runInNewContext(USER_SCRIPT, context);
    // Only input that can open a tab (a page's transient activation): no wheel, no beforeinput (its keydown came first).
    assert.deepEqual(types, ['pointerdown', 'keydown', ...(top ? ['blur'] : [])], `top: ${top}`);
    assert.deepEqual(navigations, []);
    listeners.pointerdown({ isTrusted: true, timeStamp: 10, target: { closest: () => { throw new Error('read the target'); } } });
    assert.deepEqual(Object.keys(reports[0]), ['type', 'at']);
  }
});

test('a replaced parked tab keeps its record and notice under the new id; a plain claim of it is refused', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  const call = toolsFor(browser);
  await call('tab_handoff', { tab: `${browser.key}:1`, reason: 'log in' });
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 2 }, 'canceled_by_user']);
  await sleep(10);
  browser.host.emit('event', 'chrome.tabs.onRemoved', [1, { windowId: 1, isWindowClosing: false, replacedBy: 11 }]);
  browser.host.emit('event', 'chrome.tabs.onRemoved', [2, { windowId: 1, isWindowClosing: false, replacedBy: 12 }]);
  await sleep(10);
  assert.match((await call('tab_claim', { tab: `${browser.key}:11` })).text, new RegExp(`You handed ${browser.key}:11 to the user`));
  const claim = await call('tab_claim', { tab: `${browser.key}:12` });
  assert.match(claim.text, new RegExp(`The user took over ${browser.key}:12 .*resume: true`));
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim'));
});

test('the page listener dates an event with timeStamp 0 (some synthesized OS clicks) at its handler, not the page start', async () => {
  const vm = await import('node:vm');
  const { USER_SCRIPT, USER_BINDING } = await import('../src/takeover.mjs');
  const listeners = {};
  const reports = [];
  const context = { addEventListener: (type, fn) => { listeners[type] = fn; }, performance: { timeOrigin: 1000, now: () => 5000 },
    [USER_BINDING]: (payload) => reports.push(JSON.parse(payload)) };
  context.window = context.globalThis = context.top = context;
  vm.runInNewContext(USER_SCRIPT, context);
  const before = Date.now();
  listeners.pointerdown({ isTrusted: true, timeStamp: 0, target: null });
  listeners.keydown({ isTrusted: true, timeStamp: 250, key: 'Enter', metaKey: true }); // Cmd+Enter opens a link in a new tab
  assert.ok(reports[0].at >= before, 'timeStamp 0: the handler time');
  assert.equal(reports[1].at, 1250, 'otherwise the event time');
});

test('a tab_close queued before a takeover or a handoff needs the user\'s confirmation when its turn comes', async () => {
  const listed = [agentTab(1), agentTab(2)];
  const browser = await fakeBrowser({ ids: [1, 2], listed: () => listed });
  const call = toolsFor(browser);
  let finish;
  const blocker = browser.tabs.get(1).run(() => new Promise((resolve) => { finish = resolve; }));
  const close = call('tab_close', { tab: `${browser.key}:1` });
  await sleep(10);
  detach(browser, 1);
  await sleep(10);
  finish();
  await blocker;
  const refused = await close;
  assert.equal(refused.error, true);
  assert.match(refused.text, /The user took over/);

  // Handed over by the time its turn comes (the extension says so): refused too; with the flag the extension hears it.
  let finish2;
  const blocker2 = browser.tabs.get(2).run(() => new Promise((resolve) => { finish2 = resolve; }));
  const close2 = call('tab_close', { tab: `${browser.key}:2` });
  await sleep(10);
  Object.assign(listed[1], { kept: true, handedOver: true });
  finish2();
  await blocker2;
  assert.match((await close2).text, /confirm_close_users_tab/);
  assert.ok(!browser.requests.some(([m]) => m === 'chrome.tabs.remove'));
  assert.equal((await call('tab_close', { tab: `${browser.key}:2`, confirm_close_users_tab: true })).error, false);
  assert.deepEqual(browser.requests.filter(([m]) => m === 'chrome.tabs.remove').map(([, p]) => p), [[2, { usersTab: true }]]);
});

test('a tab replaced while its handoff is still parking is parked under its new id', async () => {
  const [clearing, clear] = gate();
  const browser = await fakeBrowser({ ids: [1], hold: { 'Emulation.clearDeviceMetricsOverride': clearing } });
  browser.tabs.get(1).viewport = { width: 390, height: 844, mobile: false };
  const handoff = toolsFor(browser)('tab_handoff', { tab: `${browser.key}:1`, reason: 'log in' });
  await sleep(10);
  browser.host.emit('event', 'chrome.tabs.onRemoved', [1, { windowId: 1, isWindowClosing: false, replacedBy: 11 }]);
  await sleep(10);
  clear();
  assert.equal((await handoff).error, false);
  assert.deepEqual(parks(browser), [{ tabId: 11, kind: 'handoff' }]);
  assert.match((await toolsFor(browser)('console', { tab: `${browser.key}:11` })).text, /You handed .*:11 to the user/);
});

test('the replacement of a tab still parking is not announced for attaching meanwhile', async () => {
  const [parking, park] = gate();
  const requests = [];
  const host = Object.assign(new EventEmitter(), {
    hello: { extension: { userAgent: 'Chrome/150.0.0.0' } },
    async request(method, params) {
      requests.push([method, params]);
      if (method === 'tabs.park') await parking;
      return {};
    },
  });
  const browser = new Browser(`chrome-t${++browsers}`, host);
  const announced = [];
  browser.relay.model.onTabCreated = (tab) => announced.push(tab.id);
  browser.relay.model.hasTab = () => true;
  const tab = new Tab(browser, 1, fakePage());
  browser.tabs.set(1, tab);
  await watchUserInput(tab);
  host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  host.emit('event', 'chrome.tabs.onRemoved', [1, { windowId: 1, isWindowClosing: false, replacedBy: 11 }]);
  host.emit('event', 'chrome.tabs.onCreated', [{ id: 11, windowId: 1 }]);
  park();
  await sleep(10);
  assert.deepEqual(announced, []);
  assert.deepEqual(requests.filter(([m]) => m === 'tabs.park').map(([, p]) => p), [{ tabId: 1, kind: 'takeover' }]);
});

test('a plain tab_claim never resumes a tab taken over while it set up; only resume asks the extension to', async () => {
  const [ready, open] = gate();
  const browser = await fakeBrowser({ ids: [1, 2] });
  browser.playwright = () => ready;
  const call = toolsFor(browser);
  const claim = call('tab_claim', { tab: `${browser.key}:1` });
  await sleep(10);
  browser.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 1 }, 'canceled_by_user']);
  await sleep(10);
  open();
  const result = await claim;
  assert.equal(result.error, true);
  assert.match(result.text, /The user took over/);
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim'));

  await call('tab_claim', { tab: `${browser.key}:1`, resume: true });
  await call('tab_claim', { tab: `${browser.key}:2` });
  assert.deepEqual(browser.requests.filter(([m]) => m === 'tabs.claim').map(([, p]) => p), [{ tabId: 1, resume: true }, { tabId: 2, resume: false }]);
});

test('a handoff whose park errors after parking keeps its record: calls get the notice, a plain claim is refused', async () => {
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ ...agentTab(1), kept: true, handedOver: true, parked: 'handoff' }] });
  const request = browser.host.request;
  browser.host.request = async (method, params) => {
    if (method === 'tabs.park') throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    return request(method, params);
  };
  const call = toolsFor(browser);
  const id = `${browser.key}:1`;
  assert.equal((await call('tab_handoff', { tab: id, reason: 'log in' })).error, true);
  assert.match((await call('tab_mute', { tab: id, muted: false })).text, /You handed .*:1 to the user/);
  assert.match((await call('tab_claim', { tab: id })).text, /You handed .*:1 to the user/);
  assert.ok(!browser.requests.some(([m]) => m === 'tabs.claim' || m === 'tabs.setMuted'));
});

test('focus moving into an iframe is the agent\'s while one of its calls runs (Playwright focuses through the DOM), the user\'s otherwise', async () => {
  const browser = await fakeBrowser({ ids: [1] });
  const tab = browser.tabs.get(1);
  let finish;
  const running = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  report(tab, 'frame', Date.now());
  await sleep(10);
  assert.deepEqual(userInputs(browser), [], 'during an agent call');
  finish();
  await running;
  const at = Date.now() + 1000;
  report(tab, 'frame', at);
  await sleep(10);
  assert.deepEqual(userInputs(browser), [{ tabId: 1, at }], 'no call running: the user clicked into the frame');
  assert.deepEqual(parks(browser), []);
});

test('a popup the user\'s own click opens while an agent call runs is theirs: never attached, navigated, or named in the agent\'s result', async () => {
  const browser = await fakeBrowser({ ids: [1], answers: { 'tabs.openChild': () => ({ tabId: 9, user: true }) } });
  browser.waitForTab = async (id) => { if (id === 9) throw new Error('attached'); return browser.tabs.get(id); };
  const tab = browser.tabs.get(1);
  tab.page.waitForTimeout = sleep;
  await installPopups(tab);
  const waiting = toolsFor(browser)('wait_for', { tab: `${browser.key}:1`, seconds: 0.3, snapshot: false });
  await sleep(50);
  report(tab, 'pointerdown', Date.now());
  tab.emit('binding', POPUP_BINDING, JSON.stringify({ type: 'open', url: 'https://shop.example/terms' }));
  const started = Date.now();
  const result = await waiting;
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /New tab|new tab/);
  assert.ok(Date.now() - started < 1500, 'it did not wait for a tab of its own');
  const methods = browser.requests.map(([m]) => m);
  assert.ok(methods.indexOf('tabs.userInput') >= 0 && methods.indexOf('tabs.userInput') < methods.indexOf('tabs.openChild'), methods.join());
  assert.ok(!browser.requests.some(([m, p]) => m === 'chrome.debugger.sendCommand' && p[0].tabId === 9));
});

test('a new tab that turned into a download and was closed for it (by the extension or Chrome) is no takeover', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  browser.tabs.set(2, new Tab(browser, 2, fakePage('about:blank')));
  // The agent's click on a target=_blank download link: the child's first navigation became a download, so it closes.
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 2 }, 'Page.downloadWillBegin', { url: 'https://shop.example/invoice.pdf', guid: 'g' }]);
  browser.host.emit('event', 'chrome.tabs.onRemoved', [2, { windowId: 1, isWindowClosing: false }]);
  await sleep(10);
  const result = await toolsFor(browser)('console', { tab: `${browser.key}:1` });
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /took over/);
});

test('the user closing a page right after a download started in it is still a takeover', async () => {
  const browser = await fakeBrowser({ ids: [1] }); // a claimed checkout page
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.downloadWillBegin', { url: 'https://shop.example/invoice.pdf', guid: 'g' }]);
  browser.host.emit('event', 'chrome.tabs.onRemoved', [1, { windowId: 1, isWindowClosing: false }]);
  await sleep(10);
  const result = await toolsFor(browser)('console', { tab: `${browser.key}:1` });
  assert.match(result.text, /took over .*\(closed the tab\)/);
  browser.host.emit('close'); // its notice is for this test only
});

test('events of a connection that ended, drained after its close, take nothing over', async () => {
  const first = await fakeBrowser({ ids: [52] });
  first.host.closed = true; // HostClient: set before 'close'; messages already received still drain one per tick
  first.host.emit('close');
  first.host.emit('event', 'chrome.tabs.onRemoved', [52, { windowId: 1, isWindowClosing: false }]);
  first.host.emit('event', 'chrome.debugger.onDetach', [{ tabId: 52 }, 'canceled_by_user']);
  await sleep(10);
  const second = await fakeBrowser({ ids: [] });
  second.key = first.key;
  second.tabs.set(52, new Tab(second, 52, fakePage()));
  const result = await toolsFor(second)('console', { tab: `${first.key}:52` });
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /took over/);
});

test('a takeover of the browser\'s last connection is forgotten when it closes: after a browser restart a new tab may get the same id', async () => {
  const first = await fakeBrowser({ ids: [52] });
  first.host.emit('event', 'chrome.tabs.onRemoved', [52, { windowId: 1, isWindowClosing: false }]); // the user closed it
  await sleep(10);
  first.host.emit('close'); // Chrome restarts; the server reconnects to the same socket name
  const second = await fakeBrowser({ ids: [] });
  second.key = first.key;
  second.tabs.set(52, new Tab(second, 52, fakePage())); // tab_open got id 52 again
  const result = await toolsFor(second)('console', { tab: `${first.key}:52` });
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /took over/);
});

test('a popup announced but not yet controlled that closes (Chrome closing it for its download) is no takeover', async () => {
  const browser = await fakeBrowser({ ids: [1, 2] });
  browser.tabs.delete(2); // the extension adopted and announced it (the relay knows it); no page for it yet
  browser.host.emit('event', 'chrome.tabs.onRemoved', [2, { windowId: 1, isWindowClosing: false }]);
  await sleep(10);
  const result = await toolsFor(browser)('console', { tab: `${browser.key}:1` });
  assert.equal(result.error, false, result.text);
  assert.doesNotMatch(result.text, /took over/);
});

test('a turn that ends while a tab is attached again after a link for another app waits for it, and closes it as its work tab', async () => {
  const page = 'https://shop.example/checkout';
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ ...agentTab(1), url: page }, agentTab(2)] });
  // The detach closes the tab's Playwright page (it leaves the mapped tabs); attached again, a new Tab is mapped a moment later.
  browser.relay.model.reattach = async (tabId) => {
    await sleep(50);
    setTimeout(() => browser.tabs.set(tabId, new Tab(browser, tabId, fakePage(page))), 50);
  };
  browser.waitForTab = async (id) => { while (!browser.tabs.has(id)) await sleep(10); return browser.tabs.get(id); };
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.frameRequestedNavigation', { frameId: 'MAIN', reason: 'anchorClick', url: 'zoommtg://zoom.us/join?confno=1' }]);
  detach(browser, 1, 'target_closed');
  browser.tabs.delete(1);
  await sleep(50);
  // The next turn opens a tab while this one's end waits: never this turn's to close.
  setTimeout(() => browser.tabs.set(2, new Tab(browser, 2, fakePage('https://next.example/'))), 20);
  const result = await endTurn({ browsers: new Map([[browser.key, browser]]) });
  assert.deepEqual(result.closed, [`${browser.key}:1`], JSON.stringify(result));
  assert.ok(browser.requests.some(([m, p]) => m === 'chrome.tabs.remove' && p[0] === 1));
  assert.ok(!browser.requests.some(([m, p]) => m === 'chrome.tabs.remove' && p[0] === 2), 'the next turn\'s tab stays');
});

test('a tab attached again after a link for another app keeps what its page logged and loaded before (the same page)', async () => {
  const page = 'https://shop.example/checkout';
  const browser = await fakeBrowser({ ids: [1], listed: () => [{ ...agentTab(1), url: page }] });
  const old = browser.tabs.get(1);
  old.console.push({ time: Date.now(), page: old.documentGeneration, level: 'error', text: 'Uncaught TypeError: cart is undefined' });
  old.network.push({ time: Date.now(), page: old.documentGeneration, method: 'POST', url: 'https://shop.example/api/cart', status: 'failed', type: 'fetch', failure: 'net::ERR_FAILED' });
  browser.relay.model.reattach = async (tabId) => { setTimeout(() => browser.tabs.set(tabId, new Tab(browser, tabId, fakePage(page))), 20); };
  browser.waitForTab = async (id) => { while (browser.tabs.get(id) === old || !browser.tabs.has(id)) await sleep(10); return browser.tabs.get(id); };
  browser.host.emit('event', 'chrome.debugger.onEvent', [{ tabId: 1 }, 'Page.frameRequestedNavigation', { frameId: 'MAIN', reason: 'anchorClick', url: 'mailto:support@shop.example' }]);
  detach(browser, 1, 'target_closed');
  browser.tabs.delete(1);
  await sleep(500);
  assert.notEqual(browser.tabs.get(1), old, 'attached again');
  const call = toolsFor(browser);
  assert.match((await call('console', { tab: `${browser.key}:1` })).text, /\[error\] Uncaught TypeError: cart is undefined/);
  assert.match((await call('network', { tab: `${browser.key}:1` })).text, /POST failed net::ERR_FAILED fetch https:\/\/shop\.example\/api\/cart/);
});
