// Reading one section (snapshot with ref) must leave every ref shown before usable. Playwright's page script resolves
// aria-ref through the table of the last snapshot it took, and a section's table holds only that section's refs.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const PAGE = '- main [ref=e1]:\n  - button "Buy" [ref=e2]\n  - region "Reviews" [ref=e3]:\n    - link "More reviews" [ref=e4]';
const SECTIONS = { e2: '- button "Buy" [ref=e2]', e3: '- region "Reviews" [ref=e3]:\n  - link "More reviews" [ref=e4]' };
const refsOf = (yaml) => new Set([...yaml.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]));

function setup() {
  let table = new Set(); // the refs aria-ref resolves: those of the last snapshot taken
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://shop.example/item', mainFrame: () => page, frames: () => [page], isClosed: () => false,
    async ariaSnapshot() { table = refsOf(PAGE); return PAGE; },
    getByRef: (ref) => ({
      count: async () => (table.has(ref) ? 1 : 0),
      async ariaSnapshot() { table = refsOf(SECTIONS[ref]); return SECTIONS[ref]; },
    }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Item' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 4, page);
  browser.tabs.set(4, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  return async (args) => {
    const result = await tools.snapshot({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
}

test('after reading one section, refs outside it still work', async () => {
  const snapshot = setup();
  assert.match((await snapshot({})).text, /Snapshot 1 of this tab:/);
  const section = await snapshot({ ref: 'e3' });
  assert.equal(section.error, false, section.text);
  assert.match(section.text, /Snapshot of e3:\n```yaml\n- region "Reviews" \[ref=e3\]:\n {2}- link "More reviews" \[ref=e4\]\n```/);
  const outside = await snapshot({ ref: 'e2' });
  assert.equal(outside.error, false, outside.text);
  assert.match(outside.text, /- button "Buy" \[ref=e2\]/);
  assert.match((await snapshot({})).text, /Snapshot 2 of this tab:/, 'sections are not numbered as whole snapshots');
});
