// An action whose page can't be read right after it (busy longer than the snapshot's timeout): the action was done, so
// the result says so and that the snapshot is missing, instead of failing as if the action had not happened (an agent
// would do it again: a second purchase, a second message). A page that closed its own tab still reports that.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

function setup({ closes = false } = {}) {
  const pressed = [];
  let closed = false;
  let tab;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://shop.example/cart', mainFrame: () => page, isClosed: () => closed,
    keyboard: {
      // Enter places the order; the page then runs a long script (or closes its own tab, as payment popups do).
      press: async (key) => {
        pressed.push(key);
        if (closes) { tab.closedByPageAt = Date.now(); closed = true; }
      },
    },
    ariaSnapshot: async () => { throw new Error(closes ? 'page.ariaSnapshot: Target page, context or browser has been closed' : 'page.ariaSnapshot: Timeout 10000ms exceeded.'); },
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Cart' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  tab = new Tab(browser, 8, page);
  browser.tabs.set(8, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return { call, pressed };
}

test('an action done on a page too busy to read afterwards succeeds, saying the snapshot is missing', async () => {
  const { call, pressed } = setup();
  const result = await call('press_key', { key: 'Enter' });
  assert.deepEqual(pressed, ['Enter']);
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /Snapshot unavailable after the action \(page\.ariaSnapshot: Timeout 10000ms exceeded\.\): the action itself was done\. Call snapshot to see the page before acting again\./);
});

test('a page that closed its own tab after the action still says so', async () => {
  const { call } = setup({ closes: true });
  const result = await call('press_key', { key: 'Enter' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /The page closed this tab itself/);
});

test('a dialog answered on a page too busy to read afterwards is reported answered, not failed', async () => {
  const answered = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://shop.example/orders', mainFrame: () => page, isClosed: () => false,
    ariaSnapshot: async () => { throw new Error('page.ariaSnapshot: Timeout 10000ms exceeded.'); },
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Orders' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 9, page);
  browser.tabs.set(9, tab);
  // "Delete this order?": accepting it deletes the order, and the page then runs a long script.
  tab.dialog = { type: () => 'confirm', message: () => 'Delete this order?', accept: async () => answered.push('accept'), dismiss: async () => answered.push('dismiss') };
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const result = await tools.dialog({ tab: tab.id, accept: true });
  const text = result.content.map((c) => c.text).join('\n');
  assert.deepEqual(answered, ['accept']);
  assert.equal(result.isError, undefined, text);
  assert.match(text, /Accepted confirm "Delete this order\?"\.\nSnapshot unavailable after the action/);
});
