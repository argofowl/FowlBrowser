// The download tool against a mock host (no browser): one tab's download starts run one at a time.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { registerBrowserData } from '../src/browserData.mjs';

// A mock host and browser for one tab (7): clicks run one at a time (as the click tool's own tab queue does) and each
// starts a download that shows up a little later, the way the extension attributes it after its settle.
function harness({ clickMs = 0 } = {}) {
  const host = new EventEmitter();
  const list = [];
  const expectations = [];
  const clicked = [];
  const add = (name) => {
    const id = list.length + 1;
    list.push({ id, tabId: 7, url: `https://example.com/${name}`, filename: `/Downloads/${name}.txt`, state: 'complete', danger: 'safe' });
    host.emit('downloads.changed');
    return id;
  };
  host.request = async (method, params) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (method === 'downloads.list') return structuredClone(list);
    if (method === 'downloads.expect') { expectations.push(params.ms > 0); return { ok: true }; }
    if (method === 'downloads.start') return { id: add(params.url.split('/').pop()) };
    throw new Error(`unexpected ${method}`);
  };
  let clicks = Promise.resolve();
  const click = ({ ref }) => (clicks = clicks.then(async () => {
    clicked.push(ref);
    await new Promise((resolve) => setTimeout(resolve, clickMs));
    setTimeout(() => add(ref), 30);
  }));
  const tools = {};
  registerBrowserData((name, _description, _schema, handler) => { tools[name] = handler; },
    { get: async () => ({ name: 'Chrome', host }) },
    { click, parseTabId: (tab) => ({ key: tab.split(':')[0], tabId: Number(tab.split(':')[1]) }) });
  return { tools, list, expectations, clicked };
}

test('two concurrent ref downloads on one tab each return their own download', async () => {
  const { tools, expectations } = harness();
  const [first, second] = await Promise.all([
    tools.download({ tab: 'chrome:7', ref: 'e1', wait_ms: 5000 }),
    tools.download({ tab: 'chrome:7', ref: 'e2', wait_ms: 5000 }),
  ]);
  assert.match(first.content[0].text, /#1 .*e1\.txt/);
  assert.match(second.content[0].text, /#2 .*e2\.txt/);
  // Each call opened its expectation and closed it before the next one opened.
  assert.deepEqual(expectations, [true, false, true, false]);
});

test('a url download started while a ref download runs is never taken for the click\'s file', async () => {
  const { tools } = harness({ clickMs: 50 });
  const [byRef, byUrl] = await Promise.all([
    tools.download({ tab: 'chrome:7', ref: 'e1', wait_ms: 5000 }),
    (async () => { await new Promise((resolve) => setTimeout(resolve, 20)); return tools.download({ tab: 'chrome:7', url: 'https://example.com/direct', wait_ms: 5000 }); })(),
  ]);
  assert.match(byRef.content[0].text, /e1\.txt/);
  assert.match(byUrl.content[0].text, /direct\.txt/);
});

test('a queued ref download whose wait ran out never clicks', async () => {
  const { tools, clicked, list } = harness({ clickMs: 120 });
  const [, late] = await Promise.allSettled([
    tools.download({ tab: 'chrome:7', ref: 'e1', wait_ms: 5000 }),
    tools.download({ tab: 'chrome:7', ref: 'e2', wait_ms: 20 }),
  ]);
  assert.equal(late.status, 'rejected');
  assert.match(late.reason.message, /nothing was started/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(clicked, ['e1']);
  assert.deepEqual(list.map((d) => d.url), ['https://example.com/e1']);
});

test('download takes web URLs only: a file: URL would copy a local file into Downloads', async () => {
  const { tools, list } = harness();
  for (const url of ['file:///etc/hosts', 'fi\tle:///etc/hosts', ' FILE:///etc/hosts', 'chrome://settings', 'data:text/plain,x', 'blob:https://example.com/1']) {
    await assert.rejects(tools.download({ tab: 'chrome:7', url }), /can't be downloaded: download takes http: and https: URLs only/, JSON.stringify(url));
  }
  assert.equal(list.length, 0);
  assert.match((await tools.download({ tab: 'chrome:7', url: 'HTTPS://example.com/report', wait_ms: 5000 })).content[0].text, /report\.txt/);
});
