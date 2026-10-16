// snapshot mode "text" on documents without a body: one that has only just started loading (a "Just a moment..."
// challenge page reloading itself) and an SVG or XML file. The page function runs here against a stand-in document.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const element = (tagName, text) => ({ tagName, id: '', getAttribute: () => null, innerText: text });

// frames: the main frame's iframes, { url, shown (a box worth reading inside what is read), document }.
function setup(document, frames = []) {
  const waits = [];
  const run = (doc, fn, arg) => {
    globalThis.document = doc;
    try { return fn(arg); } finally { delete globalThis.document; }
  };
  const children = frames.map(({ url, shown, document: doc, stuck }) => ({
    url: () => url,
    frameElement: async () => ({ evaluate: async () => shown, dispose: async () => {} }),
    evaluate: async (fn, arg) => (stuck ? new Promise(() => {}) : run(doc, fn, arg)), // stuck: its script never yields
  }));
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://shop.example/', isClosed: () => false,
    mainFrame: () => ({ childFrames: () => children }), frames: () => [page, ...children],
    async evaluate(fn, arg) {
      globalThis.document = document;
      try { return fn(arg); } finally { delete globalThis.document; }
    },
    // The parser reaches <body> and the document's DOMContentLoaded fires.
    async waitForLoadState(state) {
      waits.push(state);
      Object.assign(document, { readyState: 'interactive', body: element('BODY', 'Shop\n\nAll   products') });
    },
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Shop' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 4, page);
  browser.tabs.set(4, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const text = async () => {
    const result = await tools.snapshot({ tab: tab.id, mode: 'text' });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return { text, waits };
}

test('a document still before its <body> is read once the body is there, not failed on', async () => {
  const { text, waits } = setup({ readyState: 'loading', querySelector: () => null, body: null, documentElement: element('HTML', '') });
  const result = await text();
  assert.equal(result.error, false, result.text);
  assert.deepEqual(waits, ['domcontentloaded']);
  assert.match(result.text, /Text of <body> \(readable text only.*\n^Shop\nAll products$/m);
});

test('a document with no body at all (an SVG file) gives its root element\'s text', async () => {
  const svg = { ...element('svg', undefined), textContent: 'Monthly sales' };
  const { text, waits } = setup({ readyState: 'complete', querySelector: () => null, body: null, documentElement: svg });
  const result = await text();
  assert.equal(result.error, false, result.text);
  assert.deepEqual(waits, []);
  assert.match(result.text, /Text of <svg> .*\n^Monthly sales$/m);
});

test('the page\'s iframes that show something are read too, after its own text (a sign-in form in an iframe)', async () => {
  const doc = (text) => ({ readyState: 'complete', querySelector: () => null, body: element('BODY', text), documentElement: element('HTML', text) });
  const { text } = setup(doc('App Store Connect\nCopyright © 2026 Apple Inc.'), [
    { url: 'https://idmsa.apple.com/appleauth/auth/signin?widgetKey=x', shown: true, document: doc('Sign in to App Store Connect\nEmail or Phone Number') },
    { url: 'https://tracker.example/pixel', shown: false, document: doc('tracking') },
  ]);
  const result = await text();
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /^App Store Connect\nCopyright © 2026 Apple Inc\.\n\[iframe: idmsa\.apple\.com\]\nSign in to App Store Connect\nEmail or Phone Number$/m);
  assert.doesNotMatch(result.text, /tracking/);
});

test('an iframe whose script never yields is left out after a moment instead of holding the page\'s text', async () => {
  const doc = (text) => ({ readyState: 'complete', querySelector: () => null, body: element('BODY', text), documentElement: element('HTML', text) });
  const { text } = setup(doc('News article'), [{ url: 'https://ads.example/slot', shown: true, stuck: true, document: doc('Ad') }]);
  const result = await Promise.race([text(), new Promise((r) => setTimeout(() => r('still waiting'), 4000))]);
  assert.notEqual(result, 'still waiting');
  assert.match(result.text, /^News article$/m);
});

test('snapshot mode "links" leaves out in-page anchors, "#" (the usual script-driven control) included', async () => {
  const base = 'https://shop.example/list?page=1';
  const link = (href, text) => ({ href: new URL(href, base).href, innerText: text, getAttribute: () => null, querySelector: () => null });
  const body = { tagName: 'BODY', id: '', querySelectorAll: () => [link('/item/1', 'Blue mug'), link('#', 'Sort by price'), link('#reviews', 'Reviews'),
    link('?page=2', 'Next page'), link('/item/1', 'Blue mug (again)')] };
  const document = { querySelector: () => null, body, documentElement: body };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => base, frames: () => [page], isClosed: () => false,
    async evaluate(fn, arg) {
      Object.assign(globalThis, { document, location: { href: base } });
      try { return fn(arg); } finally { delete globalThis.document; delete globalThis.location; }
    },
  });
  const host = { async request(method, params) {
    if (method === 'tabs.isShown') return { shown: false };
    if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Mugs' } };
    throw new Error(`not in this double: ${method}`);
  } };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 14, page);
  browser.tabs.set(14, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const text = (await tools.snapshot({ tab: tab.id, mode: 'links' })).content[0].text;
  assert.match(text, /Links of <body> \(2;/);
  assert.match(text, /- Blue mug → https:\/\/shop\.example\/item\/1\n- Next page → https:\/\/shop\.example\/list\?page=2$/);
});
