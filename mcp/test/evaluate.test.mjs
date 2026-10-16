// evaluate whose page function outlives its timeout (an async loop): the call ends, and says the function was not
// stopped, so the agent neither waits for it nor starts it a second time unknowingly.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

test('evaluate that runs past its timeout says the function may still be running and how to give it longer', async () => {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, frames: () => [page], isClosed: () => false,
    evaluate: () => new Promise(() => {}), // a loop with awaits that has not finished
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
  const tab = new Tab(browser, 6, page);
  browser.tabs.set(6, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const result = await tools.evaluate({ tab: tab.id, function: 'async () => { for (;;) await new Promise((r) => setTimeout(r, 1500)); }', timeout_ms: 50 });
  const text = result.content.map((c) => c.text).join('\n');
  assert.equal(result.isError, true);
  assert.match(text, /evaluate did not finish within 0\.05 s, so its result is lost\. The function was not stopped: it may still be running in the page\. /);
  assert.match(text, /pass a larger timeout_ms/);
});
