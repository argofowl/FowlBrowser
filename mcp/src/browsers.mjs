// Connected browsers: one host socket + one CDP relay + one lazy Playwright connection per browser.
import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cdp, isOwnBinding } from './cdp.mjs';
import { watchClosedShadow } from './closedShadow.mjs';
import { prepare as prepareCursor } from './cursor/index.mjs';
import { debug } from './debug.mjs';
import { HostClient, listSockets, SOCKET_DIR } from './hostClient.mjs';
import { installPopups } from './popups.mjs';
import { downloadDone, record } from './record.mjs';
import { currentCall, heldBack, notice, onTakeover, refuseParked, watchTakeovers, watchUserInput } from './takeover.mjs';
import { isBlockedUrl, localFileBlock, sleep, tabInfo, within } from './util.mjs';
import { CDPRelay } from './vendor/cdpRelay.mjs';
import { keepViewportSize } from './viewport.mjs';

export const LABEL = process.env.FOWLBROWSER_LABEL || 'Claude';
const AGENTS = { claude: 'Claude', codex: 'Codex' };

// Who this session is, for other sessions' tab_list and the browser's log, e.g. "Codex via FowlTweets in Project X (pid
// 70289)": the agent (FOWLBROWSER_LABEL, else the program that started this server), what started that agent (the nearest
// ancestor that isn't a shell, runtime or agent: its outermost app bundle, else its program), the project folder.
const PLUMBING = /^(node|bun|deno|npm|npx|python\d*(\.\d+)?|ruby|zsh|bash|sh|fish|dash|env|login|sudo|script|tmux|screen|claude|codex)$/i;
let session;
export function sessionName() {
  session ??= new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: 2000 }, (_error, stdout = '') => {
      const procs = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
      }
      const agent = procs.get(process.ppid);
      const agentName = path.basename(agent?.comm ?? '');
      const name = process.env.FOWLBROWSER_LABEL || AGENTS[agentName.toLowerCase()] || LABEL;
      let app = null;
      for (let pid = agent?.ppid, hops = 0; !app && pid > 1 && procs.has(pid) && hops < 20; pid = procs.get(pid).ppid, hops++) {
        const { comm } = procs.get(pid);
        const bundle = /^\/(?:[^/]+\/)*?([^/]+)\.app\//.exec(comm)?.[1]?.replace(/ Helper\b.*$/, '');
        const program = path.basename(comm);
        app = bundle ?? (comm.includes('.app/') || PLUMBING.test(program) ? null : program);
      }
      if (app?.toLowerCase() === agentName.toLowerCase()) app = null; // the agent's own app (Claude's desktop app)
      resolve(`${name}${app ? ` via ${app}` : ''} in ${path.basename(process.cwd())} (pid ${process.ppid})`);
    });
  });
  return session;
}

const RESCAN_MS = 5000;
const BUFFER_LIMIT = 1000;
const NAMES = { chrome: 'Chrome', helium: 'Helium', chromium: 'Chromium', brave: 'Brave', edge: 'Edge' };
const REVIVE_WAIT_MS = 5000; // a reopened browser's host is listening about a second later
const REVIVE_AGAIN_MS = 60_000; // a reopen that brought no host back (the extension is off) is not repeated sooner

// Browsers FowlBrowser can be installed in: the socket name its host takes (host.mjs browserNameFrom), its app and its
// folder in Application Support (host/install.sh).
const APPS = [
  ['chrome', 'Google Chrome', 'Google/Chrome'], ['chrome-beta', 'Google Chrome Beta', 'Google/Chrome Beta'],
  ['chrome-canary', 'Google Chrome Canary', 'Google/Chrome Canary'], ['chromium', 'Chromium', 'Chromium'],
  ['helium', 'Helium', 'net.imput.helium'], ['brave', 'Brave Browser', 'BraveSoftware/Brave-Browser'],
  ['edge', 'Microsoft Edge', 'Microsoft Edge'], ['arc', 'Arc', 'Arc/User Data'], ['vivaldi', 'Vivaldi', 'Vivaldi'],
].map(([key, app, dir]) => ({ key, app, dir }));
const baseKey = (key) => key.split(/-(?=\d+$)/)[0]; // "chrome-2" (a second profile) is Chrome's

// The Mac's view of those browsers. A browser whose last window closed keeps running but unloads the profile, and
// FowlBrowser's extension and host with it, until a window opens again.
const SUPPORT = path.join(os.homedir(), 'Library', 'Application Support');
export const macOS = {
  // FowlBrowser's native host is registered for it and has run under it (its log): install.sh registers the host in
  // every browser it finds, used with FowlBrowser or not.
  installed: ({ key, dir }) => fs.existsSync(path.join(SUPPORT, dir, 'NativeMessagingHosts', 'com.fowl.browser.json'))
    && fs.existsSync(path.join(SOCKET_DIR, 'logs', `${key}.log`)),
  // This user's processes' executable paths.
  processes: () => {
    try { return ownProcesses(execFileSync('ps', ['-axo', 'uid=,comm='], { encoding: 'utf8' })); } catch { return []; }
  },
  // What a click on its Dock icon sends, without bringing it to the front (-g): a browser with no window opens one.
  reopen: (bundle) => execFile('open', ['-g', bundle], () => {}),
};

// The executable paths of `ps -axo uid=,comm=` lines run by this user. ps lists every account's processes, and a
// "Google Chrome.app" another account runs (from /Users/Shared, say) must never be what reopen launches as this user.
export function ownProcesses(psOutput, uid = process.getuid()) {
  return psOutput.split('\n').map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((match) => match && Number(match[1]) === uid).map((match) => match[2]);
}

// The bundle of the app's running main process, or null (its helpers are .apps of other names inside it).
function runningBundle(app, processes) {
  const main = new RegExp(`^(.*/${app}\\.app)/Contents/MacOS/[^/]+$`);
  for (const executable of processes) {
    const bundle = main.exec(executable)?.[1];
    if (bundle) return bundle;
  }
  return null;
}

export const ACTION_TIMEOUT_MS = 10_000;
export const NAVIGATION_TIMEOUT_MS = 30_000;
// A page whose main thread never yields (a script stuck in a loop: a broken dev build) answers no read, so a call on it
// would wait for the host's 120 s and every later call on the tab behind it. Bounding each read would fail a merely busy
// page instead; liveness decides (Tab.run): a call with no answer after STUCK_AFTER_MS, and every STUCK_AFTER_MS after
// that, gets the page asked for '1'. An answer within PROBE_MS means it is alive (a long legitimate call: lighthouse, a
// trace, a long wait); none means it is stuck.
export const STUCK_AFTER_MS = 15_000;
const PROBE_MS = 3000;
const RECHECK_MS = 1000; // a call on a tab found stuck asks again this long before failing at once

function appVersion(browserPath) {
  const app = browserPath?.match(/^(.*?\.app)\//)?.[1];
  if (!app) return null;
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${app}/Contents/Info.plist`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function push(buffer, entry) {
  buffer.push(entry);
  if (buffer.length > BUFFER_LIMIT) buffer.splice(0, buffer.length - BUFFER_LIMIT);
}

// One controlled chrome tab and its Playwright page. Calls on the same tab run one at a time.
export class Tab extends EventEmitter {
  constructor(browser, tabId, page) {
    super();
    this.browser = browser;
    this.tabId = tabId;
    this.id = `${browser.key}:${tabId}`;
    this.page = page;
    this.dialog = null;
    this.console = [];
    this.network = [];
    this.documentGeneration = 0; // bumped when the main frame commits a new document (refs from older ones are void)
    this.frameGeneration = 0; // bumped when any iframe loads a new document (its refs from before are void; snapshots.mjs numberRefs)
    this.refusedLoad = null; // { page, why }: document `page` loaded a local file agents can't open (loaded())
    // A local document this Tab came to after it loaded (Browser._adopt): what it loaded before is unknown, so it is
    // treated as refusedLoad is, until a new document commits.
    this.unwatchedPage = null;
    // When it last showed, framed or loaded a page agents can't read (blocked()): reads compare it before and after.
    this.blockedPageAt = 0;
    this._queue = Promise.resolve();
    this._calls = 0; // run() calls not yet settled
    this._busy = null;
    this.stuckAt = null; // since when the page has not answered, once a call found its main thread stuck (run)
    // Set by other modules:
    this.refs = null; // ref numbering across snapshots (snapshots.mjs newRefState)
    this.snapshotBaseline = null; // the last whole-page snapshot, for changes-only results (tools.mjs snapshotText)
    this.snapshotCount = 0; // whole-page snapshots so far
    this.viewport = null; // the viewport tool's override (viewport.mjs)
    this.trace = null; // the recording and the last parsed trace (trace.mjs)
    this.memory = null; // the last memory reading (perf.mjs)
    // Requests of the current document that render the page (document, script, stylesheet, fetch, xhr) still in flight,
    // and when the last one started or ended: wait_for's settled wait reads them (tools.mjs pageSettled). A fetch or XHR
    // ends with its response (Chrome never reports an unread body as finished; streams and long polls never finish).
    this.inflight = new Set();
    this.requestAt = 0;
    this.ending = false; // this session is closing or releasing it: its page closing is ours (record mode)
    this.closedByPageAt = null; // when the page called window.close() (popups.mjs)
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    page.on('dialog', (dialog) => {
      this.dialog = dialog;
      this.emit('dialog', dialog);
    });
    // Answered by the user in the browser, or by the dialog tool: actions are no longer blocked.
    page.on('dialogclosed', (dialog) => { if (this.dialog === dialog) this.dialog = null; });
    // Nothing a page agents can't read (a refused local file, view-source:) logs or loads is kept, nor what a refused
    // local file in a frame logs, nor a request for one (an allowed page can load <script src=file:///.../.ssh/x>): it
    // could be read back after the tab leaves it. Checked as each entry comes in. Each entry names its page
    // (documentGeneration), so console and network show the current page's unless asked for older ones.
    // A document that loaded a refused file (refusedLoad) logs and loads nothing kept either: its script may be that file's.
    const local = () => isBlockedUrl(page.url()) || this.refusedLoad?.page === this.documentGeneration || this.unwatchedPage === this.documentGeneration;
    page.on('console', (message) => local() || isBlockedUrl(message.location()?.url) || push(this.console, {
      time: Date.now(), page: this.documentGeneration, level: message.type(), text: message.text(), url: message.location()?.url,
    }));
    page.on('pageerror', (error) => local() || push(this.console, { time: Date.now(), page: this.documentGeneration, level: 'error', text: `Uncaught ${error.message}` }));
    // A request belongs to the page that made it, even when its answer comes after the next one committed.
    const madeBy = new WeakMap(); // request -> documentGeneration when it started
    const pageOf = (request) => madeBy.get(request) ?? this.documentGeneration;
    page.on('response', (response) => {
      const request = response.request();
      if (local() || isBlockedUrl(request.url())) return;
      push(this.network, { time: Date.now(), page: pageOf(request), method: request.method(), url: request.url(), status: response.status(), type: request.resourceType(),
        main: request.frame() === page.mainFrame() });
    });
    page.on('requestfailed', (request) => local() || isBlockedUrl(request.url()) || push(this.network, {
      time: Date.now(), page: pageOf(request), method: request.method(), url: request.url(), status: 'failed', type: request.resourceType(), failure: request.failure()?.errorText,
    }));
    const RENDERING = new Set(['document', 'script', 'stylesheet', 'fetch', 'xhr']);
    const ended = (request) => { if (this.inflight.delete(request)) this.requestAt = Date.now(); };
    page.on('request', (request) => {
      madeBy.set(request, this.documentGeneration);
      // A page's own navigation to a refused file is its new document's (blocked by its URL once it commits).
      if (!(request.isNavigationRequest() && request.frame() === page.mainFrame())) this.loaded(request.url(), request.resourceType() === 'document');
      if (!RENDERING.has(request.resourceType())) return;
      this.inflight.add(request);
      this.requestAt = Date.now();
    });
    page.on('response', (response) => { if (/^(xhr|fetch)$/.test(response.request().resourceType())) ended(response.request()); });
    page.on('requestfinished', ended);
    page.on('requestfailed', ended);
  }

  // The next call starts once this one, and any work it left running (keepBusy), has finished. The check runs
  // right before each call starts, so work that resumes after its dialog is answered still holds the tab.
  // A tool call queued before the tab was parked (taken over, handed off) fails with the notice when its turn comes.
  // Neither a running nor a queued call makes input in the page the agent's (only the input the agent sends does, takeover.mjs).
  // A call on a page found stuck (stuckAt) asks it again first and fails at once if it still doesn't answer, unless it
  // is a way out (escape: navigate, closing, releasing, keeping, handing off, muting, turn end).
  run(fn, { escape = false } = {}) {
    this._calls++;
    const call = currentCall();
    const result = this._queue.then(() => this._watched(async (failed) => {
      await this._idle();
      // Failed as stuck while it waited (behind an action held by a dialog): it never starts once the page answers again.
      if (failed()) return undefined;
      refuseParked(this, call);
      // A new document meanwhile (stuckAt cleared) is not stuck, whatever the probe of the old one said.
      if (this.stuckAt && !escape && !(await this._answers(RECHECK_MS)) && this.stuckAt) throw this._stuckError();
      return fn();
    })).finally(() => { this._calls--; });
    this._queue = result.catch(() => {});
    return result;
  }

  // The call's own outcome, unless the page stops answering while it runs (STUCK_AFTER_MS): then it fails with the stuck
  // message, the tab's queue goes on (work left over from a dialog too), and the hung call is left to settle on its own
  // (the page answering at last, a navigation or the tab closing ends it), its outcome ignored. A call that ends first
  // stops the watch: one that answers costs nothing but a timer.
  _watched(start) {
    const began = Date.now();
    let timer, done = false, failed = false;
    const stuck = new Promise((_, reject) => {
      const check = async () => {
        if (await this._answers(PROBE_MS)) { if (!done) timer = setTimeout(check, STUCK_AFTER_MS); return; }
        if (done) return;
        this.stuckAt ??= began;
        this._busy = null;
        failed = true;
        reject(this._stuckError());
      };
      timer = setTimeout(check, STUCK_AFTER_MS);
    });
    return Promise.race([start(() => failed), stuck]).finally(() => { done = true; clearTimeout(timer); });
  }

  // Does the page's main thread answer within ms? Raw CDP to the tab's own session, not through Playwright. Any reply
  // counts, an error too (the tab closing, a document going away: the browser answered for it). A JS dialog holds every
  // evaluation until it is answered, but that waits on the user, not on a loop: the page counts as answering.
  async _answers(ms) {
    const answered = !!this.dialog || await within(cdp(this, 'Runtime.evaluate', { expression: '1' }).then(() => true, () => true), ms, false) || !!this.dialog;
    if (answered) this.stuckAt = null;
    return answered;
  }

  _stuckError() {
    return new Error(`The page in ${this.id} has not answered for ${Math.round((Date.now() - this.stuckAt) / 1000)} s: a script on it seems stuck in a loop ` +
      '(a broken build?). Navigate it (reload, or another URL) or close it with tab_close; other calls on this tab fail at once until it answers again.');
  }

  // A call is running or queued, or an action still runs behind an open dialog.
  get busy() {
    return this._calls > 0 || !!this._busy;
  }

  // A new document in the main frame (not same-document history): any dialog of the old one is gone, and so is a stuck script.
  // url: the new document's, when known; a blocked one (a refused local file) is noted (blockedPageAt) so no result
  // read meanwhile is kept.
  _newDocument(url) {
    if (isBlockedUrl(url)) this.blocked();
    this.documentGeneration++;
    this.dialog = null;
    this.stuckAt = null;
    // The new document's own response came in before it committed, under the old page's number: it is this page's.
    const own = this.network.findLast((e) => e.type === 'document' && e.main);
    if (own && own.url === url && own.page === this.documentGeneration - 1) own.page = this.documentGeneration;
    // The old document's requests are gone with it (the new one's own request has its response by now).
    for (const request of this.inflight) if (request.resourceType() !== 'document' || request.frame() !== this.page.mainFrame()) this.inflight.delete(request);
  }

  // The current document loaded url (an <img>, <script>, stylesheet, font, fetch or iframe): when it is a local file agents
  // can't open, the file's content may now be in the page (drawn, run, framed) whatever the page's own URL, so nothing of
  // this document is read (tools.mjs blockedTab), logged or kept, and reads running now are discarded (blockedPageAt).
  // Chrome reports file: subresources to the Network domain as any other (Playwright's request event).
  // document: url is a frame's document (a downloaded page is refused there too: localFileBlock), else a subresource.
  loaded(url, document = true) {
    const why = localFileBlock(url, undefined, { document });
    if (!why) return;
    this.blocked();
    if (this.refusedLoad?.page === this.documentGeneration) return;
    this.refusedLoad = { page: this.documentGeneration, why };
    this.console = this.console.filter((e) => e.page !== this.documentGeneration);
    this.network = this.network.filter((e) => e.page !== this.documentGeneration);
  }

  // Moves on every time, even twice within a millisecond, so a read that saw one value knows nothing came meanwhile.
  blocked() {
    this.blockedPageAt = Math.max(Date.now(), this.blockedPageAt + 1);
  }

  // An action returned early (a dialog opened) but is still running: once the dialog is resolved it goes on,
  // and later calls wait for it. While a dialog is open they run (and report the dialog) instead of hanging.
  keepBusy(work) {
    const busy = work.finally(() => { if (this._busy === busy) this._busy = null; });
    this._busy = busy;
  }

  async _idle() {
    while (this._busy && !this.dialog) {
      let onDialog;
      const opened = new Promise((resolve) => { onDialog = resolve; this.once('dialog', resolve); });
      await Promise.race([this._busy, opened]);
      this.off('dialog', onDialog);
    }
  }

  // The browser's own title for the tab; unlike document.title it does not wait for the page's JS thread
  // (blocked while a dialog is open).
  async currentTitle() {
    const info = await cdp(this, 'Target.getTargetInfo').catch(() => null);
    return info?.targetInfo?.title ?? '';
  }
}

export class Browser {
  constructor(key, host) {
    this.key = key; // socket base name: "helium", "chrome", "helium-2"
    this.host = host;
    const [base, n] = key.split(/-(?=\d+$)/);
    this._app = NAMES[base] ?? base;
    this._n = n;
    const hello = host.hello;
    this.silentDebugger = hello.silentDebugger;
    this.chromiumVersion = hello.extension?.userAgent?.match(/Chrome\/(\S+)/)?.[1] ?? null;
    this.tabs = new Map(); // chrome tab id -> Tab
    this.relay = new CDPRelay((method, params) => host.request(method, params), hello.extension?.userAgent);
    watchTakeovers(this); // first: it reads which tabs the relay knows before the relay handles the event
    host.on('event', (method, params) => {
      // A swapped tab whose takeover is still parking it: it attaches only if it is resumed.
      if (method === 'chrome.tabs.onCreated' && heldBack(this, params?.[0]?.id)) return;
      this.relay.handleExtensionEvent(method, params);
      if (method === 'chrome.debugger.onEvent') this._onDebuggerEvent(params);
      else if (method === 'extension.hello') this._identity(params);
      else if (method === 'host.hello') this._identity(params?.extension);
      else if (method === 'downloads.changed') for (const item of params ?? []) downloadDone(key, item); // record mode
    });
    this._pw = null;
    this._pages = new WeakMap(); // Playwright page -> Promise<Tab | null>
    this._waiters = new Map(); // chrome tab id -> resolve functions of waitForTab calls
    this.adopting = new Map(); // chrome tab id -> its _adopt still setting up (settles once it is done)
    this._settingUp = new Map(); // chrome tab id -> its Tab while _adopt sets it up, before it is published
  }

  // The app's version, read once when first asked (browser_list), not at connect.
  get version() {
    if (this._version === undefined) this._version = appVersion(this.host.hello.browserPath);
    return this._version;
  }

  // "Chrome (Work)" with the label the user gave this browser profile in the extension's popup, else "Chrome (2)".
  get name() {
    const label = this.host.hello.extension?.label;
    return this._app + (label ? ` (${label})` : this._n ? ` (${this._n})` : '');
  }

  // The extension's identity (user agent) can come after host.hello; keep the real one for Browser.getVersion.
  // It is sent again when the user renames the browser.
  _identity(extension) {
    if (!extension?.userAgent) return;
    this.host.hello = { ...this.host.hello, extension };
    this.chromiumVersion = extension.userAgent.match(/Chrome\/(\S+)/)?.[1] ?? this.chromiumVersion;
    this.relay.setUserAgent(extension.userAgent);
  }

  // Raw CDP events of the tab: new documents in its iframes (in the page's process, or out of it on their own session;
  // never same-document navigations, which Playwright's framenavigated reports too), and of the tab's own session the
  // main frame's new documents, 'windowopen' (url) when the page asks for a new tab or window, and 'binding' (name,
  // payload) when one of FowlBrowser's page scripts reports.
  _onDebuggerEvent([source, method, params] = []) {
    const tab = this.tabs.get(source?.tabId) ?? this._settingUp.get(source?.tabId);
    if (!tab) return;
    if (method === 'Page.frameNavigated' && (source.sessionId || params?.frame?.parentId)) {
      tab.frameGeneration++;
      tab.loaded(params?.frame?.url); // an allowed local file framing a refused one
    } else if (source.sessionId) return;
    else if (method === 'Page.frameNavigated') {
      tab._newDocument(params?.frame?.url);
      prepareCursor(tab);
      if (tab.viewport && !tab.viewport.mobile) keepViewportSize(tab).catch((error) => debug('viewport: keeping its size failed', tab.id, error.message));
    } else if (method === 'Page.windowOpen') tab.emit('windowopen', params?.url ?? '');
    else if (isOwnBinding(method, params)) tab.emit('binding', params.name, params.payload);
  }

  // The tab is no longer ours (released or closed) even if the extension's event never came.
  forget(tabId) {
    this.relay.model.forgetTab(tabId);
    this.relay.viewports.delete(tabId);
    this.tabs.delete(tabId);
  }

  async start() {
    this._relayUrl = await this.relay.start();
  }

  stop() {
    this.relay.stop();
    this._pw?.then((pw) => pw.close()).catch(() => {});
  }

  playwright() {
    this._pw ??= (async () => {
      const { chromium } = await import('playwright-core'); // loaded with the first tab, not at startup
      const pw = await chromium.connectOverCDP(this._relayUrl, { timeout: NAVIGATION_TIMEOUT_MS });
      const context = pw.contexts()[0];
      context.on('page', (page) => this.tabFor(page));
      for (const page of context.pages()) this.tabFor(page);
      pw.on('disconnected', () => {
        this._pw = null;
        this.tabs.clear();
      });
      return pw;
    })();
    this._pw.catch(() => { this._pw = null; });
    return this._pw;
  }

  // The Tab for a Playwright page (null if it could not be mapped), adopting the page on first sight.
  tabFor(page) {
    if (!this._pages.has(page)) this._pages.set(page, this._adopt(page));
    return this._pages.get(page);
  }

  async _adopt(page) {
    let tab = null;
    // Registered before any await, so a page that closes during setup is never published (or is removed).
    page.once('close', () => {
      if (!tab || this.tabs.get(tab.tabId) !== tab) return;
      this.tabs.delete(tab.tabId);
      if (!tab.ending) record({ type: 'tab', event: 'close', tab: tab.id, url: page.url() }); // found gone
    });
    try {
      const session = await page.context().newCDPSession(page);
      const { tabId } = await session.send('FowlBrowser.getTabId');
      session.detach().catch(() => {});
      tab = new Tab(this, tabId, page);
      // A page already loaded (a claim, a reattach, a server restart): a local one may have loaded a refused file (an
      // <img>, a <script>) before this Tab watched it, and nothing tells which. A tab_open tab starts at about:blank.
      if (/^file:/i.test(page.url())) tab.unwatchedPage = tab.documentGeneration;
      this._settingUp.set(tabId, tab); // its page's new documents count while it is set up (_onDebuggerEvent)
      // keep and release wait for this (adopting) to take out the popup scripts it installs; it sees one that came first.
      let adopted;
      this.adopting.set(tabId, new Promise((resolve) => { adopted = resolve; }));
      const [info] = await Promise.all([tabInfo(this, tabId).catch(() => null), watchUserInput(tab).catch(() => {})]);
      await Promise.all([
        // Popups open in the background only from the agent's own tabs, never from tabs that are (or went back to) the user's.
        info?.origin === 'agent' && !info.handedOver && !info.kept && !info.parked && installPopups(tab).catch((e) => debug('popups: install failed', e.message)),
        // The attachShadow hook goes only into agent tabs; the user's claimed tabs get a scan per document instead.
        watchClosedShadow(tab, info?.origin === 'agent').catch(() => {}),
      ]);
      this.adopting.delete(tabId);
      adopted(page.isClosed() ? null : tab);
      if (page.isClosed()) return null;
      this.relay.viewports.delete(tabId); // a new Tab has no viewport override (a detach ended any earlier one)
      this.tabs.set(tabId, tab);
      prepareCursor(tab);
      for (const resolve of this._waiters.get(tabId) ?? []) resolve(tab);
      this._waiters.delete(tabId);
      return tab;
    } catch (error) {
      if (!page.isClosed()) process.stderr.write(`[fowlbrowser] could not map a page to its tab: ${error.message}\n`);
      return null;
    } finally {
      if (tab && this._settingUp.get(tab.tabId) === tab) this._settingUp.delete(tab.tabId);
    }
  }

  // Resolves the Tab once Playwright has a page for this chrome tab. One let go (the user took over, or it showed a local
  // file agents can't open, also before it was ever attached) fails with its notice at once, or as that is noted while
  // this waits, not at the timeout; a call that works on parked tabs (tab_claim resuming one) waits for the tab itself.
  async waitForTab(tabId, timeout = ACTION_TIMEOUT_MS) {
    await this.playwright();
    if (this.tabs.has(tabId)) return this.tabs.get(tabId);
    const key = `${this.key}:${tabId}`;
    const parked = !currentCall()?.onParked && notice(key);
    if (parked) throw new Error(parked);
    let resolve, takenOver;
    const mapped = new Promise((r, reject) => { resolve = r; takenOver = (text) => reject(new Error(text)); });
    if (!this._waiters.has(tabId)) this._waiters.set(tabId, new Set());
    this._waiters.get(tabId).add(resolve);
    const stopListening = onTakeover(key, takenOver);
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const parkedNotice = notice(key);
        if (parkedNotice) return reject(new Error(parkedNotice));
        const detached = this.relay.model.hasTab(tabId) && !this.relay.model.isAttached(tabId);
        reject(new Error(`Tab ${key} did not become controllable within ${timeout / 1000} s.` + (detached
          ? ' Its debugger is detached (the user canceled debugging or opened DevTools on it); it is still yours. Call tab_claim on it to re-attach (DevTools must be closed).'
          : '')));
      }, timeout);
    });
    return Promise.race([mapped, timedOut]).finally(() => {
      clearTimeout(timer);
      stopListening();
      this._waiters.get(tabId)?.delete(resolve);
      if (!this._waiters.get(tabId)?.size) this._waiters.delete(tabId);
    });
  }
}

export class BrowserManager {
  // system: the installed and running browsers (macOS). Real browsers' hosts listen in ~/.fowlbrowser only, so with
  // another FOWLBROWSER_DIR (tests, the fake extension) none of them is looked at or reopened.
  constructor({ system = SOCKET_DIR === path.join(os.homedir(), '.fowlbrowser') ? macOS : null } = {}) {
    this.browsers = new Map(); // key -> Browser
    this._connecting = new Map(); // socket path -> promise
    this._system = system;
    this._revives = new Map(); // key -> { at, done } of its last reopen
    this.ready = this.scan();
    setInterval(() => this.scan(), RESCAN_MS).unref();
  }

  async scan() {
    const connected = new Set([...this.browsers.values()].map((b) => b.host.socketPath));
    await Promise.all(listSockets().filter((p) => !connected.has(p)).map((p) => this._connect(p)));
  }

  _connect(socketPath) {
    if (this._connecting.has(socketPath)) return this._connecting.get(socketPath);
    const attempt = (async () => {
      const host = new HostClient(socketPath);
      try {
        await host.connect(LABEL, await sessionName());
      } catch {
        host.close();
        return; // stale socket file or a browser mid-restart; the next scan retries
      }
      const key = path.basename(socketPath, '.sock');
      const browser = new Browser(key, host);
      await browser.start();
      if (host.closed) { browser.stop(); return; } // closed while the relay started; the next scan retries
      this.browsers.set(key, browser);
      host.once('close', () => {
        browser.stop();
        if (this.browsers.get(key) === browser) this.browsers.delete(key);
      });
    })().finally(() => this._connecting.delete(socketPath));
    this._connecting.set(socketPath, attempt);
    return attempt;
  }

  async get(key) {
    await this.ready;
    if (!this.browsers.has(key)) await this.scan();
    const [asleep] = this.browsers.has(key) ? [] : this.asleep(key);
    if (asleep?.bundle) await this._revive(key, asleep.bundle);
    const browser = this.browsers.get(key);
    if (!browser) {
      const known = [...this.browsers.keys()];
      const others = `Connected: ${known.length ? known.join(', ') : 'none'}.`;
      if (asleep && !asleep.bundle) {
        throw new Error(`${asleep.name} isn't running, so FowlBrowser can't reach it (it never starts a browser). Ask the user to open ${asleep.name}. ${others}`);
      }
      if (asleep) {
        throw new Error(`${asleep.name} is running but FowlBrowser didn't come up in it, even after opening a window there in the background ` +
          `(its FowlBrowser extension may be off). Ask the user to check ${asleep.name}. ${others}`);
      }
      throw new Error(`Browser "${key}" is not connected. ${others} Use browser_list.`);
    }
    return browser;
  }

  // Tells every browser this session is at work (a tool call starting or ending): only that keeps the tabs it holds from
  // being given back as idle, never the traffic its pages cause on their own (workers, iframes, loads).
  markActive() {
    for (const browser of this.browsers.values()) browser.host.notify('client.active');
  }

  async all() {
    await this.ready;
    return [...this.browsers.values()];
  }

  // Browsers with FowlBrowser installed and no profile connected (every one, or the one `key` names): { key, name,
  // bundle } (bundle: the running app, null when it isn't running).
  asleep(key) {
    if (!this._system) return [];
    const awake = new Set([...this.browsers.keys()].map(baseKey));
    const apps = APPS.filter((b) => (key === undefined || b.key === baseKey(key)) && !awake.has(b.key) && this._system.installed(b));
    const processes = apps.length ? this._system.processes() : [];
    return apps.map((b) => ({ key: b.key, name: NAMES[b.key] ?? b.app, bundle: runningBundle(b.app, processes) }));
  }

  // A browser that is running with FowlBrowser installed but not connected has most likely closed its last window: it
  // gets a window again in the background, and the call goes on once its host is here (up to 5 s). Calls naming it
  // meanwhile share one reopen; one that brought nothing back is not repeated for a minute.
  _revive(key, bundle) {
    const last = this._revives.get(key);
    if (last && (!last.settled || Date.now() - last.at < REVIVE_AGAIN_MS)) return last.done;
    const revive = { at: Date.now(), settled: false };
    revive.done = (async () => {
      debug('revive', key, bundle);
      this._system.reopen(bundle);
      for (const end = Date.now() + REVIVE_WAIT_MS; !this.browsers.has(key) && Date.now() < end;) {
        await sleep(200);
        await this.scan();
      }
      revive.settled = true;
      if (this.browsers.has(key)) this._revives.delete(key);
    })();
    this._revives.set(key, revive);
    return revive.done;
  }
}
