// frames: screenshots taken while an action's effect plays out (an animation or transition), from the moment its input
// lands, frame_ms apart; and the screenshot tool's frames of a running animation. A dialog ends them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

function setup({ dialogAfter = Infinity } = {}) {
  const shots = []; // { at, options } per capture
  let tab;
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, isClosed: () => false,
    keyboard: { press: async () => { page.pressedAt = Date.now(); } },
    ariaSnapshot: async () => '- button "Open" [ref=e1]',
    async screenshot(options) {
      shots.push({ at: Date.now() - page.pressedAt, options });
      if (shots.length === dialogAfter) {
        tab.dialog = { type: () => 'alert', message: () => 'Saved', defaultValue: () => '' };
        tab.emit('dialog', tab.dialog);
      }
      return Buffer.from(`frame ${shots.length}`);
    },
    getByRef: () => ({
      count: async () => 1,
      evaluate: async () => ({ x: 60, y: 40, w: 100, h: 50 }),
      boundingBox: async () => ({ x: 10, y: 15, width: 100, height: 50 }),
    }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'App' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  tab = new Tab(browser, 4, page);
  browser.tabs.set(4, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
      images: result.content.filter((c) => c.type === 'image').map((c) => Buffer.from(c.data, 'base64').toString()) };
  };
  return { call, shots, page, tab };
}

test('an action with frames returns that many screenshots from its input on, frame_ms apart, in order', async () => {
  const { call, shots } = setup();
  const result = await call('press_key', { key: 'Enter', frames: 4, frame_ms: 60, snapshot: false });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(result.images, ['frame 1', 'frame 2', 'frame 3', 'frame 4']);
  const times = /4 frames from the action's first input to the page, at \+(\d+), \+(\d+), \+(\d+), \+(\d+) ms \(in that order\)\./.exec(result.text);
  assert.ok(times, result.text);
  assert.ok(Number(times[1]) < 40, `the first one at once: ${times[1]}`);
  for (let i = 1; i < shots.length; i++) assert.ok(shots[i].at - shots[i - 1].at >= 55, `spaced: ${shots.map((s) => s.at)}`);
});

test('frames and screenshot together: the frames, then the screenshot once the action settled', async () => {
  const { call } = setup();
  const result = await call('press_key', { key: 'Enter', frames: 2, frame_ms: 50, screenshot: true, snapshot: false });
  assert.deepEqual(result.images, ['frame 1', 'frame 2', 'frame 3']);
  assert.match(result.text, /2 frames .* \(in that order, then the screenshot once it settled\)\./);
});

test('a dialog the action opens ends its frames; the result says the dialog is open', async () => {
  const { call, shots, tab } = setup({ dialogAfter: 2 });
  const result = await call('press_key', { key: 'Enter', frames: 6, frame_ms: 50, snapshot: false });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(result.images, []);
  assert.match(result.text, /alert/i);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(shots.length, 2, 'no capture after the dialog opened (it holds captures)');
  tab.dialog = null; // answered: the frames still don't go on behind later calls
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(shots.length, 2);
});

test('screenshot frames: of the viewport, or of the area where a ref is, never waiting for it to be stable', async () => {
  const { call, shots } = setup();
  const viewport = await call('screenshot', { frames: 3, frame_ms: 50 });
  assert.equal(viewport.error, false, viewport.text);
  assert.equal(viewport.images.length, 3);
  assert.match(viewport.text, /3 screenshots of the viewport at \+\d+, \+\d+, \+\d+ ms \(in that order\)/);
  await call('snapshot', {});
  shots.length = 0;
  const element = await call('screenshot', { ref: 'e1', frames: 2, frame_ms: 50 });
  assert.match(element.text, /2 screenshots of the area of element e1/);
  assert.deepEqual(shots.map((s) => s.options.clip), [{ x: 10, y: 15, width: 100, height: 50 }, { x: 10, y: 15, width: 100, height: 50 }]);
  const full = await call('screenshot', { full_page: true, frames: 2 });
  assert.equal(full.error, true);
  assert.match(full.text, /not of the full page/);
});
