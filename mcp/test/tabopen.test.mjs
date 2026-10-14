// tab_open with a page that opens a dialog while it loads: reported at once, as navigate does, not after the whole
// navigation timeout. Playwright keeps a dialog open while anyone listens (the Tab does), and the load waits for it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

function setup({ alerts = true } = {}) {
  let loadedPage = false;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://intranet.example/', mainFrame: () => page, isClosed: () => false,
    // The page's first script calls alert(): the document can't finish parsing until it is answered.
    goto(url, { timeout }) {
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
      if (method === 'tabs.open') return { id: 5 };
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
  return { call, loaded: () => loadedPage };
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
