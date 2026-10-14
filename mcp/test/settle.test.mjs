// What an action waits for after a new document commits (tools.mjs settle), against a page double whose load state
// works like Playwright's: every committed document clears it, and only that document's load event sets it again.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const LOAD_MS = 300;

// One controlled tab. Back (history.back) restores the previous page from the back/forward cache; a key press commits
// what next(kind, url) set: 'restore' (complete at once, never fires load again) or 'load' (its load event LOAD_MS later).
// goto, and go('stuck', url) (the page moving on by itself), commit a page whose load event never comes (a hung resource).
// A frame's getByText: its matches, each shown or hidden (count of all, and of the visible ones).
const matches = (text, texts) => {
  const found = texts[text] ?? [];
  return { count: async () => found.length, filter: ({ visible }) => ({ count: async () => found.filter((shown) => shown === visible).length }) };
};
const payment = { getByText: (text) => matches(text, { 'Pay now': [true] }) };
// An ad iframe whose script never yields: it answers no read.
const never = () => new Promise(() => {});
const stuckAd = { getByText: () => ({ count: never, filter: () => ({ count: never }) }) };

function setup({ stuck = false } = {}) {
  let url = 'https://news.example/story';
  let readyState = 'complete';
  let loadFired = true;
  let pending = ['restore', 'https://news.example/'];
  let opening = 'stuck';
  let busy = false; // the page's script holds its main thread: an evaluate gets no answer until the command times out
  let reloads = 0;
  const loads = new EventEmitter();
  const go = (kind, to) => {
    url = to;
    busy = kind === 'busy';
    tab._newDocument(); // the browser's Page.frameNavigated
    loadFired = false;
    page.emit('framenavigated', page);
    readyState = kind === 'restore' ? 'complete' : 'loading';
    if (kind === 'load') setTimeout(() => { readyState = 'complete'; loadFired = true; loads.emit('load'); }, LOAD_MS);
    page.emit('url');
  };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, isClosed: () => false, url: () => url, mainFrame: () => page,
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('readyState') && busy) return new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), 8000).unref());
      if (source.includes('readyState')) return readyState === 'complete';
      if (source.includes('canGoBack')) return { url, can: true };
      if (source.includes('history.back')) return go('restore', 'https://news.example/');
      throw new Error(`not in this double: ${source}`);
    },
    waitForEvent(name, { predicate }) {
      return new Promise((resolve) => {
        const on = (frame) => { if (predicate(frame)) { page.off(name, on); resolve(frame); } };
        page.on(name, on);
      });
    },
    waitForLoadState(state, { timeout }) {
      if (loadFired) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`page.waitForLoadState: Timeout ${timeout}ms exceeded.`)), timeout);
        loads.once('load', () => { clearTimeout(timer); resolve(); });
      });
    },
    keyboard: { press: async () => go(...pending) },
    async goto(to) {
      go(opening, to);
      return { ok: () => true };
    },
    async reload() {
      reloads++;
      go(opening, url);
      return { ok: () => true };
    },
    waitForURL(predicate) {
      return new Promise((resolve) => {
        const check = () => { if (predicate(new URL(url))) { page.off('url', check); resolve(); } };
        page.on('url', check);
        check();
      });
    },
    // Text that never changes: "Sign in" is shown, "Messages" is in the page but hidden, "Menu" is in a closed menu (hidden)
    // and again shown further down; "Inbox" is nowhere. "Pay now" is only in an iframe (the frames below).
    getByText: (text) => matches(text, { 'Sign in': [true], Messages: [false], Menu: [false, true] }),
    frames: () => [page, payment, ...(stuck ? [stuckAd] : [])],
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return { ok: true };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'News' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 1, page);
  browser.tabs.set(1, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, snapshot: false, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return { call, go, next: (kind, to) => { pending = [kind, to]; }, opens: (kind) => { opening = kind; }, loaded: () => loadFired, reloads: () => reloads };
}

test('Back to a page restored from the back/forward cache returns at once: it is complete and never fires load again', async () => {
  const { call } = setup();
  const started = Date.now();
  const result = await call('navigate', { action: 'back' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /Tab: chrome:1 · News · https:\/\/news\.example\/$/m);
  assert.ok(Date.now() - started < 2000, `navigate back took ${Date.now() - started} ms`);
});

test('an action that restores a page from the back/forward cache returns at once; one that loads a new page waits for its load', async () => {
  const { call, next, loaded } = setup();
  next('restore', 'https://news.example/');
  let started = Date.now();
  assert.equal((await call('press_key', { key: 'Alt+ArrowLeft' })).error, false);
  assert.ok(Date.now() - started < 2000, `a key press that restored a page took ${Date.now() - started} ms`);
  next('load', 'https://news.example/story');
  started = Date.now();
  assert.equal((await call('press_key', { key: 'Alt+ArrowRight' })).error, false);
  assert.ok(loaded(), `returned after ${Date.now() - started} ms, before the new page loaded`);
});

test('navigate waits at most 5 s for a load event that never comes (as tab_open does), not 5 s and then 10 s more', async () => {
  const { call } = setup();
  const started = Date.now();
  const result = await call('navigate', { url: 'https://news.example/heavy' });
  assert.equal(result.error, false, result.text);
  const took = Date.now() - started;
  assert.ok(took >= 4900 && took < 7000, `navigate took ${took} ms`);
});

test('Cmd+R waits for its page as navigate reload does (at most 5 s for a load that never comes), not twice', async () => {
  const { call } = setup();
  const started = Date.now();
  const result = await call('press_key', { key: 'Meta+r' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /did the reload instead/);
  const took = Date.now() - started;
  assert.ok(took >= 4900 && took < 7000, `press_key Meta+r took ${took} ms`);
});

test('Cmd+R with times reloads that many times, as back and forward step that many entries', async () => {
  const { call, opens, reloads } = setup();
  opens('load');
  const result = await call('press_key', { key: 'Meta+r', times: 3 });
  assert.equal(result.error, false, result.text);
  assert.equal(reloads(), 3);
});

test('a page whose script is busy while it loads holds navigate at most 5 s: the readiness check shares the load wait\'s time', async () => {
  const { call, opens } = setup();
  opens('busy');
  const started = Date.now();
  assert.equal((await call('navigate', { url: 'https://news.example/busy' })).error, false);
  const took = Date.now() - started;
  assert.ok(took < 6500, `navigate took ${took} ms`);
});

test('wait_for that saw the page move on returns once its condition holds, without waiting for the new page\'s load', async () => {
  const { call, go } = setup();
  setTimeout(() => go('stuck', 'https://news.example/done'), 50);
  const started = Date.now();
  assert.equal((await call('wait_for', { url: '/done' })).error, false);
  assert.ok(Date.now() - started < 2000, `wait_for took ${Date.now() - started} ms`);
});

test('wait_for text that does not come (or go) says so in plain words, not with Playwright\'s bare timeout', async () => {
  const { call } = setup();
  const missing = await call('wait_for', { text: 'Inbox', timeout_ms: 50 });
  assert.equal(missing.error, true);
  assert.match(missing.text, /The text "Inbox" did not appear on the page within 0\.05 s\. Call snapshot to see what the page shows\./);
  assert.doesNotMatch(missing.text, /locator\.waitFor|Timeout 50ms/);
  const hidden = await call('wait_for', { text: 'Messages', timeout_ms: 50 });
  assert.match(hidden.text, /The text "Messages" is on the page but stayed hidden for 0\.05 s\./);
  const stays = await call('wait_for', { text_gone: 'Sign in', timeout_ms: 50 });
  assert.match(stays.text, /The text "Sign in" was still on the page after 0\.05 s\./);
});

test('wait_for text looks in iframes too (the snapshot shows them), and goes by any shown copy of the text', async () => {
  const { call } = setup();
  assert.equal((await call('wait_for', { text: 'Pay now', timeout_ms: 300 })).error, false, 'text only an iframe shows');
  assert.equal((await call('wait_for', { text: 'Menu', timeout_ms: 300 })).error, false, 'a hidden copy before a shown one');
  const gone = await call('wait_for', { text_gone: 'Menu', timeout_ms: 50 });
  assert.match(gone.text, /The text "Menu" was still on the page after/, 'not gone while a copy is shown');
});

test('wait_for text is not held up by an iframe that answers nothing (an ad stuck in its own process)', async () => {
  const { call } = setup({ stuck: true });
  const settled = (args) => Promise.race([call('wait_for', args), new Promise((r) => setTimeout(() => r('still waiting'), 3000))]);
  const shown = await settled({ text: 'Sign in', timeout_ms: 500 });
  assert.notEqual(shown, 'still waiting');
  assert.equal(shown.error, false, shown.text);
  const missing = await settled({ text: 'Inbox', timeout_ms: 500 });
  assert.notEqual(missing, 'still waiting');
  assert.match(missing.text, /The text "Inbox" did not appear on the page within 0\.5 s/);
  // Gone from the frames that answer: said with the one that didn't, never a plain "gone" (it may show it).
  const started = Date.now();
  const gone = await settled({ text_gone: 'Inbox', timeout_ms: 300 });
  assert.notEqual(gone, 'still waiting');
  assert.equal(gone.error, false, gone.text);
  assert.match(gone.text, /Wait finished: "Inbox" is gone from the page, except maybe from a frame that did not answer/);
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms for a 300 ms wait`);
});
