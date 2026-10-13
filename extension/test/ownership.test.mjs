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
  const getTab = (id) => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`No tab with id: ${id}`);
    return tab;
  };
  const chrome = {
    calls, tabsById: tabs, groupsById, hooks, gates, addTab, session, local,
    storage: { session: store(session), local: store(local) },
    runtime: { id: 'fowlbrowser-ext', getManifest: () => ({ version: '0.1.0' }), reload: () => calls.push(['reload']) },
    windows: {
      async getLastFocused() { return { id: 1, type: 'normal', incognito: false }; },
      async getAll({ windowTypes } = {}) {
        const ids = new Set([1, ...[...tabs.values()].map((t) => t.windowId)]);
        return [...ids].map((id) => ({ id, type: 'normal', incognito: false, ...hooks.windows?.[id] }))
          .filter((w) => !windowTypes || windowTypes.includes(w.type));
      },
      async get(id) { return { id, type: 'normal', state: 'normal', incognito: false, ...hooks.windows?.[id] }; },
      async create(props) { calls.push(['windows.create', props]); return { id: 2, tabs: [addTab({ windowId: 2 })] }; },
      async update(id, props) { calls.push(['windows.update', id, props]); },
    },
    tabs: {
      async query(q) { return [...tabs.values()].filter((t) => (!q.active || t.active) && (q.groupId === undefined || t.groupId === q.groupId)); },
      async get(id) { await wait('tabs.get'); return structuredClone(getTab(id)); },
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
        }
      },
      async group({ groupId, tabIds }) {
        await wait('tabs.group');
        if (hooks.groupError) throw new Error(hooks.groupError);
        if (groupId !== undefined && !groupsById.has(groupId)) throw new Error(`No group with id: ${groupId}.`);
        const id = groupId ?? nextGroupId++;
        if (groupId === undefined) groupsById.set(id, { id, title: '', collapsed: false });
        for (const t of tabIds) getTab(t).groupId = id;
        calls.push(['tabs.group', tabIds, id]);
        return id;
      },
      // Like Chrome: a group whose last tab leaves is gone.
      async ungroup(ids) {
        for (const id of [ids].flat()) {
          const { groupId } = getTab(id);
          getTab(id).groupId = -1;
          if (![...tabs.values()].some((t) => t.groupId === groupId)) groupsById.delete(groupId);
        }
        calls.push(['tabs.ungroup', ids]);
      },
    },
    tabGroups: {
      async update(id, props) { calls.push(['tabGroups.update', id, props]); Object.assign(groupsById.get(id) ?? {}, props); },
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
    `Tab ${tab.id} is not owned by this client`);
  assert.ok((await call(2, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).error);
  assert.ok((await call(2, 'chrome.tabs.remove', [tab.id])).error);
  assert.ok((await call(2, 'tabs.release', { tabId: tab.id })).error);
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /owned by another client/);

  assert.ok(!(await call(1, 'chrome.debugger.attach', [{ tabId: tab.id }, '1.3'])).error);
  assert.deepEqual((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.reload'])).result,
    { ok: 'Page.reload' });
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
    assert.match((await late.ask()).error?.message ?? '', /not owned/, 'expired on lookup, with no other close to prune it');
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

test('local files and view-source: pages are never opened or claimed, however the URL is written', async () => {
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', {});
  for (const url of ['file:///Users/me/.ssh/id_ed25519', 'fi\tle:///etc/passwd', ' FILE:///etc/passwd', '\u0001file:///etc/passwd',
    'view-source:file:///etc/passwd', 'view-source:https://example.com/']) {
    assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url }])).error?.message ?? '', /is blocked/, JSON.stringify(url));
  }
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'https://example.com/file:///x' }])).error);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigate').length, 1, 'only the https one reached the tab');
  for (const url of ['file:///Users/me/notes.txt', 'view-source:https://example.com/']) {
    const local = chrome.addTab({ url });
    assert.match((await call(1, 'tabs.claim', { tabId: local.id })).error.message, /can't be controlled/, url);
  }
  // Nor opened in a new tab, by tabs.open or by chrome.tabs.create (the relay's Target.createTarget).
  for (const url of ['file:///etc/passwd', 'fi\tle:///etc/passwd', 'view-source:file:///etc/passwd']) {
    assert.match((await call(1, 'tabs.open', { url })).error?.message ?? '', /never opened/, JSON.stringify(url));
    assert.match((await call(1, 'chrome.tabs.create', [{ url }])).error?.message ?? '', /never opened/, JSON.stringify(url));
  }
  assert.equal(chrome.calls.filter((c) => c[0] === 'tabs.create' || c[0] === 'windows.create').length, 1, 'only the first about:blank tab was created');
  assert.ok(!(await call(1, 'tabs.open', { url: 'https://example.com/file:///x' })).error);
});

test('navigation checks work on Chrome 125, which has no URL.parse', async (t) => {
  const parse = URL.parse;
  delete URL.parse;
  t.after(() => { URL.parse = parse; });
  const { call, chrome } = setup();
  const { result: tab } = await call(1, 'tabs.open', { url: 'https://example.com' });
  assert.ok(!(await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'https://example.org/' }])).error);
  assert.match((await call(1, 'chrome.debugger.sendCommand', [{ tabId: tab.id }, 'Page.navigate', { url: 'file:///etc/passwd' }])).error?.message ?? '', /is blocked/);
  assert.match((await call(1, 'tabs.open', { url: 'file:///etc/passwd' })).error?.message ?? '', /never opened/);
  assert.equal(chrome.calls.filter((c) => c[0] === 'debugger.sendCommand' && c[2] === 'Page.navigate').length, 1);
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
  assert.match((await call(2, 'tabs.claim', { tabId: tab.id })).error.message, /owned by another client/);
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
  for (const method of ['Network.enable', 'Network.loadNetworkResource', 'IndexedDB.enable', 'IndexedDB.disable', 'DOMStorage.enable',
    'CacheStorage.enable', 'ServiceWorker.enable', 'ServiceWorker.disable', 'Storage.getUsageAndQuota', 'Target.getTargetInfo',
    'Target.detachFromTarget', 'Page.navigate', 'Runtime.evaluate']) {
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
  assert.match((await call(1, 'tabs.closeUnowned', { tabId: theirs.id })).error.message, /owned by another client/);
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
  assert.match((await call(2, 'tabs.expectChild', { tabId: gmail.id, ms: 1000 })).error.message, /not owned/);
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
  assert.match((await call(2, 'tabs.isShown', { tabId: tab.id })).error.message, /not owned by this client/);
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
  assert.match((await call(2, 'tabs.park', { tabId: tab.id, kind: 'handoff' })).error.message, /not owned/);
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
  assert.match((await call(2, 'tabs.userInput', { tabId: opener.id, at: Date.now() })).error.message, /not owned/);
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
  assert.match((await call(2, 'tabs.openChild', { tabId: opener.id, url: 'https://shop.example/terms' })).error.message, /not owned/);
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
    windows: { getLastFocused: () => handle(() => ({ id: 1, type: 'normal', incognito: false })) },
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
