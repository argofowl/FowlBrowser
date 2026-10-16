// The Lighthouse shim (session routing, in-flight cap, restore) over a fake host, and the result text from a small lhr.
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { auditor, formatResult, restore, rootSession } from '../src/lighthouse.mjs';
import { TRACE_WAIT } from '../src/perf.mjs';
import { tracedTabOnly } from '../src/trace.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.7000.1 Safari/537.36';

// A tab whose host records every request; `answer(method, params)` decides the result (a promise holds it).
function fakeTab(answer = () => ({})) {
  const host = new EventEmitter();
  host.hello = { extension: { userAgent: UA } };
  host.calls = [];
  host.request = async (name, args) => {
    assert.equal(name, 'chrome.debugger.sendCommand');
    const [target, method, params] = args;
    host.calls.push({ ...target, method, params });
    return answer(method, params);
  };
  return { tabId: 7, id: 'chrome:7', browser: { host } };
}
const event = (tab, method, params, sessionId) => tab.browser.host.emit('chrome.debugger.onEvent', [{ tabId: tab.tabId, sessionId }, method, params]);

test('send drops a lone {timeout} params object and keeps real params', async () => {
  const tab = fakeTab();
  const root = rootSession(tab);
  await root.send('Page.enable', { timeout: 30050 });
  await root.send('Runtime.evaluate', { expression: '1' }, { timeout: 30050 });
  await root.send('Page.getFrameTree');
  assert.deepEqual(tab.browser.host.calls.map((c) => [c.method, c.params]), [['Page.enable', {}], ['Runtime.evaluate', { expression: '1' }], ['Page.getFrameTree', {}]]);
  assert.equal(root.id(), 'fb-7');
  root.close();
});

test('Browser.getVersion and Animation.enable/disable never reach the host', async () => {
  const tab = fakeTab();
  const root = rootSession(tab);
  const version = await root.send('Browser.getVersion', { timeout: 30050 });
  assert.equal(version.product, 'Chrome/155.0.7000.1');
  assert.equal(version.userAgent, UA);
  assert.deepEqual(await root.send('Animation.enable'), {});
  assert.deepEqual(await root.send('Animation.disable'), {});
  assert.equal(tab.browser.host.calls.length, 0);
  root.close();
});

test('at most 64 requests in flight: the 65th waits until one resolves', async () => {
  const pending = [];
  const tab = fakeTab(() => new Promise((resolve) => pending.push(resolve)));
  const root = rootSession(tab);
  const sends = Array.from({ length: 65 }, (_, i) => root.send('Runtime.evaluate', { expression: String(i) }));
  await new Promise((r) => setImmediate(r));
  assert.equal(tab.browser.host.calls.length, 64);
  pending[0]({});
  await new Promise((r) => setImmediate(r));
  assert.equal(tab.browser.host.calls.length, 65);
  assert.equal(tab.browser.host.calls[64].params.expression, '64');
  for (const resolve of pending.slice(1)) resolve({});
  await Promise.all(sends);
  root.close();
});

test('events route to the root and to flattened children; children send with their sessionId', async () => {
  const tab = fakeTab();
  const root = rootSession(tab);
  const seen = [];
  root.on('*', (method, params) => seen.push(['*', method, params]));
  root.on('Page.loadEventFired', (params) => seen.push(['named', params]));
  let child;
  root.on('sessionattached', (session) => { child = session; });
  event(tab, 'Page.loadEventFired', { timestamp: 1 });
  event({ tabId: 8, browser: tab.browser }, 'Page.loadEventFired', { timestamp: 2 }); // another tab: ignored
  event(tab, 'Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe' } });
  assert.deepEqual(seen, [['*', 'Page.loadEventFired', { timestamp: 1 }], ['named', { timestamp: 1 }],
    ['*', 'Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe' } }]]);
  assert.equal(child.id(), 'S1');

  const childEvents = [];
  child.on('*', (method) => childEvents.push(method));
  event(tab, 'Network.requestWillBeSent', { requestId: 'r' }, 'S1');
  assert.deepEqual(childEvents, ['Network.requestWillBeSent']);
  assert.equal(seen.length, 3, 'a child event does not reach the root');

  await child.send('Network.enable', { timeout: 30050 });
  assert.deepEqual(tab.browser.host.calls.at(-1), { tabId: 7, sessionId: 'S1', method: 'Network.enable', params: {} });

  root.close();
  event(tab, 'Page.loadEventFired', { timestamp: 3 });
  assert.equal(seen.length, 3, 'close stops the routing');
});

test('restore: emulation cleared, cache on, blocked URLs cleared, scripts removed, domains enabled again', async () => {
  let n = 0;
  const tab = fakeTab((method) => (method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(++n) } : {}));
  const root = rootSession(tab);
  await root.send('Page.addScriptToEvaluateOnNewDocument', { source: 'a' });
  await root.send('Page.addScriptToEvaluateOnNewDocument', { source: 'b' });
  root.close();
  tab.browser.host.calls.length = 0;
  await restore(tab, root.scripts);
  assert.deepEqual(tab.browser.host.calls.map((c) => [c.method, c.params]), [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Network.setUserAgentOverride', { userAgent: '' }],
    ['Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }],
    ['Emulation.setCPUThrottlingRate', { rate: 1 }],
    ['Emulation.setScriptExecutionDisabled', { value: false }],
    ['Network.setCacheDisabled', { cacheDisabled: false }],
    ['Network.setBlockedURLs', { urls: [] }],
    ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '1' }],
    ['Page.removeScriptToEvaluateOnNewDocument', { identifier: '2' }],
    ['Page.enable', {}], ['Page.setLifecycleEventsEnabled', { enabled: true }], ['Runtime.enable', {}], ['Network.enable', {}], ['Log.enable', {}],
    ['Runtime.addBinding', { name: '__fowlbrowserUserInput', executionContextName: 'fowlbrowser-user' }],
  ]);
});

test('restore keeps going when commands fail', async () => {
  const tab = fakeTab(() => { throw new Error('Debugger is not attached'); });
  await restore(tab, [{ identifier: '1' }]);
  assert.equal(tab.browser.host.calls.length, 15);
});

test('a listener that throws or rejects (a child gone before its answer) neither breaks dispatch nor goes unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const tab = fakeTab();
    const root = rootSession(tab);
    const seen = [];
    root.on('sessionattached', async () => { throw new Error('Tab 7 is not owned by this client'); });
    root.on('sessionattached', (child) => seen.push(child.id()));
    root.on('*', () => { throw new Error('sync'); });
    root.on('*', async () => { throw new Error('async'); });
    root.on('Target.attachedToTarget', async () => { throw new Error('Session with given id not found'); });
    event(tab, 'Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe' } });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, ['S1']);
    assert.deepEqual(unhandled, []);
    root.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('close: a queued send is rejected and never sent, a new send is rejected, an in-flight one settles', async () => {
  const pending = [];
  const tab = fakeTab(() => new Promise((resolve) => pending.push(resolve)));
  const root = rootSession(tab);
  const sends = Array.from({ length: 65 }, (_, i) => root.send('Runtime.evaluate', { expression: String(i) }).then(() => 'ok', (e) => e.message));
  await new Promise((r) => setImmediate(r));
  assert.equal(tab.browser.host.calls.length, 64);
  root.close();
  const settled = root.settled(10_000);
  pending[0]({});
  await new Promise((r) => setImmediate(r));
  assert.equal(tab.browser.host.calls.length, 64, 'the queued send was not sent');
  assert.match(await sends[64], /Target closed/);
  assert.equal(await sends[0], 'ok');
  await assert.rejects(root.send('Page.enable'), /Target closed/);
  assert.equal(tab.browser.host.calls.length, 64);
  for (const resolve of pending.slice(1)) resolve({});
  await settled;
});

function fakeLhr({ flagged = 3, performance = 'navigation' } = {}) {
  const audits = {
    'first-contentful-paint': { id: 'first-contentful-paint', title: 'First Contentful Paint', scoreDisplayMode: 'numeric', score: 0.98, displayValue: '1.3 s' },
    'largest-contentful-paint': { id: 'largest-contentful-paint', title: 'Largest Contentful Paint', scoreDisplayMode: 'numeric', score: 0.97, displayValue: '1.7 s' },
    'total-blocking-time': { id: 'total-blocking-time', score: 1, displayValue: '80 ms' },
    'cumulative-layout-shift': { id: 'cumulative-layout-shift', score: 1, displayValue: '0' },
    'speed-index': { id: 'speed-index', score: 1, displayValue: '1.3 s' },
    interactive: { id: 'interactive', score: 1, displayValue: '1.7 s' },
    'color-contrast': { id: 'color-contrast', title: 'Background and foreground colors do not have a sufficient contrast ratio.', score: 0, scoreDisplayMode: 'binary' },
    'meta-description': { id: 'meta-description', title: 'Document does not have a meta description', score: 0, scoreDisplayMode: 'binary' },
    'render-blocking-insight': { id: 'render-blocking-insight', title: 'Render blocking requests', score: 0.5, scoreDisplayMode: 'metricSavings', displayValue: 'Est savings of 300 ms' },
    'is-on-https': { id: 'is-on-https', title: 'Uses HTTPS', score: 1, scoreDisplayMode: 'binary' },
    'diagnostics': { id: 'diagnostics', title: 'Diagnostics', score: null, scoreDisplayMode: 'informative' },
  };
  const extra = [];
  for (let i = 0; i < flagged - 3; i++) {
    audits[`a${i}`] = { id: `a${i}`, title: `Audit ${i}`, score: 0.4, scoreDisplayMode: 'numeric' };
    extra.push({ id: `a${i}`, weight: 0 });
  }
  const categories = {
    accessibility: { id: 'accessibility', title: 'Accessibility', score: 0.95, auditRefs: [{ id: 'color-contrast', weight: 7 }, ...extra] },
    'best-practices': { id: 'best-practices', title: 'Best Practices', score: 1, auditRefs: [{ id: 'is-on-https', weight: 5 }] },
    seo: { id: 'seo', title: 'SEO', score: 0.9, auditRefs: [{ id: 'meta-description', weight: 1 }] },
    'agentic-browsing': { id: 'agentic-browsing', title: 'Agentic Browsing', score: null, auditRefs: [] },
  };
  if (performance !== 'navigation') for (const id of ['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index', 'interactive']) delete audits[id];
  if (performance === 'snapshot') {
    categories.performance = { id: 'performance', title: 'Performance', score: 0, auditRefs: [{ id: 'render-blocking-insight', weight: 0 }, { id: 'is-on-https', weight: 0 }, { id: 'diagnostics', weight: 0 }] };
  }
  if (performance === 'navigation') {
    categories.performance = { id: 'performance', title: 'Performance', score: 0.99, auditRefs: [
      { id: 'first-contentful-paint', weight: 10 }, { id: 'largest-contentful-paint', weight: 25 }, { id: 'total-blocking-time', weight: 30 },
      { id: 'render-blocking-insight', weight: 0 }, { id: 'diagnostics', weight: 0 }] };
  }
  return { lighthouseVersion: '13.5.0', categories, audits, runWarnings: [] };
}
const paths = { device: 'mobile', mode: 'navigation', seconds: 8.62, html: '/tmp/r/report.html', json: '/tmp/r/report.json' };

test('formatResult: header, scores, metrics, flagged audits by weight then score, report paths', () => {
  const lines = formatResult(fakeLhr(), paths).split('\n');
  assert.deepEqual(lines, [
    'Lighthouse 13.5.0 · mobile · navigation · 8.6 s',
    'Scores: accessibility 95 · best practices 100 · SEO 90 · agentic browsing n/a · performance 99',
    'Metrics: FCP 1.3 s · LCP 1.7 s · TBT 80 ms · CLS 0 · Speed Index 1.3 s · TTI 1.7 s',
    'Failed or flagged audits (5):',
    '- performance · largest-contentful-paint (97): Largest Contentful Paint · 1.7 s',
    '- performance · first-contentful-paint (98): First Contentful Paint · 1.3 s',
    '- accessibility · color-contrast (fail): Background and foreground colors do not have a sufficient contrast ratio.',
    '- SEO · meta-description (fail): Document does not have a meta description',
    '- performance · render-blocking-insight (50): Render blocking requests · Est savings of 300 ms',
    'Report: /tmp/r/report.html · JSON: /tmp/r/report.json',
  ]);
});

test('formatResult: no metrics line without performance; cut at 20 with a count; warnings', () => {
  const lhr = fakeLhr({ flagged: 30, performance: false });
  lhr.runWarnings = ['The page loaded too slowly.'];
  const lines = formatResult(lhr, { ...paths, device: 'desktop', mode: 'snapshot' }).split('\n');
  assert.equal(lines[0], 'Lighthouse 13.5.0 · desktop · snapshot (page as it is, no device emulation) · 8.6 s');
  assert.ok(!lines.some((l) => l.startsWith('Metrics:')));
  assert.equal(lines[2], 'Failed or flagged audits (29):');
  assert.equal(lines.filter((l) => l.startsWith('- ')).length, 20);
  assert.equal(lines[3], '- accessibility · color-contrast (fail): Background and foreground colors do not have a sufficient contrast ratio.');
  assert.equal(lines[4], '- SEO · meta-description (fail): Document does not have a meta description');
  assert.equal(lines[23], '… and 9 more in the report.');
  assert.equal(lines[24], 'Warnings: The page loaded too slowly.');
  assert.equal(lines[25], 'Report: /tmp/r/report.html · JSON: /tmp/r/report.json');
});

test('formatResult: an audit in several categories is listed under its heaviest reference and sorted by it', () => {
  const lhr = fakeLhr();
  lhr.audits.shared = { id: 'shared', title: 'Shared audit', score: 0, scoreDisplayMode: 'binary' };
  lhr.categories.accessibility.auditRefs.unshift({ id: 'shared', weight: 0 }); // A: listed first, weight 0
  lhr.categories.seo.auditRefs.push({ id: 'shared', weight: 10 }); // B: weight 10
  const flagged = formatResult(lhr, paths).split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(flagged.slice(0, 3), [
    '- performance · largest-contentful-paint (97): Largest Contentful Paint · 1.7 s',
    '- SEO · shared (fail): Shared audit',
    '- performance · first-contentful-paint (98): First Contentful Paint · 1.3 s',
  ]);
  assert.equal(flagged.filter((l) => l.includes('shared')).length, 1);
});

test('formatResult: a category of weight-0 audits (performance in snapshot mode) counts passes instead of scoring 0', () => {
  const lines = formatResult(fakeLhr({ performance: 'snapshot' }), { ...paths, mode: 'snapshot' }).split('\n');
  assert.equal(lines[1], 'Scores: accessibility 95 · best practices 100 · SEO 90 · agentic browsing n/a · performance n/a (1 of 2 audits pass)');
  assert.ok(!lines.some((l) => l.startsWith('Metrics:')));
});

// --- The run's trace as a gzipped stream ---

const BUSY = 'Tracing has already been started (possibly in another tab).';

test('Tracing.start goes out as a gzipped stream and waits for a busy browser; the stream comes back as dataCollected chunks', async () => {
  Object.assign(TRACE_WAIT, { waitMs: 500, retryMs: 5 });
  // The audited tab's renderer (pid 1), as TracingStartedInBrowser names it.
  const started = { name: 'TracingStartedInBrowser', pid: 2, ts: 0, args: { data: { frameTreeNodeId: 1, frames: [{ frame: 'F', processId: 1, url: 'https://site.example/' }] } } };
  const trace = { traceEvents: [started, ...Array.from({ length: 24_999 }, (_, i) => ({ name: 'e', pid: 1, ts: i }))], metadata: { v: 1 } };
  const gz = zlib.gzipSync(JSON.stringify(trace));
  let starts = 0;
  let offset = 0;
  const tab = fakeTab((method) => {
    if (method === 'Tracing.start' && ++starts < 3) throw new Error(BUSY);
    if (method === 'IO.read') { const chunk = gz.subarray(offset, offset + 1024); offset += 1024; return { data: chunk.toString('base64'), base64Encoded: true, eof: offset >= gz.length }; }
    return {};
  });
  const root = rootSession(tab);
  const seen = [];
  root.on('*', (method) => seen.push(method));
  root.on('Tracing.dataCollected', (p) => seen.push(p.value.length));
  const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
  await root.send('Tracing.start', { categories: '-*,devtools.timeline', options: 'sampling-frequency=10000' });
  assert.equal(starts, 3, 'retried while busy');
  assert.deepEqual(tab.browser.host.calls.at(-1).params, { categories: '-*,devtools.timeline', options: 'sampling-frequency=10000', transferMode: 'ReturnAsStream', streamCompression: 'gzip' });
  event(tab, 'Tracing.tracingComplete', { stream: 's1', dataLossOccurred: false });
  assert.deepEqual(await complete, { dataLossOccurred: false });
  assert.deepEqual(seen, ['Tracing.dataCollected', 10_000, 'Tracing.dataCollected', 10_000, 'Tracing.dataCollected', 5_000, 'Tracing.tracingComplete']);
  const methods = tab.browser.host.calls.map((c) => c.method);
  assert.ok(methods.filter((m) => m === 'IO.read').length >= 2, 'read in chunks');
  assert.equal(methods.at(-1), 'IO.close');
  assert.deepEqual(tab.browser.host.calls.at(-1).params, { handle: 's1' });
  root.close();
});

// Another tab's font request just before the page's layout shift (trace-load.json.gz), in that tab's renderer and frame.
const OTHER_FONT = 'https://other-tab.example/private/font.woff2';
function withOtherTabsFont() {
  const trace = JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/trace-load.json.gz', import.meta.url))));
  const shift = trace.traceEvents.find((e) => e.name === 'LayoutShift');
  const t = trace.traceEvents.filter((e) => e.name === 'PrePaint' && e.pid === shift.pid && e.ts <= shift.ts).at(-1).ts - 50_000;
  const [pid, tid, frame, requestId] = [9999, 1, 'F'.repeat(32), '9999.1'];
  const at = (name, ts, data) => ({ ph: 'I', s: 't', cat: 'devtools.timeline', name, pid, tid, ts, args: { data: { frame, requestId, ...data } } });
  const timing = { requestTime: t / 1e6, proxyStart: -1, proxyEnd: -1, dnsStart: -1, dnsEnd: -1, connectStart: -1, connectEnd: -1, sslStart: -1, sslEnd: -1,
    sendStart: 0.1, sendEnd: 0.2, receiveHeadersStart: 5, receiveHeadersEnd: 5, pushStart: 0, pushEnd: 0, workerStart: -1, workerReady: -1 };
  trace.traceEvents.push(
    { ph: 'M', cat: '__metadata', name: 'process_name', pid, tid: 0, args: { name: 'Renderer' } },
    at('ResourceSendRequest', t, { url: OTHER_FONT, resourceType: 'Font', priority: 'VeryHigh', requestMethod: 'GET', renderBlocking: 'non_blocking' }),
    at('ResourceReceiveResponse', t + 10_000, { mimeType: 'font/woff2', statusCode: 200, encodedDataLength: 100, fromCache: false, fromServiceWorker: false, protocol: 'h2', responseTime: 1, timing }),
    at('ResourceFinish', t + 20_000, { finishTime: (t + 20_000) / 1e6, encodedDataLength: 100, decodedBodyLength: 100, didFail: false }));
  return trace;
}

// Lighthouse 13's insight audits, run offline on a trace as its run would (the trace is all they read here).
async function insightAudits(trace) {
  const { defaultSettings: settings } = await import('lighthouse/core/config/constants.js');
  const dir = new URL('../node_modules/lighthouse/core/audits/insights/', import.meta.url);
  const results = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('-insight.js')).sort()) {
    const { default: audit } = await import(new URL(file, dir));
    const artifacts = { Trace: structuredClone(trace), TraceElements: [], SourceMaps: [], HostDPR: 1, settings };
    results[file] = JSON.stringify(await audit.audit(artifacts, { settings, computedCache: new Map(), options: {} }).catch((e) => `error: ${e.message}`));
  }
  return results;
}

test('Lighthouse gets only the audited tab\'s trace: another tab\'s font request never reaches its layout shift culprits', async () => {
  const trace = withOtherTabsFont();
  const raw = await insightAudits(trace);
  assert.match(raw['cls-culprits-insight.js'], new RegExp(OTHER_FONT.replaceAll('.', '\\.')), 'the whole-browser trace leaks it (as before the fix)');
  // What collectTrace hands Lighthouse.
  const gz = zlib.gzipSync(JSON.stringify(trace));
  const tab = fakeTab((method) => (method === 'IO.read' ? { data: gz.toString('base64'), base64Encoded: true, eof: true } : {}));
  const root = rootSession(tab);
  const handed = [];
  root.on('Tracing.dataCollected', (p) => handed.push(...p.value));
  const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
  event(tab, 'Tracing.tracingComplete', { stream: 's3', dataLossOccurred: false });
  await complete;
  root.close();
  assert.ok(handed.length > 18_000, `the tab's events go through (${handed.length})`);
  assert.doesNotMatch(JSON.stringify(handed), /other-tab\.example/);
  const filtered = await insightAudits({ traceEvents: handed });
  assert.doesNotMatch(filtered['cls-culprits-insight.js'], /other-tab\.example/);
  // The audited page's own results: every insight audit as on the trace without the other tab.
  const clean = await insightAudits(JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/trace-load.json.gz', import.meta.url)))));
  assert.deepEqual(filtered, clean);
  assert.ok(Object.values(clean).every((r) => !r.startsWith('"error')), 'every audit ran');
});

test('a failed stream read still completes the trace, with no events, and closes the stream', async () => {
  const tab = fakeTab((method) => { if (method === 'IO.read') throw new Error('gone'); return {}; });
  const root = rootSession(tab);
  const seen = [];
  root.on('Tracing.dataCollected', (p) => seen.push(p));
  const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
  event(tab, 'Tracing.tracingComplete', { stream: 's2', dataLossOccurred: true });
  assert.deepEqual(await complete, { dataLossOccurred: true });
  assert.deepEqual(seen, []);
  assert.deepEqual(tab.browser.host.calls.map((c) => c.method), ['IO.read', 'IO.close']);
  root.close();
});

test('a Tracing.start retrying while the run closes stops at its next try, and counts as in flight until then', async () => {
  Object.assign(TRACE_WAIT, { waitMs: 500, retryMs: 30 });
  const tab = fakeTab((method) => { if (method === 'Tracing.start') throw new Error(BUSY); return {}; });
  const root = rootSession(tab);
  const sending = root.send('Tracing.start', { categories: '-*' });
  let ended = false;
  sending.catch(() => { ended = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  root.close();
  await root.settled(5000);
  assert.ok(ended, 'settled waited for the retrying start');
  await assert.rejects(sending, /Target closed/);
  assert.equal(tab.browser.host.calls.filter((c) => c.method === 'Tracing.start').length, 1, 'no start after close');
});

test('a stream read that ends after the run closed: completion with no events, IO.close still sent raw', async () => {
  let finishRead;
  const read = new Promise((resolve) => { finishRead = resolve; });
  const tab = fakeTab((method) => (method === 'IO.read' ? read : {}));
  const root = rootSession(tab);
  const seen = [];
  root.on('Tracing.dataCollected', (p) => seen.push(p));
  const complete = new Promise((resolve) => root.once('Tracing.tracingComplete', resolve));
  event(tab, 'Tracing.tracingComplete', { stream: 's2', dataLossOccurred: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tab.browser.host.calls.map((c) => c.method), ['IO.read']);
  root.close();
  finishRead({ data: zlib.gzipSync(JSON.stringify({ traceEvents: [{ name: 'e' }] })).toString('base64'), base64Encoded: true, eof: true });
  assert.deepEqual(await complete, { dataLossOccurred: false });
  assert.deepEqual(seen, [], 'no events for a run that ended');
  assert.deepEqual(tab.browser.host.calls.map((c) => c.method), ['IO.read', 'IO.close']);
});

test('lighthouse with a page dialog open says so at once instead of auditing a page that answers nothing', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const { Tab } = await import('../src/browsers.mjs');
  const { registerTools } = await import('../src/tools.mjs');
  const page = Object.assign(new Emitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, frames: () => [page], isClosed: () => false,
  });
  const sent = [];
  const host = {
    async request(method, params) {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'App' } };
      if (method === 'tabs.info') return { id: 12, owner: 'you', origin: 'agent' };
      sent.push(params?.[1] ?? method);
      return new Promise(() => {}); // the page under an alert answers nothing
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 12, page);
  browser.tabs.set(12, tab);
  tab.dialog = { type: () => 'alert', message: () => 'Session expiring', defaultValue: () => '' };
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  for (const mode of ['snapshot', 'navigation']) {
    const result = await Promise.race([tools.lighthouse({ tab: tab.id, mode }), new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
    assert.notEqual(result, 'still waiting', mode);
    assert.equal(result.isError, true, mode);
    assert.match(result.content[0].text, /A dialog is open on this tab; resolve it with the dialog tool first\./, mode);
  }
  assert.deepEqual(sent, []);
});

test('an audit during which the page loaded a refused local file is discarded: no report is made or written', async () => {
  const { Tab } = await import('../src/browsers.mjs');
  const { registerTools } = await import('../src/tools.mjs');
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, frames: () => [page], isClosed: () => false,
  });
  const host = Object.assign(new EventEmitter(), {
    async request(method, params) {
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'App', url: 'https://app.example/' } };
      if (method === 'tabs.info') return { id: 12, owner: 'you', origin: 'agent' };
      return {};
    },
  });
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 12, page);
  browser.tabs.set(12, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const reports = [];
  let during = () => {};
  const real = auditor.load;
  auditor.load = async () => ({
    snapshot: async () => { during(); return { lhr: fakeLhr() }; },
    generateReport: (lhr) => { reports.push(lhr); return '<html>'; },
  });
  try {
    // A timer loads a refused <script> during gathering (it may write into nodes the report lists), or the page goes
    // to a refused file and back.
    for (const refused of [() => tab.loaded('file:///nowhere/private.js', false), () => { tab._newDocument('file:///nowhere/x.html'); tab._newDocument('https://app.example/'); }]) {
      tab._newDocument('https://app.example/'); // a clean document each time
      during = refused;
      const result = await tools.lighthouse({ tab: tab.id, mode: 'snapshot' });
      assert.equal(result.isError, true, result.content[0].text);
      assert.match(result.content[0].text, /local file agents can't open|loaded a local file that agents can't open/);
      assert.deepEqual(reports, [], 'no report generated');
    }
    // Without one, the same run saves its reports (the stand-in works).
    tab._newDocument('https://app.example/');
    during = () => {};
    const ok = await tools.lighthouse({ tab: 'chrome:12', mode: 'snapshot' });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    assert.equal(reports.length, 1);
    fs.rmSync(path.dirname(/Report: (\S+)/.exec(ok.content[0].text)[1]), { recursive: true });
  } finally {
    auditor.load = real;
  }
});
