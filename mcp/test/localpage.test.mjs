// A tab that comes to show a local file agents may not open anyway (history back into one, a page's own history.back(),
// a link from one local file to another, a symlink, a frame) is never read or acted in: only navigate with a url,
// release, keep and close work there. An allowed local file is read like a web page.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Browser, Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const SECRET = 'file:///Users/me/notes/secret.html';

function setup(local = SECRET) {
  let url = 'https://example.com/';
  let tab;
  const go = (to) => { url = to; tab._newDocument(to); page.emit('framenavigated', page); };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => url, mainFrame: () => page, isClosed: () => false, frames: () => [page],
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
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), _settingUp: new Map(), _waiters: new Map(),
    relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  tab = new Tab(browser, 5, page);
  browser.tabs.set(5, tab);
  // The page as a new Tab finds it (a claim, a reattach, a server restart), through the production adoption.
  page.context = () => ({ newCDPSession: async () => ({ send: async () => ({ tabId: 5 }), detach: async () => {} }) });
  const adopt = async () => { tab = await Browser.prototype._adopt.call(browser, page); return tab; };
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: 'chrome:5', ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') };
  };
  return { call, url: () => url, page, tab, adopt };
}

const LOCAL = /this tab shows a local file that agents can't open \(there is no such file\), which FowlBrowser doesn't read; navigate it to a web page or an allowed local file, or close it/;

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
  assert.match(read.text, /showed or loaded a local file agents can't open while this ran.*result was discarded/);
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
    assert.match(back.text, /this tab shows a browser or extension page, not a web page, which FowlBrowser doesn't read; navigate it to a web page or an allowed local file, or close it/);
    assert.doesNotMatch(back.text, /SECRET PLANS/);
    for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['evaluate', { function: '() => 1' }], ['click', { x: 5, y: 5 }]]) {
      const result = await call(name, args);
      assert.ok(result.error, `${page} ${name}: ${result.text}`);
      assert.doesNotMatch(result.text, /SECRET PLANS/, name);
    }
  }
});

// A real prototype in a temp folder (not hidden, not in ~/Library) next to a hidden folder and a link into it.
test('an allowed local file is read like a web page; a link or symlink into a hidden folder, or a frame showing one, is refused', async (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-page-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'proto.html'), '<p>A</p>');
  fs.mkdirSync(path.join(dir, '.private'));
  fs.writeFileSync(path.join(dir, '.private', 'key.html'), 'SECRET PLANS');
  fs.symlinkSync(path.join(dir, '.private', 'key.html'), path.join(dir, 'link.html'));
  const proto = `${pathToFileURL(path.join(dir, 'proto.html')).href}?variant=A`;
  const hidden = pathToFileURL(path.join(dir, '.private', 'key.html')).href;
  const link = pathToFileURL(path.join(dir, 'link.html')).href;
  const { call, page, tab } = setup(link);
  page.evaluate = async () => true; // a page that stays where it is while it is read

  const opened = await call('navigate', { url: proto });
  assert.equal(opened.error, false, opened.text);
  assert.match(opened.text, new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/proto.html\\?variant=A`));
  assert.match(opened.text, /Back to my notes/);
  for (const [name, args] of [['snapshot', {}], ['screenshot', {}], ['evaluate', { function: '() => 1' }]]) {
    const result = await call(name, args);
    assert.equal(result.error, false, `${name}: ${result.text}`);
  }
  // Its own logs and requests are kept; a request for a hidden file it makes is not.
  page.emit('console', { type: () => 'log', text: () => 'ready', location: () => ({ url: proto }) });
  page.emit('console', { type: () => 'log', text: () => 'SECRET PLANS', location: () => ({ url: hidden }) });
  const request = (url) => ({ url: () => url, method: () => 'GET', resourceType: () => 'script', frame: () => page, failure: () => null });
  page.emit('response', { request: () => request(proto), status: () => 200 });
  page.emit('response', { request: () => request(hidden), status: () => 200 });
  page.emit('requestfailed', request(hidden));
  assert.deepEqual(tab.console.map((e) => e.text), ['ready']);
  assert.deepEqual(tab.network.map((e) => e.url), [proto]);

  // A frame showing the hidden file: nothing is read until the tab goes elsewhere.
  page.frames = () => [page, { url: () => hidden }];
  const framed = await call('snapshot', {});
  assert.match(framed.text, /a frame in this tab shows a local file that agents can't open \(it is hidden/);
  assert.doesNotMatch(framed.text, /SECRET PLANS/);
  assert.equal((await call('evaluate', { function: '() => 1' })).error, true);
  page.frames = () => [page];

  // The link resolves into the hidden folder: refused when asked for, and when reached anyway.
  assert.match((await call('navigate', { url: link })).text, /is a local file that can't be opened: it is hidden/);
  await page.goto(link);
  const reached = await call('snapshot', {});
  assert.match(reached.text, /this tab shows a local file that agents can't open \(it is hidden/);
  assert.doesNotMatch(reached.text, /SECRET PLANS/);
});

// An allowed prototype next to a hidden folder: what it loads from there, and frames it shows from there, wherever its
// own document came from.
function prototype(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-page-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'proto.html'), '<p>A</p>');
  fs.mkdirSync(path.join(dir, '.private'));
  fs.writeFileSync(path.join(dir, '.private', 'key.svg'), 'SECRET PLANS');
  return { proto: pathToFileURL(path.join(dir, 'proto.html')).href, hidden: pathToFileURL(path.join(dir, '.private', 'key.svg')).href };
}
const request = (page, url, { navigation = false, type = 'image' } = {}) => ({ url: () => url, method: () => 'GET', resourceType: () => type,
  frame: () => page, isNavigationRequest: () => navigation, failure: () => null });

test('a page that loaded a refused local file (an <img>, a <script>) is not read at all until the tab shows a new page', async (t) => {
  const { proto, hidden } = prototype(t);
  const { call, page, tab } = setup();
  page.evaluate = async () => true;
  assert.equal((await call('navigate', { url: proto })).error, false);
  // Its own navigation to a refused file is not a load of this document (the new one is refused by its URL).
  page.emit('request', request(page, hidden, { navigation: true, type: 'document' }));
  assert.equal((await call('snapshot', {})).error, false);
  page.emit('console', { type: () => 'log', text: () => 'ready', location: () => ({ url: proto }) });
  page.emit('request', request(page, hidden));
  page.emit('console', { type: () => 'log', text: () => 'SECRET PLANS', location: () => ({ url: proto }) });
  assert.deepEqual(tab.console, [], 'nothing it logged is kept, also from before');
  const LOADED = /this page loaded a local file that agents can't open \(it is hidden.*\), so none of it is read until the tab shows another page/;
  for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['snapshot', { find: 'SECRET' }], ['screenshot', {}], ['screenshot', { frames: 2 }],
    ['evaluate', { function: '() => 1' }], ['console', {}], ['network', {}], ['click', { x: 5, y: 5 }]]) {
    const result = await call(name, args);
    assert.ok(result.error || /Snapshot unavailable/.test(result.text), `${name} ${JSON.stringify(args)}: ${result.text}`);
    assert.match(result.text, LOADED, name);
  }
  const again = await call('navigate', { url: proto }); // a new document of the same file
  assert.equal(again.error, false, again.text);
  assert.match(again.text, /Back to my notes/);
});

test('a frame showing a refused local file is refused under an about:blank or data: page too', async (t) => {
  const { hidden } = prototype(t);
  for (const main of ['about:blank', 'data:text/html,<iframe>']) {
    const { call, page } = setup();
    page.evaluate = async () => true;
    assert.equal((await call('navigate', { url: main })).error, false);
    page.frames = () => [page, { url: () => hidden }];
    for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['screenshot', {}], ['evaluate', { function: '() => 1' }]]) {
      const result = await call(name, args);
      assert.match(result.text, /a frame in this tab shows a local file that agents can't open \(it is hidden/, `${main} ${name}`);
      assert.doesNotMatch(result.text, /SECRET PLANS/);
    }
  }
});

test('a snapshot, text or screenshot read while a refused file showed and went again is discarded, not numbered or kept', async (t) => {
  const { proto, hidden } = prototype(t);
  const { call, page, tab } = setup();
  page.evaluate = async () => true;
  assert.equal((await call('navigate', { url: proto })).error, false);
  const { snapshotCount, snapshotBaseline } = tab;
  // The page goes to the refused file and straight back to a new document of itself while the read runs.
  const flip = (value) => async () => { page.goto(hidden); await page.goto(proto); return value; };
  page.ariaSnapshot = flip('- heading "SECRET PLANS"');
  const snap = await call('snapshot', {});
  assert.match(snap.text, /Snapshot unavailable: a local file agents can't open showed in this tab while it was read.*discarded/);
  assert.doesNotMatch(snap.text, /SECRET PLANS/);
  assert.equal(tab.snapshotCount, snapshotCount, 'not numbered');
  assert.equal(tab.snapshotBaseline, snapshotBaseline, 'not kept for changes-only results');
  page.ariaSnapshot = async () => '- link "Back to my notes"';
  page.childFrames = () => [];
  page.evaluate = async (fn) => (String(fn).includes('innerText') ? flip({ name: 'body', text: 'SECRET PLANS' })() : true);
  page.screenshot = flip(Buffer.from('SECRET PLANS'));
  for (const [name, args] of [['snapshot', { mode: 'text' }], ['screenshot', {}], ['screenshot', { frames: 2 }]]) {
    const result = await call(name, args);
    assert.equal(result.error, true, `${name} ${JSON.stringify(args)}: ${result.text}`);
    assert.match(result.text, /showed in this tab while it was read.*discarded/, name);
    assert.doesNotMatch(result.text, /SECRET PLANS|\[image\]/, name);
  }
  // A refused frame that came and went: its document is refused for good.
  page.ariaSnapshot = async () => { tab.loaded(hidden); return '- heading "SECRET PLANS"'; };
  const framed = await call('snapshot', {});
  assert.match(framed.text, /Snapshot unavailable: this page loaded a local file that agents can't open/);
  assert.equal(tab.snapshotBaseline, snapshotBaseline);
});

test('a local page that was loaded before its Tab existed (claimed, reattached, after a restart) is not read until it loads again', async (t) => {
  const { proto, hidden } = prototype(t);
  const { call, page, adopt } = setup();
  page.evaluate = async () => true;
  assert.equal((await call('navigate', { url: proto })).error, false);
  page.emit('request', request(page, hidden)); // it loaded a refused file: the old Tab knew, the new one can't
  const tab = await adopt();
  const UNWATCHED = /this local page was loaded before FowlBrowser watched it, so it isn't read; navigate it to its URL again to read it/;
  for (const [name, args] of [['snapshot', {}], ['snapshot', { mode: 'text' }], ['screenshot', {}], ['evaluate', { function: '() => 1' }],
    ['console', {}], ['network', {}], ['click', { x: 5, y: 5 }], ['trace_start', {}], ['lighthouse', { mode: 'snapshot' }]]) {
    const result = await call(name, args);
    assert.ok(result.error || /Snapshot unavailable/.test(result.text), `${name} ${JSON.stringify(args)}: ${result.text}`);
    assert.match(result.text, UNWATCHED, name);
    assert.doesNotMatch(result.text, /SECRET PLANS/, name);
  }
  page.emit('console', { type: () => 'log', text: () => 'SECRET PLANS', location: () => ({ url: proto }) });
  assert.deepEqual(tab.console, [], 'nothing it logs is kept');
  const again = await call('navigate', { url: proto }); // a new document, watched from its start
  assert.equal(again.error, false, again.text);
  assert.equal((await call('evaluate', { function: '() => 1' })).error, false);

  // A web page, or a tab_open tab (about:blank until it loads its URL), is read as before.
  for (const start of ['https://example.com/', 'about:blank']) {
    const fresh = setup();
    fresh.page.evaluate = async () => true;
    await fresh.page.goto(start);
    await fresh.adopt();
    assert.equal((await fresh.call('evaluate', { function: '() => 1' })).error, false, start);
    assert.equal((await fresh.call('navigate', { url: proto })).error, false, start);
    assert.equal((await fresh.call('snapshot', {})).error, false, start);
  }
});

test('a title read while the page loaded a refused file, or showed one and left it, is left out of the header', async (t) => {
  const { proto, hidden } = prototype(t);
  const { call, page, tab } = setup();
  page.evaluate = async () => true;
  assert.equal((await call('navigate', { url: proto })).error, false);
  // The file's script sets document.title while the title is asked for.
  tab.currentTitle = async () => { tab.loaded(hidden, false); return 'SECRET PLANS'; };
  const loaded = await call('snapshot', {});
  assert.match(loaded.text, /Snapshot unavailable: this page loaded a local file that agents can't open/);
  assert.doesNotMatch(loaded.text, /SECRET PLANS/);
  // A refused page that came and went while the title was read: the page reads again, without that title.
  const { call: call2, page: page2, tab: tab2 } = setup();
  page2.evaluate = async () => true;
  assert.equal((await call2('navigate', { url: proto })).error, false);
  tab2.currentTitle = async () => { page2.goto(hidden); await page2.goto(proto); return 'SECRET PLANS'; };
  const flipped = await call2('snapshot', {});
  assert.doesNotMatch(flipped.text, /SECRET PLANS/);
  assert.match(flipped.text, /^Browser: Chrome · Tab: chrome:5 · file:\/\/\S+proto\.html$/m);
});
