// FowlBrowser extension core: tab ownership, command handling and event routing.
// Everything browser-facing goes through the injected `chrome`, so tests can run it in Node.

const NO_REPLY = Symbol('no reply');
const DEFAULT_LABEL = 'Claude';
const COMMAND_TIMEOUT_MS = 30_000;
const LISTED_WINDOW_TYPES = ['normal', 'popup', 'app'];
// CDP policy, an allowlist: a client drives its own tab and that tab's child targets (iframes, workers), never the
// browser, other tabs, the user's focus, the file system or the whole profile's cookies and storage. Anything not
// listed is refused, also domains Chrome adds later. Derived from what FowlBrowser sends (Playwright 1.64's chromium
// page, frame and worker sessions in crPage, crNetworkManager, crExecutionContext, crInput, crDragDrop, crPdf, crCoverage
// and crServiceWorker; mcp/src's own calls; Lighthouse 13.5's gather/), minus what the relay answers itself (Browser.*,
// browser-level Target.*, Page.bringToFront) and what reaches beyond the tab: Browser.*, Page.setDownloadBehavior,
// Security.*, Storage.* cookie and data methods, Network.clearBrowserCache and cookie methods, Extensions.*, PWA.*.
// A domain set to true is wholly the tab's own; otherwise only the methods named.
const ALLOWED_CDP = {
  Accessibility: true, Audits: true, CSS: true, Debugger: true, DOM: true, DOMDebugger: true, Emulation: true,
  Fetch: true, Input: true, Inspector: true, Log: true, Performance: true, Profiler: true, Runtime: true,
  HeapProfiler: ['collectGarbage'],
  IO: ['read', 'close'],
  // loadNetworkResource only for http(s) (isHttpUrl): export's Google Docs download, Playwright's response bodies.
  Network: ['enable', 'disable', 'getResponseBody', 'setCacheDisabled', 'setExtraHTTPHeaders', 'emulateNetworkConditions',
    'setBypassServiceWorker', 'setBlockedURLs', 'setUserAgentOverride', 'loadNetworkResource'],
  // navigate and navigateToHistoryEntry only to web pages (isWebUrl).
  Page: ['enable', 'disable', 'navigate', 'navigateToHistoryEntry', 'reload', 'getNavigationHistory', 'getFrameTree',
    'getLayoutMetrics', 'captureScreenshot', 'printToPDF', 'startScreencast', 'stopScreencast', 'screencastFrameAck',
    'createIsolatedWorld', 'addScriptToEvaluateOnNewDocument', 'removeScriptToEvaluateOnNewDocument',
    'setLifecycleEventsEnabled', 'handleJavaScriptDialog', 'setInterceptFileChooserDialog', 'setBypassCSP',
    'setFontFamilies', 'close'],
  Storage: ['getUsageAndQuota'], // Lighthouse's quota read
  // attachToTarget only flattened and only for the tab's own children (CHILD_ONLY_CDP). No sendMessageToTarget: a
  // non-flat session would carry commands past this filter.
  Target: ['setAutoAttach', 'getTargetInfo', 'detachFromTarget', 'attachToTarget'],
  Tracing: ['start', 'end', 'recordClockSyncMarker'],
  WebMCP: ['enable', 'disable'], // Lighthouse's agentic-browsing category
};
const CHILD_ONLY_CDP = /^Target\.attachToTarget$/;
const isBlockedCommand = (method) => {
  const [domain, name, ...rest] = String(method).split('.');
  const allowed = Object.hasOwn(ALLOWED_CDP, domain) ? ALLOWED_CDP[domain] : false;
  return rest.length > 0 || !name || !(allowed === true || (Array.isArray(allowed) && allowed.includes(name)));
};
// Commands that wait on the page (a promise it settles, a navigation's response) take as long as their caller allows
// (evaluate's timeout_ms, a navigation's timeout; Playwright reads any error of an evaluation as "Execution context was
// destroyed", so a cut here reads as a navigation that never happened): only the host's 120 s limit is theirs.
const waitsOnPage = (method, params) => method === 'Page.navigate' || (/^Runtime\.(evaluate|callFunctionOn)$/.test(method) && params?.awaitPromise === true);
const EXPECT_CHILD_MAX_MS = 5000;     // also how long the user's turn of a tab lasts (a page's transient activation)
const LAST_OWNED_MS = 5000; // how long a closed owned tab can still open the popup it asked for (tabs.openChild)
const CLEANUP_RETRY_MS = [200, 1000];
const SWAP_RETRY_MS = 50; // a page between documents is asked again this often (onActivePage),
const SWAP_TRIES = 40; // this many times (2 s)
const DOWNLOAD_MATCH_MS = 10_000;      // how long downloads and Page.downloadWillBegin signals are kept for matching
const DOWNLOAD_SETTLE_MS = 800;        // quiet time after the latest of them before any is attributed
const DOWNLOAD_PAIR_MS = 2000;         // a download and its tab's signal arrive this close together, or they don't pair
const DOWNLOAD_EXPECT_MAX_MS = 300_000;
const BROWSING_DATA_MAX = 200;
const POPUP_ARM_MS = 1500;             // after a Page.windowOpen, how long a new active tab in that window is switched back
const GIVEN_NAMED = 'given:named'; // the lock of named groups made for the user (groupForUser, reuseGiven), every client's
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

export function colorFor(label) {
  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
}

export function isNewTabPage(url) {
  return /^(chrome|edge):\/\/(newtab|new-tab-page)\b/.test(url) || url.startsWith('chrome-search://');
}

// Where an agent tab may go: web pages, a blank page, data: URLs and allowed local files (isLocalFile), never this
// extension's own pages (Chrome lets an extension debug those, with all of its powers), browser or DevTools pages.
// Parsed as Chrome does, so "fi\tle:" is a local file too. new URL, not URL.parse: Chrome 125 lacks that.
function parsed(url) {
  try { return new URL(String(url ?? '')); } catch { return null; }
}
// A local file agents may open: the MCP server's rule (hidden files and folders, ~/Library but iCloud Drive and the cloud
// drives, system folders and folder listings refused), applied to the URL's path alone, as defense in depth: this
// extension can't resolve symlinks, so the server, which can, is the real guard. Compared in lower case like the Mac's disk.
const SYSTEM_DIRS = ['/etc/', '/private/etc/', '/system/', '/private/var/db/', '/library/keychains/', '/private/var/log/'];
export function isLocalFile(url) {
  const u = parsed(url);
  if (u?.protocol !== 'file:' || u.host) return false;
  let path;
  try { path = decodeURIComponent(u.pathname).toLowerCase(); } catch { return false; }
  const library = /^\/users\/[^/]+\/library\/(.*)$/.exec(path);
  return !path.endsWith('/') && !path.split('/').some((part) => part.startsWith('.'))
    && !(library && !/^(mobile documents|cloudstorage)\//.test(library[1])) && !SYSTEM_DIRS.some((d) => path.startsWith(d));
}
const isFileUrl = (url) => parsed(url)?.protocol === 'file:';
const isRefusedFile = (url) => isFileUrl(url) && !isLocalFile(url);
function isWebUrl(url) {
  const { protocol, pathname } = parsed(url) ?? {};
  return ['http:', 'https:', 'data:'].includes(protocol) || (protocol === 'about:' && pathname === 'blank') || isLocalFile(url);
}
const isHttpUrl = (url) => ['http:', 'https:'].includes(parsed(url)?.protocol);
// A URL as Chrome shows it, query included, without its fragment (a redo's match: reuseGiven).
const redoUrl = (url) => {
  const page = parsed(url);
  if (page) page.hash = '';
  return page?.href ?? null;
};
const webOnly = (url) => `${url} can't be opened: agents only open web pages (http and https) and local files outside hidden folders, ~/Library and system folders`;

export function isRestricted(url) {
  if (url === 'about:blank' || isLocalFile(url)) return false;
  return /^(chrome|chrome-extension|devtools|edge|about|file|view-source):/.test(url)
    || url.startsWith('https://chromewebstore.google.com')
    || url.startsWith('https://chrome.google.com/webstore');
}

// A page shown in a tab (or a child frame) that no agent may drive: isRestricted, also behind blob: or filesystem:
// (an extension's own blob: page has its origin). An about:blank with a query or fragment is still blank.
function offTheWeb(url) {
  const inner = String(url ?? '').replace(/^(blob|filesystem):/, '');
  return isRestricted(inner) && !/^about:blank[?#]/.test(inner);
}

// No cookie value leaves the extension, HttpOnly ones included (a page's own script can't read those; any process
// holding the host token could): forwarded events, and loadNetworkResource's headers, keep each cookie's name, so
// Playwright and the network tool still see it was there, with HIDDEN for its value. Neither needs the values.
const HIDDEN = 'hidden';
const hidePair = (pair) => {
  const at = pair.indexOf('=');
  return at < 0 ? pair.replace(/\S[\s\S]*/, HIDDEN) : `${pair.slice(0, at + 1)}${HIDDEN}`;
};
const hideCookie = (value) => String(value).split(';').map(hidePair).join(';'); // "a=1; b=2"
const hideSetCookie = (value) => String(value).split('\n') // "a=1; Path=/; HttpOnly", one per line
  .map((line) => { const [first, ...attributes] = line.split(';'); return [hidePair(first), ...attributes].join(';'); }).join('\n');
const COOKIE_HEADERS = new Map([['cookie', hideCookie], ['set-cookie', hideSetCookie]]);
const hideHeaders = (headers) => {
  if (Array.isArray(headers)) return headers.map((h) => (COOKIE_HEADERS.has(String(h?.name).toLowerCase()) ? { ...h, value: COOKIE_HEADERS.get(String(h.name).toLowerCase())(h.value) } : h));
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, COOKIE_HEADERS.get(name.toLowerCase())?.(value) ?? value]));
};
const hideHeadersText = (text) => String(text).replace(/^(cookie|set-cookie)(\s*:)(.*)$/gim, (_, name, colon, value) => `${name}${colon}${COOKIE_HEADERS.get(name.toLowerCase())(value)}`);
// A copy of `object` with each of `fields` present passed through its function.
function hide(object, fields) {
  if (!object || typeof object !== 'object') return object;
  const copy = { ...object };
  for (const [key, fn] of Object.entries(fields)) if (copy[key] !== undefined) copy[key] = fn(copy[key]);
  return copy;
}
const each = (fn) => (list) => (Array.isArray(list) ? list.map(fn) : list);
const request = (r) => hide(r, { headers: hideHeaders });
const response = (r) => hide(r, { headers: hideHeaders, requestHeaders: hideHeaders, headersText: hideHeadersText, requestHeadersText: hideHeadersText });
const cookie = (c) => hide(c, { value: () => HIDDEN });
const setCookie = (b) => hide(b, { cookie, cookieLine: hideSetCookie });
// Every event of the protocol (browser_protocol.json) with a header, cookie or raw cookie line in it, of the domains
// clients may enable.
const COOKIE_FIELDS = new Map([
  ['Network.requestWillBeSent', { request, redirectResponse: response }],
  ['Network.requestWillBeSentExtraInfo', { headers: hideHeaders, associatedCookies: each((a) => hide(a, { cookie })) }],
  ['Network.responseReceived', { response }],
  ['Network.responseReceivedExtraInfo', { headers: hideHeaders, headersText: hideHeadersText, blockedCookies: each(setCookie), exemptedCookies: each(setCookie) }],
  ['Network.responseReceivedEarlyHints', { headers: hideHeaders }],
  ['Network.webSocketWillSendHandshakeRequest', { request }],
  ['Network.webSocketHandshakeResponseReceived', { response }],
  ['Network.signedExchangeReceived', { info: (i) => hide(i, { outerResponse: response, header: (h) => hide(h, { responseHeaders: hideHeaders }) }) }],
  ['Fetch.requestPaused', { request, responseHeaders: hideHeaders }],
  ['Fetch.authRequired', { request }],
  ['Audits.issueAdded', { issue: (i) => hide(i, { details: (d) => hide(d, { cookieIssueDetails: (c) => hide(c, { rawCookieLine: hideCookie }) }) }) }],
  ['Network.loadNetworkResource', { resource: (r) => hide(r, { headers: hideHeaders }) }], // a command's result
]);
const withoutCookies = (method, params) => (COOKIE_FIELDS.has(method) ? hide(params, COOKIE_FIELDS.get(method)) : params);

export function createCore({ chrome, send, timers = globalThis }) {
  // tabId -> { client, origin: 'agent'|'user', group, kept, releasing?, detached? }. `releasing` holds
  // the tab until its cleanup (detach/close) finishes; `detached` means the debugger was taken away (DevTools,
  // cancel).
  const owners = new Map();
  const labels = new Map();         // client -> label from client.hello
  const groups = new Map();         // `${client}|${label}|${windowId}` -> promise of the tab group id
  const givenGroups = new Map();    // tab group id -> title: groups made for the user (groupForUser), until removed or renamed
  // tabId -> the group made for the user that this extension put it in (groupForUser, reuseGiven): only these come back on
  // a redo, never a tab the user moved into the group themselves
  const givenTabs = new Map();
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
  // tabs whose main frame went to a page no agent may drive (offTheWeb), till a web one -> false once committed there, or
  // the URL of the navigation still on its way there (onBeforeNavigate), which an error for it calls off
  const offWeb = new Map();
  const offWebSessions = new Map(); // tabId -> its child sessions (frames) showing such a page
  const blankedByUs = new Set();    // tabs showing an about:blank this extension asked for, until their first attach
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
    const stored = await chrome.storage.session.get(['owners', 'labels', 'givenGroups', 'givenTabs']);
    for (const [tabId, owner] of Object.entries(stored.owners ?? {})) owners.set(Number(tabId), owner);
    for (const [client, label] of Object.entries(stored.labels ?? {})) labels.set(Number(client), label);
    for (const [groupId, title] of Object.entries(stored.givenGroups ?? {})) givenGroups.set(Number(groupId), title);
    for (const [tabId, groupId] of Object.entries(stored.givenTabs ?? {})) givenTabs.set(Number(tabId), groupId);
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
      givenGroups: Object.fromEntries(givenGroups),
      givenTabs: Object.fromEntries(givenTabs),
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

  // Errors agents read (the MCP server puts the browser before the id): what happened, and what to do.
  function requireOwner(client, tabId) {
    const owner = owners.get(tabId);
    if (owner && owner.client !== client) throw ownedByOther(tabId);
    if (!owner) throw new Error(`Tab ${tabId} is not controlled by this session (released or closed since, or never opened or claimed by it)`);
    if (owner.releasing) throw new Error(`Tab ${tabId} is being released`);
    return owner;
  }

  // This extension's own origin, also behind blob: or filesystem:.
  const isOwnPage = (url) => {
    const page = parsed(String(url ?? '').replace(/^(blob|filesystem):/i, ''));
    return page?.protocol === 'chrome-extension:' && page.hostname === chrome.runtime.id;
  };
  const notOnTheWeb = (tabId) => new Error(`Tab ${tabId} shows a browser, extension or local page, which agents can't control`);

  const ownedByOther = (tabId) => new Error(`Tab ${tabId} is controlled by another agent session: leave it alone (to work on the same page, open its URL in a tab of your own)`);

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

  // Chrome lets an extension open and debug file: pages only with "Allow access to file URLs" on for it.
  async function requireFileAccess(url) {
    if (isFileUrl(url) && !(await chrome.extension.isAllowedFileSchemeAccess())) {
      throw new Error(`${url} can't be opened: FowlBrowser has no access to local files. Ask the user to turn on "Allow access to file URLs" in FowlBrowser's Details on the extensions page`);
    }
  }

  // A command to a tab whose page is between documents, as a new tab's first cross-site page commits, fails with "Not
  // attached to an active page" while Chrome swaps the page the debugger is on (seen on Helium: an OAuth popup attached
  // just then failed its attach, and the agent could never drive it). The debugger stays attached: asked again shortly.
  async function onActivePage(tabId, method, params) {
    for (let tries = 1; ; tries++) {
      try {
        return await chrome.debugger.sendCommand({ tabId }, method, params);
      } catch (error) {
        if (tries >= SWAP_TRIES || !/Not attached to an active page/.test(String(error?.message))) throw error;
      }
      await new Promise((resolve) => timers.setTimeout(resolve, SWAP_RETRY_MS));
    }
  }

  // Counts tab creations and claims under way, so extension.reloadIfIdle can see them.
  async function tracked(fn) {
    inFlight++;
    try { return await fn(); } finally { inFlight--; }
  }

  // Anything failing after the tab exists closes it again: the client never has an open tab it wasn't told about.
  // A tab `forUser` is the user's from the start (handed over: out of the client's group, discardable, kept), though the
  // client still drives it until it disconnects. It stays muted while driven (focus emulation lets background pages
  // autoplay) and is unmuted when control ends, unless the agent set its mute itself or the user changed it meanwhile.
  // Several given to the user at once share a group of their own (groupForUser); a named one (`group`) gets that group at
  // once, and with `matchUrl` may be an earlier tab of it reloaded instead (reuseGiven).
  async function openTab({ client, live }, { url = 'about:blank', group, muted = true, forUser = false, matchUrl } = {}) {
    if (!isWebUrl(url)) throw new Error(webOnly(url));
    await requireFileAccess(url);
    const label = group || labelFor(client);
    const windowId = await pickWindow();
    if (forUser && group && matchUrl !== undefined && windowId !== undefined) {
      const reused = await reuseGiven({ client, live }, label, matchUrl, windowId);
      if (reused) return reused;
    }
    const tab = windowId === undefined
      ? (await chrome.windows.create({ focused: false, url })).tabs[0]
      : await chrome.tabs.create({ windowId, url, active: false });
    if (!live()) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw new Error('Client disconnected');
    }
    const owner = { client, origin: 'agent', group: label, kept: !!forUser, handedOver: !!forUser, agentMuted: !!forUser, ...(forUser && group && { named: true }) };
    owners.set(tab.id, owner);
    if (parsed(url)?.protocol === 'about:') blankedByUs.add(tab.id);
    try {
      // In the tab's queue, like a child's adoption: a disconnect's cleanup comes after it and finds the group to leave.
      return await serialize(tab.id, async () => {
        await persist();
        if (forUser) {
          await chrome.tabs.update(tab.id, { muted: true });
          await groupForUser(client, tab.id);
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
    blankedByUs.add(tabId);
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
    await removeTab(tabId);
  }

  // A browser whose last window closes keeps running but unloads the profile, and this extension and its host with it,
  // until the user opens a window again: agents lose the browser. So a tab this extension closes never takes the last
  // window with it: a New Tab page stays in its place (in the background, as the window's only tab it shows once the
  // closed one is gone). Decided one tab at a time, counting the tabs closing meanwhile (a turn end closes them at once,
  // also an agent tab and its popup's window).
  const leaving = new Set();
  let lastWindowCheck = Promise.resolve();
  async function removeTab(tabId) {
    const decided = lastWindowCheck.then(async () => {
      leaving.add(tabId);
      const { windowId } = await chrome.tabs.get(tabId);
      // A DevTools window keeps nothing: it closes with the tab it inspects (an undocked one of this very tab too).
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal', 'popup', 'app'] });
      const stays = (w) => (w.tabs ?? []).some((t) => !leaving.has(t.id));
      if (!windows.some(stays)) await chrome.tabs.create({ windowId, active: false });
    });
    lastWindowCheck = decided.catch(() => {});
    try {
      await decided;
      await showUsersPrevious(tabId);
      await chrome.tabs.remove(tabId);
    } finally {
      leaving.delete(tabId);
    }
  }

  // Closing the tab the user has in front: the browser would show the tab next to it, which may be another agent's work
  // tab. The tab they had in front before comes back instead, when it is theirs (or one given to them) and still in
  // that window; otherwise the browser picks as usual. Best effort.
  async function showUsersPrevious(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.active) return;
    const previous = activeByWindow.get(tab.windowId)?.previous;
    const theirs = () => {
      const owner = owners.get(previous);
      return previous !== undefined && previous !== tabId && !leaving.has(previous) && !(owner?.origin === 'agent' && !owner.handedOver);
    };
    if (!theirs()) return;
    const before = await chrome.tabs.get(previous).catch(() => null);
    // Asked again: the user may have picked another tab meanwhile (it stays), or an agent's session taken that one.
    if (before?.windowId === tab.windowId && activeByWindow.get(tab.windowId)?.current === tabId && theirs()) {
      await chrome.tabs.update(previous, { active: true }).catch(() => {});
    }
  }

  // Tabs a client gives the user while it controls them (forUser, tabs.keep; so each turn of an agent starts afresh)
  // share a tab group once there are two or more, say one per prototype; a lone one stays ungrouped like the user's own
  // tabs. Titled like the client's group (the tab_open group, else its label). The group is the user's: it stays when
  // the client lets the tabs go. Only tabs in the same window join, never one the user moved out of the group or into
  // another. One client at a time, so tabs opened at once make one group. Best effort: the tab is the user's either way.
  // A tab with a named group (tabs.open forUser with `group`) is grouped at once, even alone, into the newest group made
  // for the user with that title in its window (any client's, so a later turn or session adds to it), else a new one.
  async function groupForUser(client, tabId) {
    const named = !!owners.get(tabId)?.named;
    await serialize(named ? GIVEN_NAMED : `given:${client}`, async () => {
      const owner = owners.get(tabId);
      // Still this client's tab given to the user, under the same title: asked again right before grouping, since a
      // release, claim, park or disconnect can come while tabs are looked up.
      const given = (id, record) => owners.get(id) === record && record.client === client && record.origin === 'agent'
        && record.handedOver && !record.parked && !record.releasing && record.group === owner.group && !record.named === !named;
      // chrome.tabs.group takes a tab's Split View partner along (the user's own tab, maybe) and unpins a pinned tab, so
      // a split or pinned tab never joins.
      const split = (t) => (t.splitViewId ?? -1) !== -1 || !!t.pinned;
      if (!owner || !given(tabId, owner) || owner.givenGroup !== undefined) return; // grouped once already: the user's call since
      const { windowId } = await chrome.tabs.get(tabId);
      const titled = named ? await givenGroupsTitled(owner.group) : [];
      // One read of the window, then nothing awaited until the group call: the user may group, split or move tabs meanwhile.
      const inWindow = new Map((await chrome.tabs.query({ windowId })).map((t) => [t.id, t]));
      const tab = inWindow.get(tabId);
      if (!tab || tab.groupId !== -1 || split(tab) || !given(tabId, owner)) return;
      const peers = named ? [] : [...owners].filter(([id, other]) => id !== tabId && inWindow.has(id) && given(id, other)).map(([id, other]) => {
        const t = inWindow.get(id);
        return (other.givenGroup === undefined ? t.groupId === -1 && !split(t) : t.groupId === other.givenGroup) ? t : null;
      }).filter(Boolean);
      if (!named && !peers.length) return;
      const existing = named ? titled.find((id) => [...inWindow.values()].some((t) => t.groupId === id))
        : peers.find((t) => t.groupId !== -1)?.groupId;
      const tabIds = [tabId, ...peers.filter((t) => t.groupId === -1).map((t) => t.id)];
      const members = tabIds.map((id) => owners.get(id));
      const groupId = existing === undefined
        ? await chrome.tabs.group({ tabIds, createProperties: { windowId } })
        : await chrome.tabs.group({ groupId: existing, tabIds });
      for (const member of members) member.givenGroup = groupId;
      for (const id of tabIds) givenTabs.set(id, groupId);
      if (existing === undefined) givenGroups.set(groupId, owner.group);
      await persist();
      if (existing === undefined) {
        await chrome.tabGroups.update(groupId, { title: owner.group, color: colorFor(owner.group), collapsed: false })
          .catch((e) => log('group for user: title failed', groupId, e.message));
      }
    }).catch((e) => log('group for user failed', tabId, e.message));
  }

  // Groups made for the user still titled `title` (a rename since makes one the user's: onTabGroupUpdated), newest first.
  async function givenGroupsTitled(title) {
    const ids = [...givenGroups].filter(([, t]) => t === title).map(([id]) => id).reverse();
    const live = await Promise.all(ids.map((id) => chrome.tabGroups.get(id).catch(() => null)));
    return ids.filter((id, i) => live[i]?.title === title);
  }

  // A redo (tabs.open forUser with a named group and matchUrl): a tab in the newest group made for the user with that
  // title in the window, showing that URL (hash aside), is taken instead of a new one, unless another client has it. It
  // becomes this client's like a new forUser tab (kept, handed over, muted while driven unless muted already), stays
  // where it is (never activated or moved), and the client reloads it. Decided under the named groups' lock with nothing
  // awaited between the window read and taking it, so of clients racing for one tab, one gets it and the others open a
  // new tab. Null when there is none.
  async function reuseGiven({ client, live }, title, matchUrl, windowId) {
    const want = redoUrl(matchUrl);
    if (!want || !isWebUrl(matchUrl)) return null;
    const found = await serialize(GIVEN_NAMED, async () => {
      const titled = await givenGroupsTitled(title);
      const inWindow = await chrome.tabs.query({ windowId });
      const groupId = titled.find((id) => inWindow.some((t) => t.groupId === id));
      if (groupId === undefined) return null;
      const yours = (record) => record.client === client && record.origin === 'agent' && record.handedOver && !record.parked && !record.releasing;
      const tab = inWindow.find((t) => t.groupId === groupId && !t.incognito && !closing.has(t.id)
        && redoUrl(t.pendingUrl || t.url) === want && (owners.has(t.id) ? yours(owners.get(t.id)) : givenTabs.get(t.id) === groupId));
      if (!tab || !live()) return null;
      if (owners.has(tab.id)) return { tab, yours: true }; // this client's already (this turn, a subagent)
      const muted = !!tab.mutedInfo?.muted; // the user's own mute: theirs, never ended by us
      const owner = { client, origin: 'agent', group: title, named: true, kept: true, handedOver: true, givenGroup: groupId, ...(!muted && { agentMuted: true }) };
      owners.set(tab.id, owner);
      return { tab, owner, muted };
    });
    if (!found) return null;
    const { tab, owner } = found;
    if (found.yours) return { ...(await chrome.tabs.get(tab.id)), reused: true, yours: true };
    try {
      return await serialize(tab.id, async () => {
        await persist();
        if (!found.muted) await chrome.tabs.update(tab.id, { muted: true });
        return { ...(await chrome.tabs.get(tab.id)), reused: true };
      });
    } catch (error) {
      owner.releasing = true;
      await serialize(tab.id, () => cleanUp(tab.id, owner));
      throw error;
    }
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
    const grouped = owner.origin === 'agent' && !owner.handedOver && tab.groupId !== -1; // a claimed or handed-over tab's group is the user's own
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
      if (!tab.yours) ctx.emit('chrome.tabs.onCreated', [tab]);
      // In a named group made for the user: its other tabs this client doesn't control (a redo's leftovers to tidy up).
      if (!params.forUser || !params.group || !givenGroups.has(tab.groupId)) return tab;
      const groupTabs = (await chrome.tabs.query({ groupId: tab.groupId }))
        .filter((t) => t.id !== tab.id && owners.get(t.id)?.client !== ctx.client)
        .map((t) => ({ id: t.id, title: t.title, url: t.pendingUrl || t.url }));
      return { ...tab, groupTabs };
    },

    async 'chrome.tabs.create'([createProperties = {}], ctx) {
      return tracked(() => openTab(ctx, { url: createProperties.url }));
    },

    // A parked tab is the user's for now: it closes only with usersTab (they asked for it: tab_close confirm_close_users_tab).
    async 'chrome.tabs.remove'([tabIds, { usersTab = false } = {}], { client }) {
      const ids = [tabIds].flat();
      for (const id of ids) {
        // A tab that is gone (an agent tab closed at the end of an earlier turn, the user closed it): say so.
        if (!owners.has(id) && !(await chrome.tabs.get(id).then(() => true, () => false))) throw new Error(`Tab ${id} is closed already`);
        requireOwner(client, id);
      }
      await Promise.all(ids.map((id) => serialize(id, async () => {
        const owner = requireOwner(client, id);
        if (owner.parked && !usersTab) throw new Error(`Tab ${id} is the user's for now (parked), so it was not closed`);
        if (owner.origin === 'agent') await closeAgentTab(id, owner);
        else await removeTab(id);
      })));
    },

    async 'tabs.claim'({ tabId, resume = false }, { client, live, emit: emitBack }) {
      if (owners.get(tabId)?.releasing) throw new Error(`Tab ${tabId} is being released`); // refuse, don't queue
      return tracked(() => serialize(tabId, async () => {
        const owner = owners.get(tabId);
        if (owner?.releasing) throw new Error(`Tab ${tabId} is being released`);
        if (owner && owner.client !== client) throw ownedByOther(tabId);
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
        await requireFileAccess(url);
        if (owners.has(tabId)) throw ownedByOther(tabId);
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
      if (owner?.client !== client) requireOwner(client, tabId); // throws: another session's, or nobody's
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
        blankedByUs.add(tab.id);
        await reserveChild(tab.id, owner, tabId);
        return { tabId: tab.id };
      });
    },

    // Hands an agent tab to the user now (out of the client's group, discardable; groupForUser); the client drives it
    // until it disconnects. Muted by us, it stays muted till then like a forUser tab (focus emulation lets a driven
    // background page autoplay).
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
          await groupForUser(client, tabId);
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
        if (owner) throw new Error(owner.client === client ? `Tab ${tabId} is controlled by this client; close it with chrome.tabs.remove` : ownedByOther(tabId).message);
        closing.add(tabId); // a popup adoption racing this close must not hand the tab to anyone
        try {
          if ((await chrome.tabs.get(tabId)).incognito) throw new Error(`Tab ${tabId} is in an incognito window`);
          if (owners.has(tabId)) throw ownedByOther(tabId);
          await removeTab(tabId);
        } finally {
          closing.delete(tabId);
        }
        return { ok: true };
      });
    },

    // Any tab but an incognito one: focusing hands the caller nothing (the MCP server's tab_focus takes only the session's
    // own tabs; the rounds harness brings an agent's tab to the front as the user would).
    async 'tabs.focus'({ tabId }) {
      const owner = owners.get(tabId);
      if ((await chrome.tabs.get(tabId)).incognito) throw new Error(`Tab ${tabId} is in an incognito window, which is left alone`);
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
        // Also by the tab's URL now: offWeb is lost when the service worker restarts.
        if (offWeb.has(tabId) || offTheWeb((await chrome.tabs.get(tabId)).url)) throw notOnTheWeb(tabId);
        try {
          await chrome.debugger.attach({ tabId }, version);
        } catch (error) {
          if (!/already attached/i.test(error.message)) throw error;
        }
        // It left the web while attaching: leftTheWeb's detach may have come first.
        if (offWeb.has(tabId)) {
          await chrome.debugger.detach({ tabId }).catch(() => {});
          throw notOnTheWeb(tabId);
        }
        // A tab with this extension's own page in its history: a script added for new documents, then history.back(),
        // would run there with the extension's powers before any commit is seen (leftTheWeb). Checked at every attach
        // (tab_open, claim, resume), which is enough: an agent tab never gains such an entry later (Page.navigate and
        // navigateToHistoryEntry go to web pages only, and Chrome keeps web pages from this extension's pages).
        const history = await onActivePage(tabId, 'Page.getNavigationHistory').catch(async (error) => {
          await chrome.debugger.detach({ tabId }).catch(() => {});
          throw error;
        });
        if ((history?.entries ?? []).some((entry) => isOwnPage(entry.url))) {
          await chrome.debugger.detach({ tabId }).catch(() => {});
          throw new Error(`Tab ${tabId} has a FowlBrowser page in its history, which agents can't control: open its URL in a new tab instead`);
        }
        // A blank page this extension asked for (tabs.open, tabs.openChild, a claimed New Tab page) is a document Chrome made
        // with this extension as its initiator, in the extension's process. Before any client command it is replaced by a
        // blank page the browser itself navigates to (Page.navigate has no initiator): nothing a client runs or adds for new
        // documents ever runs in a document that comes from this extension, whatever Chrome would let that document do.
        if (blankedByUs.has(tabId) && history?.entries?.[history.currentIndex]?.url === 'about:blank') {
          await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: 'about:blank' }).catch(async (error) => {
            await chrome.debugger.detach({ tabId }).catch(() => {});
            throw error;
          });
        }
        blankedByUs.delete(tabId);
        // Background tabs stop painting and running rAF without focus emulation.
        await onActivePage(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true });
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
      if (offWeb.has(target.tabId) || offWebSessions.get(target.tabId)?.has(target.sessionId)) throw notOnTheWeb(target.tabId);
      if (method === 'Page.navigate' && !isWebUrl(params?.url)) throw new Error(`${method} is blocked: ${webOnly(params?.url)}`);
      if (method === 'Page.navigate') await requireFileAccess(params.url);
      if (method === 'Network.loadNetworkResource' && !isHttpUrl(params?.url)) throw new Error(`${method} is blocked: only http and https URLs load`);
      if (method === 'Page.navigateToHistoryEntry') {
        // By id, so the entry looked up is the one Chrome goes to.
        const { entries = [] } = await chrome.debugger.sendCommand(target, 'Page.getNavigationHistory') ?? {};
        const entry = entries.find((e) => e.id === params?.entryId);
        if (entry && !isWebUrl(entry.url)) throw new Error(`${method} is blocked: ${webOnly(entry.url)}`);
        if (entry) await requireFileAccess(entry.url);
      }
      if (String(method).startsWith('Input.')) agentInputAt.set(target.tabId, Date.now()); // the agent's input (usersTurn)
      if (waitsOnPage(method, params)) return chrome.debugger.sendCommand(target, method, params);
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(new Error(`${method} timed out after 30 s`)), COMMAND_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([chrome.debugger.sendCommand(target, method, params), timeout]);
        return method === 'Network.loadNetworkResource' ? withoutCookies(method, result) : result;
      } finally {
        timers.clearTimeout(timer);
      }
    },

    // Downloads with the browser's own session (the user's cookies), into their normal Downloads folder, for a tab the
    // client owns. Returns the download as downloads.list describes it.
    async 'downloads.start'({ tabId, url }, { client, live }) {
      requireOwner(client, tabId);
      url = String(url ?? '');
      // Only from the web: a file: URL would copy any local file into Downloads, a chrome-extension: one this extension's.
      if (!isHttpUrl(url)) throw new Error(`${url} can't be downloaded: only http and https URLs are`);
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
    // The tab's main frame (no parentId), or a child session's own frame (an out-of-process iframe, whose frame id is
    // its target id and which has a parentId), navigating: see leftTheWeb.
    if (method === 'Page.frameNavigated' && params?.frame) {
      const { id, parentId, url } = params.frame;
      if (!source.sessionId && !parentId && offTheWeb(url)) return leftTheWeb(source.tabId, false, url);
      // A frame of the page's own process (a file page's frames are) showing a local file agents may not open: an
      // allowed file can frame any other, and snapshots read frames.
      if (!source.sessionId && parentId && isRefusedFile(url)) return leftTheWeb(source.tabId, false, url);
      if (source.sessionId && (!parentId || childTargets.get(source.tabId)?.has(id))) offWebSession(source.tabId, source.sessionId, offTheWeb(url));
    }
    // The page asks to go to this extension's own page, in any frame of the tab (Page.frameRequestedNavigation: a script's
    // location change, a link, a form), before webNavigation hears of it: see onBeforeNavigate.
    if (method === 'Page.frameRequestedNavigation' && params?.disposition === 'currentTab' && isOwnPage(params.url)) {
      return leftTheWeb(source.tabId, params.url);
    }
    // Nothing of such a page reaches the client, from the tab or a child session.
    if (offWeb.has(source.tabId) || offWebSessions.get(source.tabId)?.has(source.sessionId)) return;
    // The tab's own child targets: the only ones Target.attachToTarget/sendMessageToTarget may reach. A child showing a
    // page no agent may drive is let go at once, its session refused meanwhile, and the client never hears of it.
    if (method === 'Target.attachedToTarget' && offTheWeb(params?.targetInfo?.url)) {
      offWebSession(source.tabId, params.sessionId, true);
      return chrome.debugger.sendCommand(source, 'Target.detachFromTarget', { sessionId: params.sessionId }).catch(() => {});
    }
    if (method === 'Target.attachedToTarget') {
      if (!childTargets.has(source.tabId)) childTargets.set(source.tabId, new Set());
      childTargets.get(source.tabId).add(params.targetInfo?.targetId).add(params.sessionId);
    } else if (method === 'Target.detachedFromTarget') {
      childTargets.get(source.tabId)?.delete(params.targetId);
      childTargets.get(source.tabId)?.delete(params.sessionId);
      offWebSession(source.tabId, params.sessionId, false);
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
    emitToOwner(owner, 'chrome.debugger.onEvent', [source, method, withoutCookies(method, params)]);
  }

  // The tab's main frame went to a page no agent may drive (offTheWeb: a page's own history.back() into an old entry, a
  // claimed tab's history), seen at its commit (Page.frameNavigated, webNavigation.onCommitted, whichever comes first):
  // the debugger lets go at once (Chrome lets this extension debug its own pages, with all its powers), and attach and
  // commands are refused until the tab commits a web page. The client hears a detach as for a browser page Chrome lets go of.
  // `pending`: the URL of a navigation that has not committed yet (onBeforeNavigate). `url`: the page (or frame) that
  // made the tab leave, told to the client with the detach, so a local file it may not open is named as such.
  async function leftTheWeb(tabId, pending = false, url = pending || null) {
    if (offWeb.has(tabId)) {
      if (!pending) offWeb.set(tabId, false);
      return;
    }
    offWeb.set(tabId, pending);
    const owner = owners.get(tabId);
    if (!owner) return;
    log('left the web', tabId);
    childTargets.delete(tabId);
    offWebSessions.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    if (owner.detached || owners.get(tabId) !== owner) return;
    owner.detached = true;
    await persist();
    emitToOwner(owner, 'chrome.debugger.onDetach', [{ tabId }, 'target_closed', { url }]);
  }

  // A navigation about to start, before the page it goes to has a document (webNavigation fires onBeforeNavigate as the
  // browser starts it, before any request, response or commit): the debugger lets go then, so nothing a client set up on
  // the session (new-document scripts, commands on their way) runs in this extension's pages. The main frame: any page
  // no agent may drive. A child frame: only this extension's own pages (no web page may frame them; other extensions'
  // frames and about:srcdoc ones are everyday, and the child-target checks cover them).
  async function onBeforeNavigate({ tabId, frameId, url }) {
    await ready;
    if (owners.has(tabId) && (frameId === 0 ? offTheWeb(url) : isOwnPage(url))) return leftTheWeb(tabId, url);
  }

  // That navigation never committed (blocked, cancelled, replaced): the tab is the agent's to drive again.
  async function onNavigationError({ tabId, url }) {
    await ready;
    if (offWeb.get(tabId) === url) offWeb.delete(tabId);
  }

  function offWebSession(tabId, sessionId, off) {
    if (off) {
      if (!offWebSessions.has(tabId)) offWebSessions.set(tabId, new Set());
      offWebSessions.get(tabId).add(sessionId);
    } else offWebSessions.get(tabId)?.delete(sessionId);
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
    offWebSessions.delete(source.tabId);
    const owner = owners.get(source.tabId);
    log('debugger detached', { source, reason, owned: !!owner });
    if (!owner) return;
    if (reason !== 'target_closed' || await chrome.tabs.get(source.tabId).then(() => true, () => false)) {
      owner.detached = true;
      await persist();
    }
    emitToOwner(owner, 'chrome.debugger.onDetach', [source, reason]);
  }

  // A tabs.openChild child's first page other than about:blank: its downloads are its own from now on (openedFor). A main
  // frame's commit also decides whether agents may drive the tab (leftTheWeb); only a commit ends that.
  // A child frame's commit of a local file agents may not open makes the tab leave as the main frame's would (an allowed
  // file can frame any other); only the main frame's commit of a web page ends that.
  async function onNavigationCommitted({ tabId, frameId, url }) {
    await ready;
    if (frameId !== 0) return isRefusedFile(url) && owners.has(tabId) ? leftTheWeb(tabId, false, url) : undefined;
    if (url !== 'about:blank') openedFor.delete(tabId);
    if (offTheWeb(url)) return leftTheWeb(tabId, false, url);
    offWeb.delete(tabId);
  }

  async function onTabRemoved(tabId, removeInfo) {
    await ready;
    childTargets.delete(tabId);
    offWeb.delete(tabId);
    offWebSessions.delete(tabId);
    blankedByUs.delete(tabId);
    expectations.delete(tabId);
    windowOf.delete(tabId);
    folded.delete(tabId);
    openedFor.delete(tabId);
    const [userAt, agentAt] = [userInputAt.get(tabId), agentInputAt.get(tabId)];
    forgetInput(tabId);
    adoptedFrom.delete(tabId);
    const given = givenTabs.delete(tabId);
    const owner = owners.get(tabId);
    if (!owner) {
      if (given) await persist();
      return;
    }
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
    offWeb.delete(removedTabId);
    offWebSessions.delete(removedTabId);
    blankedByUs.delete(removedTabId);
    forgetInput(removedTabId);
    if (adoptedFrom.has(removedTabId)) {
      adoptedFrom.set(addedTabId, adoptedFrom.get(removedTabId));
      adoptedFrom.delete(removedTabId);
      timers.setTimeout(() => adoptedFrom.delete(addedTabId), EXPECT_CHILD_MAX_MS);
    }
    // Moved with the owner before anything is awaited: a disconnect meanwhile must find the owner under its new id.
    const given = givenTabs.get(removedTabId);
    if (given !== undefined) {
      givenTabs.set(addedTabId, given);
      givenTabs.delete(removedTabId);
    }
    const owner = owners.get(removedTabId);
    if (!owner) {
      if (given !== undefined) await persist();
      return;
    }
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

  // A group made for the user is forgotten once Chrome removes it, or once the user renames it (it is theirs then: never
  // reused). A title-less update is no rename: Chrome reports the group as made, untitled, before its title is set.
  async function onTabGroupRemoved(group) {
    await ready;
    const forgot = givenGroups.delete(group.id);
    for (const [tabId, groupId] of givenTabs) if (groupId === group.id) givenTabs.delete(tabId);
    if (forgot) await persist();
  }

  async function onTabGroupUpdated(group) {
    await ready;
    if (group.title && givenGroups.has(group.id) && givenGroups.get(group.id) !== group.title) {
      givenGroups.delete(group.id);
      await persist();
    }
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
    onBeforeNavigate,
    onNavigationError,
    onTabRemoved,
    onTabReplaced,
    onTabActivated,
    onWindowCreated,
    onWindowFocusChanged,
    onWindowRemoved,
    onTabGroupRemoved,
    onTabGroupUpdated,
    onDownloadCreated,
    onDownloadChanged,
    // for tests
    owners,
    userInputAt,
    agentInputAt,
  };
}
