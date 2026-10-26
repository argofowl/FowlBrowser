// Run: node --test extension/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore, colorFor } from '../core.js';

function fakeChrome({ session = {}, local = {} } = {}) {
  const tabs = new Map();
  const calls = [];
  let nextTabId = 100;
  let nextGroupId = 1;
  const groupsById = new Map();
  const hooks = {};
  const gates = new Map(); // method name -> promise the next calls wait on (see gate())
  const wait = (name) => gates.get(name);
  const store = (data) => ({
    async get(keys) {
      return Object.fromEntries([keys].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
  });
  const addTab = (props) => {
    const tab = { id: nextTabId++, windowId: 1, index: tabs.size, url: 'about:blank', title: '', active: false,
      pinned: false, incognito: false, groupId: -1, mutedInfo: { muted: false }, status: 'complete', ...props };
    tabs.set(tab.id, tab);
    return tab;
  };
  // Like Chrome: a group whose last tab left or closed is gone (tabGroups.onRemoved).
  const emptied = async (groupId) => {
    if (groupId === -1 || !groupsById.has(groupId) || [...tabs.values()].some((t) => t.groupId === groupId)) return;
    const group = groupsById.get(groupId);
    groupsById.delete(groupId);
    await hooks.onGroupRemoved?.(structuredClone(group));
  };
  const getTab = (id) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    return tab;
  };
  const chrome = {
    calls, tabsById: tabs, groupsById, hooks, gates, addTab, session, local,
    storage: { session: store(session), local: store(local) },
    runtime: { id: 'fowlbrowser-ext', getManifest: () => ({ version: '0.1.0' }), reload: () => calls.push(['reload']) },
    extension: { isAllowedFileSchemeAccess: async () => !hooks.noFileAccess },
    windows: {
      async getLastFocused() { return { id: 1, type: 'normal', incognito: false }; },
      // Window 1, those of the tabs, and another window of the user's (holding a tab of theirs) unless the test says the
      // browser has one window.
      async getAll({ windowTypes, populate } = {}) {
        const ids = new Set([1, ...[...tabs.values()].map((t) => t.windowId), ...(hooks.oneWindow ? [] : [99])]);
        return [...ids].map((id) => ({ id, type: 'normal', incognito: false, ...hooks.windows?.[id],
          ...(populate && { tabs: id === 99 ? [{ id: 0, windowId: 99 }] : structuredClone([...tabs.values()].filter((t) => t.windowId === id)) }) }))
          .filter((w) => !windowTypes || windowTypes.includes(w.type));
      },
      async get(id) { return { id, type: 'normal', state: 'normal', incognito: false, ...hooks.windows?.[id] }; },
      async create(props) { calls.push(['windows.create', props]); return { id: 2, tabs: [addTab({ windowId: 2 })] }; },
      async update(id, props) { calls.push(['windows.update', id, props]); },
    },
    tabs: {
      async query(q) {
        await hooks.query?.(q);
        return [...tabs.values()].filter((t) => (!q.active || t.active) && (q.groupId === undefined || t.groupId === q.groupId)
          && (q.windowId === undefined || t.windowId === q.windowId));
      },
      async get(id) { await wait('tabs.get'); await hooks.get?.(id); return structuredClone(getTab(id)); },
      async create(props) {
        calls.push(['tabs.create', props]);
        await wait('tabs.create');
        if (props.openerTabId !== undefined && !tabs.has(props.openerTabId)) throw new Error(`No tab with id: ${props.openerTabId}.`);
        const tab = addTab({ windowId: props.windowId, url: props.url, active: props.active });
        await hooks.created?.(tab); // the tab exists before the call answers
        return structuredClone(tab);
      },
      async update(id, props) {
        calls.push(['tabs.update', id, props]);
        await hooks.update?.(id, props);
        const tab = getTab(id);
        if ('muted' in props) tab.mutedInfo = { muted: props.muted, reason: 'extension', extensionId: chrome.runtime.id };
        if ('url' in props) tab.url = props.url;
        if ('active' in props) tab.active = props.active;
        if ('autoDiscardable' in props) tab.autoDiscardable = props.autoDiscardable;
        return structuredClone(tab);
      },
      async remove(ids) {
        for (const id of [ids].flat()) {
          const tab = getTab(id);
          if (hooks.failRemove?.has(id)) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
          tabs.delete(id);
          calls.push(['tabs.remove', id]);
          await hooks.onRemoved?.(id, { windowId: tab.windowId, isWindowClosing: false });
          await emptied(tab.groupId);
        }
      },
      async group({ groupId, tabIds }) {
        await wait('tabs.group');
        if (hooks.groupError) throw new Error(hooks.groupError);
        if (groupId !== undefined && !groupsById.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) groupsById.set(id, { id, title: '', collapsed: false });
        // Like Chrome: a tab in Split View takes its partner along.
        const splits = new Set([tabIds].flat().map((t) => getTab(t).splitViewId).filter((v) => v !== undefined && v !== -1));
        // Like Chrome too: a pinned tab is unpinned as it joins a group (TabStripModel: the states are mutually exclusive).
        for (const t of [...[tabIds].flat(), ...[...tabs.values()].filter((t) => splits.has(t.splitViewId)).map((t) => t.id)]) Object.assign(getTab(t), { groupId: id, pinned: false });
        calls.push(['tabs.group', tabIds, id]);
        return id;
      },
      // Like Chrome: a group whose last tab leaves is gone.
      async ungroup(ids) {
        for (const id of [ids].flat()) {
          const { groupId } = getTab(id);
          getTab(id).groupId = -1;
          await emptied(groupId);
        }
        calls.push(['tabs.ungroup', ids]);
      },
    },
    tabGroups: {
      async update(id, props) {
        calls.push(['tabGroups.update', id, props]);
        if (hooks.groupUpdateError) throw new Error(hooks.groupUpdateError);
        Object.assign(groupsById.get(id) ?? {}, props);
        if (groupsById.has(id)) await hooks.onGroupUpdated?.(structuredClone(groupsById.get(id)));
      },
      async get(id) { return structuredClone(groupsById.get(id)); },
      async query() { return structuredClone([...groupsById.values()]); },
    },
    debugger: {
      async attach(target) {
        calls.push(['debugger.attach', target.tabId]);
        if (hooks.attachError) throw new Error(hooks.attachError);
      },
      async detach(target) { calls.push(['debugger.detach', target.tabId]); await wait('debugger.detach'); },
      async sendCommand(target, method, params) { calls.push(['debugger.sendCommand', target.tabId, method]); return { ok: method }; },
    },
  };
  return chrome;
}

// Makes calls to `name` wait until the returned function is called.
function gate(chrome, name) {
  let open;
  chrome.gates.set(name, new Promise((resolve) => { open = resolve; }));
  return () => { chrome.gates.delete(name); open(); };
}

// Timers that only fire when the test says so.
function manualTimers() {
  const pending = new Set();
  return {
    setTimeout(fn, ms) { const timer = { fn, ms }; pending.add(timer); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    async fire(ms) {
      for (const timer of [...pending]) if (timer.ms === ms) { pending.delete(timer); await timer.fn(); }
    },
    pending,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(options = {}) {
  const chrome = fakeChrome(options);
  const sent = [];
  const core = createCore({ chrome, timers: options.timers, send: (msg) => msg.method !== 'extension.log' && sent.push(msg) });
  chrome.hooks.onRemoved = core.onTabRemoved;
  chrome.hooks.onGroupRemoved = core.onTabGroupRemoved;
  chrome.hooks.onGroupUpdated = core.onTabGroupUpdated;
  const connected = new Set();
  const connect = (client) => {
    connected.add(client);
    return core.handleMessage({ method: 'host.clientConnected', params: { client } });
  };
  let nextId = 1;
  // Sends the request; `call` waits for it, `start` returns the pending request and a reply getter.
  const start = (client, method, params) => {
    const id = nextId++;
    if (!connected.has(client)) void connect(client);
    const done = core.handleMessage({ id, method, params, client });
    return { done, reply: () => sent.find((m) => m.id === id) };
  };
  const call = async (client, method, params) => {
    const request = start(client, method, params);
    await request.done;
    return request.reply();
  };
  return { chrome, core, sent, call, start, connect };
}

test('only the owner may drive a tab', async () => {
  const { call } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });

  assert.equal((await call(2, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error.message,
    `Tab ${tab.id} is controlled by another agent session: leave it alone (to work on the same page, open its URL in a tab of your own)`);
  assert.ok((await call(2, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).error);
  assert.ok((await call(2, 'chrome.tabs.remove', [tab.id])).error);
  assert.ok((await call(2, 'tabs.release', { tabId: tab.id })).error);
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /controlled by another agent session/);

  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).result,
    { ok: 'Page.reload' });
});

// A real-use evaluate with a 1.5 s pause per click failed at 30.1 s with Playwright's "Execution context was destroyed,
// most likely because of a navigation" (its reading of any protocol error of an evaluation): the page never navigated.
test('CDP commands time out after 30 s, except those waiting on the page (an evaluation\'s promise, a navigation)', async () => {
  const timers = manualTimers();
  const { chrome, call, start } = setup({ timers });
  const { result: tab } = await call(1, 'tabs.open', {});
  let settle;
  chrome.debugger.sendCommand = (target, method) => new Promise((resolve) => { settle = () => resolve({ ok: method }); });
  const plain = start(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'DOM.getDocument', { depth: -1 }]);
  await tick();
  await timers.fire(30_000);
  await plain.done;
  assert.equal(plain.reply().error.message, 'DOM.getDocument timed out after 30 s');
  for (const [method, params] of [['Runtime.callFunctionOn', { functionDeclaration: '() => {}', awaitPromise: true }], ['Page.navigate', { url: 'https://slow.example/' }]]) {
    const waiting = start(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, params]);
    await tick();
    assert.equal(timers.pending.size, 0, `${method}: no 30 s timer`);
    settle();
    await waiting.done;
    assert.deepEqual(waiting.reply().result, { ok: method });
  }
});

test('errors say what happened: a tab nobody controls, and closing one that is gone (an agent tab closed when an earlier turn ended)', async () => {
  const { chrome, call, core } = setup();
  const usersTab = chrome.addTab({ url: 'https://user.example' });
  assert.equal((await call(1, 'tabs.keep', { tabId: usersTab.id })).error.message,
    `Tab ${usersTab.id} is not controlled by this session (released or closed since, or never opened or claimed by it)`);
  const { result: tab } = await call(1, 'tabs.open', {});
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } }); // the turn's cleanup closes it
  assert.equal((await call(2, 'chrome.tabs.remove', [tab.id])).error.message, `Tab ${tab.id} is closed already`);
});

test('tabs.open makes a muted background tab in an expanded group and tells the client', async () => {
  const { chrome, call, sent } = setup();
  await call(1, 'client.hello', { label: 'Research' });
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });

  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabs.create')[1], { windowId: 1, url: 'https://example.com', active: false });
  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabs.update')[2], { muted: true, autoDiscardable: false });
  assert.deepEqual(chrome.calls.find((c) => c[0] === 'tabGroups.update')[2], { title: 'Research', color: colorFor('Research'), collapsed: false });
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === tab.id));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active));

  const { result: second } = await call(1, 'chrome.tabs.create', [{ url: 'https://example.org' }]);
  assert.equal(chrome.tabsById.get(second.id).groupId, chrome.tabsById.get(tab.id).groupId);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === second.id));
});

test('events go to the client that owns the tab', async () => {
  const { core, sent, call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const stranger = chrome.addTab({ url: 'https://user.example' });
  sent.length = 0;

  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.loadEventFired', { timestamp: 1 });
  await core.onDebuggerEvent({ tabId: stranger.id }, 'Page.loadEventFired', {});
  await core.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
  assert.deepEqual(sent, [
    { method: 'chrome.debugger.onEvent', params: [{ tabId: tab.id }, 'Page.loadEventFired', { timestamp: 1 }], client: 1 },
    { method: 'chrome.debugger.onDetach', params: [{ tabId: tab.id }, 'canceled_by_user'], client: 1 },
  ]);

  sent.length = 0;
  await chrome.tabs.remove(tab.id);
  assert.deepEqual(sent, [{ method: 'chrome.tabs.onRemoved', params: [tab.id, { windowId: 1, isWindowClosing: false }], client: 1 }]);
  assert.equal(core.owners.has(tab.id), false);
});

test('a tab opened by an owned tab is adopted and the user keeps their active tab', async () => {
  const { core, sent, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  sent.length = 0;

  // Chrome opened the popup in the foreground.
  chrome.tabsById.get(userTab.id).active = false;
  const child = chrome.addTab({ openerTabId: opener.id, active: true, url: 'https://example.com/popup' });
  await core.onTabActivated({ tabId: child.id, windowId: 1 });
  await core.onTabCreated(structuredClone(child));
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: child.id });

  assert.deepEqual(core.owners.get(child.id), { client: 1, origin: 'agent', group: 'Claude', kept: false });
  assert.ok(chrome.calls.some((c) => c[0] === 'tabs.update' && c[1] === userTab.id && c[2].active === true));
  assert.equal(chrome.tabsById.get(userTab.id).active, true);
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, true);
  assert.equal(chrome.tabsById.get(child.id).groupId, chrome.tabsById.get(opener.id).groupId);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === child.id));

  // Tabs opened from unowned tabs stay the user's.
  const userChild = chrome.addTab({ openerTabId: userTab.id });
  await core.onTabCreated(structuredClone(userChild));
  assert.equal(core.owners.has(userChild.id), false);
});

test('tabs.openChild opens a popup without an opener in the background next to its opener, adopted like one', async () => {
  const { core, sent, call, chrome } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  sent.length = 0;
  const { result, error } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  assert.equal(error, undefined);
  // Blank: the client navigates it once attached (popups.mjs), so a download shows on its own session.
  const create = chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1);
  assert.deepEqual(create[1], { windowId: 1, index: chrome.tabsById.get(opener.id).index + 1, url: 'about:blank', active: false, openerTabId: opener.id });
  assert.deepEqual(core.owners.get(result.tabId), { client: 1, origin: 'agent', group: 'Claude', kept: false });
  assert.equal(chrome.tabsById.get(result.tabId).mutedInfo.muted, true);
  assert.equal(chrome.tabsById.get(result.tabId).groupId, chrome.tabsById.get(opener.id).groupId);
  const created = sent.find((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === result.tabId);
  assert.equal(created?.params[0].openerTabId, opener.id, 'named as the opener\'s child');

  // Only http(s), only from a tab that passes children on, only for its owner.
  assert.match((await call(1, 'tabs.openChild', { tabId: opener.id, url: 'javascript:alert(1)' })).error.message, /http/);
  assert.ok((await call(2, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/x' })).error);
  await call(1, 'tabs.keep', { tabId: opener.id });
  assert.match((await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/x' })).error.message, /no children/);
  assert.equal(chrome.calls.filter((c) => c[0] === 'tabs.create').length, 2);
});

test('tabs.openChild: a child created while its opener changed hands, or its client left, is closed, never another client\'s or unowned', async () => {
  const changes = {
    'released, then claimed by another client that expects a child': async (call, opener) => {
      await call(1, 'tabs.release', { tabId: opener });
      await call(2, 'tabs.claim', { tabId: opener });
      await call(2, 'tabs.expectChild', { tabId: opener, ms: 3000 });
    },
    'kept (handed to the user)': (call, opener) => call(1, 'tabs.keep', { tabId: opener }),
    'kept while its action expects a child': async (call, opener) => {
      await call(1, 'tabs.expectChild', { tabId: opener, ms: 3000 });
      await call(1, 'tabs.keep', { tabId: opener });
    },
    'taken over by the user': (call, opener) => call(1, 'tabs.park', { tabId: opener, kind: 'takeover' }),
    'its client disconnected': (call, opener, core) => core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } }),
  };
  for (const [change, run] of Object.entries(changes)) {
    const { core, call, start, chrome } = setup();
    const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
    const open = gate(chrome, 'tabs.create');
    const request = start(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
    await tick();
    await run(call, opener.id, core);
    open();
    await request.done;
    const child = [...chrome.tabsById.values()].find((t) => t.id > opener.id && t.url === 'about:blank');
    assert.equal(child, undefined, `${change}: the child is closed`);
    assert.deepEqual([...core.owners.keys()].filter((id) => id !== opener.id), [], `${change}: nobody owns a child`);
    if (change !== 'its client disconnected') assert.match(request.reply().error.message, /no longer this client's/, change);
  }
});

test('tabs.openChild: an opener that closed itself right after asking still gets its child, in its last window, for its client only', async () => {
  const { core, call, chrome } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  chrome.tabsById.get(opener.id).windowId = 3;
  await chrome.tabs.remove(opener.id); // window.open(url, '_blank', 'noopener'); window.close()
  assert.ok((await call(2, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' })).error, 'another client');
  const { result, error } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  assert.equal(error, undefined);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1], { windowId: 3, url: 'about:blank', active: false });
  assert.equal(core.owners.get(result.tabId)?.client, 1);
  assert.equal(chrome.tabsById.get(result.tabId).mutedInfo.muted, true);
});

test('tabs.openChild: an opener that closes while its child is being created still gets it, in its window, without the stale opener id', async () => {
  const { core, call, start, chrome } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  chrome.tabsById.get(opener.id).windowId = 3;
  const open = gate(chrome, 'tabs.create');
  const request = start(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  await tick();
  await chrome.tabs.remove(opener.id);
  open();
  await request.done;
  const { result, error } = request.reply();
  assert.equal(error, undefined);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1], { windowId: 3, url: 'about:blank', active: false });
  assert.equal(core.owners.get(result.tabId)?.client, 1);

  // Not when its client left meanwhile.
  const second = setup();
  const { result: other } = await second.call(1, 'tabs.open', { url: 'https://example.com' });
  const release = gate(second.chrome, 'tabs.create');
  const lost = second.start(1, 'tabs.openChild', { tabId: other.id, url: 'https://example.com/next' });
  await tick();
  await second.chrome.tabs.remove(other.id);
  await second.core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  release();
  await lost.done;
  assert.ok(lost.reply().error);
  assert.equal(second.chrome.calls.filter((c) => c[0] === 'tabs.create').length, 2, 'no retry');
});

test('tabs.openChild never takes over a tab another client owns by the time it exists', async () => {
  const { core, call, start, chrome } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  chrome.hooks.created = async (tab) => {
    chrome.hooks.created = null;
    assert.equal((await call(2, 'tabs.claim', { tabId: tab.id })).error, undefined);
  };
  const request = start(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  await request.done;
  assert.ok(request.reply().error);
  const child = [...chrome.tabsById.values()].find((t) => t.id > opener.id);
  assert.equal(core.owners.get(child.id)?.client, 2, 'still the other client\'s');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.remove' && c[1] === child.id), 'and not closed');
});

test('tabs.openChild: a closed opener\'s reservation lasts 5 s, for its client on the same port only', async () => {
  const closedOpener = async () => {
    const s = setup();
    const { result: opener } = await s.call(1, 'tabs.open', { url: 'https://example.com' });
    await s.chrome.tabs.remove(opener.id);
    return { ...s, ask: () => s.call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' }) };
  };
  const late = await closedOpener();
  const now = Date.now;
  Date.now = () => now() + 6000;
  try {
    assert.match((await late.ask()).error?.message ?? '', /not controlled by this session/, 'expired on lookup, with no other close to prune it');
  } finally {
    Date.now = now;
  }
  const reconnected = await closedOpener();
  await reconnected.core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await reconnected.connect(1);
  assert.ok((await reconnected.ask()).error, 'cleared when its client disconnects');
  const restarted = await closedOpener();
  await restarted.core.portClosed();
  await restarted.connect(1); // a new client that reuses the id
  assert.ok((await restarted.ask()).error, 'cleared when the port closes');
});

test('a popup Chrome activates after Page.windowOpen is switched back inside the onCreated listener, once', async () => {
  const { core, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  const switchedBack = () => chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2].active === true);

  // Not armed: the user's own new tab (or a popup of a tab nobody drives) is left alone.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: 'https://elsewhere.example' })));
  assert.equal(switchedBack().length, 0);

  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' });
  // The user's Cmd+T in the armed window is theirs.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: 'chrome://newtab/' })));
  assert.equal(switchedBack().length, 0);

  const popup = chrome.addTab({ active: true, url: '' });
  core.onTabCreated(structuredClone(popup)); // not awaited: the switch is issued synchronously
  assert.deepEqual(switchedBack().map((c) => c[1]), [userTab.id]);

  // Used up: a second new active tab is the user's.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.equal(switchedBack().length, 1);

  // A claimed tab arms only inside its expectChild window (the agent's own click).
  const { result: claimed } = await call(1, 'tabs.claim', { tabId: userTab.id });
  await core.onDebuggerEvent({ tabId: claimed.id }, 'Page.windowOpen', { url: 'https://user.example/' });
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.equal(switchedBack().length, 1);
});

test('client disconnect closes agent tabs, ungroups kept ones and releases claimed ones', async () => {
  const { core, call, chrome } = setup();
  const { result: agentTab } = await call(1, 'tabs.open', {});
  const { result: keptTab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.keep', { tabId: keptTab.id });
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  const { result: otherTab } = await call(2, 'tabs.open', {});

  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });

  assert.equal(chrome.tabsById.has(agentTab.id), false);
  assert.equal(chrome.tabsById.get(keptTab.id).groupId, -1);
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === userTab.id));
  assert.deepEqual([...core.owners.keys()], [otherTab.id]);
  assert.deepEqual(Object.keys(chrome.session.owners), [String(otherTab.id)]);
});

test('claim refuses browser pages and turns a new tab page into about:blank', async () => {
  const { call, chrome } = setup();
  const settings = chrome.addTab({ url: 'chrome://settings/' });
  const store = chrome.addTab({ url: 'https://chromewebstore.google.com/detail/x' });
  const ntp = chrome.addTab({ url: 'chrome://newtab/' });

  assert.match((await call(1, 'tabs.claim', { tabId: settings.id })).error.message, /can't be controlled/);
  assert.ok((await call(1, 'tabs.claim', { tabId: store.id })).error);
  const { result } = await call(1, 'tabs.claim', { tabId: ntp.id });
  assert.equal(result.url, 'about:blank');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active));
});

test('refused local files and view-source: pages are never opened or claimed, however the URL is written', async () => {
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  for (const url of ['file:///Users/me/.ssh/id_ed25519', 'fi\tle:///etc/passwd', ' FILE:///etc/passwd', '\u0001file:///etc/passwd',
    'view-source:file:///etc/passwd', 'view-source:https://example.com/']) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error?.message ?? '', /is blocked/, JSON.stringify(url));
  }
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'https://example.com/file:///x' }])).error);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigate').length, 1, 'only the https one reached the tab');
  for (const url of ['file:///Users/me/.notes/notes.txt', 'view-source:https://example.com/']) {
    const local = chrome.addTab({ url });
    assert.match((await call(1, 'tabs.claim', { tabId: local.id })).error.message, /can't be controlled/, url);
  }
  // Nor opened in a new tab, by tabs.open or by chrome.tabs.create (the relay's Target.createTarget).
  for (const url of ['file:///etc/passwd', 'fi\tle:///etc/passwd', 'view-source:file:///etc/passwd']) {
    assert.match((await call(1, 'tabs.open', { url })).error?.message ?? '', /only open web pages/, JSON.stringify(url));
    assert.match((await call(1, 'chrome.tabs.create', [{ url }])).error?.message ?? '', /only open web pages/, JSON.stringify(url));
  }
  assert.equal(chrome.calls.filter((c) => c[0] === 'tabs.create' || c[0] === 'windows.create').length, 1, 'only the first about:blank tab was created');
  assert.ok(!(await call(1, 'tabs.open', { url: 'https://example.com/file:///x' })).error);
});

// The MCP server resolves symlinks and is the real guard; this is the same rule on the URL's path alone.
test('allowed local files open, navigate and claim like web pages; refused ones, a child frame showing one and file access off are refused', async () => {
  const { call, chrome, core, sent } = setup();
  const PROTO = 'file:///Users/me/Downloads/x/proto.html?variant=A';
  const allowed = [PROTO, 'file:///Users/me/Library/Mobile%20Documents/com~apple~CloudDocs/a.html', 'file:///Users/me/Library/CloudStorage/Dropbox/a.html',
    'file:///Users/me/proto%20one.html#top', 'file:///tmp/a.html'];
  const refused = ['file:///Users/me/.ssh/id.html', 'file:///Users/me/%2Essh/id.html', 'file:///Users/me/Library/Keychains/x', 'file:///users/me/library/Cookies/x',
    'file:///Users/me/Downloads/', 'file:///private/var/log/system.log', 'file:///System/Library/x.plist', 'file:///etc/hosts', 'file://server/share/a.html',
    'file:///Users/me/a%E0.html'];
  const { result: tab } = await call(1, 'tabs.open', { url: PROTO });
  assert.equal(tab.url, PROTO);
  for (const url of allowed) {
    assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error, url);
  }
  for (const url of refused) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error?.message ?? '', /is blocked: .*agents only open web pages .* and local files outside hidden folders/, url);
    assert.match((await call(1, 'tabs.open', { url })).error?.message ?? '', /only open web pages/, url);
    assert.match((await call(1, 'tabs.claim', { tabId: chrome.addTab({ url }).id })).error?.message ?? '', /can't be controlled/, url);
  }
  const users = chrome.addTab({ url: PROTO });
  assert.ok(!(await call(1, 'tabs.claim', { tabId: users.id })).error);

  // A child frame committing a refused file makes the tab leave, like its main frame would; an allowed one doesn't.
  const detaches = () => chrome.calls.filter((c) => c[0] === 'debugger.detach' && c[1] === tab.id).length;
  const evaluate = () => call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Runtime.evaluate', { expression: '1' }]);
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 3, url: allowed[1] });
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameNavigated', { frame: { id: 'f4', parentId: 'main', url: allowed[3] } });
  assert.equal(detaches(), 0);
  assert.ok(!(await evaluate()).error);
  sent.length = 0;
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 3, url: 'file:///Users/me/.ssh/id.html' });
  assert.equal(detaches(), 1);
  assert.deepEqual(sent.map((m) => [m.method, m.params]), [['chrome.debugger.onDetach', [{ tabId: tab.id }, 'target_closed', { url: 'file:///Users/me/.ssh/id.html' }]]],
    'the detach names the refused file');
  assert.match((await evaluate()).error?.message ?? '', /agents can't control/);
  // Back once the main frame commits a page again; a frame of the page's own process seen by the debugger first.
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: PROTO });
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  assert.ok(!(await evaluate()).error);
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameNavigated', { frame: { id: 'f5', parentId: 'main', url: 'file:///Users/me/Library/Keychains/k' } });
  assert.equal(detaches(), 2);
  assert.match((await evaluate()).error?.message ?? '', /agents can't control/);

  // "Allow access to file URLs" off: Chrome wouldn't let the extension near file pages, so the agent is told what to ask for.
  chrome.hooks.noFileAccess = true;
  const { result: web } = await call(1, 'tabs.open', { url: 'https://example.com/' });
  for (const reply of [await call(1, 'tabs.open', { url: PROTO }), await call(1, 'chrome.debugger.sendCommand', [{ tabId: web.id }, 'Page.navigate', { url: PROTO }]),
    await call(1, 'tabs.claim', { tabId: chrome.addTab({ url: PROTO }).id })]) {
    assert.match(reply.error?.message ?? '', /turn on "Allow access to file URLs" in FowlBrowser's Details on the extensions page/);
  }
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: web.id }, 'Page.navigate', { url: 'https://example.org/' }])).error);
});

test('navigation checks work on Chrome 125, which has no URL.parse', async (t) => {
  const parse = URL.parse;
  delete URL.parse;
  t.after(() => { URL.parse = parse; });
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'https://example.org/' }])).error);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'file:///etc/passwd' }])).error?.message ?? '', /is blocked/);
  assert.match((await call(1, 'tabs.open', { url: 'file:///etc/passwd' })).error?.message ?? '', /only open web pages/);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigate').length, 1);
});

const OWN_PAGE = 'chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html';
const NOT_WEB = [OWN_PAGE, 'CHROME-EXTENSION://lpfcnmmimgcillacmnibffooadlofjhj/popup.html', ' chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html',
  'chrome-ext\tension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
  'chrome://settings', 'chrome-untrusted://print/', 'devtools://devtools/bundled/inspector.html', 'about:version', 'javascript:alert(1)',
  'mailto:me@example.com', 'file:///etc/passwd', 'fi\tle:///etc/passwd', 'view-source:https://example.com/',
  'blob:chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/6f1c', 'filesystem:https://example.com/temporary/x', '/relative', ''];
const WEB = ['https://example.com/', 'http://127.0.0.1:5411/a', ' HTTPS://example.com/b', 'about:blank', 'data:text/html,<p>hi</p>'];

// Confirmed live: Page.navigate to this extension's own popup.html kept the debugger attached (Chrome lets an extension
// debug its own pages), and an evaluate there had chrome.debugger, chrome.history and connectNative.
test('agent tabs only go to web pages: tabs.open, Page.navigate and history entries refuse extension, browser and local pages', async () => {
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const created = () => chrome.calls.filter((c) => c[0] === 'tabs.create' || c[0] === 'windows.create').length;
  const navigated = () => chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigate').length;
  for (const url of NOT_WEB) {
    assert.match((await call(1, 'tabs.open', { url })).error?.message ?? '', /agents only open web pages/, JSON.stringify(url));
    assert.match((await call(1, 'chrome.tabs.create', [{ url }])).error?.message ?? '', /agents only open web pages/, JSON.stringify(url));
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error?.message ?? '', /is blocked: .*agents only open web pages/, JSON.stringify(url));
    // Nor in a frame of the tab, or a child session.
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'child' }, 'Page.navigate', { url, frameId: 'f' }])).error?.message ?? '', /is blocked/, JSON.stringify(url));
  }
  assert.equal(created(), 1, 'only the first tab was created');
  assert.equal(navigated(), 0);
  for (const url of WEB) {
    assert.ok(!(await call(1, 'tabs.open', { url })).error, url);
    assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error, url);
  }
  assert.equal(created(), 1 + WEB.length);
  assert.equal(navigated(), WEB.length);
  // Back and forward: the entry's URL is looked up in the same session first.
  const history = [{ id: 1, url: 'https://example.com/' }, { id: 2, url: OWN_PAGE }, { id: 3, url: 'chrome://settings/' }, { id: 4, url: 'about:blank' }];
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, params) => (method === 'Page.getNavigationHistory' ? { currentIndex: 0, entries: history } : send(target, method, params));
  for (const entryId of [2, 3]) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigateToHistoryEntry', { entryId }])).error?.message ?? '', /is blocked: .*agents only open web pages/, String(entryId));
  }
  for (const entryId of [1, 4]) assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigateToHistoryEntry', { entryId }])).error, String(entryId));
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigateToHistoryEntry').length, 2);
});

test('a tab whose page reaches a non-web page anyway is let go at once, and refused until it shows a web page again', async () => {
  const { call, chrome, core, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  const detaches = () => chrome.calls.filter((c) => c[0] === 'debugger.detach' && c[1] === tab.id).length;
  const evaluate = () => call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Runtime.evaluate', { expression: 'chrome.debugger' }]);
  // Not for an error page, a blank page with a fragment, a subframe or another tab's commit.
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'about:blank#x' });
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameNavigated', { frame: { id: 'main', url: 'chrome-error://chromewebdata/' } });
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameNavigated', { frame: { id: 'sub', parentId: 'main', url: OWN_PAGE } });
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 3, url: OWN_PAGE });
  assert.equal(detaches(), 0);
  assert.ok(!(await evaluate()).error);

  // The page's own history.back() into an old entry: its commit, as Page.frameNavigated (webNavigation's comes too).
  sent.length = 0;
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameNavigated', { frame: { id: 'main', url: OWN_PAGE } });
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: OWN_PAGE });
  assert.equal(detaches(), 1, 'detached once');
  assert.ok(core.owners.get(tab.id).detached);
  assert.deepEqual(sent.map((m) => [m.method, m.params]), [['chrome.debugger.onDetach', [{ tabId: tab.id }, 'target_closed', { url: OWN_PAGE }]]],
    'the client hears a detach naming the page, and nothing of the page');
  await core.onDebuggerEvent({ tabId: tab.id }, 'Runtime.consoleAPICalled', { type: 'log', args: [] });
  assert.equal(sent.length, 1, 'events still on their way are dropped');
  assert.match((await evaluate()).error?.message ?? '', /agents can't control/);
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /agents can't control/);
  const commands = chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' || c[0] === 'debugger.attach').length;

  // Back on the web: driven again once the client attaches.
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'https://example.com/' });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.ok(!(await evaluate()).error);
  assert.ok(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' || c[0] === 'debugger.attach').length > commands);

  // webNavigation's commit alone is enough (a client that never enabled Page).
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'chrome://settings/' });
  assert.equal(detaches(), 2);
  assert.match((await evaluate()).error?.message ?? '', /agents can't control/);
});

test('attach refuses a tab showing a non-web page, also unrecorded (a restarted service worker), and lets go of one that left meanwhile', async () => {
  const { call, chrome, core } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  chrome.tabsById.get(tab.id).url = OWN_PAGE; // committed before this core heard of it
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /agents can't control/);
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.attach'));
  chrome.tabsById.get(tab.id).url = 'https://example.com/';
  // Its commit while the attach is under way.
  const send = chrome.debugger.attach;
  chrome.debugger.attach = async (target) => { await send(target); await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: OWN_PAGE }); };
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /agents can't control/);
  const last = chrome.calls.filter((c) => c[0].startsWith('debugger.')).at(-1);
  assert.deepEqual(last, ['debugger.detach', tab.id], 'detached after the attach');
});

// Measured on a test Mac (Helium 155, 2026-10-19): an OAuth popup attached as its first cross-site page committed got
// "Not attached to an active page" for Page.getNavigationHistory; the attach failed and the popup was never the agent's.
test('attach asks again while the tab\'s page is between documents, and still lets go of the tab on any other error', async () => {
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  const send = chrome.debugger.sendCommand;
  const sent = (method) => chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[1] === tab.id && c[2] === method).length;
  const swapping = { 'Page.getNavigationHistory': 3, 'Emulation.setFocusEmulationEnabled': 2 };
  chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await send(target, method, params);
    if (swapping[method] > 0 && swapping[method]--) throw new Error('{"code":-32000,"message":"Not attached to an active page"}');
    return result;
  };
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual([sent('Page.getNavigationHistory'), sent('Emulation.setFocusEmulationEnabled')], [4, 3], 'asked again until the page was there');
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === tab.id), 'still attached');

  chrome.debugger.sendCommand = async (target, method, params) => {
    const result = await send(target, method, params);
    if (method === 'Page.getNavigationHistory') throw new Error('{"code":-32000,"message":"Inspected target navigated or closed"}');
    return result;
  };
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /Inspected target navigated or closed/);
  assert.equal(sent('Page.getNavigationHistory'), 5, 'not asked again');
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === tab.id), 'let go');
});

// Sol: a script added for new documents, then history.back() into this extension's own page, runs there with the
// extension's powers before any commit is seen. A tab with such an entry is never attached.
test("a tab with this extension's own page in its history is refused at attach and detached; other browser pages there don't matter", async () => {
  const { call, chrome } = setup();
  const histories = new Map();
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, params) => (method === 'Page.getNavigationHistory'
    ? (chrome.calls.push(['debugger.sendCommand', target.tabId, method]), { currentIndex: 1, entries: histories.get(target.tabId) ?? [] })
    : send(target, method, params));
  const web = { id: 9, url: 'https://mail.example/' };
  for (const own of ['chrome-extension://fowlbrowser-ext/popup.html', 'blob:chrome-extension://fowlbrowser-ext/6f1c', 'filesystem:chrome-extension://fowlbrowser-ext/temporary/x']) {
    const tab = chrome.addTab({ url: 'https://mail.example/' });
    histories.set(tab.id, [{ id: 1, url: own }, web]);
    assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error, 'the claim itself goes through');
    assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /FowlBrowser page in its history/, own);
    assert.deepEqual(chrome.calls.filter((c) => c[1] === tab.id && c[0].startsWith('debugger.')).map((c) => c[2] ?? c[0]),
      ['debugger.attach', 'Page.getNavigationHistory', 'debugger.detach'], 'detached before anything else was sent');
  }
  // Browser pages and another extension's page in the history: attached as usual.
  const tab = chrome.addTab({ url: 'https://mail.example/' });
  histories.set(tab.id, [{ id: 1, url: 'chrome://settings/' }, { id: 2, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html' }, web]);
  await call(1, 'tabs.claim', { tabId: tab.id });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === tab.id));
  // An agent's own tab is checked the same way (tab_open attaches through here too).
  const { result: opened } = await call(1, 'tabs.open', { url: 'https://example.com' });
  histories.set(opened.id, [{ id: 1, url: 'chrome-extension://fowlbrowser-ext/popup.html' }]);
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: opened.id }, '1.3'])).error?.message ?? '', /FowlBrowser page in its history/);
});

// Sol: the about:blank chrome.tabs.create makes runs in this extension's process with the extension as its initiator;
// whatever Chrome lets such a document navigate to, no client command or new-document script ever runs in it.
test('a blank tab this extension made is re-navigated to a browser-made blank page before the client gets it', async () => {
  const { call, chrome } = setup();
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Page.navigate') return chrome.calls.push(['navigate', target.tabId, params.url]) && { frameId: 'main' };
    if (method !== 'Page.getNavigationHistory') return send(target, method, params);
    chrome.calls.push(['debugger.sendCommand', target.tabId, method]);
    const tab = chrome.tabsById.get(target.tabId);
    return { currentIndex: 0, entries: [{ id: 1, url: tab.url }] };
  };
  const sequence = (tabId) => chrome.calls.filter((c) => c[1] === tabId && /^(debugger\.|navigate)/.test(c[0])).map((c) => (c[0] === 'navigate' ? `navigate ${c[2]}` : c[2] ?? c[0]));
  const attach = (tabId) => call(1, 'chrome.debugger.attach', [{ tabId }, '1.3']);
  // tabs.open (also the relay's Target.createTarget): replaced right after the attach, before focus emulation.
  const { result: blank } = await call(1, 'tabs.open', {});
  assert.ok(!(await attach(blank.id)).error);
  assert.deepEqual(sequence(blank.id), ['debugger.attach', 'Page.getNavigationHistory', 'navigate about:blank',
    'Emulation.setFocusEmulationEnabled', 'Page.setWebLifecycleState']);
  // Once: a later attach (a re-claim after Cancel) leaves the page alone.
  assert.ok(!(await attach(blank.id)).error);
  assert.equal(sequence(blank.id).filter((s) => s.startsWith('navigate')).length, 1);
  // A tabs.openChild child and a claimed New Tab page are blank pages this extension asked for too.
  const opener = (await call(1, 'tabs.open', { url: 'https://example.com' })).result;
  const { result: child } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  const ntp = chrome.addTab({ url: 'chrome://newtab/' });
  assert.ok(!(await call(1, 'tabs.claim', { tabId: ntp.id })).error);
  for (const tabId of [child.tabId, ntp.id]) {
    assert.ok(!(await attach(tabId)).error);
    assert.ok(sequence(tabId).includes('navigate about:blank'), String(tabId));
  }
  // Not a web page, nor a blank page the extension didn't make (a popup a page wrote into), nor one that moved on.
  const users = chrome.addTab({ url: 'about:blank' });
  await call(1, 'tabs.claim', { tabId: users.id });
  const { result: moved } = await call(1, 'tabs.open', {});
  chrome.tabsById.get(moved.id).url = 'https://example.com/';
  for (const tabId of [opener.id, users.id, moved.id]) {
    assert.ok(!(await attach(tabId)).error);
    assert.ok(!sequence(tabId).some((s) => s.startsWith('navigate')), String(tabId));
  }
  // A failed replacement leaves no debugger on the tab.
  const { result: failing } = await call(1, 'tabs.open', {});
  chrome.debugger.sendCommand = async (target, method, params) => {
    if (method === 'Page.navigate') throw new Error('Cannot navigate');
    return method === 'Page.getNavigationHistory' ? { currentIndex: 0, entries: [{ id: 1, url: 'about:blank' }] } : send(target, method, params);
  };
  assert.match((await attach(failing.id)).error?.message ?? '', /Cannot navigate/);
  assert.equal(chrome.calls.at(-1).join(' '), `debugger.detach ${failing.id}`);
});

// mac2: a fresh agent tab's own location change reached the extension's popup in Chrome and Helium, and the commit-time
// detach came only at or after that page's document existed. The debugger now lets go as the navigation starts.
test('a navigation toward a non-web page detaches the tab as it starts, before any commit; web navigations and other tabs are left alone', async () => {
  const { call, chrome, core, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  const { result: other } = await call(1, 'tabs.open', { url: 'https://example.org' });
  const users = chrome.addTab({ url: 'https://mail.example' });
  for (const id of [tab.id, other.id]) await call(1, 'chrome.debugger.attach', [{ tabId: id }, '1.3']);
  const detaches = (id) => chrome.calls.filter((c) => c[0] === 'debugger.detach' && c[1] === id).length;
  const evaluate = (id) => call(1, 'chrome.debugger.sendCommand', [{ tabId: id }, 'Runtime.evaluate', { expression: '1' }]);
  // Left alone: web navigations, the user's tab, other extensions' frames and srcdoc frames (password managers, widgets).
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 0, url: 'https://example.com/next' });
  await core.onBeforeNavigate({ tabId: users.id, frameId: 0, url: OWN_PAGE });
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 4, url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/frame.html' });
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 5, url: 'about:srcdoc' });
  await core.onDebuggerEvent({ tabId: tab.id }, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'chrome-extension://fowlbrowser-ext/popup.html', disposition: 'newTab', reason: 'scriptInitiated' });
  assert.equal(detaches(tab.id), 0);
  assert.ok(!(await evaluate(tab.id)).error);

  // The page's own location change to this extension's popup: gone as it starts, with no commit seen.
  sent.length = 0;
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 0, url: OWN_PAGE });
  assert.equal(detaches(tab.id), 1);
  assert.deepEqual(sent.map((m) => [m.method, m.params]), [['chrome.debugger.onDetach', [{ tabId: tab.id }, 'target_closed', { url: OWN_PAGE }]]]);
  assert.match((await evaluate(tab.id)).error?.message ?? '', /agents can't control/);
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error?.message ?? '', /agents can't control/);
  assert.equal(detaches(other.id), 0, 'other tabs are untouched');
  assert.ok(!(await evaluate(other.id)).error);
  // An error for another navigation changes nothing; one for this navigation (blocked, cancelled) gives the tab back.
  await core.onNavigationError({ tabId: tab.id, frameId: 0, url: 'https://example.com/old' });
  assert.match((await evaluate(tab.id)).error?.message ?? '', /agents can't control/);
  await core.onNavigationError({ tabId: tab.id, frameId: 0, url: OWN_PAGE });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.ok(!(await evaluate(tab.id)).error);
  // Once it commits there, an error no longer gives it back.
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 0, url: 'chrome://settings/' });
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'chrome://settings/' });
  await core.onNavigationError({ tabId: tab.id, frameId: 0, url: 'chrome://settings/' });
  assert.match((await evaluate(tab.id)).error?.message ?? '', /agents can't control/);
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'https://example.com/' });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);

  // A child frame sent to this extension's own page, and the page's request seen first over CDP.
  await core.onBeforeNavigate({ tabId: tab.id, frameId: 7, url: 'blob:chrome-extension://fowlbrowser-ext/6f1c' });
  assert.equal(detaches(tab.id), 3);
  await core.onNavigationCommitted({ tabId: tab.id, frameId: 0, url: 'https://example.com/again' });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: other.id }, '1.3'])).error);
  // (This extension's id in the fake chrome is fowlbrowser-ext.)
  await core.onDebuggerEvent({ tabId: other.id }, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'chrome-extension://fowlbrowser-ext/popup.html', disposition: 'currentTab', reason: 'scriptInitiated' });
  assert.equal(detaches(other.id), 1);
  assert.match((await evaluate(other.id)).error?.message ?? '', /agents can't control/);
});

test("a child target showing a non-web page is let go, and its session refused", async () => {
  const { call, chrome, core, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  sent.length = 0;
  await core.onDebuggerEvent({ tabId: tab.id }, 'Target.attachedToTarget',
    { sessionId: 'ext-session', targetInfo: { targetId: 'ext-frame', type: 'iframe', url: OWN_PAGE } });
  assert.equal(sent.length, 0, 'the client never hears of it');
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand').map((c) => [c[1], c[2]]), [[tab.id, 'Target.detachFromTarget']]);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'ext-session' }, 'Runtime.evaluate', {}])).error?.message ?? '', /agents can't control/);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.attachToTarget', { targetId: 'ext-frame', flatten: true }])).error?.message ?? '', /is blocked/);
  sent.length = 0;
  await core.onDebuggerEvent({ tabId: tab.id, sessionId: 'ext-session' }, 'Runtime.consoleAPICalled', { type: 'log', args: [] });
  assert.equal(sent.length, 0);
  // A web child that later navigates to such a page in its own session (an out-of-process iframe).
  await core.onDebuggerEvent({ tabId: tab.id }, 'Target.attachedToTarget',
    { sessionId: 'web-session', targetInfo: { targetId: 'web-frame', type: 'iframe', url: 'https://ads.example/' } });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'web-session' }, 'Runtime.evaluate', {}])).error);
  // Its own frame has a parentId (the frame in the tab it is in); a frame inside it doesn't count.
  await core.onDebuggerEvent({ tabId: tab.id, sessionId: 'web-session' }, 'Page.frameNavigated', { frame: { id: 'inner', parentId: 'web-frame', url: 'chrome://settings/' } });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'web-session' }, 'Runtime.evaluate', {}])).error);
  await core.onDebuggerEvent({ tabId: tab.id, sessionId: 'web-session' }, 'Page.frameNavigated', { frame: { id: 'web-frame', parentId: 'main', url: 'chrome://settings/' } });
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'web-session' }, 'Runtime.evaluate', {}])).error?.message ?? '', /agents can't control/);
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Runtime.evaluate', {}])).error, 'the tab itself is still driven');
  await core.onDebuggerEvent({ tabId: tab.id, sessionId: 'web-session' }, 'Page.frameNavigated', { frame: { id: 'web-frame', parentId: 'main', url: 'https://ads.example/2' } });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'web-session' }, 'Runtime.evaluate', {}])).error);
});

// The audit reached Page.setDownloadBehavior (into ~/Library/LaunchAgents), Extensions.*, PWA.*, Security.* and more
// through a blocklist; now only what FowlBrowser's own stack sends passes.
test('CDP is an allowlist: what Playwright, the MCP tools and Lighthouse send passes; anything else is refused', async () => {
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  for (const [method, params = {}] of [['Page.enable'], ['Page.getFrameTree'], ['Page.captureScreenshot'], ['Page.createIsolatedWorld'],
    ['Page.addScriptToEvaluateOnNewDocument'], ['Page.setLifecycleEventsEnabled'], ['Page.handleJavaScriptDialog'], ['Page.reload'],
    ['Page.setInterceptFileChooserDialog'], ['Page.startScreencast'], ['Page.printToPDF'], ['Runtime.enable'], ['Runtime.callFunctionOn'],
    ['Runtime.addBinding'], ['Runtime.getHeapUsage'], ['DOM.describeNode'], ['DOM.getContentQuads'], ['DOM.setFileInputFiles'],
    ['Input.dispatchMouseEvent'], ['Input.dispatchKeyEvent'], ['Input.insertText'], ['Emulation.setFocusEmulationEnabled'],
    ['Emulation.setDeviceMetricsOverride'], ['Network.enable'], ['Network.getResponseBody'], ['Network.setExtraHTTPHeaders'],
    ['Network.emulateNetworkConditions'], ['Network.loadNetworkResource', { url: 'https://docs.google.com/export', frameId: 'f' }],
    ['Fetch.enable'], ['Fetch.continueRequest'], ['Log.enable'], ['Inspector.enable'], ['IO.read'], ['IO.close'], ['Tracing.start'],
    ['Tracing.end'], ['Target.setAutoAttach'], ['Accessibility.queryAXTree'], ['Performance.getMetrics'], ['CSS.enable'],
    ['Debugger.enable'], ['DOMDebugger.getEventListeners'], ['Profiler.enable'], ['Audits.enable'], ['Storage.getUsageAndQuota'],
    ['HeapProfiler.collectGarbage'], ['WebMCP.enable']]) {
    assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, params])).error, method);
  }
  const passed = chrome.calls.filter((c) => c[0] === 'debugger.sendCommand').length;
  for (const [method, params = {}] of [['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/Users/me/Library/LaunchAgents' }],
    ['Browser.setDownloadBehavior'], ['Browser.getVersion'], ['Network.loadNetworkResource', { url: 'file:///Users/me/.ssh/id_ed25519', frameId: 'f' }],
    ['Network.loadNetworkResource', { url: OWN_PAGE }], ['Network.loadNetworkResource'], ['Network.clearBrowserCache'],
    ['Network.getAllCookies'], ['Network.setCookieControls'], ['Extensions.loadUnpacked', { path: '/tmp/x' }], ['Extensions.uninstall'],
    ['Extensions.getStorageItems'], ['PWA.install'], ['PWA.launch'], ['Cast.enable'], ['Security.setIgnoreCertificateErrors', { ignore: true }],
    ['Security.setOverrideCertificateErrors'], ['Security.handleCertificateError'], ['WebAuthn.enable'], ['WebAuthn.addVirtualAuthenticator'],
    ['FedCm.enable'], ['Autofill.trigger'], ['DeviceAccess.enable'], ['BluetoothEmulation.enable'], ['DigitalCredentials.enable'],
    ['FileSystem.getDirectory'], ['BackgroundService.startObserving'], ['SystemInfo.getInfo'], ['Storage.getCookies'],
    ['Storage.clearDataForOrigin'], ['ServiceWorker.enable'], ['IndexedDB.enable'], ['DOMStorage.enable'], ['CacheStorage.enable'],
    ['IO.resolveBlob'], ['Page.setRPHRegistrationMode'], ['Page.setSPCTransactionMode'], ['Page.bringToFront'], ['Tracing.requestMemoryDump'],
    ['Preload.enable'], ['SomeFutureDomain.enable'], ['Runtime'], ['Runtime.evaluate.extra'], ['constructor.name'], ['__proto__.x'], ['toString.call']]) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, params])).error?.message ?? '', /is blocked/, method);
  }
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand').length, passed, 'none reached the browser');
});

// Forwarded events carried every site's cookies, HttpOnly ones included, to any process holding the host token.
test('no cookie value leaves the extension: events and loadNetworkResource keep cookie names with a placeholder value', async () => {
  const { call, chrome, core, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  const source = { tabId: tab.id };
  const response = { url: 'https://example.com/', status: 200, headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=SECRET01; Path=/; HttpOnly' },
    requestHeaders: { Cookie: 'sid=SECRET02; theme=SECRET03' }, headersText: 'HTTP/1.1 200 OK\r\nset-cookie: sid=SECRET04; Secure\r\nX-A: 1\r\n',
    requestHeadersText: 'GET / HTTP/1.1\r\nCookie: sid=SECRET05\r\nHost: example.com\r\n' };
  sent.length = 0;
  const events = [
    ['Network.requestWillBeSent', { requestId: '1', request: { url: 'https://example.com/', headers: { Cookie: 'a=SECRET06', Accept: '*/*' } }, redirectResponse: response }],
    ['Network.requestWillBeSentExtraInfo', { requestId: '1', headers: { cookie: 'sid=SECRET07; nameless', ':path': '/' },
      associatedCookies: [{ blockedReasons: [], cookie: { name: 'sid', value: 'SECRET08', domain: 'example.com', httpOnly: true } }] }],
    ['Network.responseReceived', { requestId: '1', response }],
    ['Network.responseReceivedExtraInfo', { requestId: '1', statusCode: 200, headers: { 'set-cookie': 'sid=SECRET09; Path=/\nother=SECRET10; Max-Age=60' },
      headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: sid=SECRET11\r\n', blockedCookies: [{ blockedReasons: ['SecureOnly'], cookieLine: 'x=SECRET12; Secure', cookie: { name: 'x', value: 'SECRET13' } }],
      exemptedCookies: [{ exemptionReason: 'None', cookieLine: 'y=SECRET14', cookie: { name: 'y', value: 'SECRET15' } }] }],
    ['Network.responseReceivedEarlyHints', { requestId: '1', headers: { 'Set-Cookie': 'z=SECRET16' } }],
    ['Network.webSocketWillSendHandshakeRequest', { requestId: '2', request: { headers: { Cookie: 'ws=SECRET17' } } }],
    ['Network.webSocketHandshakeResponseReceived', { requestId: '2', response }],
    ['Network.signedExchangeReceived', { requestId: '3', info: { outerResponse: response, header: { responseHeaders: { 'set-cookie': 'sx=SECRET18' } } } }],
    ['Fetch.requestPaused', { requestId: 'f1', request: { url: 'https://example.com/', headers: { Cookie: 'f=SECRET19' } },
      responseHeaders: [{ name: 'Set-Cookie', value: 'g=SECRET20; Path=/' }, { name: 'Content-Type', value: 'text/html' }] }],
    ['Fetch.authRequired', { requestId: 'f2', request: { headers: { cookie: 'h=SECRET21' } } }],
    ['Audits.issueAdded', { issue: { code: 'CookieIssue', details: { cookieIssueDetails: { cookie: { name: 'i', domain: 'example.com', path: '/' }, rawCookieLine: 'i=SECRET22; j=SECRET23' } } } }],
  ];
  for (const [method, params] of events) await core.onDebuggerEvent(source, method, structuredClone(params));
  const forwarded = JSON.stringify(sent);
  assert.equal(sent.length, events.length);
  assert.doesNotMatch(forwarded, /SECRET/);
  const params = (method) => sent.find((m) => m.params[1] === method).params[2];
  assert.deepEqual(params('Network.requestWillBeSentExtraInfo').headers, { cookie: 'sid=hidden; hidden', ':path': '/' });
  assert.deepEqual(params('Network.requestWillBeSentExtraInfo').associatedCookies[0].cookie, { name: 'sid', value: 'hidden', domain: 'example.com', httpOnly: true });
  assert.equal(params('Network.responseReceivedExtraInfo').headers['set-cookie'], 'sid=hidden; Path=/\nother=hidden; Max-Age=60');
  assert.equal(params('Network.responseReceivedExtraInfo').headersText, 'HTTP/1.1 200 OK\r\nSet-Cookie: sid=hidden\r\n');
  assert.equal(params('Network.responseReceivedExtraInfo').blockedCookies[0].cookieLine, 'x=hidden; Secure');
  assert.deepEqual(params('Network.responseReceived').response, { ...response, headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'sid=hidden; Path=/; HttpOnly' },
    requestHeaders: { Cookie: 'sid=hidden; theme=hidden' }, headersText: 'HTTP/1.1 200 OK\r\nset-cookie: sid=hidden; Secure\r\nX-A: 1\r\n',
    requestHeadersText: 'GET / HTTP/1.1\r\nCookie: sid=hidden\r\nHost: example.com\r\n' });
  assert.deepEqual(params('Fetch.requestPaused').responseHeaders, [{ name: 'Set-Cookie', value: 'g=hidden; Path=/' }, { name: 'Content-Type', value: 'text/html' }]);
  assert.equal(params('Network.requestWillBeSent').request.headers.Accept, '*/*');
  // Other events pass unchanged.
  const other = { requestId: '1', timestamp: 1, type: 'Document' };
  await core.onDebuggerEvent(source, 'Network.loadingFinished', other);
  assert.equal(sent.at(-1).params[2], other);
  // A command's headers: loadNetworkResource (export's download) answers with the response's.
  chrome.debugger.sendCommand = async () => ({ resource: { success: true, httpStatusCode: 200, stream: 's1', headers: { 'content-type': 'text/csv', 'set-cookie': 'k=SECRET24' } } });
  const { result } = await call(1, 'chrome.debugger.sendCommand', [source, 'Network.loadNetworkResource', { url: 'https://docs.google.com/x', frameId: 'f' }]);
  assert.deepEqual(result.resource.headers, { 'content-type': 'text/csv', 'set-cookie': 'k=hidden' });
});

test('tabs.focus brings any tab to the front but an incognito one', async () => {
  const { call, chrome } = setup();
  const { result: mine } = await call(1, 'tabs.open', {});
  const { result: theirs } = await call(2, 'tabs.open', {});
  const users = chrome.addTab({ url: 'https://mail.example' });
  const privateTab = chrome.addTab({ url: 'https://bank.example', incognito: true, windowId: 7 });
  assert.match((await call(1, 'tabs.focus', { tabId: privateTab.id })).error?.message ?? '', /incognito/);
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active), 'nothing was activated');
  assert.ok(!chrome.calls.some((c) => c[0] === 'windows.update'));
  for (const tab of [mine, users, theirs]) assert.deepEqual((await call(1, 'tabs.focus', { tabId: tab.id })).result, { ok: true });
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2].active).map((c) => c[1]), [mine.id, users.id, theirs.id]);
});

test('incognito tabs are never claimed, also not by a resume', async () => {
  const { call, chrome, core } = setup();
  const privateTab = chrome.addTab({ url: 'https://mail.example', incognito: true });
  assert.match((await call(1, 'tabs.claim', { tabId: privateTab.id })).error.message, /incognito/);
  assert.ok(!core.owners.has(privateTab.id));
  // A tab owned (parked) before it was moved into an incognito window: the resume is refused too.
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  chrome.tabsById.get(tab.id).incognito = true;
  assert.match((await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error.message, /incognito/);
});

test('chunked host messages are reassembled', async () => {
  const { sent, core, connect } = setup();
  await connect(1);
  const json = JSON.stringify({ id: 7, method: 'extension.info', params: {}, client: 1 });
  const parts = [json.slice(0, 10), json.slice(10, 30), json.slice(30)];
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 0, total: 3, data: parts[0] } });
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 1, total: 3, data: parts[1] } });
  assert.equal(sent.length, 0);
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c1', index: 2, total: 3, data: parts[2] } });
  assert.equal(sent[0].id, 7);
  assert.equal(sent[0].result.version, '0.1.0');
});

test('a restarted worker cleans up what the previous worker owned', async () => {
  const chrome = fakeChrome();
  const agentTab = chrome.addTab({});
  const userTab = chrome.addTab({});
  Object.assign(chrome.session, {
    owners: { [agentTab.id]: { client: 3, origin: 'agent', group: 'Claude', kept: false },
      [userTab.id]: { client: 3, origin: 'user', group: null, kept: false } },
    labels: { 3: 'Claude' },
  });
  const core = createCore({ chrome, send: () => {} });
  await core.ready;
  assert.equal(chrome.tabsById.has(agentTab.id), false);
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.equal(core.owners.size, 0);
});

test('only clients the host announced are served, and chunks never carry host messages', async () => {
  const { core, sent, connect, call, chrome } = setup();
  await core.handleMessage({ id: 'stranger', method: 'tabs.open', params: {}, client: 9 });
  assert.equal(sent.find((m) => m.id === 'stranger').error.message, 'Unknown client');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.create'));

  const { result: tab } = await call(1, 'tabs.open', {});
  await connect(2);
  const smuggled = JSON.stringify({ method: 'host.clientDisconnected', params: { client: 1 } });
  await core.handleMessage({ method: 'host.chunk', params: { id: 'c', index: 0, total: 1, data: smuggled } });
  assert.ok(core.owners.has(tab.id));
  assert.ok(chrome.tabsById.has(tab.id));
});

test('a client that disconnects mid-open gets no tab: the late tab is closed', async () => {
  const { core, chrome, start } = setup();
  const release = gate(chrome, 'tabs.create');
  const request = start(1, 'tabs.open', {});
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  release();
  await request.done;
  assert.equal(request.reply().error.message, 'Client disconnected');
  assert.equal(core.owners.size, 0);
  assert.equal(chrome.tabsById.size, 0);
});

test('a client that disconnects mid-claim never owns the tab', async () => {
  const { core, chrome, start } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  const release = gate(chrome, 'tabs.get');
  const request = start(1, 'tabs.claim', { tabId: userTab.id });
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  release();
  await request.done;
  assert.equal(request.reply().error.message, 'Client disconnected');
  assert.equal(core.owners.size, 0);
  assert.ok(chrome.tabsById.has(userTab.id));
});

test('replies and tabs from before a native port reconnect never reach the new port', async () => {
  const { core, chrome, sent, start, call } = setup();
  const release = gate(chrome, 'tabs.create');
  const request = start(1, 'tabs.open', {});
  await tick();
  const closing = core.portClosed();
  // The new host restarts client and request ids: client 1 is someone else now.
  await call(1, 'client.hello', { label: 'New' });
  sent.length = 0;
  release();
  await request.done;
  await closing;
  assert.equal(request.reply(), undefined);
  assert.deepEqual(sent.filter((m) => m.client === 1), []);
  assert.equal(core.owners.size, 0);
  assert.equal(chrome.tabsById.size, 0);
});

test('a tab being released stays reserved until its cleanup is done', async () => {
  const { core, chrome, call, start } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });

  const release = gate(chrome, 'debugger.detach');
  const releasing = start(1, 'tabs.release', { tabId: userTab.id });
  await tick();
  assert.match((await call(2, 'tabs.claim', { tabId: userTab.id })).error.message, /being released/);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: userTab.id }, 'Page.reload'])).error.message, /being released/);
  release();
  await releasing.done;
  assert.deepEqual(releasing.reply().result, { ok: true });
  assert.equal(core.owners.has(userTab.id), false);

  // Disconnect cleanup: the same reservation, and the detach never lands on a later owner.
  await call(2, 'tabs.claim', { tabId: userTab.id });
  const release2 = gate(chrome, 'debugger.detach');
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 2 } });
  await tick();
  assert.match((await call(3, 'tabs.claim', { tabId: userTab.id })).error.message, /being released/);
  assert.equal(chrome.session.owners[userTab.id].client, 2, 'ownership stays stored until cleanup finishes');
  release2();
  await cleanup;
  assert.equal(core.owners.has(userTab.id), false);
  const detaches = chrome.calls.filter((c) => c[0] === 'debugger.detach').length;
  assert.ok(!(await call(3, 'tabs.claim', { tabId: userTab.id })).error);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.detach').length, detaches);
  assert.equal(core.owners.get(userTab.id).client, 3);
});

test('a popup belongs to the tab webNavigation names, not to a wrong openerTabId', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});
  sent.length = 0;

  // Helium names B's tab (the active one) as opener of A's popup.
  const popup = chrome.addTab({ openerTabId: tabB.id, url: 'https://example.com/popup' });
  await core.onTabCreated(structuredClone(popup));
  assert.equal(core.owners.has(popup.id), false, 'not adopted before the navigation target arrives');
  await core.onNavigationTarget({ sourceTabId: tabA.id, tabId: popup.id });
  await tick();
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.equal(chrome.tabsById.get(popup.id).mutedInfo.muted, true);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === popup.id));
  assert.ok(!sent.some((m) => m.client === 2 && m.params?.[0]?.id === popup.id));

  // A navigation target from the user's tab keeps the popup the user's, whatever openerTabId says.
  const userTab = chrome.addTab({ url: 'https://mail.example' });
  const userPopup = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(userPopup));
  await core.onNavigationTarget({ sourceTabId: userTab.id, tabId: userPopup.id });
  await timers.fire(750);
  assert.equal(core.owners.has(userPopup.id), false);

  // Without a navigation target the popup is never adopted, whatever openerTabId says.
  const late = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(late));
  await timers.fire(750);
  assert.equal(core.owners.has(late.id), false);
});

test('a replaced tab keeps its owner and the client hears about the swap', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const replacement = chrome.addTab({ url: 'https://example.com/prerendered' });
  chrome.tabsById.delete(tab.id);
  sent.length = 0;
  await core.onTabReplaced(replacement.id, tab.id);
  assert.equal(core.owners.has(tab.id), false);
  assert.equal(core.owners.get(replacement.id).client, 1);
  assert.deepEqual(Object.keys(chrome.session.owners), [String(replacement.id)]);
  assert.equal(sent[0].params[1].replacedBy, replacement.id, 'a swap, not a close');
  assert.deepEqual(sent.map((m) => [m.method, m.client, m.params[0]?.id ?? m.params[0]]), [
    ['chrome.tabs.onRemoved', 1, tab.id],
    ['chrome.tabs.onCreated', 1, replacement.id],
  ]);
});

test('a debugger taken away by the user stays owned and re-attaches only on an explicit claim', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const createdEvents = () => sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === tab.id).length;

  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 1, 'claiming an attached tab you own emits nothing');

  await core.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
  assert.equal(core.owners.get(tab.id).detached, true);
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.attach'), 'never re-attaches on its own');
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /controlled by another agent session/);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 2);
  // The re-attach fails (DevTools still open): the tab stays detached, so a later claim can retry.
  chrome.hooks.attachError = 'Cannot attach to this target';
  assert.ok((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.equal(core.owners.get(tab.id).detached, true);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 3);
  delete chrome.hooks.attachError;
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.ok(!core.owners.get(tab.id).detached);
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id })).error);
  assert.equal(createdEvents(), 3);

  // target_closed while the tab still exists (a chrome:// page, a crash) detaches it too; for a closing tab it does not.
  await core.onDebuggerDetach({ tabId: tab.id }, 'target_closed');
  assert.equal(core.owners.get(tab.id).detached, true);
  const { result: closing } = await call(1, 'tabs.open', {});
  chrome.tabsById.delete(closing.id);
  await core.onDebuggerDetach({ tabId: closing.id }, 'target_closed');
  assert.ok(!core.owners.get(closing.id).detached);
});

test('CDP commands that reach beyond the tab are refused for every client', async () => {
  const { call, chrome, core } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  for (const method of ['Browser.close', 'Browser.grantPermissions', 'Target.createTarget', 'Target.closeTarget',
    'Target.attachToBrowserTarget', 'Target.exposeDevToolsProtocol', 'Target.createBrowserContext',
    'Target.disposeBrowserContext', 'Network.clearBrowserCookies', 'Network.clearBrowserCache',
    'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey', 'Storage.clearCookies', 'Storage.setCookies',
    'Storage.clearSharedStorageEntries',
    // focus theft, other targets, profile-wide cookie and storage writes
    'Page.bringToFront', 'Target.activateTarget', 'Target.setDiscoverTargets', 'Target.getTargets',
    'Network.setCookie', 'Network.setCookies', 'Network.deleteCookies',
    'DOMStorage.clear', 'DOMStorage.removeDOMStorageItem', 'DOMStorage.setDOMStorageItem',
    'IndexedDB.deleteDatabase', 'IndexedDB.clearObjectStore', 'IndexedDB.deleteObjectStoreEntries',
    'CacheStorage.deleteCache', 'CacheStorage.deleteEntry',
    'ServiceWorker.unregister', 'ServiceWorker.skipWaiting', 'ServiceWorker.stopAllWorkers', 'ServiceWorker.startWorker',
    'Storage.setSharedStorageEntry', 'Storage.overrideQuotaForOrigin', 'Storage.clearTrustTokens',
    'Storage.deleteSharedStorageEntry', 'Storage.runBounceTrackingMitigations']) {
    const reply = await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, {}]);
    assert.match(reply.error?.message ?? '', /is blocked/, method);
  }
  // Target.attachToTarget / sendMessageToTarget only reach the tab's own children.
  for (const [method, params] of [['Target.attachToTarget', { targetId: 'other-tab', flatten: true }],
    ['Target.sendMessageToTarget', { targetId: 'other-tab', message: '{}' }],
    ['Target.sendMessageToTarget', { sessionId: 'other-session', message: '{}' }],
    ['Target.attachToTarget', {}]]) {
    const reply = await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, params]);
    assert.match(reply.error?.message ?? '', /is blocked/, `${method} ${JSON.stringify(params)}`);
  }
  assert.ok(!chrome.calls.some((c) => c[0] === 'debugger.sendCommand'));
  await core.onDebuggerEvent({ tabId: tab.id }, 'Target.attachedToTarget',
    { sessionId: 'child-session', targetInfo: { targetId: 'child-frame', type: 'iframe' } });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.attachToTarget', { targetId: 'child-frame', flatten: true }])).error);
  // Non-flat sessions would carry commands past the filter: refused even for the tab's own child.
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.attachToTarget', { targetId: 'child-frame' }])).error?.message ?? '', /is blocked/);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Target.sendMessageToTarget', { sessionId: 'child-session', message: '{}' }])).error?.message ?? '', /is blocked/);
  // Another tab's children are not this tab's.
  const { result: other } = await call(1, 'tabs.open', {});
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: other.id }, 'Target.attachToTarget', { targetId: 'child-frame', flatten: true }])).error?.message ?? '', /is blocked/);
  for (const method of ['Network.enable', 'Storage.getUsageAndQuota', 'Target.getTargetInfo', 'Target.detachFromTarget', 'Runtime.evaluate']) {
    assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, {}])).error, method);
  }
  // Cookies and other sites' stored data are never read out, for any site.
  for (const method of ['Network.getCookies', 'Network.getAllCookies', 'Storage.getCookies', 'DOMStorage.getDOMStorageItems',
    'IndexedDB.requestData', 'IndexedDB.requestDatabase', 'IndexedDB.requestDatabaseNames', 'IndexedDB.getMetadata',
    'CacheStorage.requestCacheNames', 'CacheStorage.requestEntries', 'CacheStorage.requestCachedResponse',
    // nor profile-wide storage metadata (trust token issuers, other origins' database names and activity)
    'Storage.getTrustTokens', 'Storage.trackIndexedDBForOrigin', 'Storage.trackCacheStorageForStorageKey',
    'Storage.getSharedStorageEntries', 'Storage.getInterestGroupDetails']) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, method, {}])).error?.message ?? '', /is blocked/, method);
  }
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id, sessionId: 'child' }, 'Target.setAutoAttach', {}])).error);
});

test("the user's new tab from a claimed tab is left alone", async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const gmail = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: gmail.id, windowId: 1 });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  sent.length = 0;
  const calls = chrome.calls.length;

  const mine = chrome.addTab({ openerTabId: gmail.id, active: true });
  await core.onTabCreated(structuredClone(mine));
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: mine.id });
  await timers.fire(750);
  assert.equal(core.owners.has(mine.id), false);
  assert.deepEqual(chrome.calls.slice(calls), [], 'not activated away, muted or grouped');
  assert.deepEqual(sent, []);

  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(mine.id));
});

test('parallel tabs.open calls share one group', async () => {
  const { chrome, call, start } = setup();
  await call(1, 'client.hello', { label: 'Fan' });
  const release = gate(chrome, 'tabs.group');
  const requests = [1, 2, 3, 4].map(() => start(1, 'tabs.open', {}));
  await tick();
  release();
  await Promise.all(requests.map((r) => r.done));
  const ids = requests.map((r) => r.reply().result.id);
  assert.equal(new Set(ids.map((id) => chrome.tabsById.get(id).groupId)).size, 1);
  assert.equal(chrome.groupsById.size, 1);
});

test('an adopted popup leaves its expanded group expanded', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  const groupId = chrome.tabsById.get(opener.id).groupId;
  const popup = chrome.addTab({ openerTabId: opener.id, groupId, active: true });
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.equal(chrome.groupsById.get(groupId).collapsed, false);
});

test('kept and released agent tabs are unmuted and discardable again', async () => {
  const { core, chrome, call } = setup();
  const { result: kept } = await call(1, 'tabs.open', {});
  const { result: released } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.keep', { tabId: kept.id });
  const handedOver = chrome.tabsById.get(kept.id);
  assert.deepEqual([handedOver.mutedInfo.muted, handedOver.autoDiscardable, handedOver.groupId], [true, true, -1],
    'handed over right away, still muted while the agent drives it');
  assert.equal(core.owners.get(kept.id).client, 1, 'still driven by the client');
  assert.equal(chrome.session.owners[kept.id].agentMuted, true, 'persisted');
  await call(1, 'tabs.release', { tabId: released.id });
  // The user mutes the kept tab themselves before the session ends: the session end must not undo that.
  chrome.tabsById.get(kept.id).mutedInfo = { muted: true, reason: 'user' };
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.equal(chrome.tabsById.get(kept.id).mutedInfo.muted, true, "the user's own mute stays");
  for (const id of [kept.id, released.id]) {
    const tab = chrome.tabsById.get(id);
    assert.equal(tab.autoDiscardable, true);
    assert.equal(tab.groupId, -1);
  }
  assert.equal(chrome.tabsById.get(released.id).mutedInfo.muted, false);
});

test('tabs.keep keeps a muted work tab muted until control ends; an unmuted one is left as it is', async () => {
  const { core, chrome, call } = setup();
  const { result: muted } = await call(1, 'tabs.open', {});
  const { result: loud } = await call(1, 'tabs.open', { muted: false });
  await call(1, 'tabs.keep', { tabId: muted.id });
  await call(1, 'tabs.keep', { tabId: loud.id });
  assert.equal(chrome.tabsById.get(muted.id).mutedInfo.muted, true, 'muted while the agent still drives it');
  assert.equal(core.owners.get(muted.id).agentMuted, true);
  assert.equal(chrome.tabsById.get(loud.id).mutedInfo.muted, false);
  assert.ok(!core.owners.get(loud.id).agentMuted);
  await call(1, 'tabs.release', { tabId: muted.id });
  assert.equal(chrome.tabsById.get(muted.id).mutedInfo.muted, false, 'unmuted on release');
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.deepEqual([muted.id, loud.id].map((id) => chrome.tabsById.has(id)), [true, true], 'both stay open');
});

test('tabs.open forUser makes a tab like their own that stays after the session', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://x.com/notifications', forUser: true });
  const live = chrome.tabsById.get(tab.id);
  assert.deepEqual([live.mutedInfo.muted, live.groupId, live.active], [true, -1, false], 'muted while the agent drives it');
  assert.equal(core.owners.get(tab.id).agentMuted, true);
  assert.equal(chrome.session.owners[tab.id].agentMuted, true, 'persisted');
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.update' && c[1] === tab.id).map((c) => c[2]), [{ muted: true }],
    'no autoDiscardable change');
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === tab.id));
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(tab.id), 'kept');
  assert.equal(chrome.tabsById.get(tab.id).mutedInfo.muted, false, 'unmuted when control ends');
  assert.equal(core.owners.has(tab.id), false);
});

test('tabs given to the user in one go share a group of their own; a lone one stays ungrouped', async () => {
  const { core, chrome, call } = setup();
  await call(1, 'client.hello', { label: 'Ad prototypes' });
  const groupOf = (tab) => chrome.tabsById.get(tab.id).groupId;
  const { result: home } = await call(1, 'tabs.open', { url: 'http://localhost:5263/?variant=A', forUser: true });
  assert.equal(groupOf(home), -1, 'a lone tab for the user is ungrouped');
  const { result: work } = await call(1, 'tabs.open', { url: 'http://localhost:5263/' });
  const { result: term } = await call(1, 'tabs.open', { url: 'http://localhost:5263/term?variant=A', forUser: true });
  const given = groupOf(home);
  assert.notEqual(given, -1);
  assert.equal(groupOf(term), given, 'the second joins the first in one group');
  assert.equal(term.groupId, given, 'tabs.open answers with the tab as grouped');
  assert.notEqual(groupOf(work), given, 'never the work group');
  assert.deepEqual(chrome.groupsById.get(given), { id: given, title: 'Ad prototypes', color: colorFor('Ad prototypes'), collapsed: false });
  const { result: third } = await call(1, 'tabs.open', { url: 'http://localhost:5263/?variant=B', forUser: true });
  assert.equal(groupOf(third), given, 'later ones join it');

  // The turn ends: the tabs and their group are the user's and stay.
  for (const tab of [home, term, third]) assert.ok(!(await call(1, 'tabs.release', { tabId: tab.id })).error);
  assert.deepEqual([home, term, third].map(groupOf), [given, given, given]);
  assert.ok(chrome.groupsById.has(given));
  assert.equal(core.owners.size, 1, 'only the work tab is still owned');

  // The next turn's tabs make a group of their own.
  const { result: next } = await call(1, 'tabs.open', { url: 'http://localhost:5263/?variant=C', forUser: true });
  assert.equal(groupOf(next), -1);
  const { result: nextTerm } = await call(1, 'tabs.open', { url: 'http://localhost:5263/term?variant=C', forUser: true });
  assert.notEqual(groupOf(next), -1);
  assert.notEqual(groupOf(next), given);
  assert.equal(groupOf(nextTerm), groupOf(next));
});

test('tabs given to the user at the same moment make one group; each client and group title has its own', async () => {
  const { chrome, call, start } = setup();
  const gateGroup = gate(chrome, 'tabs.get');
  const opens = [1, 2, 3].map((n) => start(1, 'tabs.open', { url: `https://example.com/${n}`, forUser: true }));
  const other = start(2, 'tabs.open', { url: 'https://example.com/other', forUser: true });
  gateGroup();
  await Promise.all([...opens, other].map((o) => o.done));
  const ids = opens.map((o) => o.reply().result.id);
  const groups = new Set(ids.map((id) => chrome.tabsById.get(id).groupId));
  assert.equal(groups.size, 1);
  assert.ok(!groups.has(-1));
  assert.equal(chrome.tabsById.get(other.reply().result.id).groupId, -1, "another client's lone tab is not theirs to group");
  const { result: named } = await call(1, 'tabs.open', { url: 'https://example.com/named', forUser: true, group: 'Results' });
  const namedGroup = chrome.tabsById.get(named.id).groupId;
  assert.ok(namedGroup !== -1 && !groups.has(namedGroup), 'a named title gets a group of its own at once');
});

test('a tab the user moved out of the given group, or into one of theirs, is left there', async () => {
  const { chrome, call } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const { result: b } = await call(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  const given = chrome.tabsById.get(a.id).groupId;
  await chrome.tabs.ungroup(a.id); // the user drags it out
  const { result: c } = await call(1, 'tabs.open', { url: 'https://example.com/c', forUser: true });
  assert.deepEqual([a, b, c].map((t) => chrome.tabsById.get(t.id).groupId), [-1, given, given]);

  const { result: d } = await call(2, 'tabs.open', { url: 'https://example.com/d', forUser: true });
  const theirs = await chrome.tabs.group({ tabIds: [d.id] }); // the user puts it in a group of their own
  const { result: e } = await call(2, 'tabs.open', { url: 'https://example.com/e', forUser: true });
  assert.deepEqual([d, e].map((t) => chrome.tabsById.get(t.id).groupId), [theirs, -1]);
});

// A redo: tab_open for_user with the same group and URLs in a later turn reloads the earlier tabs in place.
const REDO = 'Nearby places prototypes';
const redo = (call, client, url) => call(client, 'tabs.open', { forUser: true, group: REDO, matchUrl: url });
// The MCP server navigates a tab after tabs.open; the fake browser only needs the URL it ends up on.
const shows = (chrome, tab, url) => { chrome.tabsById.get(tab.id).url = url; };

test('a named group for the user: a lone tab gets it at once; a redo reloads the tab with the same URL, a new URL joins', async () => {
  const { core, chrome, call, sent } = setup();
  const groupOf = (tab) => chrome.tabsById.get(tab.id).groupId;
  const { result: a } = await redo(call, 1, 'http://localhost:5263/?variant=A');
  const given = groupOf(a);
  assert.notEqual(given, -1, 'grouped although alone');
  assert.deepEqual(chrome.groupsById.get(given), { id: given, title: REDO, color: colorFor(REDO), collapsed: false });
  assert.equal(a.reused, undefined);
  shows(chrome, a, 'http://localhost:5263/?variant=A#map'); // a fragment doesn't count
  const { result: b } = await redo(call, 1, 'http://localhost:5263/?variant=B');
  shows(chrome, b, 'http://localhost:5263/?variant=B');
  assert.equal(groupOf(b), given);
  assert.deepEqual(b.groupTabs, [], 'tabs this client controls are not listed');
  for (const tab of [a, b]) assert.ok(!(await call(1, 'tabs.release', { tabId: tab.id })).error); // the turn ends

  sent.length = 0;
  chrome.calls.length = 0;
  const count = chrome.tabsById.size;
  const { result: again } = await redo(call, 1, 'http://localhost:5263/?variant=A');
  assert.equal(again.id, a.id, 'the same tab');
  assert.equal(again.reused, true);
  assert.equal(chrome.tabsById.size, count, 'no new tab');
  assert.deepEqual(core.owners.get(a.id), { client: 1, origin: 'agent', group: REDO, named: true, kept: true, handedOver: true, givenGroup: given, agentMuted: true },
    'taken like a new tab for the user');
  assert.equal(chrome.session.owners[a.id].givenGroup, given, 'persisted');
  assert.deepEqual([chrome.tabsById.get(a.id).mutedInfo.muted, chrome.tabsById.get(a.id).active, groupOf(a)], [true, false, given]);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === a.id), 'announced for attaching');
  assert.deepEqual(again.groupTabs, [{ id: b.id, title: '', url: 'http://localhost:5263/?variant=B' }], 'the group\'s other tabs');
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.create' || c[0] === 'tabs.group' || (c[0] === 'tabs.update' && 'active' in c[2])),
    'never created, moved or activated');

  const { result: c } = await redo(call, 1, 'http://localhost:5263/?variant=C');
  assert.ok(c.id !== a.id && c.id !== b.id);
  assert.equal(groupOf(c), given, 'a new URL joins the same group');
  assert.deepEqual(c.groupTabs.map((t) => t.id), [b.id]);
  assert.equal(chrome.groupsById.size, 1, 'one group');

  // The next turn end lets it go like any tab given to the user: open, unmuted, still in the group.
  assert.ok(!(await call(1, 'tabs.release', { tabId: a.id })).error);
  assert.deepEqual([chrome.tabsById.has(a.id), chrome.tabsById.get(a.id).mutedInfo.muted, groupOf(a)], [true, false, given]);
});

test('a redo reloads the user\'s muted tab without ending their mute, and a tab still this client\'s without announcing it again', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: a } = await redo(call, 1, 'https://example.com/a');
  shows(chrome, a, 'https://example.com/a');
  const { result: same } = await redo(call, 1, 'https://example.com/a'); // the same turn, say a subagent
  assert.deepEqual([same.id, same.reused, same.yours], [a.id, true, true]);
  assert.equal(sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === a.id).length, 1, 'attached once');
  await call(1, 'tabs.release', { tabId: a.id });
  await chrome.tabs.update(a.id, { muted: true }); // the user mutes it
  const { result: again } = await redo(call, 1, 'https://example.com/a');
  assert.equal(again.id, a.id);
  assert.equal(core.owners.get(a.id).agentMuted, undefined);
  await call(1, 'tabs.release', { tabId: a.id });
  assert.equal(chrome.tabsById.get(a.id).mutedInfo.muted, true, 'their mute stays');
});

test('only groups made for the user are reused: never the user\'s own group with that title, nor one renamed or removed since', async () => {
  const { chrome, call } = setup();
  const groupOf = (tab) => chrome.tabsById.get(tab.id).groupId;
  const url = 'https://example.com/a';
  const theirs = chrome.addTab({ url });
  const theirGroup = await chrome.tabs.group({ tabIds: [theirs.id] });
  await chrome.tabGroups.update(theirGroup, { title: REDO });
  const { result: first } = await redo(call, 1, url);
  assert.notEqual(first.id, theirs.id);
  assert.ok(![-1, theirGroup].includes(groupOf(first)), 'a group of its own');
  assert.deepEqual(first.groupTabs, [], 'nothing of the user\'s group listed');
  shows(chrome, first, url);
  await call(1, 'tabs.release', { tabId: first.id });

  const renamed = groupOf(first);
  await chrome.tabGroups.update(renamed, { title: 'My picks' }); // the user renames it: theirs now
  assert.equal(chrome.session.givenGroups[renamed], undefined, 'forgotten');
  await chrome.tabGroups.update(renamed, { title: REDO }); // and back: still theirs
  const { result: second } = await redo(call, 1, url);
  assert.ok(![first.id, theirs.id].includes(second.id));
  assert.ok(![-1, theirGroup, renamed].includes(groupOf(second)));
  shows(chrome, second, url);
  await call(1, 'tabs.release', { tabId: second.id });

  const removed = groupOf(second);
  assert.equal(chrome.session.givenGroups[removed], REDO);
  await chrome.tabs.remove(second.id); // the user closes its last tab: Chrome removes the group
  assert.equal(chrome.session.givenGroups[removed], undefined, 'forgotten');
});

test('a redo never takes a tab another client controls or one the user moved out of the group; racing clients get one each', async () => {
  const { chrome, call, start } = setup();
  const groupOf = (tab) => chrome.tabsById.get(tab.id).groupId;
  const url = 'https://example.com/a';
  const { result: a } = await redo(call, 1, url);
  shows(chrome, a, url);
  await call(1, 'tabs.release', { tabId: a.id });
  const given = groupOf(a);

  assert.ok(!(await call(2, 'tabs.claim', { tabId: a.id })).error);
  const { result: beside } = await redo(call, 1, url);
  assert.notEqual(beside.id, a.id, 'another client has it');
  assert.equal(groupOf(beside), given);
  shows(chrome, beside, 'https://example.com/other');
  await call(1, 'tabs.release', { tabId: beside.id });
  await call(2, 'tabs.release', { tabId: a.id });

  const one = start(1, 'tabs.open', { forUser: true, group: REDO, matchUrl: url });
  const other = start(3, 'tabs.open', { forUser: true, group: REDO, matchUrl: url });
  await Promise.all([one.done, other.done]);
  const ids = [one.reply().result, other.reply().result];
  assert.deepEqual(ids.map((t) => t.reused === true).sort(), [false, true], 'one reuses it, the other opens a tab');
  assert.ok(ids.some((t) => t.id === a.id));
  assert.deepEqual(ids.map(groupOf), [given, given]);
  for (const [client, t] of [[1, ids[0]], [3, ids[1]]]) await call(client, 'tabs.release', { tabId: t.id });

  await chrome.tabs.ungroup(a.id); // the user drags it out of the group
  const { result: after } = await redo(call, 1, url);
  assert.notEqual(after.id, a.id, 'out of the group, out of reach');
  assert.equal(groupOf(a), -1);
});

test('a redo matches the URL as Chrome shows it: a bare host is its root page', async () => {
  const { chrome, call } = setup();
  const { result: a } = await redo(call, 1, 'https://Example.com');
  shows(chrome, a, 'https://example.com/'); // what Chrome shows for it
  await call(1, 'tabs.release', { tabId: a.id });
  const { result: again } = await redo(call, 2, 'https://Example.com');
  assert.deepEqual([again.id, again.reused], [a.id, true]);
});

test('a redo never takes a tab the user moved into the group themselves, also after a worker restart', async () => {
  const { chrome, call } = setup();
  const groupOf = (tab) => chrome.tabsById.get(tab.id).groupId;
  const { result: a } = await redo(call, 1, 'https://example.com/a');
  shows(chrome, a, 'https://example.com/b'); // the agent's tab went on to another page
  await call(1, 'tabs.release', { tabId: a.id });
  const given = groupOf(a);
  const theirs = chrome.addTab({ url: 'https://example.com/a' }); // the user's own tab, dragged into the group
  await chrome.tabs.group({ groupId: given, tabIds: [theirs.id] });
  const { result: again } = await redo(call, 2, 'https://example.com/a');
  assert.notEqual(again.id, theirs.id, 'the user\'s tab is left alone');
  assert.equal(again.reused, undefined);
  assert.equal(groupOf(again), given, 'the new tab joins the group');
  shows(chrome, again, 'https://example.com/a');
  await call(2, 'tabs.release', { tabId: again.id });

  const sent = [];
  const core = createCore({ chrome, send: (msg) => sent.push(msg) }); // the restarted worker remembers which tabs were given
  await core.ready;
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 3 } });
  await core.handleMessage({ id: 1, method: 'tabs.open', params: { forUser: true, group: REDO, matchUrl: 'https://example.com/a' }, client: 3 });
  assert.deepEqual([sent.find((m) => m.id === 1).result.id, sent.find((m) => m.id === 1).result.reused], [again.id, true]);
});

test('the groups made for the user survive a worker restart', async () => {
  const { chrome, call } = setup();
  const url = 'https://example.com/a';
  const { result: a } = await redo(call, 1, url);
  shows(chrome, a, url);
  await call(1, 'tabs.release', { tabId: a.id });

  const sent = [];
  const core = createCore({ chrome, send: (msg) => sent.push(msg) }); // the restarted worker
  await core.ready;
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 1 } });
  await core.handleMessage({ id: 1, method: 'tabs.open', params: { forUser: true, group: REDO, matchUrl: url }, client: 1 });
  const reply = sent.find((m) => m.id === 1);
  assert.deepEqual([reply.result.id, reply.result.reused], [a.id, true]);
});

test('a tab the user took out of the given group while its own open was still under way stays out', { timeout: 5000 }, async () => {
  const { chrome, call, start } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  chrome.hooks.update = async (id, props) => { if (id !== a.id && props.muted === true && chrome.hooks.update) { chrome.hooks.update = null; await paused; } };
  const b = start(1, 'tabs.open', { url: 'https://example.com/b', forUser: true }); // stops at its mute
  await tick();
  const { result: c } = await call(1, 'tabs.open', { url: 'https://example.com/c', forUser: true });
  const given = chrome.tabsById.get(a.id).groupId;
  const bId = [...chrome.tabsById.keys()].find((id) => ![a.id, c.id].includes(id));
  assert.equal(chrome.tabsById.get(bId).groupId, given, "c's grouping took the still-opening b along");
  await chrome.tabs.ungroup(bId); // the user takes it out
  resume();
  await b.done;
  assert.deepEqual([a.id, bId, c.id].map((id) => chrome.tabsById.get(id).groupId), [given, -1, given]);
});

// Pauses the next tab open's grouping at its first read after looking up its own tab (tabs.get of another tab, or
// tabs.query): what the user and other clients do meanwhile must be respected.
function pauseGrouping(chrome) {
  let target, stage = 0, reached, resume;
  const atRead = new Promise((resolve) => { reached = resolve; });
  const paused = new Promise((resolve) => { resume = resolve; });
  chrome.hooks.created = (tab) => { target ??= tab.id; };
  const read = async (kind, arg) => {
    if (stage === 0 && kind === 'get' && arg === target) stage = 1;
    else if (stage === 1) { stage = 2; reached(); await paused; }
  };
  chrome.hooks.get = (id) => read('get', id);
  chrome.hooks.query = (q) => read('query', q);
  return { atRead, resume, target: () => target };
}

test('a tab released and claimed by another client while the group is being made is left out', { timeout: 5000 }, async () => {
  const { chrome, core, call, start } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const pause = pauseGrouping(chrome);
  const b = start(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  await pause.atRead;
  assert.ok(!(await call(1, 'tabs.release', { tabId: a.id })).error);
  assert.ok(!(await call(2, 'tabs.claim', { tabId: a.id })).error);
  pause.resume();
  await b.done;
  assert.equal(core.owners.get(a.id).client, 2);
  assert.equal(chrome.tabsById.get(a.id).groupId, -1, "another client's tab is never grouped");
  assert.equal(chrome.tabsById.get(pause.target()).groupId, -1, 'a lone one after all');
});

test('a split or a group the user makes while the given group is being made is respected', { timeout: 5000 }, async () => {
  const { chrome, call, start } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const { result: e } = await call(1, 'tabs.open', { url: 'https://example.com/e', forUser: true });
  const given = chrome.tabsById.get(e.id).groupId;
  const partner = chrome.addTab({ url: 'https://user.example' });
  const pause = pauseGrouping(chrome);
  const b = start(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  await pause.atRead;
  chrome.tabsById.get(pause.target()).splitViewId = 9; // the user pairs b with their own tab
  partner.splitViewId = 9;
  const theirs = await chrome.tabs.group({ tabIds: [a.id] }); // and puts a in a group of their own
  pause.resume();
  await b.done;
  assert.deepEqual([pause.target(), partner.id].map((id) => chrome.tabsById.get(id).groupId), [-1, -1], 'the split pair is left alone');
  assert.equal(chrome.tabsById.get(a.id).groupId, theirs, "a stays in the user's group");
  assert.equal(chrome.tabsById.get(e.id).groupId, given);
});

test("a tab in Split View never joins a given group, so its partner (the user's own tab) is never moved", async () => {
  const { chrome, call } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const partner = chrome.addTab({ url: 'https://user.example' });
  chrome.tabsById.get(a.id).splitViewId = 7; // the user pairs a with their own tab
  partner.splitViewId = 7;
  const { result: b } = await call(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  const { result: c } = await call(1, 'tabs.open', { url: 'https://example.com/c', forUser: true });
  assert.deepEqual([a.id, partner.id].map((id) => chrome.tabsById.get(id).groupId), [-1, -1], 'the split pair stays as it is');
  const given = chrome.tabsById.get(b.id).groupId;
  assert.notEqual(given, -1);
  assert.equal(chrome.tabsById.get(c.id).groupId, given);
});

test('a given tab the user pinned never joins a given group, so it stays pinned (grouping unpins)', async () => {
  const { chrome, call } = setup();
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  chrome.tabsById.get(a.id).pinned = true; // the user pins the result they were given
  const { result: b } = await call(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  const { result: c } = await call(1, 'tabs.open', { url: 'https://example.com/c', forUser: true });
  assert.deepEqual([chrome.tabsById.get(a.id).pinned, chrome.tabsById.get(a.id).groupId], [true, -1], 'still pinned, ungrouped');
  const given = chrome.tabsById.get(b.id).groupId;
  assert.ok(given !== -1 && chrome.tabsById.get(c.id).groupId === given);
});

test('a given group whose title could not be set is still the one later tabs join', async () => {
  const { chrome, call } = setup();
  chrome.hooks.groupUpdateError = 'Tabs cannot be edited right now (user may be dragging a tab).';
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const { result: b } = await call(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  const given = chrome.tabsById.get(a.id).groupId;
  assert.ok(given !== -1 && chrome.tabsById.get(b.id).groupId === given, 'grouped, untitled');
  delete chrome.hooks.groupUpdateError;
  const { result: c } = await call(1, 'tabs.open', { url: 'https://example.com/c', forUser: true });
  assert.equal(chrome.tabsById.get(c.id).groupId, given, 'no second group');
});

test('tabs.keep moves kept work tabs out of the work group into one given to the user', async () => {
  const { chrome, call } = setup();
  const { result: one } = await call(1, 'tabs.open', { url: 'https://example.com/1' });
  const { result: two } = await call(1, 'tabs.open', { url: 'https://example.com/2' });
  const { result: scratch } = await call(1, 'tabs.open', { url: 'https://example.com/scratch' });
  const work = chrome.tabsById.get(one.id).groupId;
  await call(1, 'tabs.keep', { tabId: one.id });
  assert.equal(chrome.tabsById.get(one.id).groupId, -1, 'a lone kept tab is ungrouped');
  await call(1, 'tabs.keep', { tabId: two.id });
  const given = chrome.tabsById.get(one.id).groupId;
  assert.ok(given !== -1 && given !== work);
  assert.equal(chrome.tabsById.get(two.id).groupId, given);
  assert.equal(chrome.tabsById.get(scratch.id).groupId, work, 'the work tab stays in the work group');
});

test('a takeover of a tab given to the user leaves it in its group, and a resume never moves it to the work group', async () => {
  const { chrome, call } = setup();
  await call(1, 'tabs.open', { url: 'https://example.com/work' });
  const { result: a } = await call(1, 'tabs.open', { url: 'https://example.com/a', forUser: true });
  const { result: b } = await call(1, 'tabs.open', { url: 'https://example.com/b', forUser: true });
  await call(1, 'chrome.debugger.attach', [{ tabId: a.id }, '1.3']);
  const given = chrome.tabsById.get(a.id).groupId;
  await call(1, 'tabs.park', { tabId: a.id, kind: 'takeover' });
  assert.equal(chrome.tabsById.get(a.id).groupId, given, 'parked in place');
  assert.ok(!(await call(1, 'tabs.claim', { tabId: a.id, resume: true })).error);
  assert.deepEqual([a, b].map((t) => chrome.tabsById.get(t.id).groupId), [given, given], 'resumed in place');
});

test('a forUser tab is unmuted on release only while its agent mute is still on', async () => {
  const { core, chrome, call } = setup();
  const { result: plain } = await call(1, 'tabs.open', { forUser: true });
  const { result: userMuted } = await call(1, 'tabs.open', { forUser: true });
  const { result: userUnmuted } = await call(1, 'tabs.open', { forUser: true });
  chrome.tabsById.get(userMuted.id).mutedInfo = { muted: true, reason: 'user' }; // The user toggles them themselves
  chrome.tabsById.get(userUnmuted.id).mutedInfo = { muted: false, reason: 'user' };
  for (const tab of [plain, userMuted, userUnmuted]) assert.ok(!(await call(1, 'tabs.release', { tabId: tab.id })).error);
  assert.deepEqual([plain, userMuted, userUnmuted].map((t) => chrome.tabsById.get(t.id).mutedInfo),
    [{ muted: false, reason: 'extension', extensionId: 'fowlbrowser-ext' }, { muted: true, reason: 'user' }, { muted: false, reason: 'user' }]);
  assert.equal(core.owners.size, 0);
});

test("tabs.setMuted makes a forUser tab's mute the agent's choice; tabs.focus unmutes it", async () => {
  const { core, chrome, call } = setup();
  const { result: silenced } = await call(1, 'tabs.open', { forUser: true });
  const { result: shown } = await call(1, 'tabs.open', { forUser: true });
  await call(1, 'tabs.setMuted', { tabId: silenced.id, muted: true });
  assert.equal(core.owners.get(silenced.id).agentMuted, undefined);
  assert.equal(chrome.session.owners[silenced.id].agentMuted, undefined, 'persisted');
  await call(1, 'tabs.focus', { tabId: shown.id });
  assert.equal(chrome.tabsById.get(shown.id).mutedInfo.muted, false, 'the user asked to see it');
  assert.equal(core.owners.get(shown.id).agentMuted, undefined);
  chrome.tabsById.get(shown.id).mutedInfo = { muted: true, reason: 'extension', extensionId: 'fowlbrowser-ext' };
  await call(1, 'tabs.release', { tabId: silenced.id });
  await call(1, 'tabs.release', { tabId: shown.id });
  assert.equal(chrome.tabsById.get(silenced.id).mutedInfo.muted, true, "the agent's explicit mute stays");
  assert.equal(chrome.tabsById.get(shown.id).mutedInfo.muted, true, 'release no longer touches it');
});

test("tabs.closeUnowned closes the user's tab without attaching, and refuses owned tabs", async () => {
  const { chrome, call } = setup();
  const userTab = chrome.addTab({ url: 'https://www.youtube.com/watch?v=1' });
  const { result: mine } = await call(1, 'tabs.open', {});
  const { result: theirs } = await call(2, 'tabs.open', {});
  assert.match((await call(1, 'tabs.closeUnowned', { tabId: theirs.id })).error.message, /controlled by another agent session/);
  assert.match((await call(1, 'tabs.closeUnowned', { tabId: mine.id })).error.message, /controlled by this client/);
  assert.deepEqual((await call(1, 'tabs.closeUnowned', { tabId: userTab.id })).result, { ok: true });
  assert.equal(chrome.tabsById.has(userTab.id), false);
  assert.ok(chrome.tabsById.has(theirs.id) && chrome.tabsById.has(mine.id));
  assert.ok(!chrome.calls.some((c) => c[0].startsWith('debugger.')), 'the debugger never attached');
});

test('the user\'s tabs in a group titled like an agent label are never closed (no title-based cleanup)', async () => {
  const chrome = fakeChrome();
  chrome.groupsById.set(1, { id: 1, title: 'Claude', collapsed: false });
  const userTab = chrome.addTab({ groupId: 1 });
  const core = createCore({ chrome, send: () => {} });
  await core.ready;
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 1 } });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  assert.ok(chrome.tabsById.has(userTab.id));
  assert.equal(core.closeOrphanGroups, undefined);
  assert.equal(chrome.local.agentLabels, undefined);
});

test('a navigation target arriving while the opener fallback runs still decides the owner', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  const { result: tabA } = await call(1, 'tabs.open', {});
  const { result: tabB } = await call(2, 'tabs.open', {});
  sent.length = 0;
  const popup = chrome.addTab({ openerTabId: tabB.id });
  await core.onTabCreated(structuredClone(popup));
  const release = gate(chrome, 'tabs.get');
  const fallback = timers.fire(750);
  await tick();
  const target = core.onNavigationTarget({ sourceTabId: tabA.id, tabId: popup.id });
  await tick();
  release();
  await fallback;
  await target;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.get(popup.id).client, 1);
  const created = sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === popup.id).map((m) => m.client);
  assert.equal(created.at(-1), 1);
  const toB = sent.filter((m) => m.client === 2 && (m.params?.[0]?.id ?? m.params?.[0]) === popup.id).map((m) => m.method);
  assert.ok(toB.length === 0 || toB.at(-1) === 'chrome.tabs.onRemoved', `B ends without the popup: ${toB}`);
});

test('a client that disconnects while its popup is being adopted gets the popup closed', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  const popup = chrome.addTab({ openerTabId: opener.id, url: 'https://example.com/popup' });
  const release = gate(chrome, 'tabs.get');
  const adopting = core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  await tick();
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  release();
  await adopting;
  await cleanup;
  assert.equal(chrome.tabsById.has(popup.id), false);
  assert.equal(chrome.tabsById.has(opener.id), false);
  assert.equal(core.owners.size, 0);
});

test('a tab replaced while its owner is being cleaned up is cleaned up under its new id', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  const release = gate(chrome, 'tabs.get');
  const releaseDetach = gate(chrome, 'debugger.detach');
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  // Chrome swaps both tabs for prerendered ones mid-cleanup.
  const replacement = chrome.addTab({ url: 'https://example.com/next', groupId: chrome.tabsById.get(tab.id).groupId });
  chrome.tabsById.delete(tab.id);
  const userReplacement = chrome.addTab({ url: 'https://user.example/next' });
  chrome.tabsById.delete(userTab.id);
  const swaps = [core.onTabReplaced(replacement.id, tab.id), core.onTabReplaced(userReplacement.id, userTab.id)];
  await tick();
  release();
  releaseDetach();
  await cleanup;
  await Promise.all(swaps);
  assert.equal(chrome.tabsById.has(replacement.id), false, 'agent replacement closed');
  assert.ok(chrome.tabsById.has(userReplacement.id), "the user's replacement stays open");
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === userReplacement.id));
  assert.equal(core.owners.size, 0);
  assert.ok(!(await call(2, 'tabs.claim', { tabId: userReplacement.id })).error, 'claimable again');
});

test('a cleanup that fails keeps the ownership record and is retried', async () => {
  const { core, chrome, call } = setup();
  const { result: stuck } = await call(1, 'tabs.open', {});
  const { result: gone } = await call(1, 'tabs.open', {});
  chrome.hooks.failRemove = new Set([stuck.id, gone.id]);
  const cleanup = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  chrome.tabsById.delete(gone.id); // closed by the user while cleanup kept failing
  await cleanup;
  assert.ok(chrome.tabsById.has(stuck.id));
  assert.equal(core.owners.get(stuck.id)?.client, 1, 'provenance kept');
  assert.equal(chrome.session.owners[stuck.id]?.client, 1, 'and stored');
  assert.equal(core.owners.has(gone.id), false, 'a tab that is gone drops its record');
  assert.match((await call(2, 'tabs.claim', { tabId: stuck.id })).error.message, /being released/);

  // Retried on the next disconnect (port close / worker restart), once Chrome lets go.
  chrome.hooks.failRemove.clear();
  await core.portClosed();
  assert.equal(chrome.tabsById.has(stuck.id), false);
  assert.equal(core.owners.size, 0);
});

test('a failed ungroup is retried before closing, so no saved group is left behind', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  let failures = 1;
  const ungroup = chrome.tabs.ungroup;
  chrome.tabs.ungroup = async (ids) => {
    if (failures-- > 0) throw new Error('Tabs cannot be edited right now');
    return ungroup(ids);
  };
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  const removed = chrome.calls.findIndex((c) => c[0] === 'tabs.remove' && c[1] === tab.id);
  const ungrouped = chrome.calls.findIndex((c) => c[0] === 'tabs.ungroup' && [c[1]].flat().includes(tab.id));
  assert.ok(ungrouped !== -1 && ungrouped < removed, 'ungrouped, then closed');
});

test('tabs.open that fails after creating the tab closes it and reports the error', async () => {
  const { core, chrome, call, sent } = setup();
  chrome.hooks.groupError = 'Grouping is not supported by tabs in this window.';
  const reply = await call(1, 'tabs.open', { url: 'https://example.com' });
  assert.match(reply.error.message, /Grouping is not supported/);
  assert.equal(chrome.tabsById.size, 0, 'no undisclosed tab');
  assert.equal(core.owners.size, 0);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated'));
});

// A browser whose last window closes unloads the profile, and FowlBrowser with it, until a window opens again.
// Closing the tab the user has in front shows the tab they had before, not whatever the browser puts next (another
// agent's work tab, maybe).
test('closing the tab in front brings back the user\'s previous tab, never another agent\'s work tab', async () => {
  const { core, chrome, call } = setup();
  const usersTab = chrome.addTab({ url: 'https://user.example', active: true });
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://a.example' });
  const { result: other } = await call(2, 'tabs.open', { url: 'https://b.example' });
  await core.onTabActivated({ tabId: usersTab.id, windowId: 1 });
  chrome.tabsById.get(tab.id).active = true; // the user clicks into the agent's tab
  await core.onTabActivated({ tabId: tab.id, windowId: 1 });
  await call(1, 'chrome.tabs.remove', [tab.id]);
  const shown = chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2]?.active === true).map((c) => c[1]);
  assert.deepEqual(shown, [usersTab.id], 'the user\'s tab first, before the close');

  // The one before was another agent's work tab: the browser picks, as usual.
  chrome.tabsById.get(other.id).active = true;
  await core.onTabActivated({ tabId: other.id, windowId: 1 });
  const { result: third } = await call(1, 'tabs.open', { url: 'https://c.example' });
  chrome.tabsById.get(third.id).active = true;
  await core.onTabActivated({ tabId: third.id, windowId: 1 });
  await call(1, 'chrome.tabs.remove', [third.id]);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2]?.active === true).map((c) => c[1]), [usersTab.id]);

  // The user picks another tab of theirs while the previous one is looked up: theirs stays in front.
  const picked = chrome.addTab({ url: 'https://picked.example' });
  await core.onTabActivated({ tabId: usersTab.id, windowId: 1 });
  const { result: fourth } = await call(1, 'tabs.open', { url: 'https://d.example' });
  chrome.tabsById.get(fourth.id).active = true;
  await core.onTabActivated({ tabId: fourth.id, windowId: 1 });
  chrome.hooks.get = async (id) => { if (id === usersTab.id) await core.onTabActivated({ tabId: picked.id, windowId: 1 }); };
  await call(1, 'chrome.tabs.remove', [fourth.id]);
  chrome.hooks.get = null;
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.update' && c[2]?.active === true).map((c) => c[1]), [usersTab.id], 'not brought back over the pick');
});

// An undocked DevTools window closes with the tab it inspects, so it keeps nothing open.
test('a DevTools window does not count as a window that stays when the last tab closes', async () => {
  const { chrome, call } = setup();
  chrome.hooks.oneWindow = true;
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://a.example' });
  chrome.addTab({ windowId: 7 }); // the DevTools window's own page
  chrome.hooks.windows = { 7: { type: 'devtools' } };
  await call(1, 'chrome.tabs.remove', [tab.id]);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)?.[1], { windowId: tab.windowId, active: false }, 'a New Tab page stays');
});

test('tabs the extension closes never close the browser\'s last window: a New Tab page stays', async () => {
  const { core, chrome, call } = setup();
  chrome.hooks.oneWindow = true;
  const { result: a } = await call(1, 'tabs.open', { url: 'https://a.example' });
  const { result: b } = await call(1, 'tabs.open', { url: 'https://b.example' });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } }); // closes both at once (a turn end)
  const left = [...chrome.tabsById.values()];
  assert.equal(left.length, 1, 'one New Tab page, not one per closed tab');
  assert.equal(left[0].windowId, 1);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1], { windowId: 1, active: false });
  assert.ok(!core.owners.has(left[0].id), 'nobody\'s');
  assert.ok(!chrome.tabsById.has(a.id) && !chrome.tabsById.has(b.id));

  // The same for the user's last tab closed for them, and for a claimed one.
  const users = left[0];
  assert.deepEqual((await call(2, 'tabs.closeUnowned', { tabId: users.id })).result, { ok: true });
  assert.equal(chrome.tabsById.size, 1);
  const [another] = chrome.tabsById.values();
  await call(2, 'tabs.claim', { tabId: another.id });
  await call(2, 'chrome.tabs.remove', [another.id, { usersTab: true }]);
  assert.equal(chrome.tabsById.size, 1);

  // Two windows whose only tabs close at once (an agent tab and its popup's window): one New Tab page stays.
  const { result: d } = await call(6, 'tabs.open', {});
  const popup = chrome.addTab({ windowId: 3, openerTabId: d.id });
  await core.onNavigationTarget({ sourceTabId: d.id, tabId: popup.id });
  await call(5, 'tabs.closeUnowned', { tabId: [...chrome.tabsById.values()][0].id });
  assert.deepEqual([...chrome.tabsById.values()].map((t) => t.id).sort(), [d.id, popup.id].sort(), 'the agent tab and its popup window, nothing else');
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 6 } });
  assert.equal(chrome.tabsById.size, 1, 'a window stays');
  assert.ok(!chrome.tabsById.has(d.id) && !chrome.tabsById.has(popup.id));

  // With another window open, or other tabs in this one, nothing is added.
  const kept = [...chrome.tabsById.values()][0];
  const { result: c } = await call(3, 'tabs.open', {});
  await call(3, 'chrome.tabs.remove', [c.id]);
  chrome.hooks.oneWindow = false;
  await call(4, 'tabs.closeUnowned', { tabId: kept.id });
  assert.equal(chrome.tabsById.size, 0);
});

test('a release racing the tab closing still tells the client', async () => {
  const { core, chrome, call, start, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://user.example' });
  await call(1, 'tabs.claim', { tabId: userTab.id });
  sent.length = 0;
  const release = gate(chrome, 'debugger.detach');
  const releasing = start(1, 'tabs.release', { tabId: userTab.id });
  await tick();
  await chrome.tabs.remove(userTab.id); // The user closes it mid-release
  release();
  await releasing.done;
  assert.deepEqual(releasing.reply().result, { ok: true });
  assert.deepEqual(sent.filter((m) => m.method === 'chrome.tabs.onRemoved').map((m) => [m.client, m.params[0]]), [[1, userTab.id]]);
  assert.equal(core.owners.size, 0);
});

test('a popup is handed to its client even when backgrounding it partly fails', async () => {
  const { core, chrome, call, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', {});
  sent.length = 0;
  const popup = chrome.addTab({ openerTabId: opener.id, active: true });
  await core.onTabActivated({ tabId: popup.id, windowId: 1 });
  chrome.tabsById.delete(userTab.id); // the tab to re-activate is gone (no event yet)
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: popup.id });
  assert.equal(core.owners.get(popup.id).client, 1);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === popup.id));

  // Its opener closed by a parallel tab_close: still handed over (muted by default).
  const second = chrome.addTab({ openerTabId: opener.id });
  await chrome.tabs.remove(opener.id);
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: second.id });
  assert.equal(core.owners.has(second.id), false, 'no adopter any more');
  const third = chrome.addTab({ openerTabId: popup.id });
  const getTab = chrome.tabs.get;
  chrome.tabs.get = async (id) => { if (id === popup.id) throw new Error(`No tab with id: ${id}`); return getTab(id); };
  await core.onNavigationTarget({ sourceTabId: popup.id, tabId: third.id });
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === third.id));
  assert.equal(chrome.tabsById.get(third.id).mutedInfo.muted, true);
});

test('tabs.expectChild lets the agent own a tab its click opens from a claimed tab, for a few seconds', async () => {
  const timers = manualTimers();
  const { core, chrome, call, sent } = setup({ timers });
  await call(1, 'client.hello', { label: 'Research' });
  const gmail = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: gmail.id, windowId: 1 });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  assert.match((await call(2, 'tabs.expectChild', { tabId: gmail.id, ms: 1000 })).error.message, /controlled by another agent session/);
  assert.deepEqual((await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 1000 })).result, { ok: true });
  sent.length = 0;

  const child = chrome.addTab({ openerTabId: gmail.id, active: true });
  chrome.tabsById.get(gmail.id).active = false;
  await core.onTabActivated({ tabId: child.id, windowId: 1 });
  await core.onTabCreated(structuredClone(child));
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  // kept: handed back to the user when the session ends, never closed (it may be their own Cmd-click).
  assert.deepEqual(core.owners.get(child.id), { client: 1, origin: 'agent', group: 'Research', kept: true });
  assert.equal(chrome.tabsById.get(gmail.id).active, true, 'the user keeps their tab in front');
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, false, 'muted like its opener');
  assert.equal(chrome.groupsById.get(chrome.tabsById.get(child.id).groupId).title, 'Research');
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.client === 1 && m.params[0].id === child.id));

  // The window is capped at 5 s, and outside it the claimed tab's children are the user's again.
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 60_000 });
  const now = Date.now;
  Date.now = () => now() + 5001;
  try {
    const late = chrome.addTab({ openerTabId: gmail.id });
    await core.onTabCreated(structuredClone(late));
    await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: late.id });
    await timers.fire(750);
    assert.equal(core.owners.has(late.id), false);
  } finally {
    Date.now = now;
  }
});

test('extension.reloadIfIdle refuses while tabs are owned or being opened, then blocks new work', async () => {
  const timers = manualTimers();
  const { chrome, call, start, core } = setup({ timers });
  const { result: tab } = await call(1, 'tabs.open', {});
  assert.deepEqual((await call(9, 'extension.reloadIfIdle', {})).result, { reloaded: false, ownedTabs: 1, inFlight: 0 });
  await call(1, 'chrome.tabs.remove', [tab.id]);

  const release = gate(chrome, 'tabs.create');
  const opening = start(1, 'tabs.open', {});
  await tick();
  assert.equal((await call(9, 'extension.reloadIfIdle', {})).result.reloaded, false, 'an open in flight counts');
  release();
  await opening.done;
  await call(1, 'chrome.tabs.remove', [opening.reply().result.id]);
  assert.equal(core.owners.size, 0);

  assert.deepEqual((await call(9, 'extension.reloadIfIdle', {})).result, { reloaded: true });
  assert.match((await call(1, 'tabs.open', {})).error.message, /reloading/);
  assert.equal(chrome.tabsById.size, 0);
  await timers.fire(50);
  assert.ok(chrome.calls.some((c) => c[0] === 'reload'));
});

test('a tab adopted from a claimed tab is handed back to the user, never closed, when the session ends', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example' });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  const child = chrome.addTab({ openerTabId: gmail.id });
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  await tick();
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(child.id), 'still open');
  assert.equal(chrome.tabsById.get(child.id).groupId, -1);
  assert.equal(chrome.tabsById.get(child.id).mutedInfo.muted, false);
  assert.ok(chrome.tabsById.has(gmail.id));
});

test('tabs.isShown: only an active tab in a normal, app or popup window that is not minimized, and only for its owner; focused when that window has focus', async () => {
  const { chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  const shown = async () => (await call(1, 'tabs.isShown', { tabId: tab.id })).result;
  assert.deepEqual(await shown(), { shown: false, focused: false }, 'background tab');
  chrome.tabsById.get(tab.id).active = true;
  assert.deepEqual(await shown(), { shown: true, focused: false }, 'active tab, window without focus');
  chrome.hooks.windows = { 1: { focused: true } };
  assert.deepEqual(await shown(), { shown: true, focused: true }, 'active tab of the focused window');
  chrome.hooks.windows = { 1: { state: 'minimized', focused: true } };
  assert.deepEqual(await shown(), { shown: false, focused: false }, 'minimized window');
  chrome.hooks.windows = { 1: { type: 'popup' } };
  assert.equal((await shown()).shown, true, 'popup window');
  chrome.hooks.windows = { 1: { type: 'app' } };
  assert.equal((await shown()).shown, true, 'app window');
  chrome.hooks.windows = { 1: { type: 'devtools', focused: true } };
  assert.deepEqual(await shown(), { shown: false, focused: false }, 'devtools window');
  assert.match((await call(2, 'tabs.isShown', { tabId: tab.id })).error.message, /controlled by another agent session/);
});

test('tabs.listAll: kept and windowType per tab, tabs of popup and app windows, never DevTools or incognito ones', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example' });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  const child = chrome.addTab({ openerTabId: gmail.id, windowId: 3 }); // a popup window
  await core.onNavigationTarget({ sourceTabId: gmail.id, tabId: child.id });
  await tick();
  const { result: work } = await call(1, 'tabs.open', {});
  const { result: forUser } = await call(1, 'tabs.open', { forUser: true });
  const app = chrome.addTab({ windowId: 4 });
  const devtools = chrome.addTab({ windowId: 5 });
  const incognito = chrome.addTab({ windowId: 6, incognito: true });
  chrome.hooks.windows = { 3: { type: 'popup' }, 4: { type: 'app' }, 5: { type: 'devtools' }, 6: { incognito: true } };
  const listed = new Map((await call(1, 'tabs.listAll', {})).result.map((t) => [t.id, t]));
  const pick = (id) => { const t = listed.get(id); return { owner: t.owner, origin: t.origin, kept: t.kept, handedOver: t.handedOver, windowType: t.windowType }; };
  assert.deepEqual(pick(child.id), { owner: 'you', origin: 'agent', kept: true, handedOver: false, windowType: 'popup' });
  assert.deepEqual(pick(work.id), { owner: 'you', origin: 'agent', kept: false, handedOver: false, windowType: 'normal' });
  assert.deepEqual(pick(forUser.id), { owner: 'you', origin: 'agent', kept: true, handedOver: true, windowType: 'normal' });
  assert.deepEqual(pick(gmail.id), { owner: 'you', origin: 'user', kept: false, handedOver: false, windowType: 'normal' });
  assert.equal(listed.get(app.id).windowType, 'app');
  assert.ok(!listed.has(devtools.id) && !listed.has(incognito.id));
});

test('tabs.info answers for one tab exactly as tabs.listAll lists it, null where listAll leaves it out', async () => {
  const { chrome, call } = setup();
  await call(1, 'client.hello', { label: 'Research' });
  const { result: mine } = await call(1, 'tabs.open', { url: 'https://example.com' });
  const { result: theirs } = await call(2, 'tabs.open', {});
  const user = chrome.addTab({ url: 'https://user.example', title: 'User', active: true, windowId: 3 });
  const devtools = chrome.addTab({ windowId: 5 });
  const incognito = chrome.addTab({ windowId: 6, incognito: true });
  chrome.hooks.windows = { 3: { type: 'popup' }, 5: { type: 'devtools' }, 6: { incognito: true } };
  const listed = new Map((await call(1, 'tabs.listAll', {})).result.map((t) => [t.id, t]));
  const info = async (tabId) => (await call(1, 'tabs.info', { tabId })).result;

  for (const id of [mine.id, theirs.id, user.id]) assert.deepEqual(await info(id), listed.get(id));
  assert.deepEqual([listed.get(mine.id).owner, listed.get(mine.id).groupTitle], ['you', 'Research']);
  assert.equal(listed.get(theirs.id).owner, 'other');
  assert.deepEqual([listed.get(user.id).owner, listed.get(user.id).windowType, listed.get(user.id).groupTitle], [null, 'popup', null]);
  assert.equal(await info(devtools.id), null);
  assert.equal(await info(incognito.id), null);
  assert.equal(await info(9999), null, 'a missing tab');

  await call(1, 'tabs.park', { tabId: mine.id, kind: 'takeover' });
  assert.equal((await info(mine.id)).parked, 'takeover');
});

test('a closed window forgets its armed popup and its active tab history', async () => {
  const { core, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' });
  core.onWindowRemoved(1);
  // Window ids are not reused in practice, but nothing of the old window may act on a tab that turns up with its id.
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active === true));
});

test('a tab the user opens from a tab already handed to them stays theirs', async () => {
  const { core, chrome, call } = setup();
  const { result: kept } = await call(1, 'tabs.open', { forUser: true });
  const child = chrome.addTab({ openerTabId: kept.id });
  await core.onNavigationTarget({ sourceTabId: kept.id, tabId: child.id });
  await tick();
  assert.equal(core.owners.has(child.id), false, 'not adopted without an expectChild window');
  // Inside the window (the agent's own click) it is adopted, but kept: handed back, never closed.
  await call(1, 'tabs.expectChild', { tabId: kept.id, ms: 3000 });
  const agentChild = chrome.addTab({ openerTabId: kept.id });
  await core.onNavigationTarget({ sourceTabId: kept.id, tabId: agentChild.id });
  await tick();
  assert.equal(core.owners.get(agentChild.id)?.kept, true);
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(child.id) && chrome.tabsById.has(agentChild.id) && chrome.tabsById.has(kept.id));
});

test('tabs.park hands the tab to the user for now; tabs.claim resumes it as it was', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://shop.example/checkout' });
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  const groupId = chrome.tabsById.get(tab.id).groupId;
  assert.notEqual(groupId, -1);
  sent.length = 0;
  assert.match((await call(2, 'tabs.park', { tabId: tab.id, kind: 'handoff' })).error.message, /controlled by another agent session/);
  assert.deepEqual((await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' })).result, { ok: true });

  const parked = chrome.tabsById.get(tab.id);
  assert.equal(parked.groupId, -1, 'out of the group');
  assert.equal(parked.mutedInfo.muted, false, 'our mute ended');
  assert.equal(parked.autoDiscardable, true);
  assert.ok(chrome.calls.some((c) => c[0] === 'debugger.detach' && c[1] === tab.id));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active), 'never focused');
  const owner = core.owners.get(tab.id);
  assert.deepEqual([owner.client, owner.kept, owner.handedOver, owner.detached, owner.parked.kind], [1, true, true, true, 'handoff']);
  assert.deepEqual(sent.filter((m) => m.method), [{ method: 'chrome.debugger.onDetach', params: [{ tabId: tab.id }, 'parked'], client: 1 }]);
  assert.equal((await call(1, 'tabs.listAll', {})).result.find((t) => t.id === tab.id).parked, 'handoff');
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error.message, /parked/, 'no re-attach while parked');

  sent.length = 0;
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error);
  const resumed = chrome.tabsById.get(tab.id);
  assert.notEqual(resumed.groupId, -1, 'back in a group (made again: its old one went with its last tab)');
  assert.equal(resumed.mutedInfo.muted, true, 'muted again');
  assert.equal(resumed.autoDiscardable, false);
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === tab.id), 'the claim re-attaches');
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual([owner.parked, owner.kept, owner.handedOver], [undefined, false, false]);
  assert.equal((await call(1, 'tabs.listAll', {})).result.find((t) => t.id === tab.id).parked, null);
  assert.equal(owner.detached, undefined);
});

test('a parked claimed tab keeps the user\'s group and mute; a parked tab is handed over at disconnect, never closed', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example', groupId: 42, mutedInfo: { muted: true, reason: 'user' } });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.park', { tabId: gmail.id, kind: 'takeover' });
  assert.equal(chrome.tabsById.get(gmail.id).groupId, 42);
  assert.deepEqual(chrome.tabsById.get(gmail.id).mutedInfo, { muted: true, reason: 'user' });
  await call(1, 'tabs.claim', { tabId: gmail.id, resume: true });
  assert.equal(chrome.tabsById.get(gmail.id).groupId, 42);
  assert.deepEqual(chrome.tabsById.get(gmail.id).mutedInfo, { muted: true, reason: 'user' });

  const { result: work } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: work.id, kind: 'takeover' });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(work.id) && chrome.tabsById.has(gmail.id), 'both stay open');
  assert.equal(core.owners.size, 0);
});

test('a parked tab can be released or closed by its owner, and resuming a tab now on a browser page fails and keeps it parked', async () => {
  const { core, chrome, call } = setup();
  const { result: a } = await call(1, 'tabs.open', {});
  const { result: b } = await call(1, 'tabs.open', {});
  const { result: c } = await call(1, 'tabs.open', {});
  for (const t of [a, b, c]) await call(1, 'tabs.park', { tabId: t.id, kind: 'takeover' });
  assert.ok(!(await call(1, 'tabs.release', { tabId: a.id })).error);
  assert.ok(chrome.tabsById.has(a.id) && !core.owners.has(a.id));
  assert.ok(!(await call(1, 'chrome.tabs.remove', [b.id, { usersTab: true }])).error);
  assert.ok(!chrome.tabsById.has(b.id));
  chrome.tabsById.get(c.id).url = 'chrome://settings';
  assert.match((await call(1, 'tabs.claim', { tabId: c.id, resume: true })).error.message, /can't be controlled/);
  assert.equal(core.owners.get(c.id).parked.kind, 'takeover');
});

// The user's turn of a tab (usersTurn): their latest input in it, as the server saw it (tabs.userInput), is later than
// the agent's latest Input.* and at most 5 s old.
const input = (call, tabId, sessionId) => call(1, 'chrome.debugger.sendCommand', [{ tabId, ...(sessionId && { sessionId }) }, 'Input.dispatchMouseEvent', { type: 'mousePressed' }]);
const openFrom = async (core, chrome, opener, props = {}) => {
  const child = chrome.addTab({ openerTabId: opener, ...props });
  await core.onTabCreated(structuredClone(child));
  await core.onNavigationTarget({ sourceTabId: opener, tabId: child.id });
  await tick();
  return child.id;
};

test('the user\'s turn: a tab their own input opens from an agent tab is theirs, until the agent\'s next input', async () => {
  const { core, chrome, call, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  assert.deepEqual((await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() })).result, { ok: true });
  assert.match((await call(2, 'tabs.userInput', { tabId: opener.id, at: Date.now() })).error.message, /controlled by another agent session/);
  sent.length = 0;

  // Chrome opened it in front, for the user's click: it stays in front and nobody owns it.
  chrome.tabsById.get(userTab.id).active = false;
  const theirs = await openFrom(core, chrome, opener.id, { active: true, url: 'https://shop.example/terms' });
  assert.equal(core.owners.has(theirs), false);
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && (c[1] === theirs || c[2].active)), 'not muted, grouped or switched away from');
  assert.equal(chrome.tabsById.get(theirs).groupId, -1);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated'));
  // Chrome put one into the agent's group (a tab opened from a grouped tab joins it): out it goes, and stays nobody's.
  const grouped = await openFrom(core, chrome, opener.id, { groupId: chrome.tabsById.get(opener.id).groupId });
  assert.equal(core.owners.has(grouped), false);
  assert.equal(chrome.tabsById.get(grouped).groupId, -1, 'out of the agent\'s group');

  // Other commands are no input; any Input.* command of the tab, also on a child session, is the agent's.
  await call(1, 'chrome.debugger.sendCommand', [{ tabId: opener.id }, 'Runtime.evaluate', { expression: '1' }]);
  assert.equal(core.owners.has(await openFrom(core, chrome, opener.id)), false);
  await input(call, opener.id, 'CHILD-SESSION');
  const agents = await openFrom(core, chrome, opener.id);
  assert.equal(core.owners.get(agents)?.client, 1);

  // The user's input again, then the agent's: the agent's turn.
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  assert.equal(core.owners.has(await openFrom(core, chrome, opener.id)), false);
  await input(call, opener.id);
  assert.equal(core.owners.get(await openFrom(core, chrome, opener.id))?.client, 1);
  // An older report of the user's input does not take the turn back.
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() - 1000 });
  assert.equal(core.owners.get(await openFrom(core, chrome, opener.id))?.client, 1);
});

test('the user\'s turn lasts 5 s, a page\'s transient activation', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() - 5100 });
  assert.equal(core.owners.get(await openFrom(core, chrome, opener.id))?.client, 1, 'over 5 s ago');
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() + 60_000 }); // never later than now
  const now = Date.now;
  Date.now = () => now() + 5001;
  try {
    assert.equal(core.owners.get(await openFrom(core, chrome, opener.id))?.client, 1, 'expired');
  } finally {
    Date.now = now;
  }
});

test('Page.windowOpen during the user\'s turn arms nothing: the popup Chrome opens in front for them stays there', async () => {
  const { core, call, chrome, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  sent.length = 0;
  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' });
  assert.ok(sent.some((m) => m.method === 'chrome.debugger.onEvent' && m.params[1] === 'Page.windowOpen'), 'the owner still hears it');
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active === true));

  // The agent's input: armed again.
  await input(call, opener.id);
  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' });
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.ok(chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active === true));
});

test('tabs.openChild during the user\'s turn opens the tab for them: in front, right after its opener, nobody\'s', async () => {
  const { core, call, chrome, sent } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  const group = chrome.tabsById.get(opener.id).groupId;
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  assert.match((await call(1, 'tabs.openChild', { tabId: opener.id, url: 'javascript:alert(1)' })).error.message, /http/);
  assert.match((await call(2, 'tabs.openChild', { tabId: opener.id, url: 'https://shop.example/terms' })).error.message, /controlled by another agent session/);
  sent.length = 0;
  chrome.hooks.created = (tab) => { tab.groupId = group; }; // Chrome put it inside the agent's group
  const { result, error } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://shop.example/terms' });
  chrome.hooks.created = undefined;
  assert.equal(error, undefined);
  assert.equal(result.user, true);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1],
    { windowId: 1, index: chrome.tabsById.get(opener.id).index + 1, url: 'https://shop.example/terms', active: true, openerTabId: opener.id });
  assert.equal(core.owners.has(result.tabId), false);
  assert.equal(chrome.tabsById.get(result.tabId).groupId, -1, 'out of the agent\'s group');
  assert.equal(chrome.tabsById.get(result.tabId).mutedInfo.muted, false);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated'));

  // After the agent's input: the agent's own, as before (blank, background, adopted).
  await input(call, opener.id);
  const agents = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://shop.example/next' });
  assert.equal(agents.result.user, undefined);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1],
    { windowId: 1, index: chrome.tabsById.get(opener.id).index + 1, url: 'about:blank', active: false, openerTabId: opener.id });
  assert.equal(core.owners.get(agents.result.tabId)?.client, 1);
});

test('a tab opened from a claimed tab inside its expectChild window is the user\'s during their turn', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example', active: true, groupId: 77 }); // in a group of the user's
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  await call(1, 'tabs.userInput', { tabId: gmail.id, at: Date.now() });
  const theirs = await openFrom(core, chrome, gmail.id, { groupId: 77 });
  assert.equal(core.owners.has(theirs), false);
  assert.equal(chrome.tabsById.get(theirs).groupId, 77, 'the user\'s own group stays');
  await input(call, gmail.id);
  assert.equal(core.owners.get(await openFrom(core, chrome, gmail.id))?.client, 1, 'the agent\'s click');
});

test('the user\'s turn ends with control: release, disconnect, the tab closing or being replaced', async () => {
  const { core, chrome, call } = setup();
  const gmail = chrome.addTab({ url: 'https://mail.example' });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.userInput', { tabId: gmail.id, at: Date.now() });
  await call(1, 'tabs.release', { tabId: gmail.id });
  await call(1, 'tabs.claim', { tabId: gmail.id });
  await call(1, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  assert.equal(core.owners.get(await openFrom(core, chrome, gmail.id))?.client, 1, 'released: the turn went with it');

  await call(1, 'tabs.userInput', { tabId: gmail.id, at: Date.now() });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  await call(2, 'tabs.claim', { tabId: gmail.id });
  await call(2, 'tabs.expectChild', { tabId: gmail.id, ms: 3000 });
  assert.equal(core.owners.get(await openFrom(core, chrome, gmail.id))?.client, 2, 'disconnected: the turn went with it');

  const { result: a } = await call(3, 'tabs.open', {});
  const { result: b } = await call(3, 'tabs.open', {});
  for (const tab of [a, b]) {
    await call(3, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Input.insertText', { text: 'x' }]);
    await call(3, 'tabs.userInput', { tabId: tab.id, at: Date.now() });
  }
  for (const map of [core.userInputAt, core.agentInputAt]) assert.ok(map.has(a.id) && map.has(b.id));
  await chrome.tabs.remove(a.id);
  await core.onTabReplaced(chrome.addTab({}).id, b.id);
  for (const map of [core.userInputAt, core.agentInputAt]) assert.ok(!map.has(a.id) && !map.has(b.id), 'closed and replaced tabs leave nothing behind');
});

test('tabs opened from a parked tab are the user\'s, even inside an expectChild window', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  await call(1, 'tabs.park', { tabId: opener.id, kind: 'handoff' });
  const child = chrome.addTab({ openerTabId: opener.id });
  await core.onNavigationTarget({ sourceTabId: opener.id, tabId: child.id });
  await tick();
  assert.equal(core.owners.has(child.id), false);
});

test('a resume that fails partway leaves the tab parked and protected: the disconnect hands it over, never closes it', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  chrome.hooks.groupError = 'Tabs cannot be edited right now (user may be dragging a tab).';
  assert.match((await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error.message, /dragging/);
  const owner = core.owners.get(tab.id);
  assert.deepEqual([owner.parked?.kind, owner.kept, owner.handedOver], ['handoff', true, true]);
  assert.equal(chrome.session.owners[tab.id].parked?.kind, 'handoff', 'persisted as parked');
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(tab.id), 'still open');
});

test('parking ends our mute while the debugger is still attached, then detaches', async () => {
  const { chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  chrome.calls.length = 0;
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  const unmute = chrome.calls.findIndex((c) => c[0] === 'tabs.update' && c[2].muted === false);
  const detach = chrome.calls.findIndex((c) => c[0] === 'debugger.detach');
  assert.ok(unmute >= 0 && detach > unmute, JSON.stringify(chrome.calls));

  const { result: user } = await call(1, 'tabs.open', {});
  chrome.tabsById.get(user.id).mutedInfo = { muted: true, reason: 'user' }; // the user's own mute meanwhile stays
  await call(1, 'tabs.park', { tabId: user.id, kind: 'handoff' });
  assert.deepEqual(chrome.tabsById.get(user.id).mutedInfo, { muted: true, reason: 'user' });
});

test('a replaced parked tab stays parked under its new id and is not announced for attaching', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  const replacement = chrome.addTab({ url: 'https://example.com/prerendered' });
  chrome.tabsById.delete(tab.id);
  sent.length = 0;
  await core.onTabReplaced(replacement.id, tab.id);
  assert.equal(core.owners.get(replacement.id).parked.kind, 'handoff');
  assert.deepEqual(sent.map((m) => [m.method, m.params[1]?.replacedBy]), [['chrome.tabs.onRemoved', replacement.id]]);
});

test('a resume stays parked until its attach worked: a failed attach or a client gone meanwhile leaves the tab parked and open', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error);
  const owner = core.owners.get(tab.id);
  assert.deepEqual([owner.parked?.kind, owner.kept, owner.handedOver], ['handoff', true, true], 'still parked until attached');
  assert.notEqual(chrome.tabsById.get(tab.id).groupId, -1, 'back in its group meanwhile');
  chrome.hooks.attachError = 'Cannot access a chrome-extension:// URL of different extension';
  assert.ok((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual([owner.parked?.kind, owner.parked?.resuming, owner.kept], ['handoff', undefined, true], 'rolled back');
  assert.equal(chrome.tabsById.get(tab.id).groupId, -1, 'out of the group again');
  assert.equal(chrome.tabsById.get(tab.id).mutedInfo.muted, false, 'our mute ended again');

  delete chrome.hooks.attachError;
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error);
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  await tick();
  assert.ok(chrome.tabsById.has(tab.id), 'a client gone mid-resume never closes it');
  assert.equal(chrome.tabsById.get(tab.id).groupId, -1);
  assert.equal(chrome.tabsById.get(tab.id).mutedInfo.muted, false);
});

test('a resume ends its parking only once the attach worked; tabs.park meanwhile calls it off', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'takeover' });
  await call(1, 'tabs.claim', { tabId: tab.id, resume: true });
  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  const owner = core.owners.get(tab.id);
  assert.deepEqual([owner.parked, owner.kept, owner.handedOver], [undefined, false, false]);

  await call(1, 'tabs.park', { tabId: tab.id, kind: 'takeover' });
  await call(1, 'tabs.claim', { tabId: tab.id, resume: true });
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'takeover' });
  assert.match((await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error.message, /parked/);
  assert.deepEqual([owner.parked?.kind, owner.parked?.resuming], ['takeover', undefined]);
  assert.equal(chrome.tabsById.get(tab.id).groupId, -1);
});

test('a plain tabs.claim never un-parks a tab: only resume does', async () => {
  const { core, chrome, call, sent } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'takeover' });
  sent.length = 0;
  assert.match((await call(1, 'tabs.claim', { tabId: tab.id })).error.message, /parked/);
  assert.equal(core.owners.get(tab.id).parked.kind, 'takeover');
  assert.equal(chrome.tabsById.get(tab.id).groupId, -1);
  assert.ok(!sent.some((m) => m.method === 'chrome.tabs.onCreated'));
});

test('a parked tab closes only with the user\'s confirmation', async () => {
  const { chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'takeover' });
  assert.match((await call(1, 'chrome.tabs.remove', [tab.id])).error.message, /user's/);
  assert.ok(chrome.tabsById.has(tab.id));
  assert.ok(!(await call(1, 'chrome.tabs.remove', [tab.id, { usersTab: true }])).error);
  assert.ok(!chrome.tabsById.has(tab.id));
});

test('a group the user folded stays folded: a resumed tab and an adopted popup fold it again', async () => {
  const { core, chrome, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://shop.example/' });
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']);
  const groupId = chrome.tabsById.get(tab.id).groupId;
  chrome.groupsById.get(groupId).collapsed = true; // the user folded it
  await call(1, 'tabs.park', { tabId: tab.id, kind: 'handoff' });
  assert.ok(!chrome.groupsById.has(groupId), 'its last tab left: the group is gone');
  assert.ok(!(await call(1, 'tabs.claim', { tabId: tab.id, resume: true })).error);
  assert.notEqual(chrome.tabsById.get(tab.id).groupId, groupId, 'a new group');
  assert.equal(chrome.groupsById.get(chrome.tabsById.get(tab.id).groupId).collapsed, true, 'resumed into a folded group');
  await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3']); // the resume completes once re-attached

  // An action that opens a popup: Chrome makes it active in the folded group, which unfolds it.
  await call(1, 'tabs.expectChild', { tabId: tab.id, ms: 3000 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const popup = chrome.addTab({ openerTabId: tab.id, groupId: chrome.tabsById.get(tab.id).groupId, active: true });
  chrome.groupsById.get(chrome.tabsById.get(tab.id).groupId).collapsed = false;
  await core.onNavigationTarget({ sourceTabId: tab.id, tabId: popup.id });
  assert.equal(chrome.groupsById.get(chrome.tabsById.get(tab.id).groupId).collapsed, true, 'folded again after the popup');
});

test('a group the user unfolded is left alone: a resume into it, and children opened in the background', async () => {
  const { core, chrome, call } = setup();
  const { result: a } = await call(1, 'tabs.open', {});
  const { result: b } = await call(1, 'tabs.open', {});
  await call(1, 'chrome.debugger.attach', [{ tabId: a.id }, '1.3']);
  const groupId = chrome.tabsById.get(a.id).groupId;
  chrome.groupsById.get(groupId).collapsed = true;
  await call(1, 'tabs.park', { tabId: a.id, kind: 'takeover' });
  chrome.groupsById.get(groupId).collapsed = false; // b keeps the group; the user unfolds it
  await call(1, 'tabs.claim', { tabId: a.id, resume: true });
  assert.equal(chrome.tabsById.get(a.id).groupId, groupId);
  assert.equal(chrome.groupsById.get(groupId).collapsed, false, 'the resume did not fold it');

  chrome.groupsById.get(groupId).collapsed = true;
  await call(1, 'chrome.debugger.attach', [{ tabId: b.id }, '1.3']);
  await call(1, 'tabs.expectChild', { tabId: b.id, ms: 3000 });
  chrome.groupsById.get(groupId).collapsed = false; // the user unfolds it during the action
  const child = chrome.addTab({ openerTabId: b.id, groupId, active: false }); // opened in the background
  await core.onNavigationTarget({ sourceTabId: b.id, tabId: child.id });
  assert.equal(core.owners.get(child.id).client, 1);
  assert.equal(chrome.groupsById.get(groupId).collapsed, false, 'a background child never folds it');
});

test('a tab adopted before the user\'s input that opened it was heard of is theirs after all, back in front', async () => {
  const { core, chrome, call, sent } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  const agents = await openFrom(core, chrome, opener.id); // the agent's, before the user pressed anything
  // The user is on the agent's tab (its input can only be theirs there).
  chrome.tabsById.get(userTab.id).active = false;
  chrome.tabsById.get(opener.id).active = true;
  await core.onTabActivated({ tabId: opener.id, windowId: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pressed = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  // A key press opened it at once, in front, before its report came: adopted and switched back meanwhile.
  chrome.tabsById.get(opener.id).active = false;
  const early = await openFrom(core, chrome, opener.id, { active: true, url: 'https://shop.example/terms' });
  assert.equal(core.owners.get(early)?.client, 1);
  sent.length = 0;
  await call(1, 'tabs.userInput', { tabId: opener.id, at: pressed });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.has(early), false, 'the user\'s after all');
  const tab = chrome.tabsById.get(early);
  assert.deepEqual([tab.groupId, tab.mutedInfo.muted], [-1, false], 'out of the group, unmuted');
  assert.ok(sent.some((m) => m.method === 'chrome.tabs.onRemoved' && m.params[0] === early && m.params[1].usersPopup), 'the client hears it is gone, no takeover');
  assert.ok(chrome.calls.some((c) => c[0] === 'tabs.update' && c[1] === early && c[2].active === true), 'back in front');
  assert.equal(core.owners.get(agents)?.client, 1, 'what opened before the input stays the agent\'s');

  // Once the user picked another tab, a late hand-back brings nothing to the front behind their back.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pressedAgain = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await openFrom(core, chrome, opener.id, { active: true, url: 'https://shop.example/faq' });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  await call(1, 'tabs.userInput', { tabId: opener.id, at: pressedAgain });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.has(second), false);
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[1] === second && c[2].active === true), 'the user moved on: left in the background');

  // Reports out of order: the agent acted and its click opened a tab, then a newer report of the user's input came
  // before an older one. The older one gives back nothing the agent opened before the newer.
  await input(call, opener.id);
  const agentsChild = await openFrom(core, chrome, opener.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  await call(1, 'tabs.userInput', { tabId: opener.id, at: pressedAgain + 1 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.get(agentsChild)?.client, 1, 'still the agent\'s');
});

test('a popup armed before the user\'s input was heard of is not switched away from once it is their turn', async () => {
  const { core, call, chrome } = setup();
  const userTab = chrome.addTab({ url: 'https://mail.example', active: true });
  await core.onTabActivated({ tabId: userTab.id, windowId: 1 });
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await call(1, 'tabs.expectChild', { tabId: opener.id, ms: 3000 });
  await core.onDebuggerEvent({ tabId: opener.id }, 'Page.windowOpen', { url: 'https://idp.example/auth' }); // still the agent's turn
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  core.onTabCreated(structuredClone(chrome.addTab({ active: true, url: '' })));
  assert.ok(!chrome.calls.some((c) => c[0] === 'tabs.update' && c[2].active === true));
});

test('a popup the user\'s click asked for is theirs even when its opener closed itself meanwhile', async () => {
  const { core, call, chrome } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://example.com' });
  chrome.tabsById.get(opener.id).windowId = 3;
  await call(1, 'tabs.userInput', { tabId: opener.id, at: Date.now() });
  await chrome.tabs.remove(opener.id); // window.open(url, '_blank', 'noopener'); window.close()
  const { result, error } = await call(1, 'tabs.openChild', { tabId: opener.id, url: 'https://example.com/next' });
  assert.equal(error, undefined);
  assert.equal(result.user, true);
  assert.deepEqual(chrome.calls.filter((c) => c[0] === 'tabs.create').at(-1)[1], { windowId: 3, url: 'https://example.com/next', active: true });
  assert.equal(core.owners.has(result.tabId), false);
});

test('a tab given back to the user while the agent was closing it stays open, theirs', async () => {
  const { core, chrome, call, start } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pressed = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const child = await openFrom(core, chrome, opener.id);
  let open;
  const held = new Promise((resolve) => { open = resolve; });
  const ungroup = chrome.tabs.ungroup;
  chrome.tabs.ungroup = async (ids) => { await held; return ungroup(ids); };
  const closing = start(1, 'chrome.tabs.remove', [child]);
  await tick();
  await call(1, 'tabs.userInput', { tabId: opener.id, at: pressed }); // the late report, mid-close
  chrome.tabs.ungroup = ungroup;
  open();
  await closing.done;
  for (let i = 0; i < 5; i++) await tick();
  assert.ok(chrome.tabsById.has(child), 'not closed');
  assert.equal(core.owners.has(child), false);
  assert.equal(chrome.tabsById.get(child).mutedInfo.muted, false, 'handed over: unmuted');
});

test('a tab adopted for the user\'s input and swapped by Chrome before the report came is still given back', async () => {
  const { core, chrome, call } = setup();
  const { result: opener } = await call(1, 'tabs.open', { url: 'https://shop.example' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pressed = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const child = await openFrom(core, chrome, opener.id);
  const replacement = chrome.addTab({ url: 'https://shop.example/terms' });
  chrome.tabsById.delete(child);
  await core.onTabReplaced(replacement.id, child);
  assert.equal(core.owners.get(replacement.id)?.client, 1);
  await call(1, 'tabs.userInput', { tabId: opener.id, at: pressed });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(core.owners.has(replacement.id), false, 'the replacement is the user\'s');
});

test('an attach that finishes after the tab was released or its client left leaves it detached', async () => {
  const { chrome, core, call, start } = setup();
  const claimed = chrome.addTab({ url: 'https://user.example' });
  const released = chrome.addTab({ url: 'https://user.example/2' });
  await call(1, 'tabs.claim', { tabId: claimed.id });
  await call(1, 'tabs.claim', { tabId: released.id });
  const pending = [];
  chrome.debugger.attach = async ({ tabId }) => { // a busy browser's attach can take seconds
    await new Promise((resolve) => pending.push(resolve));
    chrome.calls.push(['debugger.attach', tabId]);
  };
  const attaching = [claimed.id, released.id].map((tabId) => start(1, 'chrome.debugger.attach', [{ tabId }, '1.3']));
  await tick();
  await call(1, 'tabs.release', { tabId: released.id });
  await core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } }); // the session ended meanwhile
  for (const resolve of pending) resolve();
  await Promise.all(attaching.map((a) => a.done));
  for (const [tabId, request] of [[claimed.id, attaching[0]], [released.id, attaching[1]]]) {
    const last = chrome.calls.filter((c) => c[1] === tabId && /^debugger\.(attach|detach)$/.test(c[0])).at(-1);
    assert.deepEqual(last, ['debugger.detach', tabId], `tab ${tabId} left attached with no owner`);
    assert.ok(request.reply().error, 'the attach fails');
    assert.equal(core.owners.has(tabId), false);
  }
});

// Chrome handles each API call when the extension makes it and answers later, in call order (the fake above reads tab
// state when it answers instead). `answer()` delivers the oldest pending answer.
function orderedChrome() {
  const tabs = new Map();
  const groups = new Set();
  const calls = [];
  const closedInGroup = []; // tabs Chrome closed while they were in a group: it keeps such a group as a saved group
  const pending = [];
  let nextTab = 100, nextGroup = 1;
  const handle = (fn) => {
    let result, error;
    try { result = structuredClone(fn()); } catch (e) { error = e; }
    return new Promise((resolve, reject) => pending.push(() => (error ? reject(error) : resolve(result))));
  };
  const tab = (id) => { if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`); return tabs.get(id); };
  const store = { async get() { return {}; }, async set() {} };
  return {
    calls, closedInGroup,
    answer: async () => { // the extension's own work runs first: an answer never comes back at once
      const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
      await settle();
      pending.shift()?.();
      await settle();
    },
    get waiting() { return pending.length; },
    runtime: { id: 'fowlbrowser-ext', getManifest: () => ({ version: '0.1.0' }) },
    storage: { session: store, local: store },
    windows: {
      getLastFocused: () => handle(() => ({ id: 1, type: 'normal', incognito: false })),
      getAll: () => handle(() => [{ id: 2, type: 'normal', tabs: [{ id: 1 }] }]), // the user's window, with a tab of theirs
    },
    tabGroups: { update: (id) => handle(() => { if (!groups.has(id)) throw new Error(`No group with id: ${id}`); return {}; }) },
    debugger: { detach: () => handle(() => ({})) },
    tabs: {
      query: () => handle(() => []),
      create: (props) => handle(() => {
        const t = { id: nextTab++, windowId: props.windowId, index: 0, url: props.url, groupId: -1, mutedInfo: { muted: false } };
        tabs.set(t.id, t);
        return t;
      }),
      get: (id) => handle(() => tab(id)),
      update: (id, props) => handle(() => { calls.push(['tabs.update', id]); return Object.assign(tab(id), { mutedInfo: { muted: !!props.muted } }); }),
      group: ({ groupId, tabIds }) => handle(() => {
        const g = groupId ?? nextGroup++;
        groups.add(g);
        for (const id of tabIds) tab(id).groupId = g;
        return g;
      }),
      ungroup: (id) => handle(() => { tab(id).groupId = -1; }),
      remove: (id) => handle(() => { if (tab(id).groupId !== -1) closedInGroup.push(id); tabs.delete(id); }),
    },
  };
}

test('a client that leaves while tabs.open still sets up its tab: the tab leaves its group before it closes (no saved group)', async () => {
  const chrome = orderedChrome();
  const core = createCore({ chrome, send: () => {} });
  do await chrome.answer(); while (chrome.waiting); // restore()
  await core.handleMessage({ method: 'host.clientConnected', params: { client: 1 } });
  const opening = core.handleMessage({ id: 1, method: 'tabs.open', params: {}, client: 1 });
  for (let i = 0; i < 20 && !chrome.calls.some(([c]) => c === 'tabs.update'); i++) await chrome.answer();
  const leaving = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } }); // the session ends
  while (chrome.waiting) await chrome.answer();
  await Promise.all([opening, leaving]);
  assert.deepEqual(chrome.closedInGroup, []);
  assert.equal(core.owners.size, 0);
});

// argo's X chat tab (2026-10-26): an agent closed it with a draft in it, the page asked "leave page?" through the debugger,
// nobody answered, and the tab stayed frozen, active, muted and held by a session that had long ended.
test('a page asking "leave page?" as the extension closes it is answered: the close goes through', async () => {
  const { chrome, core, call } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://chat.example/' });
  const remove = chrome.tabs.remove;
  chrome.tabs.remove = async (id) => {
    let answered;
    const left = new Promise((resolve) => { answered = resolve; });
    const send = chrome.debugger.sendCommand;
    chrome.debugger.sendCommand = async (target, method, params) => {
      if (method === 'Page.handleJavaScriptDialog' && target.tabId === id && params.accept) answered();
      return send(target, method, params);
    };
    await core.onDebuggerEvent({ tabId: id }, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' });
    await left;
    return remove(id);
  };
  assert.ok(!(await call(1, 'chrome.tabs.remove', [tab.id])).error);
  assert.ok(!chrome.tabsById.has(tab.id));
  // Not the extension's close: the question goes to the client as usual.
  const { result: other } = await call(1, 'tabs.open', {});
  chrome.calls.length = 0;
  await core.onDebuggerEvent({ tabId: other.id }, 'Page.javascriptDialogOpening', { type: 'beforeunload', message: '' });
  assert.ok(!chrome.calls.some(([, , method]) => method === 'Page.handleJavaScriptDialog'));
});

test('a close the page holds up stops being waited for: the leaving session\'s cleanup gives the tab to the user, unmuted and detached', async () => {
  const timers = manualTimers();
  const { chrome, core, call, start } = setup({ timers });
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://chat.example/' });
  chrome.tabs.remove = () => new Promise(() => {}); // the page's question is never answered
  const closing = start(1, 'chrome.tabs.remove', [tab.id]);
  for (let i = 0; i < 20 && !timers.pending.size; i++) await tick();
  await timers.fire(10_000);
  await closing.done;
  assert.match(closing.reply().error.message, /did not close within 10 s: its page asks before it is left/);
  assert.equal(core.owners.get(tab.id).client, 1, 'still the agent\'s, which may try again');

  const leaving = core.handleMessage({ method: 'host.clientDisconnected', params: { client: 1 } });
  for (let i = 0; i < 20 && !timers.pending.size; i++) await tick();
  await timers.fire(10_000);
  await leaving;
  assert.ok(!core.owners.has(tab.id), 'nobody holds it');
  assert.equal(chrome.tabsById.get(tab.id).mutedInfo.muted, false);
  assert.equal(chrome.tabsById.get(tab.id).groupId, -1);
  assert.ok(chrome.calls.some(([c, id]) => c === 'debugger.detach' && id === tab.id));
});

test('a connected session quiet for 10 min gives back the tabs the user sees as theirs; its background work tabs stay', async () => {
  const { chrome, core, call, sent } = setup();
  const usersTab = chrome.addTab({ url: 'https://user.example/' });
  await call(1, 'tabs.claim', { tabId: usersTab.id });
  const { result: work } = await call(1, 'tabs.open', { url: 'https://work.example/' });
  const { result: front } = await call(1, 'tabs.open', { url: 'https://front.example/' });
  chrome.tabsById.get(front.id).active = true; // the user is looking at it
  const { result: kept } = await call(1, 'tabs.open', { url: 'https://kept.example/', forUser: true });
  const busyTab = chrome.addTab({ url: 'https://busy.example/' });
  await call(2, 'tabs.claim', { tabId: busyTab.id });
  const now = Date.now;
  try {
    await core.releaseIdle();
    Date.now = () => now() + 9 * 60_000;
    // Session 2 is at work in another tab of its own; session 1 still sends nothing.
    await call(2, 'tabs.listAll', {});
    await core.releaseIdle();
    assert.equal(core.owners.size, 5, 'nothing quiet for 10 min yet');
    Date.now = () => now() + 10 * 60_000 + 1;
    await core.releaseIdle();
  } finally {
    Date.now = now;
  }
  assert.deepEqual([...core.owners.keys()].sort(), [work.id, busyTab.id].sort(), 'the background work tab and the busy session\'s tab stay held');
  for (const id of [usersTab.id, front.id, kept.id]) {
    assert.ok(chrome.tabsById.has(id), 'never closed');
    assert.equal(chrome.tabsById.get(id).mutedInfo.muted, false);
  }
  assert.equal(chrome.tabsById.get(front.id).groupId, -1);
  // A dialog the session left open would pop up in front of the user after the detach: dismissed first.
  const steps = chrome.calls.filter(([, id]) => id === usersTab.id).map(([c, , method]) => method ?? c);
  assert.ok(steps.includes('Page.handleJavaScriptDialog') && steps.indexOf('Page.handleJavaScriptDialog') < steps.lastIndexOf('debugger.detach'), String(steps));
  const told = sent.filter((m) => m.method === 'chrome.tabs.onRemoved' && m.client === 1);
  assert.deepEqual(told.map((m) => m.params[0]).sort(), [usersTab.id, front.id, kept.id].sort(), 'the session hears each one is gone');
  assert.ok(told.every((m) => m.params[1].idle === true), 'and why');
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: usersTab.id }, 'Page.reload'])).error.message, /not controlled by this session/);
});

test('tabs.listAll names the session holding another session\'s tab and when it was last at work', async () => {
  const { chrome, call } = setup();
  await call(1, 'client.hello', { label: 'Codex', session: 'Codex via FowlTweets in Project X (pid 70289)' });
  await call(2, 'client.hello', { label: 'Claude' });
  const usersTab = chrome.addTab({ url: 'https://x.example/i/chat' });
  await call(1, 'tabs.claim', { tabId: usersTab.id });
  const listed = (await call(2, 'tabs.listAll', {})).result.find((t) => t.id === usersTab.id);
  assert.equal(listed.owner, 'other');
  assert.equal(listed.ownerSession, 'Codex via FowlTweets in Project X (pid 70289)');
  assert.ok(listed.ownerSeenAt <= Date.now() && listed.ownerSeenAt > Date.now() - 60_000, 'when the holder last showed it is at work');
  assert.equal(listed.releasing, false);
  const own = (await call(1, 'tabs.listAll', {})).result.find((t) => t.id === usersTab.id);
  assert.equal(own.ownerSession, null, 'a session\'s own tab names nobody');
});

test('a client that marks its tool calls (client.active) is at work only then: its pages\' own traffic keeps no tab held', async () => {
  const { chrome, core, call } = setup();
  const usersTab = chrome.addTab({ url: 'https://chat.example/' });
  await call(1, 'tabs.claim', { tabId: usersTab.id });
  const active = () => core.handleMessage({ method: 'client.active', params: {}, client: 1 });
  await active();
  const now = Date.now;
  try {
    Date.now = () => now() + 9 * 60_000;
    await active(); // a tool call
    Date.now = () => now() + 18 * 60_000;
    await core.releaseIdle();
    assert.ok(core.owners.has(usersTab.id), 'at work 9 min ago');
    // Playwright attaching a worker the page started, a document load's body fetch: not the agent.
    await call(1, 'chrome.debugger.sendCommand', [{ tabId: usersTab.id }, 'Runtime.runIfWaitingForDebugger']);
    Date.now = () => now() + 19 * 60_000 + 1;
    await core.releaseIdle();
  } finally {
    Date.now = now;
  }
  assert.ok(!core.owners.has(usersTab.id), 'quiet for 10 min whatever its page did');
});
