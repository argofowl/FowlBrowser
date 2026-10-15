// A tab that comes to show a local file anyway (history back into one, a page's own history.back(), a link from one
// local file to another) is never read or acted in: only navigate with a url, release, keep and close work there.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const SECRET = 'file:///Users/me/notes/secret.html';

function setup(local = SECRET) {
  let url = 'https://example.com/';
  let tab;
  const go = (to) => { url = to; tab._newDocument(to); page.emit('framenavigated', page); };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => url, mainFrame: () => page, isClosed: () => false,
    async evaluate(fn) {
      const source = String(fn);
      if (source.includes('history.back')) return go(local);
      // A page that jumps into a local file and straight back while the agent's own read runs.
      if (source.includes('innerText')) { go(SECRET); const text = 'SECRET PLANS'; go('https://example.com/'); return text; }
      if (source.includes('canGoBack')) return { url, can: true };
      return true; // document.readyState === 'complete'
    },
    waitForEvent: (name) => new Promise((resolve) => page.once(name, resolve)),
    waitForLoadState: async () => {},
    async goto(to) { go(to); return null; },
    ariaSnapshot: async () => (url === local ? '- heading "SECRET PLANS"' : '- link "Back to my notes"'),
    screenshot: async () => Buffer.from('jpeg'),
    // A click on the page that lands on a local file (a link from one local file to another).
    mouse: { click: async () => go(SECRET), move: async () => {} },
    keyboard: { down: async () => {}, up: async () => {} },
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: url === local ? 'SECRET PLANS' : 'Example' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(),
    relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  tab = new Tab(browser, 5, page);
  browser.tabs.set(5, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: 'chrome:5', ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') };
  };
  return { call, url: () => url, page, tab };
}

const LOCAL = /this tab shows a local file, which FowlBrowser doesn't read; navigate it to a web page or close it/;

test('back into a local file page: the result shows nothing of it, and every tool but navigate with a url refuses the tab', async () => {
  const { call, url } = setup();
  const back = await call('navigate', { action: 'back' });
  assert.equal(url(), SECRET);
  assert.match(back.text, LOCAL);
  assert.doesNotMatch(back.text, /SECRET PLANS/);
  for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['screenshot', {}], ['evaluate', { function: '() => document.body.innerText' }],
    ['click', { x: 5, y: 5 }], ['navigate', { action: 'back' }], ['navigate', { action: 'reload' }], ['export', {}], ['console', {}], ['network', {}],
    ['wait_for', { seconds: 1 }], ['press_key', { key: 'Enter' }], ['tab_handoff', { reason: 'log in' }], ['trace_start', {}], ['lighthouse', {}]]) {
    const result = await call(name, args);
    assert.ok(result.error, `${name} ${JSON.stringify(args)}: ${result.text}`);
    assert.match(result.text, LOCAL, name);
    assert.doesNotMatch(result.text, /SECRET PLANS/, name);
  }
  const away = await call('navigate', { url: 'https://example.org/' });
  assert.equal(away.error, false, away.text);
  assert.match(away.text, /Back to my notes/);
});

test('an action whose page lands on a local file: its result shows no snapshot or title of it', async () => {
  const { call, url } = setup();
  const clicked = await call('click', { x: 10, y: 10 });
  assert.equal(url(), SECRET);
  assert.equal(clicked.error, false, clicked.text);
  assert.match(clicked.text, LOCAL);
  assert.doesNotMatch(clicked.text, /SECRET PLANS/);
  assert.match((await call('snapshot', {})).text, LOCAL);
});

test('a read during which the page went to a local file and back is discarded; nothing a local page logs is kept', async () => {
  const { call, page, tab } = setup();
  const read = await call('evaluate', { function: '() => document.body.innerText' });
  assert.equal(read.error, true);
  assert.match(read.text, /showed a local file while this ran.*result was discarded/);
  assert.doesNotMatch(read.text, /SECRET PLANS/);

  await call('navigate', { action: 'back' }); // now on the local page
  page.emit('console', { type: () => 'log', text: () => 'SECRET PLANS', location: () => ({ url: SECRET }) });
  page.emit('pageerror', new Error('SECRET PLANS'));
  assert.equal(tab.console.length, 0);
});

test('back into an extension or browser page: nothing of it is read, and tools refuse the tab as for a local file', async () => {
  for (const page of ['chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html', 'chrome://settings/passwords', 'devtools://devtools/x.html']) {
    const { call, url } = setup(page);
    const back = await call('navigate', { action: 'back' });
    assert.equal(url(), page);
    assert.match(back.text, /this tab shows a browser or extension page, not a web page, which FowlBrowser doesn't read; navigate it to a web page or close it/);
    assert.doesNotMatch(back.text, /SECRET PLANS/);
    for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['evaluate', { function: '() => 1' }], ['click', { x: 5, y: 5 }]]) {
      const result = await call(name, args);
      assert.ok(result.error, `${page} ${name}: ${result.text}`);
      assert.doesNotMatch(result.text, /SECRET PLANS/, name);
    }
  }
});
