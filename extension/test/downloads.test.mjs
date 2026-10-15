// Run: node --test extension/test/
// Downloads (attribution and per-client isolation) and the read-only browsing data command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../core.js';

function fakeChrome() {
  const tabs = new Map();
  const items = new Map(); // download id -> DownloadItem
  const calls = [];
  let nextTabId = 100;
  let nextDownloadId = 1;
  const data = {};
  const addTab = (props) => {
    const tab = { id: nextTabId++, windowId: 1, index: tabs.size, url: 'about:blank', title: '', active: false,
      incognito: false, groupId: -1, mutedInfo: { muted: false }, status: 'complete', ...props };
    tabs.set(tab.id, tab);
    return tab;
  };
  const getTab = (id) => {
    if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
    return tabs.get(id);
  };
  const addDownload = (props) => {
    const item = { id: nextDownloadId++, url: '', finalUrl: props.url, referrer: '', filename: '', state: 'in_progress',
      danger: 'safe', mime: 'text/plain', bytesReceived: 0, totalBytes: 32, fileSize: 0, startTime: '2026-10-10T19:00:00.000Z', exists: true, ...props };
    items.set(item.id, item);
    return item;
  };
  return {
    calls, tabsById: tabs, items, addTab, addDownload,
    storage: { session: { async get() { return {}; }, async set(v) { Object.assign(data, v); } },
      local: { async get() { return {}; }, async set() {} } },
    runtime: { getManifest: () => ({ version: '0.1.0' }), reload() {} },
    windows: {
      async getLastFocused() { return { id: 1, type: 'normal', incognito: false }; },
      async getAll() { return [{ id: 1, type: 'normal', incognito: false }]; },
    },
    tabs: {
      async query(q) { return [...tabs.values()].filter((t) => !q.active || t.active); },
      async get(id) { return structuredClone(getTab(id)); },
      async create(props) { return structuredClone(addTab({ url: props.url })); },
      async update(id, props) { Object.assign(getTab(id), props); return structuredClone(getTab(id)); },
      async remove(ids) { for (const id of [ids].flat()) tabs.delete(id); },
      async group({ groupId, tabIds }) { for (const t of tabIds) getTab(t).groupId = groupId ?? 1; return groupId ?? 1; },
      async ungroup(ids) { for (const id of [ids].flat()) getTab(id).groupId = -1; },
    },
    tabGroups: { async update() {}, async get() { return {}; }, async query() { return []; } },
    debugger: { async attach() {}, async detach() {}, async sendCommand() { return {}; } },
    downloads: {
      async download(options) {
        calls.push(['downloads.download', options]);
        return addDownload({ url: options.url }).id;
      },
      async search({ id }) { return items.has(id) ? [structuredClone(items.get(id))] : []; },
    },
    history: {
      async search(query) {
        calls.push(['history.search', query]);
        return [{ url: 'https://example.com/a', title: 'Example A', lastVisitTime: 1000, visitCount: 3 }];
      },
    },
    bookmarks: {
      async getTree() {
        return [{ id: '0', title: '', children: [
          { id: '1', title: 'Bookmarks bar', children: [
            { id: '3', title: 'Old', url: 'https://old.example', dateAdded: 1 },
            { id: '4', title: 'Work', children: [{ id: '5', title: 'Docs', url: 'https://docs.example', dateAdded: 5 }] },
          ] },
          { id: '2', title: 'Other bookmarks', children: [{ id: '6', title: 'Recipes', url: 'https://food.example', dateAdded: 3 }] },
        ] }];
      },
    },
    sessions: {
      async getRecentlyClosed() {
        return [
          { lastModified: 200, tab: { title: 'Closed tab', url: 'https://closed.example' } },
          { lastModified: 100, window: { tabs: [{ title: 'W1', url: 'https://w1.example' }, { title: 'W2', url: 'https://w2.example' }] } },
        ];
      },
    },
    topSites: { async get() { return Array.from({ length: 300 }, (_, i) => ({ title: `Site ${i}`, url: `https://s${i}.example` })); } },
  };
}

function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(fn, ms) { const timer = { fn, ms }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    async fire(ms) { for (const timer of [...pending]) if (timer.ms === ms) { pending.delete(timer); await timer.fn(); } },
  };
}

function setup(tweak) {
  const chrome = fakeChrome();
  tweak?.(chrome);
  const timers = manualTimers();
  const sent = [];
  const core = createCore({ chrome, timers, send: (msg) => msg.method !== 'extension.log' && sent.push(msg) });
  const connected = new Set();
  let nextId = 1;
  const call = async (client, method, params) => {
    if (!connected.has(client)) {
      connected.add(client);
      await core.handleMessage({ method: 'host.clientConnected', params: { client } });
    }
    const id = nextId++;
    await core.handleMessage({ id, method, params, client });
    return sent.find((m) => m.id === id);
  };
  const disconnect = (client) => core.handleMessage({ method: 'host.clientDisconnected', params: { client } });
  return { chrome, core, sent, call, timers, disconnect };
}

const FILE = 'http://127.0.0.1:5411/download.txt?attachment=report.txt';
const changedFor = (sent, client) => sent.filter((m) => m.method === 'downloads.changed' && m.client === client);

test("a download goes to the client whose tab started it, and client A never sees client B's downloads", async () => {
  const { chrome, core, sent, call, timers } = setup();
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});

  // A: the CDP event first, then chrome.downloads.onCreated.
  await core.onDebuggerEvent({ tabId: tabA.id }, 'Page.downloadWillBegin', { url: FILE, guid: 'g1', frameId: 'f' });
  const a = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(a);
  // B: onCreated first (url before redirects), then the event naming the final url.
  const b = chrome.addDownload({ url: 'https://b.example/export', finalUrl: 'https://cdn.b.example/file.csv' });
  await core.onDownloadCreated(b);
  await core.onDebuggerEvent({ tabId: tabB.id, sessionId: 'frame' }, 'Page.downloadWillBegin', { url: 'https://cdn.b.example/file.csv' });
  // The user's own download: no tab of any client named it.
  const usersDownload = chrome.addDownload({ url: 'https://user.example/private.pdf', referrer: 'https://user.example/' });
  await core.onDownloadCreated(usersDownload);
  await timers.fire(800);

  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]), [[a.id, tabA.id]]);
  assert.deepEqual((await call(2, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]), [[b.id, tabB.id]]);
  assert.deepEqual((await call(3, 'downloads.list', {})).result, []);

  sent.length = 0;
  chrome.items.get(a.id).state = 'complete';
  await core.onDownloadChanged({ id: a.id, state: { current: 'complete' } });
  await core.onDownloadChanged({ id: usersDownload.id, state: { current: 'complete' } });
  assert.deepEqual(sent.map((m) => [m.method, m.client, m.params[0].id, m.params[0].state]), [['downloads.changed', 1, a.id, 'complete']]);
});

// A live run copied ~/.ssh/id_ed25519 into ~/Downloads with downloads.start {url: 'file:///...'}.
test('downloads.start downloads only from the web, however the URL is written', async () => {
  const { chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  for (const url of ['file:///Users/me/.ssh/id_ed25519', 'fi\tle:///etc/passwd', ' FILE:///etc/passwd',
    'chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html', 'chrome://settings', 'data:text/plain,hi',
    'blob:https://example.com/6f1c', 'filesystem:https://example.com/temporary/x', 'javascript:alert(1)', '/relative', '']) {
    assert.match((await call(1, 'downloads.start', { tabId: tab.id, url })).error?.message ?? '', /only http and https/, JSON.stringify(url));
  }
  assert.ok(!chrome.calls.some((c) => c[0] === 'downloads.download'));
  for (const url of [FILE, 'https://example.com/report.pdf', ' HTTPS://example.com/a.csv']) {
    assert.ok(!(await call(1, 'downloads.start', { tabId: tab.id, url })).error, url);
  }
  assert.equal(chrome.calls.filter((c) => c[0] === 'downloads.download').length, 3);
});

test('only the owner of a tab may start or expect downloads on it', async () => {
  const { chrome, core, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const usersTab = chrome.addTab({ url: 'https://user.example' });

  assert.match((await call(2, 'downloads.start', { tabId: tab.id, url: FILE })).error.message, /controlled by another agent session/);
  assert.match((await call(2, 'downloads.start', { tabId: usersTab.id, url: FILE })).error.message, /not controlled by this session/);
  assert.match((await call(2, 'downloads.expect', { tabId: tab.id, ms: 5000 })).error.message, /controlled by another agent session/);
  assert.ok(!chrome.calls.some((c) => c[0] === 'downloads.download'));

  const { result: started } = await call(1, 'downloads.start', { tabId: tab.id, url: FILE });
  assert.deepEqual(chrome.calls.find((c) => c[0] === 'downloads.download')[1], { url: FILE, saveAs: false, conflictAction: 'uniquify' });
  assert.equal(started.tabId, tab.id);
  // Its onCreated (after the call) is not handed to anyone else, even with another client's matching event waiting.
  const { result: other } = await call(2, 'tabs.open', {});
  await core.onDebuggerEvent({ tabId: other.id }, 'Page.downloadWillBegin', { url: FILE });
  await core.onDownloadCreated(chrome.items.get(started.id));
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => d.id), [started.id]);
  assert.deepEqual((await call(2, 'downloads.list', {})).result, []);
});

test('a download no tab names goes to a downloads.expect window only when exactly one expecting tab shows its referrer', async () => {
  const { chrome, core, call, timers } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  chrome.tabsById.get(tab.id).url = 'https://docs.example/sheet#gid=0';
  await call(1, 'downloads.expect', { tabId: tab.id, ms: 30_000 });

  const popup = chrome.addDownload({ url: 'https://docs.example/export', referrer: 'https://docs.example/sheet' });
  await core.onDownloadCreated(popup);
  const elsewhere = chrome.addDownload({ url: 'https://other.example/file', referrer: 'https://other.example/' });
  await core.onDownloadCreated(elsewhere);
  await timers.fire(800);
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]), [[popup.id, tab.id]]);

  // Two clients expecting on the same page: ambiguous, so nobody gets it.
  const { result: tab2 } = await call(2, 'tabs.open', {});
  chrome.tabsById.get(tab2.id).url = 'https://docs.example/sheet';
  await call(2, 'downloads.expect', { tabId: tab2.id, ms: 30_000 });
  const ambiguous = chrome.addDownload({ url: 'https://docs.example/export2', referrer: 'https://docs.example/sheet' });
  await core.onDownloadCreated(ambiguous);
  await timers.fire(800);
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => d.id), [popup.id]);
  assert.deepEqual((await call(2, 'downloads.list', {})).result, []);

  // A closed window (ms 0) takes nothing.
  await call(1, 'downloads.expect', { tabId: tab.id, ms: 0 });
  await call(2, 'downloads.expect', { tabId: tab2.id, ms: 0 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const late = chrome.addDownload({ url: 'https://docs.example/export3', referrer: 'https://docs.example/sheet' });
  await core.onDownloadCreated(late);
  await timers.fire(800);
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => d.id), [popup.id]);
});

test("a disconnected client's downloads are forgotten, never canceled, and its events stop", async () => {
  const { chrome, core, sent, call, disconnect } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const { result: started } = await call(1, 'downloads.start', { tabId: tab.id, url: FILE });
  await disconnect(1);
  sent.length = 0;
  await core.onDownloadChanged({ id: started.id, state: { current: 'complete' } });
  assert.deepEqual(changedFor(sent, 1), []);
  assert.equal(chrome.items.get(started.id).state, 'in_progress');
  assert.match((await call(1, 'downloads.list', {})).error.message, /Unknown client/);
});

// Regressions: a URL alone never proves whose download it is.
const listOf = async (call, client) => (await call(client, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]);

test("the user's earlier download of the same URL never goes to an agent's signal", async () => {
  const { chrome, core, call, timers } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const usersDownload = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(usersDownload);
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE, guid: 'g1' });
  const agents = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(agents);
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 1), []);
});

test('two clients downloading the same URL never get each other\'s download, in either event order', async () => {
  for (const order of ['signals first', 'interleaved']) {
    const { chrome, core, call, timers } = setup();
    const { result: tabA } = await call(1, 'tabs.open', {});
    const { result: tabB } = await call(2, 'tabs.open', {});
    const signal = (tab) => core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE });
    const created = () => core.onDownloadCreated(chrome.addDownload({ url: FILE }));
    if (order === 'signals first') { await signal(tabA); await signal(tabB); await created(); await created(); }
    else { await signal(tabA); await created(); await signal(tabB); await created(); }
    await timers.fire(800);
    const a = await listOf(call, 1);
    const b = await listOf(call, 2);
    assert.deepEqual([a, b], [[], []], order);
  }
});

test('a download a tabs.openChild child starts in its first navigation is the opener\'s, however late, and the blank child closes', async () => {
  const { chrome, core, call, timers } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  const { result: child } = await call(1, 'tabs.openChild', { tabId: opener.id, url: FILE });
  await timers.fire(800); // long before the response: nothing was signalled for the mere open
  await core.onDebuggerEvent({ tabId: child.tabId }, 'Page.downloadWillBegin', { url: FILE });
  const item = chrome.addDownload({ url: FILE, referrer: 'http://127.0.0.1:5411/download.html' });
  await core.onDownloadCreated(item);
  await timers.fire(800);
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]), [[item.id, opener.id]]);
  assert.equal(chrome.tabsById.has(child.tabId), false, 'closed, as Chrome closes a new tab that turned into a download');

  // Once a page committed in it, the child is a tab like any other: its downloads are its own.
  const { result: other } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'http://127.0.0.1:5411/page.html' });
  await core.onNavigationCommitted({ tabId: other.tabId, frameId: 0, url: 'about:blank' });
  await core.onNavigationCommitted({ tabId: other.tabId, frameId: 0, url: 'http://127.0.0.1:5411/page.html' });
  await core.onDebuggerEvent({ tabId: other.tabId }, 'Page.downloadWillBegin', { url: FILE });
  const later = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(later);
  await timers.fire(800);
  assert.deepEqual((await call(1, 'downloads.list', {})).result.map((d) => [d.id, d.tabId]).at(-1), [later.id, other.tabId]);
  assert.equal(chrome.tabsById.has(other.tabId), true);
});

test("a tabs.openChild page that loads is no claim on the user's download of the same URL", async () => {
  const { chrome, core, call, timers } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.openChild', { tabId: opener.id, url: FILE });
  const users = chrome.addDownload({ url: FILE }); // the user's own <a download> in another tab, a moment later
  await core.onDownloadCreated(users);
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 1), []);
});

test("a downloads.start in flight neither hides another client's download nor lets its signal take a later one", async () => {
  const { chrome, core, call, timers } = setup();
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});
  let finish;
  chrome.downloads.download = () => new Promise((resolve) => { finish = resolve; });
  const starting = call(1, 'downloads.start', { tabId: tabA.id, url: FILE });
  await new Promise((resolve) => setImmediate(resolve));
  await core.onDebuggerEvent({ tabId: tabB.id }, 'Page.downloadWillBegin', { url: FILE });
  const bs = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(bs);
  const as = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(as);
  await timers.fire(800); // waits: the start's id is not known yet
  assert.deepEqual(await listOf(call, 2), []);
  finish(as.id);
  await starting;
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 1), [[as.id, tabA.id]]);
  assert.deepEqual(await listOf(call, 2), [[bs.id, tabB.id]]);
  // The user downloads the same file later: B's signal is spent.
  await core.onDownloadCreated(chrome.addDownload({ url: FILE }));
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 2), [[bs.id, tabB.id]]);
  assert.deepEqual(await listOf(call, 1), [[as.id, tabA.id]]);
});

test('a signal from before a native host restart never reaches the next client with the same id', async () => {
  const { chrome, core, call, timers, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE });
  await core.portClosed();
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 1 } });
  sent.length = 0;
  await core.onDownloadCreated(chrome.addDownload({ url: FILE }));
  await timers.fire(800);
  assert.deepEqual(changedFor(sent, 1), []);
  assert.deepEqual(await listOf(call, 1), []);
});

test('the expectation fallback refuses a referrer another tab also shows, even one nobody owns', async () => {
  const { chrome, core, call, timers } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  chrome.tabsById.get(tab.id).url = 'https://docs.example/sheet';
  chrome.addTab({ url: 'https://docs.example/sheet#gid=3' }); // The user's own tab on the same page
  await call(1, 'downloads.expect', { tabId: tab.id, ms: 30_000 });
  await core.onDownloadCreated(chrome.addDownload({ url: 'https://docs.example/export', referrer: 'https://docs.example/sheet' }));
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 1), []);
});

// Date.now() under test control (download records keep their arrival time).
async function withClock(fn) {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    return await fn((ms) => { now += ms; });
  } finally {
    Date.now = real;
  }
}

test("an older same-URL download is no candidate: settling early gives the agent nothing, then its own", async () => {
  await withClock(async (advance) => {
    const { chrome, core, call, timers } = setup();
    const { result: tab } = await call(1, 'tabs.open', {});
    await core.onDownloadCreated(chrome.addDownload({ url: FILE, filename: '/Downloads/users.txt' }));
    advance(3000);
    await core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE });
    await timers.fire(800); // before the agent's own download shows up
    assert.deepEqual(await listOf(call, 1), []);
    advance(300);
    const own = chrome.addDownload({ url: FILE });
    await core.onDownloadCreated(own);
    await timers.fire(800);
    assert.deepEqual(await listOf(call, 1), [[own.id, tab.id]]);
  });
});

test('a download event that waited out a native host restart stays with the old port', async () => {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const { chrome, core, call, timers } = setup((c) => {
    const get = c.storage.session.get;
    c.storage.session.get = async (...args) => { await gate; return get(...args); };
  });
  const early = core.onDownloadCreated(chrome.addDownload({ url: FILE, filename: '/Downloads/before-restart.txt' }));
  const closing = core.portClosed();
  open();
  await Promise.all([early, closing]);
  const { result: tab } = await call(1, 'tabs.open', {});
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE });
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 1), []);
});

test("a downloads.start left hanging by a closed port doesn't hold up the next port's attribution", async () => {
  const { chrome, core, call, timers } = setup();
  const { result: old } = await call(1, 'tabs.open', {});
  const download = chrome.downloads.download;
  chrome.downloads.download = () => new Promise(() => {}); // never settles
  call(1, 'downloads.start', { tabId: old.id, url: FILE });
  await new Promise((resolve) => setImmediate(resolve));
  chrome.downloads.download = download;
  await core.portClosed();
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 7 } });
  const { result: tab } = await call(7, 'tabs.open', {});
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.downloadWillBegin', { url: FILE });
  const item = chrome.addDownload({ url: FILE });
  await core.onDownloadCreated(item);
  await timers.fire(800);
  assert.deepEqual(await listOf(call, 7), [[item.id, tab.id]]);
});

test('the expectation fallback never takes a download that began before the window opened', async () => {
  const { chrome, core, call, timers } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  chrome.tabsById.get(tab.id).url = 'https://docs.example/sheet';
  await withClock(async (advance) => {
    await core.onDownloadCreated(chrome.addDownload({ url: 'https://docs.example/export', referrer: 'https://docs.example/sheet' }));
    advance(100);
    await call(1, 'downloads.expect', { tabId: tab.id, ms: 30_000 });
    await timers.fire(800);
  });
  assert.deepEqual(await listOf(call, 1), []);
});

test('browserData.query reads history, bookmarks with folders, recently closed tabs and top sites, capped at 200', async () => {
  const { chrome, call } = setup();
  const history = await call(1, 'browserData.query', { kind: 'history', query: 'example', maxResults: 500, sinceHours: 2 });
  assert.deepEqual(history.result, [{ title: 'Example A', url: 'https://example.com/a', lastVisit: 1000, visitCount: 3 }]);
  const search = chrome.calls.find((c) => c[0] === 'history.search')[1];
  assert.equal(search.text, 'example');
  assert.equal(search.maxResults, 200);
  assert.ok(Math.abs(Date.now() - 2 * 3_600_000 - search.startTime) < 5000);

  assert.deepEqual((await call(1, 'browserData.query', { kind: 'bookmarks' })).result, [
    { title: 'Docs', url: 'https://docs.example', dateAdded: 5, folder: 'Bookmarks bar / Work' },
    { title: 'Recipes', url: 'https://food.example', dateAdded: 3, folder: 'Other bookmarks' },
    { title: 'Old', url: 'https://old.example', dateAdded: 1, folder: 'Bookmarks bar' },
  ]);
  assert.deepEqual((await call(1, 'browserData.query', { kind: 'bookmarks', query: 'FOOD' })).result.map((b) => b.title), ['Recipes']);

  assert.deepEqual((await call(1, 'browserData.query', { kind: 'recently_closed', maxResults: 2 })).result, [
    { title: 'Closed tab', url: 'https://closed.example', closed: 200_000, inWindow: false },
    { title: 'W1', url: 'https://w1.example', closed: 100_000, inWindow: true },
  ]);
  assert.equal((await call(1, 'browserData.query', { kind: 'top_sites', maxResults: 1000 })).result.length, 200);
  assert.deepEqual((await call(1, 'browserData.query', { kind: 'top_sites', query: 's7.' })).result, [{ title: 'Site 7', url: 'https://s7.example' }]);
  assert.match((await call(1, 'browserData.query', { kind: 'passwords' })).error.message, /Unknown kind/);
});
