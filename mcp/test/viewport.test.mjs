// The viewport tool (src/viewport.mjs) against a fake host: what it sends as raw CDP, what it remembers on the Tab,
// the journal lines, and the clears before release and at turn end. FOWLBROWSER_RECORD is set before the modules load.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-viewport-'));
process.env.FOWLBROWSER_RECORD = dir;
const { Tab } = await import('../src/browsers.mjs');
const { registerTools } = await import('../src/tools.mjs');
const { endTurn } = await import('../src/turns.mjs');
const { keepViewportSize } = await import('../src/viewport.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const viewportLines = () => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((l) => l.type === 'viewport').map(({ t, ...rest }) => rest);

let nextId = 1;
// One browser with one controlled tab of the given origin. cdp lists the CDP methods sent (and their params), sent
// every host request in order; a CDP method put in `failing` fails once. zoom: the browser's zoom for the site, which
// Page.getLayoutMetrics reports (that read is not listed in cdp), as 1 while a mobile override is on (as Chromium does).
function setup({ origin = 'agent', kept = false, zoom } = {}) {
  let override = null;
  const zoomOf = { now: zoom };
  const tabId = nextId++;
  const cdp = [];
  const sent = [];
  const failing = new Set();
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'http://127.0.0.1:5411/mobile.html', frames: () => [page],
    evaluate: async () => ({ w: 390, h: 844, dpr: 3 }),
  });
  let owned = true;
  const host = {
    async request(method, params) {
      sent.push(method === 'chrome.debugger.sendCommand' ? params[1] : method);
      const info = { id: tabId, owner: owned ? 'you' : null, origin, kept, handedOver: kept, url: page.url() };
      if (method === 'tabs.info') return info;
      if (method === 'tabs.listAll') return [info];
      if (method === 'tabs.release' || method === 'chrome.tabs.remove') return void (owned = false);
      if (method !== 'chrome.debugger.sendCommand') throw new Error(`unexpected ${method}`);
      const [, name, args] = params;
      if (name === 'Target.getTargetInfo') return { targetInfo: { title: 'Mobile' } };
      if (name === 'Page.getLayoutMetrics') return { cssVisualViewport: { zoom: override?.mobile ? 1 : zoomOf.now } };
      if (name === 'Emulation.setDeviceMetricsOverride') override = args;
      if (name === 'Emulation.clearDeviceMetricsOverride') override = null;
      cdp.push([name, args]);
      if (failing.delete(name)) throw new Error(`${name} failed`);
      return {};
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { model: { hasTab: () => true }, viewports: new Map() } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  browser.forget = (id) => { browser.tabs.delete(id); browser.relay.viewports.delete(id); };
  const tab = new Tab(browser, tabId, page);
  browser.tabs.set(tabId, tab);
  const handlers = {};
  registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, { get: async () => browser, browsers: new Map([['chrome', browser]]) });
  const call = async (name, args) => {
    const result = await handlers[name]({ tab: tab.id, snapshot: false, ...args });
    return { ...result, text: result.content.map((c) => c.text).join('\n') };
  };
  return { tab, cdp, sent, call, browser, failing, zoomOf };
}

test('mobile: metrics override with the given scale and touch on, remembered and journaled', async () => {
  const { tab, cdp, call } = setup();
  const result = await call('viewport', { width: 390, height: 844, mobile: true, device_scale_factor: 3 });
  assert.equal(result.isError, undefined, result.text);
  assert.deepEqual(cdp, [
    ['Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }],
    ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
  ]);
  assert.deepEqual(tab.viewport, { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 });
  assert.equal(tab.browser.relay.viewports.get(tab.tabId), tab.viewport, 'the relay knows the override for Playwright\'s screenshots');
  assert.match(result.text, /Viewport set to 390x844 \(mobile\): the page reflowed \(innerWidth 390, innerHeight 844, devicePixelRatio 3\)/);
  assert.match(result.text, /reset with viewport reset: true/);
  assert.doesNotMatch(result.text, /user's tab/);
  assert.deepEqual(viewportLines().at(-1), { type: 'viewport', event: 'set', tab: tab.id, width: 390, height: 844, mobile: true, reason: 'tool' });
});

test('desktop keeps the real scale (0) and sends no touch; from mobile it turns touch off', async () => {
  const { cdp, call } = setup();
  await call('viewport', { width: 1280, height: 800 });
  assert.deepEqual(cdp, [['Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false }]]);
  cdp.length = 0;
  await call('viewport', { width: 390, height: 844, mobile: true });
  await call('viewport', { width: 800, height: 600 });
  assert.deepEqual(cdp.map(([m, p]) => `${m} ${p.enabled ?? p.width}`), [
    'Emulation.setDeviceMetricsOverride 390', 'Emulation.setTouchEmulationEnabled true',
    'Emulation.clearDeviceMetricsOverride undefined', 'Emulation.setDeviceMetricsOverride 800', 'Emulation.setTouchEmulationEnabled false',
  ]);
  assert.ok(!cdp.some(([m]) => m === 'Emulation.setEmitTouchEventsForMouse'));
});

test('a site the browser zooms (the user\'s Cmd-minus) still gets the CSS px and scale asked for; mobile emulation ignores the zoom', async () => {
  const { tab, cdp, call } = setup({ zoom: 0.8 });
  await call('viewport', { width: 1100, height: 1000 });
  await call('viewport', { width: 390, height: 844, mobile: true, device_scale_factor: 3 });
  assert.deepEqual(tab.viewport, { width: 390, height: 844, mobile: true, deviceScaleFactor: 3 }, 'what was asked for is remembered');
  await call('viewport', { width: 800, height: 600, device_scale_factor: 2 });
  assert.deepEqual(cdp.filter(([m]) => m.startsWith('Emulation.') && m.endsWith('MetricsOverride')).map(([m, p]) => (m.startsWith('Emulation.clear') ? 'clear' : p)), [
    { width: 880, height: 800, deviceScaleFactor: 0, mobile: false },
    { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    'clear', // the zoom is read without the mobile override, which hides it
    { width: 640, height: 480, deviceScaleFactor: 2.5, mobile: false },
  ]);
});

test('a desktop size is sent again for a new page with another browser zoom (the user\'s per-site Cmd-minus)', async () => {
  const { tab, cdp, call, zoomOf } = setup({ zoom: 0.8 });
  await call('viewport', { width: 1100, height: 1000 });
  zoomOf.now = 1; // the next site is at 100%
  await keepViewportSize(tab);
  await keepViewportSize(tab); // the same zoom again: nothing to send
  assert.deepEqual(cdp.filter(([m]) => m === 'Emulation.setDeviceMetricsOverride').map(([, p]) => [p.width, p.height]), [[880, 800], [1100, 1000]]);
});

test('reset clears the override and touch; a second reset says nothing was set and sends nothing', async () => {
  const { tab, cdp, call } = setup();
  await call('viewport', { width: 390, height: 844, mobile: true });
  cdp.length = 0;
  const reset = await call('viewport', { reset: true });
  assert.match(reset.text, /Viewport reset/);
  assert.deepEqual(cdp, [['Emulation.clearDeviceMetricsOverride', {}], ['Emulation.setTouchEmulationEnabled', { enabled: false }]]);
  assert.equal(tab.viewport, null);
  assert.equal(tab.browser.relay.viewports.has(tab.tabId), false);
  assert.deepEqual(viewportLines().at(-1), { type: 'viewport', event: 'clear', tab: tab.id, width: 390, height: 844, mobile: true, reason: 'tool' });
  cdp.length = 0;
  assert.match((await call('viewport', { reset: true })).text, /No viewport was set/);
  assert.deepEqual(cdp, []);
});

test('a reset that fails keeps what is left to clear, so another reset finishes it', async () => {
  for (const step of ['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled']) {
    const { tab, cdp, call, failing } = setup();
    await call('viewport', { width: 390, height: 844, mobile: true });
    failing.add(step);
    assert.match((await call('viewport', { reset: true })).text, /failed/);
    assert.equal(tab.viewport?.mobile, true, `kept after ${step} failed`);
    cdp.length = 0;
    assert.match((await call('viewport', { reset: true })).text, /Viewport reset/);
    assert.deepEqual(cdp, [['Emulation.clearDeviceMetricsOverride', {}], ['Emulation.setTouchEmulationEnabled', { enabled: false }]]);
    assert.equal(tab.viewport, null);
  }
});

test('a missing height is refused before anything is sent', async () => {
  const { cdp, call } = setup();
  assert.match((await call('viewport', { width: 390 })).text, /Pass both width and height/);
  assert.match((await call('viewport', {})).text, /Pass width and height, color_scheme or reduced_motion, or reset: true/);
  assert.deepEqual(cdp, []);
});

test('colour scheme and reduced motion: set alone or with a size, kept together, cleared by reset and at release', async () => {
  const { tab, cdp, call } = setup();
  await call('viewport', { color_scheme: 'dark' });
  assert.deepEqual(cdp.splice(0), [['Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }] }]]);
  await call('viewport', { width: 390, height: 844, reduced_motion: true });
  assert.deepEqual(cdp.splice(0).map(([name, args]) => (name === 'Emulation.setEmulatedMedia' ? [name, args] : name)), ['Emulation.setDeviceMetricsOverride',
    ['Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }]]);
  assert.match((await call('viewport', { reset: true })).text, /back at the tab's real size, colour scheme and motion/);
  assert.deepEqual(cdp.splice(0).map(([name, args]) => (name === 'Emulation.setEmulatedMedia' ? [name, args] : name)),
    [['Emulation.setEmulatedMedia', { media: '', features: [] }], 'Emulation.clearDeviceMetricsOverride']);
  assert.equal(tab.media, null);
  await call('viewport', { color_scheme: 'light' });
  cdp.splice(0);
  await call('tab_release', {});
  assert.deepEqual(cdp.map(([name, args]) => [name, args]), [['Emulation.setEmulatedMedia', { media: '', features: [] }]]);
});

test('on a claimed or kept tab it works, with the warning that the user sees it resized', async () => {
  for (const options of [{ origin: 'user' }, { kept: true }]) {
    const { cdp, call } = setup(options);
    const result = await call('viewport', { width: 390, height: 844 });
    assert.equal(cdp[0][0], 'Emulation.setDeviceMetricsOverride');
    assert.match(result.text, /This is the user's tab: they see it resized too until you reset it or release it\./);
  }
});

test('tab_release clears the override before the tab goes back, while the debugger is attached', async () => {
  const { tab, sent, call } = setup({ origin: 'user' });
  await call('viewport', { width: 390, height: 844, mobile: true });
  sent.length = 0;
  const result = await call('tab_release', {});
  assert.equal(result.isError, undefined, result.text);
  assert.deepEqual(sent.filter((m) => m !== 'Runtime.evaluate'),
    ['Emulation.clearDeviceMetricsOverride', 'Emulation.setTouchEmulationEnabled', 'tabs.release']);
  assert.deepEqual(viewportLines().at(-1), { type: 'viewport', event: 'clear', tab: tab.id, width: 390, height: 844, mobile: true, reason: 'release' });
});

test('turn end clears it before closing or releasing; a failed clear does not stop the cleanup', async () => {
  const { tab, sent, call, browser } = setup();
  await call('viewport', { width: 390, height: 844 });
  sent.length = 0;
  const result = await endTurn({ browsers: new Map([['chrome', browser]]) });
  assert.deepEqual(result.closed, [tab.id]);
  assert.deepEqual(sent.filter((m) => m !== 'Runtime.evaluate' && m !== 'tabs.listAll'), ['Emulation.clearDeviceMetricsOverride', 'chrome.tabs.remove']);
  assert.deepEqual(viewportLines().at(-1), { type: 'viewport', event: 'clear', tab: tab.id, width: 390, height: 844, mobile: false, reason: 'turn end' });

  const second = setup({ origin: 'user' });
  await second.call('viewport', { width: 390, height: 844 });
  const request = second.browser.host.request;
  second.browser.host.request = async (method, params) => {
    if (params?.[1] === 'Emulation.clearDeviceMetricsOverride') throw new Error('Debugger is not attached to the tab');
    return request(method, params);
  };
  assert.deepEqual((await endTurn({ browsers: new Map([['chrome', second.browser]]) })).released, [second.tab.id]);
});

test('with a dialog open (the page is blocked) it says so at once instead of waiting on the page', async () => {
  const { tab, cdp, call } = setup();
  tab.dialog = { type: () => 'alert', message: () => 'Your session is about to expire', defaultValue: () => '' };
  tab.page.evaluate = () => new Promise(() => {}); // a page under an open alert never answers
  const result = await Promise.race([call('viewport', { width: 390, height: 844 }), new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
  assert.notEqual(result, 'still waiting');
  assert.equal(result.isError, true);
  assert.match(result.text, /Dialog open: alert "Your session is about to expire"\. The page is blocked until you resolve it with the dialog tool\./);
  assert.deepEqual(cdp, [], 'nothing sent');
});
