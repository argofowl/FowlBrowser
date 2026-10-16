// screenshot full_page on a page taller than Chromium can capture in one surface (16,384 px a side): cut, and said so,
// instead of a capture that never finishes. The page's size is read like Playwright reads it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

// height: the page's; the element e5 (main) is that tall less 500 px, 1,180 wide, at (10, 300) in the document.
function setup(height) {
  const shots = [];
  const main = { x: 10, y: 300, w: 1180, h: height - 500 };
  const element = (scrollHeight) => ({ scrollWidth: 1200, scrollHeight, offsetWidth: 1200, offsetHeight: scrollHeight, clientWidth: 1200, clientHeight: 800 });
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://news.example/', mainFrame: () => page, frames: () => [page], isClosed: () => false,
    async evaluate(fn) {
      globalThis.document = { body: element(height), documentElement: element(height) };
      try { return fn(); } finally { delete globalThis.document; }
    },
    async screenshot(options) {
      // Chromium hangs on a surface over 16,384 px.
      const tall = options.fullPage && (options.clip?.height ?? height) > 16_384;
      shots.push(options);
      if (tall) throw new Error(`page.screenshot: Timeout ${options.timeout}ms exceeded.`);
      return Buffer.from('jpeg');
    },
    ariaSnapshot: async () => '- main [ref=e5]',
    getByRef: () => ({
      count: async () => 1,
      evaluate: async (fn) => { globalThis.scrollX = 0; globalThis.scrollY = 0; try { return fn({ getBoundingClientRect: () => ({ left: main.x, top: main.y, width: main.w, height: main.h }) }); } finally { delete globalThis.scrollX; delete globalThis.scrollY; } },
      screenshot: async (options) => {
        shots.push({ ...options, element: true });
        if (main.h > 16_384) throw new Error(`locator.screenshot: Timeout ${options.timeout}ms exceeded.`);
        return Buffer.from('jpeg');
      },
    }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'News' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 2, page);
  browser.tabs.set(2, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const shoot = async (args) => {
    if (args.ref) await tools.snapshot({ tab: tab.id });
    const result = await tools.screenshot({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') };
  };
  return { shoot, shots, page };
}

test('full_page on a page taller than 16,000 px is cut there and says so', async () => {
  const { shoot, shots } = setup(34_000);
  const result = await shoot({ full_page: true });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(shots[0].clip, { x: 0, y: 0, width: 1200, height: 16_000 });
  assert.match(result.text, /Screenshot of the full page, cut to its first 1,200x16,000 px of 1,200x34,000 \(the browser captures at most 16,000 px a side; for the rest, scroll and take viewport screenshots\), JPEG/);
});

test('full_page on a page that fits is captured whole, as before', async () => {
  const { shoot, shots } = setup(3_000);
  const result = await shoot({ full_page: true });
  assert.equal(result.error, false, result.text);
  assert.equal(shots[0].clip, undefined);
  assert.match(result.text, /Screenshot of the full page, JPEG, 1 image px = 1 CSS px\./);
});

test('an element taller than 16,000 px is cut from its own top, not a capture that never finishes', async () => {
  const { shoot, shots } = setup(34_000);
  const result = await shoot({ ref: 'e5' });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(shots.at(-1).clip, { x: 10, y: 300, width: 1180, height: 16_000 });
  assert.match(result.text, /Screenshot of the element e5, cut to its first 1,180x16,000 px of 1,180x33,500 \(the browser captures at most 16,000 px a side/);
});

test('an element that fits is screenshot as itself, as before', async () => {
  const { shoot, shots } = setup(3_000);
  const result = await shoot({ ref: 'e5' });
  assert.equal(result.error, false, result.text);
  assert.equal(shots.at(-1).element, true);
  assert.match(result.text, /Screenshot of the element e5, JPEG/);
});

test('a page too busy to answer the size read still gets its screenshot call ended by the timeout, not held forever', async () => {
  const { shoot, shots, page } = setup(3_000);
  page.evaluate = () => new Promise(() => {}); // a script that never yields
  const result = await Promise.race([shoot({ full_page: true, timeout_ms: 200 }), new Promise((r) => setTimeout(() => r('still waiting'), 1500))]);
  assert.notEqual(result, 'still waiting');
  assert.equal(shots.at(-1).clip, undefined, 'no cut without a size: Playwright\'s own capture and timeout decide');
});
