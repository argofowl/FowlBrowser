// Every result an agent reads fits Claude Code's MCP result limit (25,000 tokens by default). Claude Code takes a result
// of up to 50,000 characters without counting (its estimate is characters / 4); a larger one is counted, and a snapshot
// runs under 2.4 characters per token (a 58,959-character YouTube snapshot was refused). So no snapshot, at the largest
// max_chars, and no evaluate result, however large, may go over 50,000 characters.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const UNCOUNTED = 50_000;
const PAGE = Array.from({ length: 4000 }, (_, i) => `${'  '.repeat(1 + (i % 9))}- button "Like this comment along with ${i} other people" [ref=e${i + 1}] [cursor=pointer]`).join('\n');

function setup() {
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://www.youtube.com/watch?v=ND_kRgU_WlY', mainFrame: () => page, isClosed: () => false,
    ariaSnapshot: async () => PAGE,
    // A page function that returns a lot of data.
    evaluate: async () => Array.from({ length: 5000 }, (_, i) => ({ title: `Comment ${i}`, likes: i, url: `https://www.youtube.com/watch?v=ND_kRgU_WlY&lc=${i}` })),
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'I finally ported typescript to rust - YouTube' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'helium', name: 'Helium', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 7, page);
  browser.tabs.set(7, tab);
  const tools = {};
  const schemas = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; schemas[name] = meta.inputSchema; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  return { call, schemas };
}

test('snapshot max_chars stops where Claude Code still takes the result, and the largest one fits', async () => {
  const { call, schemas } = setup();
  const largest = [60_000, 50_000, 40_000].find((n) => schemas.snapshot.max_chars.safeParse(n).success);
  assert.ok(largest <= 40_000, `max_chars allows ${largest}`);
  const result = await call('snapshot', { max_chars: largest });
  assert.equal(result.error, false, result.text);
  assert.ok(result.text.length <= UNCOUNTED, `${result.text.length} characters`);
  assert.match(result.text, /more lines not shown/);
});

test('an evaluate result is cut so the whole result fits too', async () => {
  const { call } = setup();
  const result = await call('evaluate', { function: '() => comments' });
  assert.equal(result.error, false, result.text);
  assert.ok(result.text.length <= UNCOUNTED, `${result.text.length} characters`);
  assert.match(result.text, /more lines not shown\. Return less data\.\]$/);
});
