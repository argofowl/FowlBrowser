// scroll without ref: what the result says moved, read once the wheel has landed (Chromium applies a wheel turn after
// Input.dispatchMouseEvent returns), and which box a wheel at the viewport centre moves (app shells and phone mock-ups
// scroll in a box while the window stays put). The page functions run here against a stand-in DOM.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools, WHEEL_TARGET_FN } from '../src/tools.mjs';

const LAND_MS = 40; // a wheel turn lands this long after mouse.wheel returned

// A box (or the page's root) with overflow, sizes and a parent; scrolled by `top`.
function box(name, { overflowY = 'visible', height = 600, content = height, parent = null, id = '' } = {}) {
  return { localName: name, id, style: { overflowY, overflowX: 'visible' }, scrollTop: 0, scrollLeft: 0, clientHeight: height, scrollHeight: content,
    clientWidth: 800, scrollWidth: 800, parentElement: parent, getRootNode: () => ({}) };
}

// A window 1200x800 whose page is pageHeight tall, with `hit` under the viewport centre.
function setup({ pageHeight, hit }) {
  const html = box('html', { height: 800, content: pageHeight });
  const body = box('body', { parent: html });
  const win = { innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0 };
  const doc = { documentElement: html, body, elementFromPoint: () => hit?.(body) ?? body };
  win.document = doc;
  const run = (fn, ...args) => {
    const globals = { document: doc, window: win, innerWidth: 1200, innerHeight: 800, scrollX: win.scrollX, scrollY: win.scrollY, getComputedStyle: (n) => n.style };
    Object.assign(globalThis, globals);
    try { return fn(...args); } finally { for (const key of Object.keys(globals)) delete globalThis[key]; }
  };
  const target = hit?.(body);
  const scroller = (n) => { for (; n && n !== body; n = n.parentElement) if (n.style.overflowY === 'auto') return n; return null; };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, frames: () => [page], isClosed: () => false,
    evaluate: async (fn, arg) => run(fn, arg),
    evaluateHandle: async (fn, arg) => {
      const value = run(fn, arg);
      return { asElement: () => value, evaluate: async (f, a) => run(f, value, a), dispose: async () => {} };
    },
    mouse: {
      move: async () => {},
      // The wheel moves the scroller under the pointer (else the page), clamped, a moment after the call returns.
      wheel: async (dx, dy) => setTimeout(() => {
        const s = scroller(target);
        if (s) s.scrollTop = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, s.scrollTop + dy));
        else win.scrollY = Math.max(0, Math.min(pageHeight - 800, win.scrollY + dy));
      }, LAND_MS),
    },
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'App' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 3, page);
  browser.tabs.set(3, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const scroll = async (args) => {
    const result = await tools.scroll({ tab: tab.id, snapshot: false, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return { scroll, win, run };
}

test('scroll reports where the page landed, not where it was before the wheel took effect', async () => {
  const { scroll } = setup({ pageHeight: 5000 });
  const first = await scroll({ direction: 'down' });
  assert.equal(first.error, false, first.text);
  assert.match(first.text, /Scrolled down 1 page\. Window scroll position: x=0 y=640 \(max y 4200\)\./);
  assert.match((await scroll({ direction: 'down', pages: 2 })).text, /y=1920 \(max y 4200\)/);
});

test('scroll on a page whose content scrolls in a box says the box moved, by pages of the box', async () => {
  let content;
  const { scroll } = setup({ pageHeight: 800, hit: (body) => { content ??= box('main', { overflowY: 'auto', height: 500, content: 8000, parent: body, id: 'content' }); return box('li', { parent: content }); } });
  const result = await scroll({ direction: 'down' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /Scrolled the box under the viewport centre \(<main#content>\) down 1 page: scrollTop 400 of 7500\./);
  assert.doesNotMatch(result.text, /Window scroll position: x=0 y=0/);
});

test('scroll where nothing can move says so at once, with what to do', async () => {
  const { scroll } = setup({ pageHeight: 800 });
  const started = Date.now();
  const result = await scroll({ direction: 'down' });
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assert.match(result.text, /nothing moved: the window does not scroll \(its content fits\) and no box under the viewport centre scrolls down\. To scroll a box elsewhere, call scroll with its ref and direction\./);
});

test('WHEEL_TARGET_FN: the innermost box under the centre that can still move that way, else the page', () => {
  const { run } = setup({ pageHeight: 5000 });
  const body = box('body');
  const list = box('ul', { overflowY: 'auto', height: 300, content: 3000, parent: body });
  const row = box('li', { parent: list });
  const call = (hit, args) => { globalThis.__hit = hit; return run(() => { document.elementFromPoint = () => hit; return WHEEL_TARGET_FN(args); }); };
  assert.equal(call(row, { vertical: true, sign: 1 }), list);
  assert.equal(call(row, { vertical: true, sign: -1 }), null, 'at its start, an up wheel goes on to the page');
  list.scrollTop = 2700;
  assert.equal(call(row, { vertical: true, sign: 1 }), null, 'at its end, a down wheel goes on to the page');
  assert.equal(call(row, { vertical: true, sign: -1 }), list);
  assert.equal(call(row, { vertical: false, sign: 1 }), null, 'it does not scroll sideways');
});

test('scroll over an iframe at the viewport centre says where the window went (a wheel the iframe can\'t use moves the page)', async () => {
  const { scroll } = setup({ pageHeight: 5000, hit: (body) => box('iframe', { parent: body, id: 'map' }) });
  const result = await scroll({ direction: 'down' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /Scrolled down 1 page\. Window scroll position: x=0 y=640 \(max y 4200\)\./);
});

test('scroll over an iframe that took the wheel itself says the window did not move and why', async () => {
  const { scroll } = setup({ pageHeight: 800, hit: (body) => box('iframe', { parent: body, id: 'map' }) });
  const result = await scroll({ direction: 'down' });
  assert.equal(result.error, false, result.text);
  assert.match(result.text, /over an iframe \(<iframe#map>\): the window did not move, so the page in the iframe may have scrolled \(it can't be read from here; take a screenshot to see\)\. Window scroll position: x=0 y=0 \(max y 0\)\./);
});
