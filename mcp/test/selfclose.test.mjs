// A page that closes its own tab during a call (window.close(), as sign-in and payment popups do once they are done):
// the call says so instead of failing with Playwright's "Target page, context or browser has been closed".
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const CLOSED = 'Target page, context or browser has been closed';

// One controlled tab whose key press makes the page close the tab: `itself` (the popup script reported window.close(),
// popups.mjs sets closedByPageAt) or not (the tab went some other way); `during` the press (Playwright's press fails)
// or right after it (the snapshot read fails).
function setup({ itself = true, during = true, answerFails = false } = {}) {
  let closed = false;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://idp.example/consent', mainFrame: () => page, frames: () => [page],
    isClosed: () => closed,
    keyboard: {
      async press() {
        if (itself) tab.closedByPageAt = Date.now();
        closed = true;
        page.emit('close');
        if (during) throw new Error(`keyboard.press: ${CLOSED}`);
      },
    },
    async ariaSnapshot() {
      if (closed) throw new Error(`page.ariaSnapshot: ${CLOSED}`);
      return '- button "Continue" [ref=e1]';
    },
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return { ok: true };
      if (closed) throw new Error(`Tab ${params?.tabId ?? params?.[0]?.tabId} is not owned by this client`);
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Sign in' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 3, page);
  browser.tabs.set(3, tab);
  // An alert ("Payment complete") whose page closes the tab once it is answered, maybe before the answer's reply
  // (answerFails: Playwright's accept then fails too).
  tab.dialog = { type: () => 'alert', message: () => 'Payment complete', accept: () => page.keyboard.press().catch((e) => { if (answerFails) throw e; }) };
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return async (args) => {
    if (args.dialog) return call('dialog', { accept: true, snapshot: args.snapshot });
    tab.dialog = null;
    return call('press_key', { key: 'Enter', ...args });
  };
}

test('a page that closes its own tab during the action, or once its alert is answered: the result says so, not an error', async () => {
  for (const [during, snapshot, dialog] of [[true, false], [true, true], [false, true], [false, true, true]]) {
    const result = await setup({ during })({ snapshot, dialog });
    assert.equal(result.error, false, `during ${during}, snapshot ${snapshot}, dialog ${!!dialog}: ${result.text}`);
    assert.equal(result.text, 'Browser: Chrome · Tab: chrome:3\nThe page closed this tab itself (window.close(), as sign-in and payment popups do ' +
      'once they are done) during this call; the tab is gone.');
  }
});

test('a popup that closes itself before the answer to its alert comes back: the dialog result says so, not an error', async () => {
  const result = await setup({ answerFails: true })({ dialog: true, snapshot: true });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /The page closed this tab itself/);
});

test('a tab that closed some other way still fails the call', async () => {
  const result = await setup({ itself: false })({ snapshot: false });
  assert.equal(result.error, true);
  assert.match(result.text, /Target page, context or browser has been closed/);
});
