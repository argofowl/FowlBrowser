// A page stuck in an endless script (a broken dev build) answers nothing: a call on it fails once the page has not
// answered a liveness probe (Tab.run), the tab's queue goes on, and later calls fail at once until the page answers
// again or loads a new document; navigate and the other ways out still go ahead. A page that is only busy, or a call
// that answers, is never probed early or failed.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { STUCK_AFTER_MS, Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const never = new Promise(() => {});
const flush = () => new Promise((resolve) => setImmediate(resolve)); // setImmediate is never mocked here

// A tab whose page hangs every read while `state.stuck` (its main thread never yields) and whose host leaves the
// liveness probe (Runtime.evaluate '1') unanswered then too, unless `state.probeAnswers`. `probes` counts the probes.
function setup() {
  const state = { stuck: false, wedged: false, probeAnswers: false, probes: 0, read: null, steps: [] };
  let url = 'https://dev.example/';
  let tab;
  // Chrome holds a navigation of a page whose thread is stuck (only stopping its script lets it go).
  const go = (to) => {
    state.steps.push(`load ${to}`);
    if (state.stuck) return never;
    url = to;
    tab._newDocument(to);
    page.emit('framenavigated', page);
    return null;
  };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => url, mainFrame: () => page, frames: () => [page], childFrames: () => [], isClosed: () => false,
    async evaluate(fn) {
      if (state.stuck) return never;
      if (state.read) return state.read; // a slow read the test settles itself
      return String(fn).includes('innerText') ? { name: 'main', text: `Text of ${url}`, early: false } : true;
    },
    waitForEvent: (name) => new Promise((resolve) => page.once(name, resolve)),
    waitForLoadState: async () => {},
    goto: async (to) => go(to),
    reload: async () => go(url),
    ariaSnapshot: async () => (state.stuck ? never : `- heading "${url}"`),
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.setMuted' || method === 'chrome.tabs.remove') return {};
      if (method === 'tabs.info') return { id: 5, owner: 'you', origin: 'agent' };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Dev build' } };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Runtime.evaluate' && params[2].expression === '1') {
        state.probes++;
        return state.stuck && !state.probeAnswers ? never : { result: { type: 'number', value: 1 } };
      }
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Runtime.terminateExecution') {
        if (state.wedged) return never; // a navigation waits on the stuck page: Chrome holds every command to it
        state.steps.push('stop script');
        state.stuck = false;
        return {};
      }
      throw new Error(`not in this double: ${method} ${params?.[1] ?? ''}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), forget() {},
    relay: { viewports: new Map(), model: { hasTab: () => true, forgetTab() {}, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  tab = new Tab(browser, 5, page);
  browser.tabs.set(5, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = (name, args) => tools[name]({ tab: 'chrome:5', ...args })
    .then((result) => ({ error: !!result.isError, text: result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') }));
  return { call, state, tab };
}

const settled = async (promise) => Promise.race([promise, flush().then(() => 'still waiting')]);
const STUCK = /The page in chrome:5 has not answered for (\d+) s: a script on it seems stuck in a loop \(a broken build\?\)\. Navigate it \(reload, or another URL\) or close it with tab_close; other calls on this tab fail at once until it answers again\./;

test('a page stuck in a script: the call fails after 18 s, the call queued behind it fails at once, navigate gets out, and the new page needs no probe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state, tab } = setup();
  state.stuck = true;
  const text = call('snapshot', { mode: 'text' });
  await flush();
  const queued = call('snapshot', {}); // the agent's next call, waiting in the tab's queue
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS - 1);
  await flush();
  assert.equal(state.probes, 0, 'no probe before 15 s');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(state.probes, 1);
  assert.equal(await settled(text), 'still waiting', 'the probe gets 3 s');
  t.mock.timers.tick(3000);
  const failed = await text;
  assert.ok(failed.error);
  assert.match(failed.text, STUCK);
  assert.equal(STUCK.exec(failed.text)[1], '18');
  assert.ok(tab.stuckAt, 'the tab is marked stuck');

  // The queued call no longer waits behind the hung one: it asks the page once more (1 s) and fails.
  await flush();
  assert.equal(state.probes, 2);
  t.mock.timers.tick(1000);
  const next = await queued;
  assert.ok(next.error);
  assert.equal(STUCK.exec(next.text)?.[1], '19', next.text);

  // A way out goes ahead without asking the page: navigate stops the stuck script first (Chrome holds a reload of a page
  // whose thread is stuck), and the new document ends the stuck state.
  const reloaded = await call('navigate', { action: 'reload' });
  assert.equal(reloaded.error, false, reloaded.text);
  assert.deepEqual(state.steps, ['stop script', 'load https://dev.example/']);
  assert.equal(tab.stuckAt, null);
  assert.equal(state.probes, 2, 'navigate sent no probe');
  const read = await call('snapshot', { mode: 'text' });
  assert.equal(read.error, false, read.text);
  assert.match(read.text, /Text of https:\/\/dev\.example\//);
  assert.equal(state.probes, 2, 'a call on a page that answers sends no probe');
});

test('while a page is stuck every call but the ways out fails within 1 s; tab_mute and tab_close go ahead at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state } = setup();
  state.stuck = true;
  const hung = call('snapshot', { mode: 'text' });
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS);
  await flush();
  t.mock.timers.tick(3000);
  assert.match((await hung).text, STUCK);
  for (const [name, args] of [['click', { x: 5, y: 5 }], ['evaluate', { function: '() => 1' }], ['scroll', { direction: 'down' }], ['tab_focus', {}]]) {
    const result = call(name, args);
    await flush();
    t.mock.timers.tick(1000);
    const { error, text } = await result;
    assert.ok(error, name);
    assert.match(text, STUCK, name);
  }
  const probes = state.probes;
  const muted = await call('tab_mute', { muted: true });
  assert.equal(muted.error, false, muted.text);
  const closed = await call('tab_close', {});
  assert.equal(closed.error, false, closed.text);
  assert.equal(state.probes, probes, 'the ways out ask the page nothing');
});

test('a navigate sent to a page already stuck waits on it, and holds every later command: the next navigate says only closing gets out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state } = setup();
  state.stuck = true;
  const reload = call('navigate', { action: 'reload' }); // the first call since the page got stuck: Chrome holds it
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS);
  await flush();
  t.mock.timers.tick(3000);
  assert.match((await reload).text, STUCK);
  state.wedged = true;
  const again = call('navigate', { action: 'reload' });
  await flush();
  t.mock.timers.tick(1000);
  const { error, text } = await again;
  assert.ok(error);
  assert.match(text, /The page in chrome:5 is stuck in a script, and a navigation sent before that was found still waits on it, so it can't be navigated any more\. Close it with tab_close \(and open a new tab\)\./);
  assert.deepEqual(state.steps, ['load https://dev.example/'], 'no second load was sent');
  const closed = await call('tab_close', {});
  assert.equal(closed.error, false, closed.text);
});

test('a stuck page that answers again (its script ended) is used as before: the next call runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state, tab } = setup();
  state.stuck = true;
  const hung = call('snapshot', { mode: 'text' });
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS);
  await flush();
  t.mock.timers.tick(3000);
  assert.match((await hung).text, STUCK);
  state.stuck = false; // the loop ended without a new document
  const read = await call('snapshot', { mode: 'text' });
  assert.equal(read.error, false, read.text);
  assert.match(read.text, /Text of https:\/\/dev\.example\//);
  assert.equal(tab.stuckAt, null);
});

test('a page that is busy but answers the probe: the call keeps waiting, asked every 15 s, and returns its own result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state, tab } = setup();
  let finish;
  state.read = new Promise((resolve) => { finish = resolve; }); // a long legitimate read (a page answering slowly)
  const slow = call('snapshot', { mode: 'text' });
  await flush();
  for (let i = 1; i <= 3; i++) {
    t.mock.timers.tick(STUCK_AFTER_MS);
    await flush();
    assert.equal(state.probes, i);
    assert.equal(await settled(slow), 'still waiting');
  }
  finish({ name: 'main', text: 'Finally here', early: false });
  const result = await slow;
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /Finally here/);
  assert.equal(tab.stuckAt, null);
  t.mock.timers.tick(STUCK_AFTER_MS * 4);
  await flush();
  assert.equal(state.probes, 3, 'the watch ended with the call');
});

test('a fast call costs no probe and leaves no timer behind', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { call, state } = setup();
  for (const [name, args] of [['snapshot', { mode: 'text' }], ['snapshot', {}], ['navigate', { url: 'https://dev.example/2' }]]) {
    const result = await call(name, args);
    assert.equal(result.error, false, `${name}: ${result.text}`);
  }
  t.mock.timers.tick(STUCK_AFTER_MS * 4);
  await flush();
  assert.equal(state.probes, 0);
  assert.deepEqual(state.steps, ['load https://dev.example/2'], 'a page that is not stuck has no script stopped');
});

test('a call waiting behind a JS dialog is not called stuck: the dialog holds evaluation, and the page is not asked', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { state, tab } = setup();
  tab.dialog = { type: () => 'alert', message: () => 'Saved' };
  let finish;
  const waiting = tab.run(() => new Promise((resolve) => { finish = resolve; }));
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS * 3);
  await flush();
  assert.equal(state.probes, 0);
  assert.equal(await settled(waiting), 'still waiting');
  finish('done');
  assert.equal(await waiting, 'done');
  assert.equal(tab.stuckAt, null);
});

test('a call that failed as stuck while it waited behind earlier work never starts once that work ends', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const { state, tab } = setup();
  let release;
  tab.keepBusy(new Promise((resolve) => { release = resolve; })); // an action going on after its dialog was answered
  state.stuck = true;
  let started = false;
  const waiting = tab.run(async () => { started = true; });
  await flush();
  t.mock.timers.tick(STUCK_AFTER_MS);
  await flush();
  t.mock.timers.tick(3000);
  await assert.rejects(waiting, STUCK);
  state.stuck = false; // the page answers again (reloaded), and the earlier work ends
  release();
  await flush();
  await flush();
  assert.equal(started, false, 'the failed call did not run its action after all');
});
