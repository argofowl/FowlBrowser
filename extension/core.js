// FowlBrowser extension core: tab ownership, command handling and event routing.
// Everything browser-facing goes through the injected `chrome`, so tests can run it in Node.

const NO_REPLY = Symbol('no reply');
const DEFAULT_LABEL = 'Claude';
const COMMAND_TIMEOUT_MS = 30_000;
const LISTED_WINDOW_TYPES = ['normal', 'popup', 'app'];
// CDP policy: a client drives its own tab and that tab's child targets (iframes, workers), never the browser,
// other tabs, the user's focus or the whole profile's cookies and storage. Refused for every client; the relay
// answers what Playwright needs from these itself.
const BLOCKED_CDP = [
  /^Browser\./,
  /^Page\.bringToFront$/,
  // Only these Target methods; attachToTarget only flattened and only for the tab's own children. No
  // sendMessageToTarget: a non-flat session would carry commands past this filter.
  /^Target\.(?!(setAutoAttach|getTargetInfo|detachFromTarget|attachToTarget)$)/,
  /^Network\.(clearBrowserCookies|clearBrowserCache|setCookie|setCookies|deleteCookies|getCookies|getAllCookies)$/,
  // Profile-wide storage domains: Storage only the quota read Lighthouse makes, and enable/disable; ServiceWorker
  // reads (get*, request*), tracking and enable/disable; any site's DOM storage, IndexedDB and Cache Storage only
  // enable/disable, never their data.
  /^Storage\.(?!(getUsageAndQuota|enable|disable)$)/,
  /^ServiceWorker\.(?!((get|request|track|untrack)[A-Z]\w*|enable|disable)$)/,
  /^(DOMStorage|IndexedDB|CacheStorage)\.(?!(enable|disable)$)/,
];
const CHILD_ONLY_CDP = /^Target\.attachToTarget$/;
const isBlockedCommand = (method) => BLOCKED_CDP.some((rule) => rule.test(String(method)));
const EXPECT_CHILD_MAX_MS = 5000;     // also how long the user's turn of a tab lasts (a page's transient activation)
const LAST_OWNED_MS = 5000; // how long a closed owned tab can still open the popup it asked for (tabs.openChild)
const CLEANUP_RETRY_MS = [200, 1000];
const DOWNLOAD_MATCH_MS = 10_000;      // how long downloads and Page.downloadWillBegin signals are kept for matching
const DOWNLOAD_SETTLE_MS = 800;        // quiet time after the latest of them before any is attributed
const DOWNLOAD_PAIR_MS = 2000;         // a download and its tab's signal arrive this close together, or they don't pair
const DOWNLOAD_EXPECT_MAX_MS = 300_000;
const BROWSING_DATA_MAX = 200;
const POPUP_ARM_MS = 1500;             // after a Page.windowOpen, how long a new active tab in that window is switched back
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export function colorFor(label) {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

export function isNewTabPage(url) {
  return /^(chrome|edge):\/\/(newtab|new-tab-page)\b/.test(url) || url.startsWith('chrome-search://');
}

// Parsed as Chrome does, so "fi\tle:" is a local file too. new URL, not URL.parse: Chrome 125 lacks that.
function isLocalFile(url) {
  try { return ['file:', 'view-source:'].includes(new URL(String(url ?? '')).protocol); } catch { return false; }
}

export function isRestricted(url) {
  if (url === 'about:blank') return false;
  return /^(chrome|chrome-extension|devtools|edge|about|file|view-source):/.test(url)
    || url.startsWith('https://chromewebstore.google.com')
    || url.startsWith('https://chrome.google.com/webstore');
}

export function createCore({ chrome, send, timers = globalThis }) {
  // tabId -> { client, origin: 'agent'|'user', group, kept, releasing?, detached? }. `releasing` holds
  // the tab until its cleanup (detach/close) finishes; `detached` means the debugger was taken away (DevTools,
  // cancel).
  const owners = new Map();
  const labels = new Map();         // client -> label from client.hello
  const groups = new Map();         // `${client}|${label}|${windowId}` -> promise of the tab group id
  const activeByWindow = new Map(); // windowId -> { current, previous } active tab ids
  const chunks = new Map();         // chunk id -> text received so far
  const liveClients = new Set();    // clients the current host announced and hasn't disconnected
  const tabLocks = new Map();       // tabId -> tail of that tab's claim/release/close queue
  const childTargets = new Map();   // tabId -> target and session ids of that tab's own children (iframes, workers)
  const closing = new Set();        // unowned tabs tabs.closeUnowned is closing: never adopted meanwhile
  const expectations = new Map();   // claimed tabId -> { client, until }: tabs.expectChild windows
  const folded = new Map();         // owned tabId -> { groupId, folded }: its group's state right before its current action
  const openedActive = new Set();   // tabs Chrome opened as the active tab (that unfolds a folded group they join)
  const windowOf = new Map();       // owned tabId -> windowId, learnt before each of its actions (tabs.expectChild)
  const armedWindows = new Map();   // windowId -> { source, url, at, until }: a popup is on its way into that window
  const openedFor = new Map();      // tabs.openChild child tabId -> opener tabId, until the child's first page commits
  const lastOwned = new Map();      // owned tabId that closed -> { owner, windowId, at }, for 5 s (tabs.openChild)
  const userInputAt = new Map();    // owned tabId -> time of the user's latest input in it (tabs.userInput)
  const agentInputAt = new Map();   // owned tabId -> when its client last sent it an Input.* command
  const adoptedFrom = new Map();    // adopted child tabId -> { from, at, wasActive }, for EXPECT_CHILD_MAX_MS (giveBack)
  // Downloads: each belongs to the client whose tab started it (see attributeDownload), and only that client
  // ever sees it. Nothing here survives a disconnect; the files stay.
  const downloads = new Map();      // download id -> { client, tabId }
  const downloadSignals = [];       // { client, tabId, url, guid, at, claimed? }: Page.downloadWillBegin of the last 10 s
  const strayDownloads = new Map(); // download id -> { url, finalUrl, referrer, at, tried? }: unattributed, last 10 s
  const downloadExpectations = new Map(); // tabId -> { client, until }: downloads.expect windows
  let startsInFlight = 0;           // downloads.start calls whose id is not known yet
  let settleTimer = null;
  let inFlight = 0;                 // tab creations and claims under way
  let reloading = false;
  // Bumped when the native port closes: the next host restarts client and request ids, so work and replies
  // from the old port must never reach the new one.
  let generation = 0;
  let instanceIdPromise = null;
  const activityWatchers = new Set(); // clients that asked for tabs.activity events (tools/rounds.mjs monitors)

  const ready = restore();

  async function restore() {
    const stored = await chrome.storage.session.get(['owners', 'labels']);
    for (const [tabId, owner] of Object.entries(stored.owners ?? {})) owners.set(Number(tabId), owner);
    for (const [client, label] of Object.entries(stored.labels ?? {})) labels.set(Number(client), label);
    // A worker restart closes the native port, and with it the host and every client it served,
    // so whatever the previous worker owned is cleaned up like a disconnect.
    await disconnectAll();
    for (const tab of await chrome.tabs.query({ active: true })) {
      activeByWindow.set(tab.windowId, { current: tab.id });
    }
  }

  function persist() {
    return chrome.storage.session.set({
      owners: Object.fromEntries(owners),
      labels: Object.fromEntries(labels),
    });
  }

  function instanceId() {
    instanceIdPromise ??= (async () => {
      const { instanceId } = await chrome.storage.local.get('instanceId');
      if (instanceId) return instanceId;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ instanceId: id });
      return id;
    })();
    return instanceIdPromise;
  }

  // Goes to the host's log file (~/.fowlbrowser/logs/<browser>.log), never to clients.
  function log(...parts) {
    send({ method: 'extension.log', params: { text: parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') } });
  }

  function emit(client, method, params) {
    send({ method, params, client });
  }

  // Tab events for an owner; a tab being released is no longer the client's to hear about.
  function emitToOwner(owner, method, params) {
    if (!owner.releasing) emit(owner.client, method, params);
  }

  function requireOwner(client, tabId) {
    const owner = owners.get(tabId);
    if (!owner || owner.client !== client) throw new Error(`Tab ${tabId} is not owned by this client`);
    if (owner.releasing) throw new Error(`Tab ${tabId} is being released`);
    return owner;
  }

  // Claim, release and close of one tab run one at a time.
  function serialize(tabId, fn) {
    const run = (tabLocks.get(tabId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    tabLocks.set(tabId, tail);
    tail.then(() => { if (tabLocks.get(tabId) === tail) tabLocks.delete(tabId); });
    return run;
  }

  function labelFor(client) {
    return labels.get(client) ?? DEFAULT_LABEL;
  }

  async function pickWindow() {
    const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    if (last && last.type === 'normal' && !last.incognito) return last.id;
    const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    return windows.find((w) => !w.incognito)?.id;
  }

  // The group is created once per key even when several tabs.open calls race: they all await one promise.
  async function addToGroup(client, label, tabId, windowId) {
    const key = `${client}|${label}|${windowId}`;
    for (let attempt = 0; ; attempt++) {
      const existing = groups.get(key);
      if (!existing) {
        const created = (async () => {
          const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
          await chrome.tabGroups.update(groupId, { title: label, color: colorFor(label), collapsed: false });
          return groupId;
        })();
        groups.set(key, created);
        created.catch(() => { if (groups.get(key) === created) groups.delete(key); });
        await created;
        return;
      }
      try {
        await chrome.tabs.group({ groupId: await existing, tabIds: [tabId] });
        return;
      } catch (error) {
        // The group emptied and Chrome removed it; make a new one.
        if (groups.get(key) === existing) groups.delete(key);
        if (attempt) throw error;
      }
    }
  }

  // Counts tab creations and claims under way, so extension.reloadIfIdle can see them.
  async function tracked(fn) {
    inFlight++;
    try { return await fn(); } finally { inFlight--; }
  }

  // Anything failing after the tab exists closes it again: the client never has an open tab it wasn't told about.
  // A tab `forUser` is the user's from the start (handed over: not grouped, discardable, kept), though the client still
  // drives it until it disconnects. It stays muted while driven (focus emulation lets background pages autoplay) and
  // is unmuted when control ends, unless the agent set its mute itself or the user changed it meanwhile.
  async function openTab({ client, live }, { url = 'about:blank', group, muted = true, forUser = false } = {}) {
    if (isLocalFile(url)) throw new Error(`${url} can't be opened: local files and view-source: pages are never opened`);
    const label = group || labelFor(client);
    const windowId = await pickWindow();
    const tab = windowId === undefined
      ? (await chrome.windows.create({ focused: false, url })).tabs[0]
      : await chrome.tabs.create({ windowId, url, active: false });
    if (!live()) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error('Client disconnected');
    }
    const owner = { client, origin: 'agent', group: label, kept: !!forUser, handedOver: !!forUser, agentMuted: !!forUser };
    owners.set(tab.id, owner);
    try {
      // In the tab's queue, like a child's adoption: a disconnect's cleanup comes after it and finds the group to leave.
      return await serialize(tab.id, async () => {
        await persist();
        if (forUser) {
          await chrome.tabs.update(tab.id, { muted: true });
          return await chrome.tabs.get(tab.id);
        }
        await chrome.tabs.update(tab.id, { muted, autoDiscardable: false });
        await addToGroup(client, label, tab.id, tab.windowId);
        return await chrome.tabs.get(tab.id);
      });
    } catch (error) {
      owner.releasing = true;
      await serialize(tab.id, () => cleanUp(tab.id, owner));
      throw error;
    }
  }

  async function navigateBlank(tabId) {
    await chrome.tabs.update(tabId, { url: 'about:blank' });
    for (let waited = 0; waited < 5000; waited += 25) {
      const tab = await chrome.tabs.get(tabId);
      if (tab.url === 'about:blank' && tab.status !== 'loading') return tab;
      await new Promise((resolve) => timers.setTimeout(resolve, 25));
    }
    throw new Error(`Tab ${tabId} did not leave the new tab page`);
  }

  // Chrome saves every tab group and keeps it (bookmarks bar, saved groups) after its tabs close;
  // ungrouping first deletes the group instead, so agent groups never pile up in the user's browser.
  async function ungroup(tabId) {
    if ((await chrome.tabs.get(tabId)).groupId !== -1) await chrome.tabs.ungroup(tabId);
  }

  async function closeAgentTab(tabId, owner) {
    await ungroup(tabId);
    if (owner?.givenBack) return; // the user's own popup after all (giveBack): theirs, never closed
    await chrome.tabs.remove(tabId);
  }

  // An agent tab the user gets to keep (kept or released) leaves its group and behaves like their own tabs again.
  async function handOver(tabId) {
    await ungroup(tabId);
    await chrome.tabs.update(tabId, { muted: false, autoDiscardable: true });
  }

  const ownMute = ({ mutedInfo }) => !!mutedInfo?.muted && mutedInfo.reason === 'extension' && mutedInfo.extensionId === chrome.runtime.id;

  // Ends a forUser or kept tab's agent mute: unmuted only if this extension's mute is still on (the user's own choice stays).
  async function endAgentMute(tabId, owner) {
    if (ownMute(await chrome.tabs.get(tabId))) await chrome.tabs.update(tabId, { muted: false });
    delete owner.agentMuted;
  }

  // Whether the user has the tab's group folded (false when it has none).
  async function groupFolded(tab) {
    return tab.groupId !== -1 && (await chrome.tabGroups.get(tab.groupId).catch(() => null))?.collapsed === true;
  }

  // A parked tab stays the client's (so it can resume) but is the user's meanwhile: debugger detached, out of the
  // client's group, this extension's mute ended, discardable, and kept and handed over, so a disconnect hands it to
  // them and never closes it. What it was is remembered for unpark. The client hears a detach with reason "parked".
  async function park(tabId, owner, kind) {
    const tab = await chrome.tabs.get(tabId);
    const grouped = owner.origin === 'agent' && tab.groupId !== -1; // a claimed tab's group is the user's own
    owner.parked = { kind, at: Date.now(), grouped, groupId: tab.groupId, folded: grouped && await groupFolded(tab), muted: ownMute(tab), agentMuted: !!owner.agentMuted, kept: !!owner.kept, handedOver: !!owner.handedOver };
    owner.detached = true;
    owner.kept = owner.handedOver = true;
    delete owner.agentMuted;
    await persist();
    try {
      await quiet(tabId, owner.parked);
    } finally {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      childTargets.delete(tabId);
      emitToOwner(owner, 'chrome.debugger.onDetach', [{ tabId }, 'parked']);
    }
  }

  // A parked tab out of the client's group, discardable, this extension's mute ended. Unmuted before any detach, as in
  // cleanUp: Helium can lose an unmute sent right after one.
  async function quiet(tabId, parked) {
    await chrome.tabs.update(tabId, { autoDiscardable: true, ...(parked.muted && { muted: false }) });
    if (parked.grouped) await ungroup(tabId);
  }

  // tabs.claim {resume} of a parked tab: back into the client's group and its mute as it was; the claim then
  // re-attaches. It stays parked (kept, handed over: a disconnect never closes it) until that attach worked (resumed);
  // a failed step, a failed attach, a tabs.park meanwhile or the client leaving rolls it back (rollBack).
  async function unpark(tabId, owner, tab) {
    const url = tab.pendingUrl || tab.url || '';
    if (isRestricted(url)) throw new Error(`Tab ${tabId} shows ${url}, which can't be controlled`);
    const { parked } = owner;
    parked.resuming = true;
    try {
      if (parked.grouped) {
        await addToGroup(owner.client, owner.group ?? labelFor(owner.client), tabId, tab.windowId);
        // Its group went with it (it was the last tab) and was made again, expanded: folded again if it was. A group
        // that is still there keeps whatever the user did to it since.
        const { groupId } = await chrome.tabs.get(tabId);
        if (parked.folded && groupId !== -1 && groupId !== parked.groupId) await chrome.tabGroups.update(groupId, { collapsed: true });
      }
      const restore = { ...(parked.muted && { muted: true }), ...(owner.origin === 'agent' && !parked.handedOver && { autoDiscardable: false }) };
      if (Object.keys(restore).length) await chrome.tabs.update(tabId, restore);
      await persist();
    } catch (error) {
      await rollBack(tabId, owner).catch(() => {});
      throw error;
    }
    return chrome.tabs.get(tabId);
  }

  async function rollBack(tabId, owner) {
    if (!owner.parked?.resuming) return; // rolled back already (a release, a tabs.park)
    delete owner.parked.resuming;
    await persist();
    await quiet(tabId, owner.parked);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  // The resume's attach worked: the tab is the client's again, as it was before parking.
  function resumed(owner) {
    const { parked } = owner;
    delete owner.parked;
    owner.kept = parked.kept;
    owner.handedOver = parked.handedOver;
    if (parked.agentMuted) owner.agentMuted = true;
  }

  // The owner record stays (releasing) until cleanup is done, so nobody can claim the tab mid-cleanup. A failed
  // step is retried; the record is dropped only once cleanup worked or the tab is gone, so a surviving agent tab
  // never loses its provenance (a later disconnect or worker restart tries again). Returns whether it finished.
  async function cleanUp(tabId, owner) {
    for (let attempt = 0; owners.get(tabId) === owner; attempt++) {
      try {
        await rollBack(tabId, owner); // the client left mid-resume: still the user's
        if (owner.origin === 'agent' && !owner.kept) await closeAgentTab(tabId, owner);
        if (owner.origin !== 'agent' || owner.kept) { // kept: also given back to the user while it was closing (giveBack)
          // Handed over already (tab_keep, forUser): the user may have muted it since; never undo their changes.
          // Unmuted before the detach: Helium can lose an unmute sent right after one.
          if (owner.origin === 'agent' && !owner.handedOver) await handOver(tabId);
          else if (owner.agentMuted) await endAgentMute(tabId, owner);
          await chrome.debugger.detach({ tabId }).catch(() => {});
        }
      } catch (error) {
        if (await chrome.tabs.get(tabId).then(() => true, () => false)) {
          if (attempt >= CLEANUP_RETRY_MS.length) {
            log('cleanup failed, kept the record', tabId, error.message);
            return false;
          }
          await new Promise((resolve) => timers.setTimeout(resolve, CLEANUP_RETRY_MS[attempt]));
          continue;
        }
      }
      if (owners.get(tabId) === owner) owners.delete(tabId);
      folded.delete(tabId);
      await persist();
      return true;
    }
    return true; // closed or moved on meanwhile (onTabReplaced schedules cleanup for the new id)
  }

  // Takes its snapshot synchronously, so tabs a later client gets are never part of this cleanup.
  async function disconnectClient(client) {
    liveClients.delete(client);
    labels.delete(client);
    for (const key of groups.keys()) if (key.startsWith(`${client}|`)) groups.delete(key);
    for (const [id, record] of downloads) if (record.client === client) downloads.delete(id);
    for (const [tabId, expected] of downloadExpectations) if (expected.client === client) downloadExpectations.delete(tabId);
    for (let i = downloadSignals.length - 1; i >= 0; i--) if (downloadSignals[i].client === client) downloadSignals.splice(i, 1);
    for (const [tabId, last] of lastOwned) if (last.owner.client === client) lastOwned.delete(tabId);
    const mine = [...owners].filter(([, owner]) => owner.client === client);
    for (const [tabId, owner] of mine) {
      owner.releasing = true;
      forgetInput(tabId);
    }
    await Promise.allSettled([persist(), ...mine.map(([tabId, owner]) => serialize(tabId, () => cleanUp(tabId, owner)))]);
  }

  function disconnectAll() {
    chunks.clear();
    const clients = new Set([...labels.keys(), ...[...owners.values()].map((o) => o.client)]);
    return Promise.all([...clients].map(disconnectClient));
  }

  // Every handler gets (params, ctx); ctx.live() turns false once the client or the native port is gone,
  // ctx.emit/ctx.reply drop anything a dead client or an old port would otherwise receive.
  const handlers = {
    async 'client.hello'({ label }, { client, msg, reply, emit: emitBack }) {
      labels.set(client, label || DEFAULT_LABEL);
      await persist();
      reply({ id: msg.id, result: { ok: true } });
      for (const [tabId, owner] of owners) {
        if (owner.client === client && !owner.releasing) emitBack('chrome.tabs.onCreated', [await chrome.tabs.get(tabId)]);
      }
      emitBack('extension.initialized', []);
      return NO_REPLY;
    },

    // Tabs of normal, popup and app windows (an owned tab can sit in a popup), never DevTools or incognito ones.
    async 'tabs.listAll'(_params, { client }) {
      const windows = new Map((await chrome.windows.getAll({ windowTypes: LISTED_WINDOW_TYPES }))
        .filter((w) => !w.incognito).map((w) => [w.id, w.type]));
      const tabs = (await chrome.tabs.query({})).filter((t) => !t.incognito && windows.has(t.windowId));
      const titles = new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g.title]));
      return tabs.map((t) => tabEntry(t, windows.get(t.windowId), titles.get(t.groupId), client));
    },

    // One tab as tabs.listAll lists it, or null where listAll would leave it out (gone, incognito, DevTools).
    async 'tabs.info'({ tabId } = {}, { client }) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t || t.incognito) return null;
      const window = await chrome.windows.get(t.windowId).catch(() => null);
      if (!window || window.incognito || !LISTED_WINDOW_TYPES.includes(window.type)) return null;
      const group = t.groupId >= 0 ? await chrome.tabGroups.get(t.groupId).catch(() => null) : null;
      return tabEntry(t, window.type, group?.title, client);
    },

    async 'tabs.open'(params, ctx) {
      const tab = await tracked(() => openTab(ctx, params));
      ctx.emit('chrome.tabs.onCreated', [tab]);
      return tab;
    },

    async 'chrome.tabs.create'([createProperties = {}], ctx) {
      return tracked(() => openTab(ctx, { url: createProperties.url }));
    },

    // A parked tab is the user's for now: it closes only with usersTab (they asked for it: tab_close confirm_close_users_tab).
    async 'chrome.tabs.remove'([tabIds, { usersTab = false } = {}], { client }) {
      const ids = [tabIds].flat();
      for (const id of ids) requireOwner(client, id);
      await Promise.all(ids.map((id) => serialize(id, async () => {
        const owner = requireOwner(client, id);
        if (owner.parked && !usersTab) throw new Error(`Tab ${id} is the user's for now (parked), so it was not closed`);
        if (owner.origin === 'agent') await closeAgentTab(id, owner);
        else await chrome.tabs.remove(id);
      })));
    },

    async 'tabs.claim'({ tabId, resume = false }, { client, live, emit: emitBack }) {
      if (owners.get(tabId)?.releasing) throw new Error(`Tab ${tabId} is being released`); // refuse, don't queue
      return tracked(() => serialize(tabId, async () => {
        const owner = owners.get(tabId);
        if (owner?.releasing) throw new Error(`Tab ${tabId} is being released`);
        if (owner && owner.client !== client) throw new Error(`Tab ${tabId} is owned by another client`);
        let tab = await chrome.tabs.get(tabId);
        if (tab.incognito) throw new Error(`Tab ${tabId} is in an incognito window, which is left alone`);
        if (owner) {
          if (owner.parked && !resume) throw new Error(`Tab ${tabId} is parked (the user has it); only a resume takes it back`);
          if (owner.parked && !owner.parked.resuming) tab = await unpark(tabId, owner, tab);
          // The debugger was taken away (DevTools, "Cancel" on the bar): this explicit claim lets the client
          // re-attach. `detached` clears only once chrome.debugger.attach succeeds, so a failed one can be retried.
          if (owner.detached) emitBack('chrome.tabs.onCreated', [tab]);
          return tab;
        }
        const url = tab.pendingUrl || tab.url || '';
        if (isNewTabPage(url)) tab = await navigateBlank(tabId);
        else if (isRestricted(url)) throw new Error(`Tab ${tabId} shows ${url}, which can't be controlled`);
        if (owners.has(tabId)) throw new Error(`Tab ${tabId} is owned by another client`);
        if (!live()) throw new Error('Client disconnected');
        owners.set(tabId, { client, origin: 'user', group: null, kept: false });
        await persist();
        emitBack('chrome.tabs.onCreated', [tab]);
        return tab;
      }));
    },

    // The client always hears onRemoved, even when the tab closes during the release.
    async 'tabs.release'({ tabId }, { client, emit: emitBack }) {
      return serialize(tabId, async () => {
        const owner = requireOwner(client, tabId);
        const tab = await chrome.tabs.get(tabId).catch(() => ({ windowId: -1 }));
        owner.releasing = true;
        forgetInput(tabId);
        owner.kept = true; // released agent tabs are handed over, never closed
        const done = await cleanUp(tabId, owner);
        emitBack('chrome.tabs.onRemoved', [tabId, { windowId: tab.windowId, isWindowClosing: false }]);
        if (!done) throw new Error(`Tab ${tabId} could not be released yet; it is retried when this client disconnects`);
        return { ok: true };
      });
    },

    // During the next `ms` (at most 5 s), a tab whose navigation-target source is this tab becomes the client's
    // even though it is a claimed tab: the agent's own click opened it.
    async 'tabs.expectChild'({ tabId, ms }, { client }) {
      requireOwner(client, tabId);
      expectations.set(tabId, { client, until: Date.now() + Math.min(Math.max(Number(ms) || 0, 0), EXPECT_CHILD_MAX_MS) });
      // Read before replying, so before the action: the window, so a popup of the action can be armed synchronously, and
      // whether the user has its group folded, so a popup Chrome activates in it (which unfolds it) folds it back.
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) windowOf.set(tabId, tab.windowId);
      if (tab && owners.get(tabId)?.client === client) folded.set(tabId, { groupId: tab.groupId, folded: await groupFolded(tab) });
      return { ok: true };
    },

    // A popup the page opens without an opener (mcp/src/popups.mjs): a blank tab in the background right after its
    // opener, adopted like any child of it, which the client then navigates (no referrer). A tab the
    // page opens itself, with a user gesture, makes Chrome show the opener's window, which brings the browser to the
    // front; tabs.create doesn't. An opener that closed itself right after asking (window.open, then window.close)
    // still gets it, in its last window (also when it closes while the tab is being created). The child is this
    // client's only if the opener's ownership (record, keep, handover, parking) is what it asked with once the tab
    // exists and nobody else has the tab; otherwise it closes again, unless someone else has it. During the user's turn
    // of the opener (their own click asked for it) it opens for them instead (openForUser).
    async 'tabs.openChild'({ tabId, url }, { client, live }) {
      if (!/^https?:\/\//i.test(String(url))) throw new Error(`Not an http(s) URL: ${url}`);
      const current = owners.get(tabId);
      if (current?.client === client && !current.releasing && usersTurn(tabId)) return tracked(() => openForUser(tabId, url));
      const last = current ? null : closedOwner(tabId); // the user's click opened it, then the page closed itself
      if (last?.owner.client === client && turnOf(last.userAt, last.agentAt)) return tracked(() => openForUser(tabId, url, last.windowId));
      const ownership = () => {
        const owner = owners.get(tabId) ?? closedOwner(tabId)?.owner;
        return owner ? [owner, !!owner.kept, !!owner.handedOver, owner.parked, owner.origin, !!owner.releasing] : [];
      };
      const asked = ownership();
      const [owner] = asked;
      if (!owner || owner.client !== client) throw new Error(`Tab ${tabId} is not owned by this client`);
      if (!passesOn(owner, tabId)) throw new Error(`Tab ${tabId} passes no children on`);
      const unchanged = () => live() && ownership().every((value, i) => value === asked[i]);
      return tracked(async () => {
        const source = await chrome.tabs.get(tabId).catch(() => null);
        const windowId = source?.windowId ?? closedOwner(tabId)?.windowId;
        if (windowId === undefined) throw new Error(`Tab ${tabId} closed`);
        const blank = { windowId, url: 'about:blank', active: false };
        const tab = await chrome.tabs.create(source ? { ...blank, index: source.index + 1, openerTabId: tabId } : blank).catch(async (error) => {
          // The opener closed after the lookup (Chrome refuses a gone openerTabId): once more without it.
          if (!source || !unchanged() || await chrome.tabs.get(tabId).then(() => true, () => false)) throw error;
          return chrome.tabs.create(blank);
        });
        if (owners.has(tab.id) || closing.has(tab.id)) throw new Error(`Tab ${tab.id} was taken meanwhile`);
        if (!unchanged()) {
          await chrome.tabs.remove(tab.id).catch(() => {});
          throw new Error(`Tab ${tabId} is no longer this client's to open from`);
        }
        openedFor.set(tab.id, tabId);
        await reserveChild(tab.id, owner, tabId);
        return { tabId: tab.id };
      });
    },

    // Hands an agent tab to the user now (ungrouped, discardable); the client drives it until it disconnects. Muted by
    // us, it stays muted till then like a forUser tab (focus emulation lets a driven background page autoplay).
    async 'tabs.keep'({ tabId }, { client }) {
      return serialize(tabId, async () => {
        const owner = requireOwner(client, tabId);
        owner.kept = true;
        await persist();
        if (owner.origin === 'agent' && !owner.handedOver) {
          if (ownMute(await chrome.tabs.get(tabId))) {
            await ungroup(tabId);
            await chrome.tabs.update(tabId, { autoDiscardable: true });
            owner.agentMuted = true;
          } else await handOver(tabId);
          owner.handedOver = true;
          await persist();
        }
        return { ok: true };
      });
    },

    // The user took the tab over, or the client handed it to them mid-task (kind "takeover" or "handoff"): it stays the
    // client's but goes quiet and becomes theirs for now (see park).
    async 'tabs.park'({ tabId, kind }, { client }) {
      return serialize(tabId, async () => {
        const owner = requireOwner(client, tabId);
        if (owner.parked?.resuming) await rollBack(tabId, owner); // a resume that did not get the tab back
        else if (!owner.parked) await park(tabId, owner, kind === 'handoff' ? 'handoff' : 'takeover');
        return { ok: true };
      });
    },

    // Closes one of the user's tabs that nobody owns, without attaching the debugger (a claim would wake it: focus
    // emulation and an active lifecycle start its media).
    async 'tabs.closeUnowned'({ tabId }, { client }) {
      return serialize(tabId, async () => {
        const owner = owners.get(tabId);
        if (owner) throw new Error(owner.client === client ? `Tab ${tabId} is controlled by this client; close it with chrome.tabs.remove` : `Tab ${tabId} is owned by another client`);
        closing.add(tabId); // a popup adoption racing this close must not hand the tab to anyone
        try {
          if ((await chrome.tabs.get(tabId)).incognito) throw new Error(`Tab ${tabId} is in an incognito window`);
          if (owners.has(tabId)) throw new Error(`Tab ${tabId} is owned by another client`);
          await chrome.tabs.remove(tabId);
        } finally {
          closing.delete(tabId);
        }
        return { ok: true };
      });
    },

    async 'tabs.focus'({ tabId }) {
      const owner = owners.get(tabId);
      if (owner?.agentMuted) { // The user asked to see it: they hear it too
        await endAgentMute(tabId, owner);
        await persist();
      }
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true };
    },

    // Whether the user can see the tab: active in a normal, non-minimized window (the agent cursor shows only then).
    // focused: that window has the focus too (only then can input in the page be the user's).
    async 'tabs.isShown'({ tabId }, { client }) {
      requireOwner(client, tabId);
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) return { shown: false, focused: false };
      const window = await chrome.windows.get(tab.windowId);
      // App and popup windows (installed web apps, Helium's app windows) are seen too; DevTools windows never.
      const shown = ['normal', 'app', 'popup'].includes(window.type) && window.state !== 'minimized';
      return { shown, focused: shown && !!window.focused };
    },

    // The client saw the user's own input in the tab at `at` (ms since epoch, from the page): see usersTurn.
    async 'tabs.userInput'({ tabId, at }, { client }) {
      requireOwner(client, tabId);
      const time = Math.min(Number(at) || Date.now(), Date.now());
      userInputAt.set(tabId, Math.max(userInputAt.get(tabId) ?? -Infinity, time));
      // A tab Chrome opened for that input before this report came (a key press opens at once) went to the agent: it is
      // the user's after all. Judged against the latest input, so a report that comes after a newer one gives nothing
      // back that the agent opened in between.
      if (usersTurn(tabId)) {
        const latest = userInputAt.get(tabId);
        for (const [childId, child] of adoptedFrom) {
          const owner = owners.get(childId);
          if (child.from === tabId && child.at > latest && owner?.client === client && !owner.releasing) giveBack(childId, owner);
        }
      }
      return { ok: true };
    },

    async 'tabs.setMuted'({ tabId, muted }, { client }) {
      const owner = requireOwner(client, tabId);
      if (owner.agentMuted) { // the agent's own choice now; release leaves it as set
        delete owner.agentMuted;
        await persist();
      }
      return chrome.tabs.update(tabId, { muted });
    },

    async 'chrome.debugger.attach'([target, version = '1.3'], { client }) {
      const { tabId } = target;
      const owner = requireOwner(client, tabId);
      const refused = () => new Error(`Tab ${tabId} is parked (the user has it); claim it to resume`);
      // A parked tab attaches only during a resume (tabs.claim resume), and that attach is what ends its parking.
      if (owner.parked && !owner.parked.resuming) throw refused();
      try {
        try {
          await chrome.debugger.attach({ tabId }, version);
        } catch (error) {
          if (!/already attached/i.test(error.message)) throw error;
        }
        // Background tabs stop painting and running rAF without focus emulation.
        await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      } catch (error) {
        if (owner.parked?.resuming) await serialize(tabId, () => rollBack(tabId, owner)).catch(() => {});
        throw error;
      }
      if (owner.parked && !owner.parked.resuming) { // called off meanwhile (tabs.park)
        await chrome.debugger.detach({ tabId }).catch(() => {});
        throw refused();
      }
      // Released, or its client left, meanwhile: cleanUp's detach may have come first. Detached after the cleanup, unless
      // the tab has a new owner by then.
      if (owners.get(tabId) !== owner || owner.releasing) {
        await serialize(tabId, async () => { if ((owners.get(tabId) ?? owner) === owner) await chrome.debugger.detach({ tabId }).catch(() => {}); });
        throw new Error(`Tab ${tabId} is no longer controlled by this client`);
      }
      if (owner.parked) resumed(owner);
      delete owner.detached;
      await persist();
    },

    async 'chrome.debugger.detach'([target], { client }) {
      requireOwner(client, target.tabId);
      await chrome.debugger.detach({ tabId: target.tabId });
    },

    async 'chrome.debugger.sendCommand'([target, method, params], { client }) {
      requireOwner(client, target.tabId);
      const children = childTargets.get(target.tabId);
      if (isBlockedCommand(method)
        || (CHILD_ONLY_CDP.test(method) && (params?.flatten !== true || !children?.has(params?.targetId)))) {
        throw new Error(`${method} is blocked: it reaches beyond the tab (other tabs, the browser, the whole profile or the user's focus)`);
      }
      if (method === 'Page.navigate' && isLocalFile(params?.url)) {
        throw new Error(`${method} to ${params.url} is blocked: local files and view-source: pages can't be opened`);
      }
      if (String(method).startsWith('Input.')) agentInputAt.set(target.tabId, Date.now()); // the agent's input (usersTurn)
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(new Error(`${method} timed out after 30 s`)), COMMAND_TIMEOUT_MS);
      });
      try {
        return await Promise.race([chrome.debugger.sendCommand(target, method, params), timeout]);
      } finally {
        timers.clearTimeout(timer);
      }
    },

    // Downloads with the browser's own session (the user's cookies), into their normal Downloads folder, for a tab the
    // client owns. Returns the download as downloads.list describes it.
    async 'downloads.start'({ tabId, url }, { client, live }) {
      requireOwner(client, tabId);
      url = String(url ?? '');
      const gen = generation;
      startsInFlight++; // attribution waits until this id is known, so no signal takes its item meanwhile
      let id;
      try {
        id = await chrome.downloads.download({ url, saveAs: false, conflictAction: 'uniquify' });
      } finally {
        if (gen === generation) startsInFlight--; // a closed port's starts never hold up the next one's
      }
      strayDownloads.delete(id);
      if (!live()) throw new Error('Client disconnected');
      downloads.set(id, { client, tabId });
      return (await describeDownloads([id]))[0] ?? { id, tabId, state: 'in_progress', url };
    },

    // For the next `ms`, a download no tab's CDP event claims (a tab that closed at once, a popup not attached yet)
    // goes to this client if its referrer is this tab's page. The MCP server sets it around a click that should
    // download.
    async 'downloads.expect'({ tabId, ms }, { client }) {
      requireOwner(client, tabId);
      const from = Date.now();
      const until = from + Math.min(Math.max(Number(ms) || 0, 0), DOWNLOAD_EXPECT_MAX_MS);
      downloadExpectations.set(tabId, { client, from, until });
      return { ok: true };
    },

    // Only this client's downloads, newest last.
    async 'downloads.list'(_params, { client }) {
      const ids = [...downloads].filter(([, record]) => record.client === client).map(([id]) => id);
      return describeDownloads(ids);
    },

    // The user's browsing data, read only. Results are compact and capped at 200.
    async 'browserData.query'({ kind, query = '', maxResults = 25, sinceHours = 168 }) {
      const max = Math.min(Math.max(Math.floor(Number(maxResults)) || 25, 1), BROWSING_DATA_MAX);
      const needle = String(query ?? '').toLowerCase();
      const matches = (...fields) => !needle || fields.some((field) => String(field ?? '').toLowerCase().includes(needle));
      switch (kind) {
        case 'history': {
          const startTime = Date.now() - Math.max(Number(sinceHours) || 0, 0) * 3_600_000;
          const items = await chrome.history.search({ text: String(query ?? ''), startTime, maxResults: max });
          return items.map((h) => ({ title: h.title ?? '', url: h.url, lastVisit: h.lastVisitTime ?? null, visitCount: h.visitCount ?? 0 }));
        }
        case 'bookmarks': {
          const found = [];
          const walk = (node, folders) => {
            if (node.url) {
              if (matches(node.title, node.url)) found.push({ title: node.title ?? '', url: node.url, dateAdded: node.dateAdded ?? null, folder: folders.join(' / ') });
              return;
            }
            const inside = node.title ? [...folders, node.title] : folders; // the root has no title
            for (const child of node.children ?? []) walk(child, inside);
          };
          for (const root of await chrome.bookmarks.getTree()) walk(root, []);
          return found.sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0)).slice(0, max);
        }
        case 'recently_closed': {
          const found = [];
          for (const session of await chrome.sessions.getRecentlyClosed({})) {
            const inWindow = !!session.window;
            for (const tab of session.tab ? [session.tab] : session.window?.tabs ?? []) {
              if (matches(tab.title, tab.url)) found.push({ title: tab.title ?? '', url: tab.url ?? '', closed: session.lastModified * 1000, inWindow });
            }
          }
          return found.slice(0, max);
        }
        case 'top_sites':
          return (await chrome.topSites.get()).filter((site) => matches(site.title, site.url)).slice(0, max)
            .map((site) => ({ title: site.title ?? '', url: site.url }));
        default:
          throw new Error(`Unknown kind "${kind}": use history, bookmarks, recently_closed or top_sites`);
      }
    },

    async 'extension.reload'(_params, { msg, reply }) {
      return reload(msg, reply, { ok: true });
    },

    // Checks and reloads in one step: refuses while any client owns a tab or is opening or claiming one; once it
    // says yes, every new request is refused until the worker restarts.
    async 'extension.reloadIfIdle'(_params, { msg, reply }) {
      if (owners.size || inFlight) return { reloaded: false, ownedTabs: owners.size, inFlight };
      return reload(msg, reply, { reloaded: true });
    },

    // A monitor's exact view of focus: every tab activation and creation, window creation and window focus change,
    // as `tabs.activity` events to this client until it disconnects. Polling tabs.listAll misses short flashes.
    async 'tabs.watchActivity'(_params, { client }) {
      activityWatchers.add(client);
      return { ok: true };
    },

    async 'extension.info'() {
      const ownedTabs = {};
      for (const { client } of owners.values()) ownedTabs[client] = (ownedTabs[client] ?? 0) + 1;
      return { version: chrome.runtime.getManifest().version, instanceId: await instanceId(), ownedTabs };
    },
  };

  function reload(msg, reply, result) {
    reloading = true;
    reply({ id: msg.id, result });
    timers.setTimeout(() => chrome.runtime.reload(), 50); // let the reply leave first
    return NO_REPLY;
  }

  async function handleRequest(msg, gen) {
    const { client } = msg;
    const live = () => gen === generation && liveClients.has(client);
    const reply = (message) => { if (gen === generation) send(message); };
    const ctx = { client, msg, live, reply, emit: (method, params) => { if (live()) emit(client, method, params); } };
    const handler = handlers[msg.method];
    try {
      // `client` is only ever set by the host, for a client it announced with host.clientConnected.
      if (!live()) throw new Error('Unknown client');
      if (!handler) throw new Error(`Unknown method: ${msg.method}`);
      if (reloading) throw new Error('The extension is reloading');
      const started = Date.now();
      const result = await handler(msg.params ?? {}, ctx);
      if (Date.now() - started > 2000) log('slow request', msg.method, `${Date.now() - started} ms`);
      if (result !== NO_REPLY) reply({ id: msg.id, result: result ?? null });
    } catch (error) {
      reply({ id: msg.id, error: { message: String(error?.message ?? error) } });
    }
  }

  async function handleMessage(msg) {
    const gen = generation;
    await ready;
    if (gen !== generation) return; // sent on a port that has since closed
    switch (msg.method) {
      case 'host.chunk': {
        // Parts arrive in order on the one native pipe.
        const { id, index, total, data } = msg.params;
        const text = (chunks.get(id) ?? '') + data;
        if (index + 1 < total) return void chunks.set(id, text);
        chunks.delete(id);
        // A chunked message is always a client request; it never carries another host.* message.
        const inner = JSON.parse(text);
        if (inner.id !== undefined && !String(inner.method).startsWith('host.')) return handleRequest(inner, gen);
        return;
      }
      case 'host.clientConnected':
        liveClients.add(msg.params.client);
        return;
      case 'host.clientDisconnected':
        return disconnectClient(msg.params.client);
      default:
        if (msg.id !== undefined) return handleRequest(msg, gen);
    }
  }

  // A tab as tabs.listAll and tabs.info describe it to `client`.
  function tabEntry(t, windowType, groupTitle, client) {
    const owner = owners.get(t.id);
    return {
      id: t.id,
      windowId: t.windowId,
      windowType,
      index: t.index,
      url: t.url || t.pendingUrl || '',
      title: t.title ?? '',
      active: t.active,
      pinned: t.pinned,
      audible: !!t.audible,
      muted: !!t.mutedInfo?.muted,
      groupTitle: groupTitle ?? null,
      owner: owner ? (owner.client === client ? 'you' : 'other') : null,
      origin: owner?.origin ?? null,
      handedOver: !!owner?.handedOver,
      kept: !!owner?.kept,
      parked: owner?.parked?.kind ?? null,
    };
  }

  async function onDebuggerEvent(source, method, params) {
    await ready;
    const owner = owners.get(source.tabId);
    if (!owner) return;
    // The tab's own child targets: the only ones Target.attachToTarget/sendMessageToTarget may reach.
    if (method === 'Target.attachedToTarget') {
      if (!childTargets.has(source.tabId)) childTargets.set(source.tabId, new Set());
      childTargets.get(source.tabId).add(params.targetInfo?.targetId).add(params.sessionId);
    } else if (method === 'Target.detachedFromTarget') {
      childTargets.get(source.tabId)?.delete(params.targetId);
      childTargets.get(source.tabId)?.delete(params.sessionId);
    } else if (method === 'Page.downloadWillBegin' && !owner.releasing) {
      // A tabs.openChild child's first navigation is its opener's (the agent acted on the opener), and the tab closes
      // as Chrome closes a new tab whose first navigation turned into a download.
      const opener = openedFor.get(source.tabId);
      downloadSignal(owner.client, opener ?? source.tabId, params?.url, params?.guid);
      if (opener !== undefined) {
        openedFor.delete(source.tabId);
        closeAgentTab(source.tabId, owner).catch(() => {});
      }
    } else if (method === 'Page.windowOpen' && adopter(source.tabId)) {
      armPopup(source.tabId, params?.url ?? '');
    }
    emitToOwner(owner, 'chrome.debugger.onEvent', [source, method, params]);
  }

  // --- Downloads ---
  // chrome.downloads says nothing about tabs. The tab's own debugger session does: Chrome and Helium emit
  // Page.downloadWillBegin {url} on the tab that starts a download (no Page.setDownloadBehavior needed). Every
  // download and every such signal is kept for 10 s, and attribution waits until none has arrived for 800 ms
  // (and no downloads.start is still waiting for its id). A download then belongs to a signal's client only
  // when the pairing is unambiguous among everything unclaimed in the window: exactly one signal names the
  // download's url or finalUrl, and that signal names exactly one download. Downloads the extension starts itself
  // (downloads.start) are recorded directly. A download no signal names goes to a downloads.expect window
  // (a tab that closed at once, a popup not attached yet) only if the expecting tab is the one tab in the whole
  // browser showing the download's referrer. Anything else, including any ambiguity, is the user's and nobody sees it.

  function pruneDownloadWaits() {
    const old = Date.now() - DOWNLOAD_MATCH_MS;
    while (downloadSignals.length && downloadSignals[0].at < old) downloadSignals.shift();
    for (const [id, stray] of strayDownloads) if (stray.at < old || downloads.has(id)) strayDownloads.delete(id);
  }

  function scheduleSettle() {
    timers.clearTimeout(settleTimer);
    const gen = generation;
    settleTimer = timers.setTimeout(() => {
      settleTimer = null;
      if (gen === generation) return settleDownloads(gen);
    }, DOWNLOAD_SETTLE_MS);
  }

  function downloadSignal(client, tabId, url, guid) {
    if (!liveClients.has(client)) return;
    pruneDownloadWaits();
    downloadSignals.push({ client, tabId, url, guid, at: Date.now() });
    scheduleSettle();
  }

  async function onDownloadCreated(item) {
    const gen = generation;
    await ready;
    if (gen !== generation || downloads.has(item.id)) return; // seen by a port that has since closed; or started by downloads.start
    pruneDownloadWaits();
    strayDownloads.set(item.id, { url: item.url, finalUrl: item.finalUrl, referrer: item.referrer, at: Date.now() });
    scheduleSettle();
  }

  const names = (signal, stray) => !!signal.url && (signal.url === stray.url || signal.url === stray.finalUrl);
  // A tab's signal and its own download arrive within moments of each other; an older same-url download (the user's,
  // another agent's) is no candidate.
  const near = (signal, stray) => names(signal, stray) && Math.abs(stray.at - signal.at) <= DOWNLOAD_PAIR_MS;

  async function settleDownloads(gen) {
    if (startsInFlight) return scheduleSettle();
    pruneDownloadWaits();
    const signals = downloadSignals.filter((s) => !s.claimed);
    const strays = [...strayDownloads];
    const pairs = [];
    for (const signal of signals) {
      const matches = strays.filter(([, stray]) => near(signal, stray));
      if (matches.length === 1 && signals.filter((s) => near(s, matches[0][1])).length === 1) pairs.push([matches[0][0], signal]);
    }
    for (const [id, signal] of pairs) {
      signal.claimed = true;
      strayDownloads.delete(id);
      await attributeDownload(id, signal.client, signal.tabId, gen);
    }
    for (const [id, stray] of strays) {
      if (strayDownloads.get(id) !== stray || stray.tried || !stray.referrer) continue;
      if (downloadSignals.some((s) => names(s, stray))) continue;
      stray.tried = true; // judged once, so a window opened later never takes an older download
      await expectedDownload(id, stray, gen);
    }
  }

  async function attributeDownload(id, client, tabId, gen) {
    if (gen !== generation || downloads.has(id) || !liveClients.has(client)) return;
    downloads.set(id, { client, tabId });
    log('download', id, 'from tab', tabId, 'for client', client);
    const [item] = await describeDownloads([id]);
    if (item && gen === generation && downloads.get(id)?.client === client) emit(client, 'downloads.changed', [item]);
  }

  const withoutHash = (url) => String(url ?? '').split('#')[0];

  async function expectedDownload(id, stray, gen) {
    const page = withoutHash(stray.referrer);
    const showing = (await chrome.tabs.query({}).catch(() => [])).filter((tab) => withoutHash(tab.url) === page);
    if (showing.length !== 1 || gen !== generation || strayDownloads.get(id) !== stray) return;
    const tabId = showing[0].id;
    const expected = downloadExpectations.get(tabId);
    const owner = owners.get(tabId);
    // Only a download that began while the window was open (after the click was announced) qualifies.
    if (!expected || expected.until < Date.now() || stray.at < expected.from || owner?.client !== expected.client || owner.releasing) return;
    strayDownloads.delete(id);
    await attributeDownload(id, expected.client, tabId, gen);
  }

  async function onDownloadChanged(delta) {
    await ready;
    const record = downloads.get(delta.id);
    if (!record) return;
    const [item] = await describeDownloads([delta.id]);
    if (item && downloads.get(delta.id) === record) emit(record.client, 'downloads.changed', [item]);
  }

  // Compact download records; ids erased from Chrome's list are left out.
  async function describeDownloads(ids) {
    const items = await Promise.all(ids.map((id) => chrome.downloads.search({ id }).then(([item]) => item, () => null)));
    return items.filter(Boolean).map((d) => ({
      id: d.id, tabId: downloads.get(d.id)?.tabId ?? null, url: d.url, finalUrl: d.finalUrl, filename: d.filename,
      state: d.state, error: d.error ?? null, danger: d.danger, mime: d.mime, bytesReceived: d.bytesReceived,
      totalBytes: d.totalBytes, fileSize: d.fileSize, startTime: d.startTime, endTime: d.endTime ?? null, exists: d.exists,
    }));
  }

  // Detached for any reason but the tab closing (the user pressed Cancel, it went to a page the debugger may not stay
  // on, its renderer died): the tab stays owned but marked detached, and is never re-attached until the owner claims
  // it again. target_closed also comes while the tab still exists (a chrome:// page, a crash).
  async function onDebuggerDetach(source, reason) {
    await ready;
    childTargets.delete(source.tabId);
    const owner = owners.get(source.tabId);
    log('debugger detached', { source, reason, owned: !!owner });
    if (!owner) return;
    if (reason !== 'target_closed' || await chrome.tabs.get(source.tabId).then(() => true, () => false)) {
      owner.detached = true;
      await persist();
    }
    emitToOwner(owner, 'chrome.debugger.onDetach', [source, reason]);
  }

  // A tabs.openChild child's first page other than about:blank: its downloads are its own from now on (openedFor).
  async function onNavigationCommitted({ tabId, frameId, url }) {
    await ready;
    if (frameId === 0 && url !== 'about:blank') openedFor.delete(tabId);
  }

  async function onTabRemoved(tabId, removeInfo) {
    await ready;
    childTargets.delete(tabId);
    expectations.delete(tabId);
    windowOf.delete(tabId);
    folded.delete(tabId);
    openedFor.delete(tabId);
    const [userAt, agentAt] = [userInputAt.get(tabId), agentInputAt.get(tabId)];
    forgetInput(tabId);
    adoptedFrom.delete(tabId);
    const owner = owners.get(tabId);
    if (!owner) return;
    owners.delete(tabId);
    lastOwned.set(tabId, { owner, windowId: removeInfo?.windowId, at: Date.now(), gen: generation, userAt, agentAt });
    await persist();
    emitToOwner(owner, 'chrome.tabs.onRemoved', [tabId, removeInfo]);
  }

  // Chrome swapped an owned tab for another one (prerender, back/forward cache): ownership moves with it, and so
  // does a cleanup still due for it (the one queued for the old id finds the record gone and does nothing).
  async function onTabReplaced(addedTabId, removedTabId) {
    await ready;
    folded.delete(removedTabId);
    forgetInput(removedTabId);
    if (adoptedFrom.has(removedTabId)) {
      adoptedFrom.set(addedTabId, adoptedFrom.get(removedTabId));
      adoptedFrom.delete(removedTabId);
      timers.setTimeout(() => adoptedFrom.delete(addedTabId), EXPECT_CHILD_MAX_MS);
    }
    const owner = owners.get(removedTabId);
    if (!owner) return;
    owners.delete(removedTabId);
    owners.set(addedTabId, owner);
    await persist();
    if (owner.releasing) return serialize(addedTabId, () => cleanUp(addedTabId, owner));
    const tab = await chrome.tabs.get(addedTabId);
    // replacedBy: nobody closed it (the owner must not take it for the user closing the tab).
    emitToOwner(owner, 'chrome.tabs.onRemoved', [removedTabId, { windowId: tab.windowId, isWindowClosing: false, replacedBy: addedTabId }]);
    if (!owner.parked) emitToOwner(owner, 'chrome.tabs.onCreated', [tab]); // a parked one attaches only when resumed
  }

  // --- Popups that Chrome opens as the active tab ---
  // A window.open the page script let through (it needs its opener) or one it never saw (no script in that frame) opens
  // as the active tab of the opener's window. Blink reports it (Page.windowOpen) before it asks the browser for the
  // window, so the window is armed first; the new tab is then switched back in the tabs.onCreated listener itself,
  // before anything is awaited, to keep the flash to a frame or two. settleChild's re-activation is the fallback.
  // Only a new tab in the armed window, showing the asked URL (or nothing yet), once: never the user's own tab switch
  // or their Cmd+T (chrome://newtab).
  function armPopup(tabId, url) {
    const arm = (windowId) => armedWindows.set(windowId, { source: tabId, url, at: Date.now(), until: Date.now() + POPUP_ARM_MS });
    if (windowOf.has(tabId)) return arm(windowOf.get(tabId));
    chrome.tabs.get(tabId).then((tab) => { windowOf.set(tabId, tab.windowId); arm(tab.windowId); }, () => {});
  }

  function switchBackFromPopup(tab) {
    const arm = armedWindows.get(tab.windowId);
    if (!arm || !tab.active || Date.now() > arm.until || usersTurn(arm.source)) return; // the user's input came in meanwhile
    const url = tab.pendingUrl || tab.url || '';
    if (url && url !== 'about:blank' && url !== arm.url) return;
    const record = activeByWindow.get(tab.windowId);
    const previous = record?.current === tab.id ? record.previous : record?.current;
    if (previous === undefined || previous === tab.id) return;
    armedWindows.delete(tab.windowId);
    chrome.tabs.update(previous, { active: true }).catch(() => {});
    log('popup: switched back', { tab: tab.id, previous, source: arm.source, armedMs: Date.now() - arm.at });
  }

  async function onTabActivated({ tabId, windowId }) {
    activity('activated', { tabId, windowId, active: true });
    await ready;
    const record = activeByWindow.get(windowId);
    if (record?.current !== tabId) activeByWindow.set(windowId, { current: tabId, previous: record?.current });
  }

  // A tab opened by an owned tab (window.open, target=_blank) joins the opener's client in the background.
  // Only webNavigation's navigation-target event decides whose it is: Helium reports the window's active tab as
  // openerTabId, which can be the user's or another session's, so openerTabId is never used.
  async function onTabCreated(tab) {
    if (tab?.active) {
      openedActive.add(tab.id);
      timers.setTimeout(() => openedActive.delete(tab.id), EXPECT_CHILD_MAX_MS);
    }
    activity('created', { tabId: tab?.id, windowId: tab?.windowId, active: !!tab?.active });
    switchBackFromPopup(tab);
  }

  async function onNavigationTarget({ sourceTabId, tabId }) {
    await ready;
    if (owners.has(tabId)) return;
    if (usersTurn(sourceTabId)) return leaveAgentGroup(tabId, sourceTabId); // the user's own: theirs, see passesOn
    return adoptChild(tabId, sourceTabId);
  }

  // Agent tabs pass their children on. A tab opened from a claimed tab is the user's own (Cmd-click, their new tab)
  // and is never moved, muted, grouped or closed, unless the owner asked for it with tabs.expectChild and
  // webNavigation names the claimed tab as the source.
  function adopter(openerTabId) {
    const opener = owners.get(openerTabId);
    return passesOn(opener, openerTabId) ? opener : null;
  }

  function passesOn(opener, openerTabId) {
    // A parked tab is the user's for now: what opens from it is theirs, even inside an expectChild window. So is what
    // the user's own input opens during their turn (their click on a link or a button), in any tab.
    if (!opener || opener.releasing || opener.parked || usersTurn(openerTabId)) return false;
    // A tab already handed to the user (for_user, tab_keep) is theirs like a claimed one: its children are theirs too.
    if (opener.origin === 'agent' && !opener.handedOver) return true;
    const expected = expectations.get(openerTabId);
    return expected?.client === opener.client && Date.now() <= expected.until;
  }

  // The user's turn of an owned tab: the latest input in it was theirs (tabs.userInput, later than every Input.* its
  // client sent), within a page's transient activation. A tab opened from it then is theirs, as Chrome would have it.
  function usersTurn(tabId) {
    return turnOf(userInputAt.get(tabId), agentInputAt.get(tabId));
  }

  function turnOf(userAt, agentAt) {
    return userAt !== undefined && Date.now() - userAt <= EXPECT_CHILD_MAX_MS && userAt > (agentAt ?? -Infinity);
  }

  // A child adopted before the user's input that opened it was heard of: handed to them as tabs.release leaves a tab,
  // and back in front if Chrome had opened it there. The client hears it is gone.
  function giveBack(tabId, owner) {
    owner.releasing = true;
    owner.kept = true;
    owner.givenBack = true;
    log('popup: the user\'s after all', { tab: tabId });
    return serialize(tabId, async () => {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const { from, wasActive } = adoptedFrom.get(tabId) ?? {};
      adoptedFrom.delete(tabId);
      await cleanUp(tabId, owner);
      emit(owner.client, 'chrome.tabs.onRemoved', [tabId, { windowId: tab?.windowId ?? -1, isWindowClosing: false, usersPopup: true }]);
      // Only while the user is still on the tab it was switched back to: never away from a tab they picked since.
      if (tab && wasActive && activeByWindow.get(tab.windowId)?.current === from) await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }).catch((e) => log('give back failed', tabId, e.message));
  }

  function forgetInput(tabId) {
    userInputAt.delete(tabId);
    agentInputAt.delete(tabId);
  }

  // A popup the user's own click asked for (tabs.openChild during their turn): opened as Chrome opens it for them, in
  // front, right after its opener, and nobody's (not grouped, muted or closed with the session).
  async function openForUser(tabId, url, closedWindowId) {
    const source = closedWindowId === undefined ? await chrome.tabs.get(tabId) : null;
    const tab = await chrome.tabs.create(source ? { windowId: source.windowId, index: source.index + 1, url, active: true, openerTabId: tabId }
      : { windowId: closedWindowId, url, active: true });
    await leaveAgentGroup(tab.id, tabId);
    log('popup: opened for the user', { tab: tab.id, opener: tabId });
    return { tabId: tab.id, user: true };
  }

  // A tab of the user's opened from an agent tab joins that tab's group (Chrome groups a tab opened from a grouped tab,
  // before webNavigation names it): it goes out again, since nothing of the user's may keep an agent's group alive. A
  // claimed or handed-over tab's group is the user's own and stays.
  async function leaveAgentGroup(tabId, openerTabId) {
    const opener = owners.get(openerTabId);
    if (opener?.origin !== 'agent' || opener.handedOver) return;
    const [tab, source] = await Promise.all([tabId, openerTabId].map((id) => chrome.tabs.get(id).catch(() => null)));
    if (tab && source && tab.groupId !== -1 && tab.groupId === source.groupId) await chrome.tabs.ungroup(tabId).catch(() => {});
  }

  // A closed owned tab's record and window, for 5 s, while its client is still served on the same port.
  function closedOwner(tabId) {
    const last = lastOwned.get(tabId);
    if (!last) return;
    if (Date.now() - last.at <= LAST_OWNED_MS && last.gen === generation && liveClients.has(last.owner.client)) return last;
    lastOwned.delete(tabId);
  }

  function adoptChild(tabId, openerTabId) {
    const opener = adopter(openerTabId);
    if (!opener || owners.has(tabId) || closing.has(tabId)) return;
    return reserveChild(tabId, opener, openerTabId);
  }

  // Reserves the child for the opener's client synchronously (so a disconnect meanwhile cleans it up), then
  // backgrounds, mutes and groups it and tells the client, in the tab's queue.
  function reserveChild(tabId, opener, openerTabId) {
    const { client } = opener;
    // A child of the user's claimed or handed-over tab may be their own Cmd-click inside the expectChild window, and a child
    // of a kept tab is kept too: handed back to them when the session ends, never closed.
    const owner = { client, origin: 'agent', group: opener.group ?? labelFor(client),
      kept: opener.origin === 'user' || !!opener.kept || !!opener.handedOver };
    owners.set(tabId, owner);
    adoptedFrom.set(tabId, { from: openerTabId, at: Date.now(), wasActive: false });
    timers.setTimeout(() => adoptedFrom.delete(tabId), EXPECT_CHILD_MAX_MS);
    log('adopt: owned', { tab: tabId, opener: openerTabId, client, kept: owner.kept });
    return serialize(tabId, () => settleChild(tabId, owner, openerTabId)).catch((e) => log('adopt failed', tabId, e.message));
  }

  // Every step but the first is best effort, so the client always hears about a tab it owns.
  async function settleChild(tabId, owner, openerTabId) {
    await persist();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const wasActive = openedActive.delete(tabId) || !!tab?.active;
    if (adoptedFrom.has(tabId)) adoptedFrom.get(tabId).wasActive = wasActive;
    if (!tab) {
      if (owners.get(tabId) === owner) owners.delete(tabId);
      return persist();
    }
    if (tab.active) {
      const record = activeByWindow.get(tab.windowId);
      const previous = record?.current === tabId ? record.previous : record?.current;
      if (previous !== undefined && previous !== tabId) await chrome.tabs.update(previous, { active: true }).catch(() => {});
    }
    const openerTab = await chrome.tabs.get(openerTabId).catch(() => null);
    await chrome.tabs.update(tabId, { muted: openerTab ? !!openerTab.mutedInfo?.muted : true, autoDiscardable: false }).catch(() => {});
    await addToGroup(owner.client, owner.group, tabId, tab.windowId).catch((e) => log('adopt: group failed', e.message)); // popup windows can't hold groups
    const adopted = await chrome.tabs.get(tabId).catch(() => null);
    if (!adopted || owners.get(tabId) !== owner) return; // closed or cleaned up meanwhile
    // Chrome unfolds a folded group when an active tab joins it: a group the user had folded right before the action
    // goes back. Children that never were active (opened in the background) leave the group alone.
    const before = folded.get(openerTabId);
    if (wasActive && before?.folded && before.groupId === adopted.groupId) {
      folded.delete(openerTabId);
      await chrome.tabGroups.update(adopted.groupId, { collapsed: true }).catch(() => {});
    }
    // openerTabId is the source webNavigation named (Helium's own value can point at another tab).
    emitToOwner(owner, 'chrome.tabs.onCreated', [{ ...adopted, openerTabId }]);
    log('adopt: handed to client', tabId, owner.client);
  }

  // tabs.activity for watchers: `at` is taken when the event arrives, the window type looked up after (in a chain, so
  // events leave in the order they came).
  let activitySent = Promise.resolve();
  function activity(kind, fields) {
    if (!activityWatchers.size) return;
    const at = Date.now();
    const typed = fields.windowType !== undefined || !(fields.windowId >= 0) ? Promise.resolve(fields.windowType ?? null)
      : chrome.windows.get(fields.windowId).then((w) => w.type, () => null);
    activitySent = activitySent.then(() => typed).then((windowType) => {
      for (const client of activityWatchers) {
        if (liveClients.has(client)) emit(client, 'tabs.activity', { kind, ...fields, windowType, at });
        else activityWatchers.delete(client);
      }
    });
  }

  function onWindowCreated(window) {
    activity('windowCreated', { tabId: null, windowId: window.id, active: !!window.focused, windowType: window.type });
  }

  // windowId is chrome.windows.WINDOW_ID_NONE (-1) when the browser itself lost focus.
  function onWindowFocusChanged(windowId) {
    activity('windowFocus', { tabId: null, windowId, active: windowId >= 0 });
  }

  function onWindowRemoved(windowId) {
    activeByWindow.delete(windowId);
    armedWindows.delete(windowId);
  }

  // The host and every client it served are gone; whatever is still in flight belongs to the old port.
  async function portClosed() {
    generation++;
    liveClients.clear();
    downloadSignals.length = 0;
    strayDownloads.clear();
    downloadExpectations.clear();
    lastOwned.clear();
    startsInFlight = 0;
    timers.clearTimeout(settleTimer);
    settleTimer = null;
    await ready;
    await disconnectAll();
  }

  return {
    ready,
    instanceId,
    handleMessage,
    portClosed,
    onDebuggerEvent,
    onDebuggerDetach,
    onTabCreated,
    onNavigationTarget,
    onNavigationCommitted,
    onTabRemoved,
    onTabReplaced,
    onTabActivated,
    onWindowCreated,
    onWindowFocusChanged,
    onWindowRemoved,
    onDownloadCreated,
    onDownloadChanged,
    // for tests
    owners,
    userInputAt,
    agentInputAt,
  };
}
