// Lighthouse audits in the tab's own debugger session, through a fake puppeteer page: Lighthouse only calls
// page.url() and page.target().createCDPSession(), and uses send, events ('*', by name, 'sessionattached'), id() and
// detach() on the session.
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { z } from 'zod';
import { cdp, clearEmulation, fileTab, isUsersTab, onCdpEvent, outputDir, readStream, stamp, startTracing, traceBusy, tracingSlot, waitForTracing } from './perf.mjs';
import { debug } from './debug.mjs';
import { POPUP_BINDING, POPUP_WORLD, popupsInstalled } from './popups.mjs';
import { notice, USER_BINDING, USER_WORLD } from './takeover.mjs';
import { resetEngine, tracedTabOnly } from './trace.mjs';
import { clearViewport, setMedia, setViewport } from './viewport.mjs';

const CATEGORIES = ['performance', 'accessibility', 'best-practices', 'seo', 'agentic-browsing'];
// bf-cache navigates to chrome://terms (refused), unused-javascript and script-treemap-data need the Profiler domain.
const SKIP_AUDITS = ['bf-cache', 'unused-javascript', 'script-treemap-data'];
const MOBILE_SCREEN = { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false };
// Domains an extension's debugger session doesn't have; Lighthouse only enables and disables them.
const STUBBED = new Set(['Animation.enable', 'Animation.disable']);
const MAX_IN_FLIGHT = 64; // the host refuses a client with over 256; Lighthouse's AnchorElements fires hundreds at once
// The run's own Tracing.start retries this long for another session's trace to end: under Lighthouse's 30 s protocol
// timeout (run() waited the long wait before starting, so this covers one that began meanwhile).
const LH_TRACE_WAIT_MS = 25_000;
const TRACE_CHUNK = 10_000; // trace events per Tracing.dataCollected handed to Lighthouse
const LH_SETTLE_MS = 60_000; // a run abandoned at the browser connection's close gets this long to end on its own
const TRACE_BUSY = 'Lighthouse could not trace the page: something else kept recording a trace in this browser (another session\'s trace or Lighthouse run, or DevTools\' Performance panel) for as long as this call waited. Stop it, then run lighthouse again.';
const gunzip = promisify(zlib.gunzip);
const MAX_FLAGGED = 20;
const METRICS = [['FCP', 'first-contentful-paint'], ['LCP', 'largest-contentful-paint'], ['TBT', 'total-blocking-time'],
  ['CLS', 'cumulative-layout-shift'], ['Speed Index', 'speed-index'], ['TTI', 'interactive']];

// One CDP session of the run: the tab's own (root) or a flattened child (iframe, worker). They share the in-flight cap,
// the child map and the list of scripts Lighthouse added.
export class Session extends EventEmitter {
  constructor(shared, sessionId) { super(); this.shared = shared; this.sessionId = sessionId; }
  id() { return this.sessionId ?? `fb-${this.shared.tab.tabId}`; }
  async send(method, params, options) {
    if (this.shared.closed) throw closedError();
    // Lighthouse's ProtocolSession passes only {timeout} for commands without params.
    if (options === undefined && params && typeof params.timeout === 'number' && Object.keys(params).length === 1) params = undefined;
    const { tab } = this.shared;
    if (method === 'Browser.getVersion') {
      const userAgent = tab.browser.host.hello.extension.userAgent;
      return { protocolVersion: '1.3', product: `Chrome/${/Chrome\/(\S+)/.exec(userAgent)?.[1]}`, revision: '', jsVersion: '', userAgent };
    }
    if (STUBBED.has(method)) return {};
    await this.slot();
    if (this.shared.closed) { this.release(); throw closedError(); }
    let result;
    const call = () => {
      const sent = cdp(tab, method, params, this.sessionId);
      this.shared.inFlightSends.add(sent);
      return sent.finally(() => this.shared.inFlightSends.delete(sent));
    };
    const started = Date.now();
    try {
      // The run's trace comes back as a gzipped stream (many times fewer bytes through the extension and the host than
      // its Tracing.dataCollected events; collectTrace hands the events over), and its start waits a little for another
      // session's trace to end: one in-flight operation for settled(), ended by a close at its next try.
      if (method === 'Tracing.start') {
        params = { ...params, transferMode: 'ReturnAsStream', streamCompression: 'gzip' };
        const op = startTracing(() => (this.shared.closed ? Promise.reject(closedError()) : call()), { waitMs: LH_TRACE_WAIT_MS });
        this.shared.inFlightSends.add(op);
        try {
          const { result: started, waitedMs } = await op;
          result = started;
          this.shared.traceWaitMs = waitedMs;
        } finally { this.shared.inFlightSends.delete(op); }
      } else result = await call();
    } catch (error) { debug('lh err', method, String(error?.message).slice(0, 120)); throw error; } finally { this.release(); debug('lh', method, `${Date.now() - started} ms`); }
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && result?.identifier) this.shared.scripts.push({ sessionId: this.sessionId, identifier: result.identifier });
    return result;
  }
  async detach() {}
  slot() {
    const s = this.shared;
    if (s.inFlight < MAX_IN_FLIGHT) { s.inFlight++; return Promise.resolve(); }
    return new Promise((resolve, reject) => s.waiting.push({ resolve, reject }));
  }
  release() {
    const s = this.shared;
    const next = s.waiting.shift();
    if (next) next.resolve(); // the slot passes straight to the next waiter
    else s.inFlight--;
  }
  dispatch(method, params) {
    // The run's trace, as a stream (send above): read, gunzipped and handed over as dataCollected events, then complete.
    if (method === 'Tracing.tracingComplete' && params?.stream) { this.collectTrace(params); return; }
    let child;
    if (method === 'Target.attachedToTarget' && params?.sessionId) this.shared.children.set(params.sessionId, child = new Session(this.shared, params.sessionId));
    if (method === 'Target.detachedFromTarget') this.shared.children.delete(params?.sessionId);
    this.emitSafe('*', method, params);
    this.emitSafe(method, params);
    if (child) this.emitSafe('sessionattached', child);
  }
  // One in-flight operation for settled(). IO.close goes raw: a run that closed meanwhile refuses sends, but the
  // stream's buffer in Chrome is still worth freeing. Such a run gets its completion with no events (Lighthouse's
  // collector would otherwise wait for it without end), and says so. Chrome traces the whole browser: Lighthouse gets
  // only the audited tab's events (trace.mjs tracedTabOnly), or its audits (layout shift culprits: any font request
  // before a shift) could put another tab's URLs in the report.
  collectTrace({ stream, dataLossOccurred }) {
    const send = (m, p) => (m === 'IO.close' ? cdp(this.shared.tab, m, p, this.sessionId) : this.send(m, p));
    const op = (async () => {
      let events = [];
      try {
        ({ traceEvents: events } = tracedTabOnly(JSON.parse((await gunzip(await readStream(send, stream))).toString('utf8'))));
      } catch (error) {
        debug('lh trace', String(error?.message).slice(0, 120)); // Lighthouse then has no trace events, and says so
      }
      if (!this.shared.closed) for (let i = 0; i < events.length; i += TRACE_CHUNK) this.dispatch('Tracing.dataCollected', { value: events.slice(i, i + TRACE_CHUNK) });
      this.dispatch('Tracing.tracingComplete', { dataLossOccurred });
    })();
    this.shared.inFlightSends.add(op);
    op.finally(() => this.shared.inFlightSends.delete(op)).catch(() => {});
  }
  // Lighthouse's listeners are partly async (TargetManager's sessionattached and frameNavigated) and their promises
  // reach nobody: a rejection there (a child target gone before its answer) would be unhandled and end the process.
  emitSafe(event, ...args) {
    for (const listener of this.rawListeners(event)) {
      try { listener.apply(this, args)?.catch?.(() => {}); } catch {}
    }
  }
}

// Lighthouse treats "Target closed" as benign.
const closedError = () => new Error('Target closed: the Lighthouse run has ended');

// The root session of a run, receiving the tab's CDP events (its children's by sessionId). close() stops that.
export function rootSession(tab) {
  const shared = { tab, inFlight: 0, waiting: [], inFlightSends: new Set(), closed: false, scripts: [], children: new Map() };
  const root = new Session(shared);
  const off = onCdpEvent(tab, (method, params, sessionId) => (sessionId ? shared.children.get(sessionId) : root)?.dispatch(method, params));
  // After close, nothing more is sent: queued and new sends fail, so none lands after restore and undoes it.
  root.close = () => {
    off();
    shared.closed = true;
    for (const { reject } of shared.waiting.splice(0)) reject(closedError());
  };
  // Settles once the sends already in flight have (at most timeoutMs).
  root.settled = (timeoutMs) => {
    let timer;
    return Promise.race([Promise.allSettled([...shared.inFlightSends]), new Promise((r) => { timer = setTimeout(r, timeoutMs); })]).finally(() => clearTimeout(timer));
  };
  root.scripts = shared.scripts;
  root.waited = () => shared.traceWaitMs ?? 0; // how long the run's own Tracing.start retried for another session's trace
  return root;
}

// Resolves once `promise` settles, or after timeoutMs.
function within(promise, timeoutMs) {
  let timer;
  return Promise.race([promise.catch(() => {}), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]).finally(() => clearTimeout(timer));
}

// After a run, whatever happened: Lighthouse leaves its emulation, blocked URLs and scripts on the session, and
// disables Page, Runtime and Log, which Playwright (on the same session) needs.
export async function restore(tab, scripts) {
  await clearEmulation(tab);
  await cdp(tab, 'Network.setCacheDisabled', { cacheDisabled: false }).catch(() => {});
  await cdp(tab, 'Network.setBlockedURLs', { urls: [] }).catch(() => {});
  for (const { sessionId, identifier } of scripts) await cdp(tab, 'Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId).catch(() => {});
  // Lighthouse's Page.disable also turned lifecycle events off, which Playwright's load waits need.
  for (const [method, params] of [['Page.enable'], ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Runtime.enable'], ['Network.enable'], ['Log.enable']]) {
    await cdp(tab, method, params).catch(() => {});
  }
  // Runtime.disable dropped the bindings FowlBrowser's own page scripts report through (the user's input, popup
  // interception): without them new documents would go unheard.
  await cdp(tab, 'Runtime.addBinding', { name: USER_BINDING, executionContextName: USER_WORLD }).catch(() => {});
  if (popupsInstalled(tab)) await cdp(tab, 'Runtime.addBinding', { name: POPUP_BINDING, executionContextName: POPUP_WORLD }).catch(() => {});
}

let loading;
const load = () => loading ??= (async () => {
  const [lighthouse, { userAgents }, logger] = await Promise.all([
    import('lighthouse'), import('lighthouse/core/config/constants.js'), import('lighthouse-logger')]).catch((error) => {
    loading = null;
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    throw new Error('Lighthouse is not installed: FowlBrowser was installed with --lite. Run its install.sh again without --lite to add it (about 160 MB); traces and memory work without it.');
  });
  logger.default.setLevel(process.env.FOWLBROWSER_LH_LOG || 'error');
  return { navigation: lighthouse.navigation, snapshot: lighthouse.snapshot, generateReport: lighthouse.generateReport, desktopConfig: lighthouse.desktopConfig, mobileUA: userAgents.mobile };
})();
export const auditor = { load }; // for tests: a stand-in Lighthouse

async function run(tab, lh, { device, mode, categories }) {
  const flags = { disableStorageReset: true, skipAudits: SKIP_AUDITS, logLevel: process.env.FOWLBROWSER_LH_LOG || 'error', maxWaitForLoad: 30_000 }; // 30 s as chrome-devtools-mcp; the level: Lighthouse sets its logger from it
  if (categories) flags.onlyCategories = categories;
  let config;
  if (device === 'desktop') config = lh.desktopConfig;
  else Object.assign(flags, { formFactor: 'mobile', screenEmulation: MOBILE_SCREEN, emulatedUserAgent: lh.mobileUA });
  // Snapshot mode never applies the emulation before collecting: it audits the page as it is (formFactor only sets
  // the audit thresholds), without the full-page screenshot, whose gatherer would emulate a device on its own.
  if (mode === 'snapshot') Object.assign(flags, { screenEmulation: { disabled: true }, emulatedUserAgent: false, disableFullPageScreenshot: true });
  // The tab's own recording holds the slot this run needs, and trace_stop would queue behind this call: say so instead.
  if (tab.trace?.startedAt) throw new Error('A trace is recording in this tab: call trace_stop first, then lighthouse.');
  const release = await tracingSlot(); // Lighthouse records and parses a trace: one at a time
  // A viewport the agent set (viewport tool) is set again after the run in both modes (the clean-up clears every
  // override); in navigation mode it first makes way for Lighthouse's emulation, a snapshot audits the page at it.
  const viewport = tab.viewport;
  const media = tab.media; // the colour scheme and motion the agent set, put back the same way
  const warnings = [];
  // The slot, the wait below and the set-up can take a while: a user who took the tab over meanwhile keeps it as it is.
  const takenOver = () => { const n = notice(tab.id); if (n) throw new Error(n); };
  try {
    takenOver();
    // Another session's recording would fail the run's own Tracing.start (Chrome records one trace per browser): it
    // ends first, waited for on the page as it is (up to TRACE_WAIT), and the result says for how long.
    if (mode === 'navigation') {
      let waitedMs;
      try { waitedMs = await waitForTracing(tab); } catch (error) { throw traceBusy(error) ? new Error(TRACE_BUSY) : error; }
      takenOver();
      if (waitedMs >= 1000) warnings.push(`Waited ${Math.round(waitedMs / 1000)} s for another session's trace to end before the run.`);
    }
  } catch (error) {
    release();
    throw error;
  }
  let failure = null;
  let running = null; // the Lighthouse run itself
  const root = rootSession(tab);
  const page = { url: async () => (await root.send('Target.getTargetInfo')).targetInfo.url, target: () => ({ createCDPSession: async () => root }) };
  try {
    if ((viewport || media) && mode === 'navigation') await clearViewport(tab, 'lighthouse');
    const url = await page.url();
    await root.send('Network.enable');
    await root.send('Network.setCacheDisabled', { cacheDisabled: true });
    takenOver(); // the set-up above awaited the browser: a navigation run would otherwise replace the user's page
    // Lighthouse waits for trace and page events that never come once the browser's connection is gone.
    let onClose;
    const closed = new Promise((_, reject) => { onClose = () => reject(new Error('The browser\'s FowlBrowser connection closed during the audit (the tab is no longer controlled).')); tab.browser.host.once('close', onClose); });
    closed.catch(() => {});
    let result;
    running = mode === 'navigation' ? lh.navigation(page, url, { flags, config }) : lh.snapshot(page, { flags, config });
    running.catch(() => {});
    try {
      result = await Promise.race([running, closed]);
    } finally {
      tab.browser.host.off('close', onClose);
    }
    return { lhr: result.lhr, warnings };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    root.close();
    await root.settled(45_000); // a host request can take that long to time out
    if (root.waited() >= 1000) warnings.push(`Waited ${Math.round(root.waited() / 1000)} s for another session's trace to end before recording.`);
    // The user took the tab over meanwhile (asked right before each step: a takeover lands at any time): it is theirs
    // now, and nothing more is done to its page (the takeover parks the tab, and the session's overrides end with it).
    if (!notice(tab.id)) await restore(tab, root.scripts);
    if (viewport && !notice(tab.id)) await setViewport(tab, viewport).catch((error) => warnings.push(`The viewport you had set (${viewport.width}x${viewport.height}) could not be put back: ${error.message}. Set it again with viewport.`));
    if (media && !notice(tab.id)) await setMedia(tab, media).catch((error) => warnings.push(`The colour scheme or motion you had set could not be put back: ${error.message}. Set it again with viewport.`));
    // Lighthouse's init scripts ran in the audited document and its frames (one wraps requestIdleCallback): after a
    // navigation run, whatever its outcome, the page loads once more, so the agent goes on with a clean document
    // (Playwright's reload: refs start over).
    if (mode === 'navigation' && !notice(tab.id)) await tab.page.reload({ waitUntil: 'load' }).catch((error) => warnings.push(`The page could not be loaded again after the audit (${error.message.split('\n')[0]}): navigate to it before going on.`));
    // A run abandoned at the browser connection's close may still be parsing its trace with the shared engine: it
    // ends (its sends fail now, its load waits time out) before the engine is reset and the slot released.
    if (running) await within(running, LH_SETTLE_MS);
    await resetEngine().catch(() => {}); // Lighthouse parsed its trace with the shared engine
    release();
    if (failure && warnings.length) failure.message += `\n${warnings.join('\n')}`;
  }
}

// "Best Practices" -> "best practices", "SEO" stays.
const label = (category) => category.title.replace(/\b[A-Z][a-z]+/g, (w) => w.toLowerCase());
const score = (s) => (s === null || s === undefined ? 'n/a' : String(Math.round(s * 100)));
const plain = (s) => s?.replace(/\u00a0/g, ' '); // Lighthouse puts no-break spaces in display values

// A category with only weight-0 audits (performance in snapshot mode) scores a meaningless 0: count passes instead.
function categoryScore(lhr, category) {
  if (category.score === null || category.auditRefs.some((ref) => ref.weight > 0)) return score(category.score);
  const scored = category.auditRefs.map((ref) => lhr.audits[ref.id]?.score).filter((s) => s !== null && s !== undefined);
  return `n/a (${scored.filter((s) => s >= 1).length} of ${scored.length} audits pass)`;
}

export function formatResult(lhr, { device, mode, seconds, html, json }) {
  const categories = Object.values(lhr.categories);
  const lines = [
    `Lighthouse ${lhr.lighthouseVersion} · ${device} · ${mode === 'snapshot' ? 'snapshot (page as it is, no device emulation)' : mode} · ${seconds.toFixed(1)} s`,
    `Scores: ${categories.map((c) => `${label(c)} ${categoryScore(lhr, c)}`).join(' · ')}`,
  ];
  if (METRICS.some(([, id]) => lhr.audits[id])) lines.push(`Metrics: ${METRICS.map(([name, id]) => `${name} ${plain(lhr.audits[id]?.displayValue) ?? 'n/a'}`).join(' · ')}`);
  const heaviest = new Map(); // audit id -> its heaviest reference across categories
  for (const c of categories) {
    for (const ref of c.auditRefs) {
      const audit = lhr.audits[ref.id];
      if (!audit || audit.score === null || audit.score >= 1) continue;
      if (!(heaviest.get(ref.id)?.weight >= ref.weight)) heaviest.set(ref.id, { category: label(c), weight: ref.weight, audit });
    }
  }
  const flagged = [...heaviest.values()];
  flagged.sort((a, b) => b.weight - a.weight || a.audit.score - b.audit.score);
  if (flagged.length) {
    lines.push(`Failed or flagged audits (${flagged.length}):`);
    for (const { category, audit } of flagged.slice(0, MAX_FLAGGED)) {
      const value = audit.scoreDisplayMode === 'binary' ? 'fail' : score(audit.score);
      lines.push(`- ${category} · ${audit.id} (${value}): ${audit.title}${audit.displayValue ? ` · ${plain(audit.displayValue)}` : ''}`);
    }
    if (flagged.length > MAX_FLAGGED) lines.push(`… and ${flagged.length - MAX_FLAGGED} more in the report.`);
  } else {
    lines.push('Failed or flagged audits: none.');
  }
  if (lhr.runWarnings?.length) lines.push(`Warnings: ${lhr.runWarnings.map(plain).join(' · ')}`);
  lines.push(`Report: ${html} · JSON: ${json}`);
  return lines.join('\n');
}

export function registerLighthouse(tool, manager, { withTab, header, text, tabArg, refuseBlockedPage }) {
  tool('lighthouse',
    'Run a Lighthouse audit in a tab: scores (0-100) for performance, accessibility, best practices, SEO and agentic browsing, ' +
    'the lab metrics (FCP, LCP, TBT, CLS, Speed Index, TTI), the failed or flagged audits heaviest first, and the paths of the full HTML and JSON reports. ' +
    'mode "navigation" (default) reloads the page and audits the load, emulating a phone (default) or desktop during the run and clearing that afterwards; ' +
    'it is refused on a claimed tab (the user\'s page): audit a tab_open of the URL instead, or use mode "snapshot", which audits the page as it is now ' +
    '(its current layout and user agent, no device emulation: device only sets the score thresholds; no load metrics). ' +
    'Never clears the user\'s cache or site data. Takes 10 to 60 s.',
    {
      tab: tabArg,
      device: z.enum(['mobile', 'desktop']).optional().describe('Emulated device in navigation mode (default mobile: Lighthouse\'s Moto G Power preset); in snapshot mode only the score thresholds.'),
      mode: z.enum(['navigation', 'snapshot']).optional().describe('navigation (default): reload and audit the page load. snapshot: audit the page as it is.'),
      categories: z.array(z.enum(CATEGORIES)).min(1).optional().describe('Only these categories (default all five).'),
    },
    withTab(async (tab, { device = 'mobile', mode = 'navigation', categories }) => {
      const before = tab.blockedPageAt; // before any wait: a refused file loaded during the audit voids it
      // The page answers none of the audit's reads while a dialog blocks it.
      if (tab.dialog) throw new Error('A dialog is open on this tab; resolve it with the dialog tool first.');
      if (mode === 'navigation' && await isUsersTab(tab)) {
        throw new Error(`Tab ${tab.id} is the user's own tab (you claimed it, or it is kept or handed over to them): mode "navigation" reloads the page, so it was not run. ` +
          'Audit a tab_open of the URL instead, or use mode "snapshot" to audit the page as it is.');
      }
      const lh = await auditor.load();
      const started = Date.now();
      const { lhr, warnings } = await run(tab, lh, { device, mode, categories });
      const seconds = (Date.now() - started) / 1000;
      // The page showed, framed or loaded a refused local file during the audit (or does now): the gathered nodes,
      // snippets and screenshots may hold it, so no report is made or written.
      refuseBlockedPage(tab, before);
      // Tracing is one per browser: a trace_start recording or DevTools' Performance panel in any tab blocks it.
      const tail = warnings.length ? `\n${warnings.join('\n')}` : '';
      if (lhr.runtimeError?.code === 'TRACING_ALREADY_STARTED') throw new Error(`${TRACE_BUSY}${tail}`);
      if (lhr.runtimeError) throw new Error(`Lighthouse could not audit the page: ${lhr.runtimeError.message} (${lhr.runtimeError.code})${tail}`);
      const dir = path.join(outputDir('lighthouse'), `${stamp()}-${fileTab(tab)}`);
      fs.mkdirSync(dir, { recursive: true });
      const html = path.join(dir, 'report.html');
      const json = path.join(dir, 'report.json');
      fs.writeFileSync(html, lh.generateReport(lhr, 'html'));
      fs.writeFileSync(json, JSON.stringify(lhr));
      return text([await header(tab), formatResult(lhr, { device, mode, seconds, html, json }), ...warnings].join('\n'));
    }));
}
