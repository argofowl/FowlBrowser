// tab_open with a page that opens a dialog while it loads: reported at once, as navigate does, not after the whole
// navigation timeout. Playwright keeps a dialog open while anyone listens (the Tab does), and the load waits for it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

function setup({ alerts = true, opened = { id: 5 }, pageUrl = 'https://intranet.example/' } = {}) {
  let loadedPage = false;
  const requests = [];
  const loads = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => pageUrl, mainFrame: () => page, frames: () => [page], isClosed: () => false,
    // The page's first script calls alert(): the document can't finish parsing until it is answered.
    async reload() { loads.push(['reload']); loadedPage = true; return null; },
    goto(url, { timeout }) {
      loads.push(['goto', url]);
      pageUrl = url;
      if (!alerts) { loadedPage = true; return Promise.resolve(null); }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`page.goto: Timeout ${timeout}ms exceeded.`)), timeout);
        const dialog = { type: () => 'alert', message: () => 'Please log in with your badge', defaultValue: () => '',
          accept: async () => { clearTimeout(timer); loadedPage = true; resolve(null); page.emit('dialogclosed', dialog); } };
        setTimeout(() => page.emit('dialog', dialog), 20);
      });
    },
    evaluate: async () => loadedPage,
    waitForLoadState: async () => {},
    ariaSnapshot: async () => '- heading "Intranet" [level=1]',
    screenshot: async () => Buffer.from('jpeg'),
  });
  const host = {
    async request(method, params) {
      requests.push([method, params]);
      if (method === 'tabs.open') return opened;
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Intranet' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.playwright = async () => {};
  browser.waitForTab = async (id) => browser.tabs.get(id);
  browser.tabs.set(5, new Tab(browser, 5, page));
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name](args);
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n'), images: result.content.filter((c) => c.type === 'image').length };
  };
  return { call, loaded: () => loadedPage, requests, loads };
}

test('tab_open reports a dialog the page opens while it loads at once; once it is answered, the load goes on and later calls wait for it', async () => {
  const { call, loaded } = setup();
  const started = Date.now();
  const opened = await call('tab_open', { browser: 'chrome', url: 'https://intranet.example/', timeout_ms: 3000 });
  assert.equal(opened.error, false, opened.text);
  assert.ok(Date.now() - started < 1500, `tab_open took ${Date.now() - started} ms`);
  assert.match(opened.text, /^Browser: Chrome · Tab: chrome:5 · Intranet · https:\/\/intranet\.example\/\nDialog open: alert "Please log in with your badge"\. .*dialog tool\.\nOpened chrome:5 in Chrome\.$/);
  assert.equal(loaded(), false);
  assert.match((await call('dialog', { tab: 'chrome:5', accept: true, snapshot: false })).text, /Accepted alert "Please log in with your badge"\./);
  const after = await call('snapshot', { tab: 'chrome:5' });
  assert.ok(loaded(), 'the load went on');
  assert.match(after.text, /heading "Intranet"/);
});

test('tab_open with screenshot: true returns the page\'s picture too, as actions do', async () => {
  const { call } = setup({ alerts: false });
  const opened = await call('tab_open', { browser: 'chrome', url: 'https://intranet.example/', screenshot: true });
  assert.equal(opened.error, false, opened.text);
  assert.equal(opened.images, 1);
});

test('tab_open for_user with a group asks for a redo match; a reused tab is reloaded and the group\'s other tabs are listed', async () => {
  const groupTabs = Array.from({ length: 12 }, (_, i) => ({ id: 53 + i, title: i ? `Variant ${i}` : '', url: `https://proto.example/${i}` }));
  const { call, requests, loads } = setup({ alerts: false, opened: { id: 5, groupId: 7, reused: true, groupTabs }, pageUrl: 'https://proto.example/a?v=2' });
  const opened = await call('tab_open', { browser: 'chrome', url: 'https://proto.example/a?v=2', for_user: true, group: 'Nearby places prototypes', snapshot: false });
  assert.equal(opened.error, false, opened.text);
  assert.deepEqual(requests.find(([m]) => m === 'tabs.open')[1],
    { group: 'Nearby places prototypes', muted: undefined, forUser: true, matchUrl: 'https://proto.example/a?v=2' });
  assert.deepEqual(loads, [['reload']], 'reloaded in place, not navigated');
  assert.match(opened.text, /^Reloaded your earlier tab chrome:5 in group "Nearby places prototypes" \(same URL\) instead of opening another\.$/m);
  assert.match(opened.text, /^It is the user's tab, in the tab group "Nearby places prototypes", and stays open/m);
  assert.match(opened.text, /^Also in group "Nearby places prototypes": chrome:53 · \(no title\) · https:\/\/proto\.example\/0, chrome:54 · Variant 1 · https:\/\/proto\.example\/1, .*chrome:62 · Variant 9 · https:\/\/proto\.example\/9, and 2 more\.$/m);
});

// The extension matches URLs without their fragment: a redo for another fragment reloads too (a fragment-only goto would
// keep the old document), then applies the asked fragment; a reused tab showing another URL is navigated, and says so.
test('tab_open redo: another fragment reloads, then goes to the asked fragment; another URL is loaded, not called a reload', async () => {
  const group = 'Nearby places prototypes';
  const reused = { id: 5, groupId: 7, reused: true };
  let { call, loads } = setup({ alerts: false, opened: reused, pageUrl: 'https://proto.example/a#overview' });
  let opened = await call('tab_open', { browser: 'chrome', url: 'https://proto.example/a#details', for_user: true, group, snapshot: false });
  assert.equal(opened.error, false, opened.text);
  assert.deepEqual(loads, [['reload'], ['goto', 'https://proto.example/a#details']]);
  assert.match(opened.text, /^Reloaded your earlier tab chrome:5 in group "Nearby places prototypes" \(same URL\) instead of opening another\.$/m);

  ({ call, loads } = setup({ alerts: false, opened: reused, pageUrl: 'https://proto.example/b' }));
  opened = await call('tab_open', { browser: 'chrome', url: 'https://proto.example/a', for_user: true, group, snapshot: false });
  assert.deepEqual(loads, [['goto', 'https://proto.example/a']]);
  assert.match(opened.text, /^Loaded the URL in your earlier tab chrome:5 in group "Nearby places prototypes" instead of opening another\.$/m);
});

test('tab_open without a group or for_user asks for no match and navigates as before', async () => {
  const { call, requests, loads } = setup({ alerts: false, opened: { id: 5, groupId: -1 } });
  const opened = await call('tab_open', { browser: 'chrome', url: 'https://intranet.example/', for_user: true, snapshot: false });
  assert.equal(opened.error, false, opened.text);
  assert.deepEqual(requests.find(([m]) => m === 'tabs.open')[1], { group: undefined, muted: undefined, forUser: true });
  assert.deepEqual(loads, [['goto', 'https://intranet.example/']]);
  assert.match(opened.text, /^Opened chrome:5 in Chrome\.\nIt is the user's tab and stays open/m);
  assert.doesNotMatch(opened.text, /Also in group/);
});
