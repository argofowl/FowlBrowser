// The trace summary and insight details over two real traces of test/site/perf.html (screenshots and script sources
// stripped): a page load (render-blocking CSS, long task, layout shift, late text LCP) and a slow click (INP).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { TRACE_WAIT, tracingSlot } from '../src/perf.mjs';
import { insightText, parseTrace, registerTrace, summaryText, tracedTabOnly } from '../src/trace.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const load = (name) => parseTrace(JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))));
const pageLoad = await load('trace-load.json.gz');
const click = await load('trace-click.json.gz');

test('summary of a page load: set, metrics, long tasks, file', () => {
  const s = summaryText(pageLoad, { file: '/tmp/t.json.gz' });
  assert.match(s, /^Trace: http:\/\/127\.0\.0\.1:\d+\/perf\.html\S* · 2\.5 s · [\d,]+ events$/m);
  assert.match(s, /^File: \/tmp\/t\.json\.gz /m);
  assert.match(s, /^Throttling: CPU none · network none$/m);
  assert.match(s, /^NAVIGATION_0: http:\/\/127\.0\.0\.1:\d+\/perf\.html\S* · \d+ ms to [\d,]+ ms of the trace$/m);
  assert.match(s, /^LCP: 928 ms \(TTFB 2 ms · render delay 926 ms\) · element: P id='hero' \(node 10\) · text$/m);
  assert.match(s, /^INP: n\/a \(no interactions\)$/m);
  assert.match(s, /^CLS: 0\.02$/m);
  assert.match(s, /^Long tasks: 1 over 50 ms, longest 151 ms$/m);
  assert.match(s, /^Details: trace_insight \{tab, name\}$/m);
});

test('summary lists failing, then informative insights, then the passed ones on one line', () => {
  const lines = summaryText(pageLoad, { file: 'f' }).split('\n');
  const listed = lines.filter((l) => l.startsWith('- ')).map((l) => /^- (\w+) \((\w+)\)/.exec(l).slice(1, 3));
  assert.deepEqual(listed, [['RenderBlocking', 'fail'], ['NetworkDependencyTree', 'fail'], ['LCPBreakdown', 'informative'], ['CLSCulprits', 'informative']]);
  assert.ok(lines.includes('- RenderBlocking (fail): Render-blocking requests · est. FCP -140 ms · est. LCP -140 ms'));
  const passed = lines.filter((l) => l.startsWith('Passed: '));
  assert.equal(passed.length, 1);
  assert.match(passed[0], /^Passed: INPBreakdown, LCPDiscovery, .*LegacyJavaScript$/);
  assert.ok(!/RenderBlocking/.test(passed[0]));
});

test('summary of an interaction: INP with its phases, no LCP', () => {
  const s = summaryText(click, { file: 'f', dataLoss: true });
  assert.match(s, /some events were lost/);
  assert.match(s, /^NO_NAVIGATION: /m);
  assert.match(s, /^LCP: n\/a /m);
  assert.match(s, /^INP: 231 ms \(pointerdown: input delay 1 ms · processing 201 ms · presentation delay 28 ms\)$/m);
  assert.match(s, /^- INPBreakdown \(fail\): INP breakdown$/m);
});

test('insight details: title, plain description, savings, data', () => {
  const lcp = insightText(pageLoad, 'LCPBreakdown');
  assert.match(lcp, /^LCPBreakdown \(informative\): LCP breakdown\nEach \[subpart has specific improvement strategies\]\(https:\/\/developer\.chrome\.com\/[^)]+\)/);
  assert.match(lcp, /^Estimated savings: none$/m);
  assert.match(lcp, /^- TTFB: 2 ms \(0%\)$/m);
  assert.match(lcp, /^- render delay: 926 ms \(100%\)$/m);
  const rb = insightText(pageLoad, 'RenderBlocking');
  assert.match(rb, /^Estimated savings: FCP -140 ms · LCP -140 ms$/m);
  assert.match(rb, /^- http:\/\/127\.0\.0\.1:\d+\/style\.css\?delay=300 · 303 ms · 516 B · est\. 151 ms saved without it$/m);
  assert.match(insightText(pageLoad, 'CLSCulprits'), /^Shift 1: at 721 ms, score 0\.017 · moved: H1, /m);
  assert.match(insightText(pageLoad, 'DocumentLatency'), /^- \[pass\] Server responds quickly \(observed \d+ ms\)$/m);
  assert.match(insightText(click, 'INPBreakdown'), /^Longest interaction: pointerdown, 231 ms\n- input delay: 1 ms\n- processing: 201 ms\n- presentation delay: 28 ms$/m);
  assert.match(insightText(pageLoad, 'INPBreakdown'), /^No interactions in this trace\.$/m);
  for (const name of Object.keys(pageLoad.insights.get('NAVIGATION_0').model)) assert.ok(insightText(pageLoad, name).length > 0, name);
});

test('unknown insight or set: the error lists what exists', () => {
  assert.throws(() => insightText(pageLoad, 'Nope'), /^Error: No insight "Nope"\. Insights of the last trace: .*\bRenderBlocking\b.*\bLCPBreakdown\b/);
  assert.throws(() => insightText(pageLoad, 'LCPBreakdown', 'NAVIGATION_7'), /No insight set "NAVIGATION_7"\. Sets of the last trace: NAVIGATION_0/);
});

test('insight details are cut at 20,000 characters', async () => {
  const parsed = await load('trace-load.json.gz');
  const rb = parsed.insights.get('NAVIGATION_0').model.RenderBlocking;
  rb.renderBlockingRequests = Array(2000).fill(rb.renderBlockingRequests[0]);
  const out = insightText(parsed, 'RenderBlocking');
  assert.ok(out.length <= 20_000, String(out.length));
  assert.match(out, /\.\.\. \[\d+ more lines not shown\. The trace file has everything/);
});

test('a failed insight generator: the summary names it with its error, trace_insight says the engine failed', async () => {
  const parsed = await load('trace-load.json.gz');
  const set = parsed.insights.get('NAVIGATION_0');
  delete set.model.RenderBlocking;
  set.modelErrors.RenderBlocking = new Error('boom\nstack');
  const s = summaryText(parsed, { file: 'f' });
  assert.match(s, /^Could not compute: RenderBlocking \(boom\)$/m);
  assert.ok(!/^- RenderBlocking /m.test(s));
  assert.throws(() => insightText(parsed, 'RenderBlocking'), /^Error: The trace engine failed to compute RenderBlocking: boom$/);
});

test('DuplicatedJavaScript is not shown as passed: it needs source maps', () => {
  const lines = summaryText(pageLoad, { file: 'f' }).split('\n');
  assert.ok(!lines.find((l) => l.startsWith('Passed: ')).includes('DuplicatedJavaScript'));
  assert.ok(lines.includes('Not computed (needs source maps, which are not fetched): DuplicatedJavaScript'));
  assert.match(insightText(pageLoad, 'DuplicatedJavaScript'), /^DuplicatedJavaScript: not computed\. It needs the scripts' source maps, which are not fetched/);
});

test('parsing resets the engine\'s module state without touching the parsed traces kept', async () => {
  const before = [summaryText(pageLoad, { file: 'f' }), ...Object.keys(pageLoad.insights.get('NAVIGATION_0').model).map((n) => insightText(pageLoad, n))];
  await load('trace-click.json.gz');
  const after = [summaryText(pageLoad, { file: 'f' }), ...Object.keys(pageLoad.insights.get('NAVIGATION_0').model).map((n) => insightText(pageLoad, n))];
  assert.deepEqual(after, before);
  const Trace = await import('@paulirish/trace_engine');
  assert.throws(() => Trace.Helpers.SyntheticEvents.SyntheticEventsManager.getActiveManager(), /without initializing/);
});

// --- The traced tab only ---

const fixture = (name) => JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url))));
// Another tab's renderer process, as a whole-browser trace has it.
const otherRenderer = [
  { ph: 'M', name: 'process_name', pid: 777, tid: 0, args: { name: 'Renderer' } },
  { ph: 'X', cat: 'devtools.timeline', name: 'RunTask', pid: 777, tid: 1, ts: 1, dur: 60_000, args: {} },
  { ph: 'I', cat: 'devtools.timeline', name: 'ResourceSendRequest', pid: 777, tid: 1, ts: 2, args: { data: { url: 'https://mail.example/inbox?id=7' } } },
];
const FOREIGN = /example\.com|example\.org|google\.com|user-lighthouse|mail\.example/;

test('a trace keeps only the traced tab: other tabs\' URLs, frame tree nodes and renderer processes go', () => {
  const json = fixture('trace-load.json.gz');
  json.traceEvents.push(...otherRenderer);
  assert.match(JSON.stringify(json.traceEvents), FOREIGN, 'the fixture has other tabs in it');
  const kept = tracedTabOnly(json);
  const text = JSON.stringify(kept.traceEvents);
  assert.doesNotMatch(text, FOREIGN);
  assert.ok(!kept.traceEvents.some((e) => e.pid === 777), 'another tab\'s renderer');
  assert.ok(!kept.traceEvents.some((e) => e.args?.render_frame_host?.frame_tree_node_id === 222), 'another tab\'s frame tree node');
  assert.match(text, /perf\.html\?t=trace-chrome/, 'the traced page stays');
  assert.deepEqual(kept.metadata, json.metadata);
  assert.deepEqual(tracedTabOnly({ traceEvents: otherRenderer }).traceEvents, [], 'no TracingStartedInBrowser: nothing can be told apart');
});

test('URLs without // (data:, blob:, about:, javascript:) of another tab are recognized too, by key or by scheme', () => {
  const json = fixture('trace-load.json.gz');
  const browser = json.traceEvents.find((e) => e.name === 'TracingStartedInBrowser').pid;
  const at = (name, args) => ({ ph: 'I', cat: 'loading', name, pid: browser, tid: 1, ts: 1, s: 't', args });
  json.traceEvents.push(
    at('UkmPageLoadTimingUpdate', { ukm_page_load_timing_update: { latest_url: 'data:text/html,<p>secret-inbox</p>' } }),
    at('SomeBrowserEvent', { data: { documentLoaderURL: 'blob:https://mail.example/1234' } }),
    at('AnotherBrowserEvent', { data: { target: 'javascript:alert(\'secret-script\')' } }),
    at('YetAnother', { info: { href: 'about:srcdoc#secret-anchor' } }));
  const text = JSON.stringify(tracedTabOnly(json).traceEvents);
  assert.doesNotMatch(text, /secret-inbox|mail\.example|secret-script|secret-anchor/);
  assert.match(text, /about:blank/, 'the traced tab\'s own about:blank frame stays');
});

test('the traced tab\'s summary and every insight are the same before and after the filter', async () => {
  for (const name of ['trace-load.json.gz', 'trace-click.json.gz']) {
    const before = await parseTrace(fixture(name));
    const after = await parseTrace(tracedTabOnly(fixture(name)));
    const summary = (parsed) => summaryText(parsed, { file: 'f' }).replace(/[\d,]+ events/, 'events');
    assert.equal(summary(after), summary(before), name);
    for (const [set, { model }] of before.insights) {
      for (const insight of Object.keys(model)) {
        const details = (parsed) => { try { return insightText(parsed, insight, set); } catch (error) { return error.message; } };
        assert.equal(details(after), details(before), `${name} ${set} ${insight}`);
      }
    }
  }
});

// --- Recording, through a fake tab whose host answers the CDP commands ---

const clickTrace = zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/trace-click.json.gz', import.meta.url))).toString('utf8');
const tools = {};
registerTrace((name, description, shape, handler) => { tools[name] = handler; }, null,
  { withTab: (handler) => handler, header: async () => 'Tab: chrome:1', text: (body) => body, tabArg: undefined,
    // As tools.mjs's, over blockedPageAt alone (these tabs show a web page).
    blockedSince: (tab, before) => tab.blockedPageAt !== before,
    refuseBlockedPage: (tab, before) => { if (before !== undefined && tab.blockedPageAt !== before) throw new Error(`Tab ${tab.id}: discarded.`); } });

// As Chrome streams it (streamCompression gzip), with another tab's renderer process in it.
const clickTraceGz = zlib.gzipSync(JSON.stringify((({ traceEvents, ...rest }) => ({ ...rest, traceEvents: [...traceEvents, ...otherRenderer] }))(JSON.parse(clickTrace))));
const BUSY = 'Tracing has already been started (possibly in another tab).';
Object.assign(TRACE_WAIT, { waitMs: 100, retryMs: 5 }); // a busy browser is waited for this long here

// `fail`: command -> error message, or a function of the command's 1-based count returning one (or nothing).
function fakeTab(fail = {}) {
  const host = new EventEmitter();
  const sent = [];
  const params = [];
  const counts = {};
  host.request = async (method, args) => {
    if (method === 'tabs.info') return null;
    const [, command, p] = args;
    sent.push(command);
    params.push(p);
    counts[command] = (counts[command] ?? 0) + 1;
    const message = typeof fail[command] === 'function' ? fail[command](counts[command]) : fail[command];
    if (message) throw new Error(message);
    if (command === 'Tracing.end') {
      setImmediate(() => host.emit('chrome.debugger.onEvent', [{ tabId: 1 }, 'Tracing.tracingComplete', { stream: 's1', dataLossOccurred: false }]));
    }
    if (command === 'IO.read') return { data: clickTraceGz.toString('base64'), base64Encoded: true, eof: true };
    return {};
  };
  const page = new EventEmitter();
  page.gotos = [];
  page.url = () => 'http://127.0.0.1/perf.html';
  page.goto = async (u) => { page.gotos.push(u); };
  return { id: 'chrome:1', tabId: 1, page, browser: { host }, sent, params };
}

const slotIsFree = async () => (await Promise.race([tracingSlot(), sleep(500).then(() => null)]))?.();
// 'held' or 'free' now; a queued acquire releases the slot the moment it gets it, so nothing stays held by the check.
const slotState = () => Promise.race([tracingSlot().then((release) => { release(); return 'free'; }), sleep(300).then(() => 'held')]);

test('trace_start takes the slot first; a busy browser is waited for on the page as it is, then given up on', async () => {
  const tab = fakeTab({ 'Tracing.start': BUSY });
  const held = await tracingSlot();
  const started = tools.trace_start(tab, { reload: true, auto_stop: false }).then(() => null, (e) => e.message);
  await sleep(20);
  assert.deepEqual(tab.sent, [], 'nothing is sent while the slot is held');
  held();
  assert.match(await started, /^Chrome records one trace at a time and something else kept recording/);
  assert.ok(tab.sent.filter((c) => c === 'Tracing.start').length >= 3, `retried (${tab.sent.length} sends)`);
  assert.deepEqual(tab.page.gotos, [], 'the page was never blanked');
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(!tab.trace?.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: busy at first, then free: the empty probe trace ends, the page is blanked and the recording starts gzipped', async () => {
  const tab = fakeTab({ 'Tracing.start': (n) => (n < 3 ? BUSY : undefined) });
  assert.match(await tools.trace_start(tab, { reload: true, auto_stop: false }), /Trace recording \(page reloaded\)\./);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.start', 'Tracing.start', 'Tracing.end', 'IO.close', 'Tracing.start']);
  assert.deepEqual(tab.params[0].traceConfig, { includedCategories: ['__metadata'], excludedCategories: ['*'] });
  assert.equal(tab.params[5].streamCompression, 'gzip');
  assert.deepEqual(tab.page.gotos, ['about:blank', 'http://127.0.0.1/perf.html']);
  tab.trace.waitedMs = 3000;
  const out = await tools.trace_stop(tab);
  const file = /^File: (\S+)/m.exec(out)[1];
  const saved = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
  assert.deepEqual(JSON.parse(saved), tracedTabOnly(JSON.parse(clickTrace)), 'saved gzipped, the traced tab only');
  assert.doesNotMatch(saved, FOREIGN);
  fs.rmSync(file);
  assert.match(out, /^Waited 3 s for another session's trace to end before recording\.$/m);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: a blank navigation that fails after it began (the page may have changed) is undone too', async () => {
  const tab = fakeTab();
  tab.page.goto = async (u) => { tab.page.gotos.push(u); if (u === 'about:blank') throw new Error('load wait timed out'); };
  await assert.rejects(tools.trace_start(tab, { reload: true, auto_stop: false }), /load wait timed out/);
  assert.deepEqual(tab.page.gotos, ['about:blank', 'http://127.0.0.1/perf.html']);
  assert.ok(!tab.trace?.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: a reload that fails after the start ends the recording; a lost trace read still lets go, a refused end keeps it tracked', async () => {
  // Chrome stopped (IO.read failed after a successful end): nothing is recording, so the state and the slot go.
  let tab = fakeTab({ 'IO.read': 'read refused' });
  tab.page.goto = async (u) => { tab.page.gotos.push(u); if (u !== 'about:blank') throw new Error('load failed'); };
  await assert.rejects(tools.trace_start(tab, { reload: true, auto_stop: false }), (e) => /load failed/.test(e.message) && !/could not be ended/.test(e.message));
  assert.ok(!tab.trace.startedAt);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.notEqual(await slotIsFree(), null, 'slot released');
  // The end itself refused: Chrome may still record, so the recording stays tracked for trace_stop, with the slot.
  tab = fakeTab({ 'Tracing.end': (n) => (n === 2 ? 'Request refused: the browser is not keeping up' : undefined) }); // the probe's end is the first
  tab.page.goto = async (u) => { tab.page.gotos.push(u); if (u !== 'about:blank') throw new Error('load failed'); };
  await assert.rejects(tools.trace_start(tab, { reload: true, auto_stop: false }), /load failed\nThe recording could not be ended \(Request refused: the browser is not keeping up\): call trace_stop to end it\./);
  assert.ok(tab.trace.startedAt, 'still tracked');
  assert.equal(tab.page.listenerCount('close'), 1);
  assert.equal(await slotState(), 'held', 'slot still held');
  const out = await tools.trace_stop(tab);
  fs.rmSync(/^File: (\S+)/m.exec(out)[1]);
  assert.ok(!tab.trace.startedAt);
  assert.equal(await slotState(), 'free', 'slot released by trace_stop');
});

test('trace_start: a tab that closed while the start was underway is let go of at once', async () => {
  const tab = fakeTab();
  tab.page.isClosed = () => true;
  await assert.rejects(tools.trace_start(tab, { reload: false, auto_stop: false }), /The tab closed while the trace started/);
  assert.ok(!tab.trace.startedAt);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_start: a start failing after the page was blanked releases the slot and goes back', async () => {
  const tab = fakeTab({ 'Tracing.start': (n) => (n === 2 ? 'boom' : undefined) });
  await assert.rejects(tools.trace_start(tab, { reload: true, auto_stop: false }), /boom/);
  assert.deepEqual(tab.page.gotos, ['about:blank', 'http://127.0.0.1/perf.html']);
  assert.ok(!tab.trace?.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop end to end: summary and file, and the close listener goes with the recording', async () => {
  const tab = fakeTab();
  assert.match(await tools.trace_start(tab, { reload: false, auto_stop: false }), /Trace recording\./);
  assert.equal(tab.page.listenerCount('close'), 1);
  const out = await tools.trace_stop(tab);
  const file = /^File: (\S+)/m.exec(out)[1];
  fs.rmSync(file);
  assert.match(out, /^INP: 231 ms /m);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.equal(tab.browser.host.listenerCount('chrome.debugger.onEvent'), 0);
  assert.ok(tab.trace.last && !tab.trace.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop: a recording during which the tab showed a local file is discarded, not saved', async () => {
  const tab = fakeTab();
  assert.match(await tools.trace_start(tab, { reload: false, auto_stop: false }), /Trace recording\./);
  tab.blockedPageAt = Date.now(); // history back into a local file page, then away again
  await assert.rejects(tools.trace_stop(tab), /showed or loaded a local file agents can't open during the recording.*trace was discarded/);
  assert.ok(!tab.trace.startedAt && !tab.trace.last, 'nothing kept');
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.equal(await slotState(), 'free', 'slot released');
});

test('trace_start: a refused file the page loads while the recording is set up voids it, auto-stop or not', async () => {
  for (const autoStop of [true, false]) {
    const tab = fakeTab();
    tab.blockedPageAt = 5;
    const request = tab.browser.host.request;
    tab.browser.host.request = async (method, args) => {
      if (args?.[1] === 'Tracing.start') tab.blockedPageAt = 6; // a timer loads a refused <script> while Chrome starts
      return request(method, args);
    };
    await assert.rejects(tools.trace_start(tab, { reload: false, auto_stop: autoStop, seconds: 0.01 }), /discarded/);
    assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close'], 'the recording was ended');
    assert.ok(!tab.trace.startedAt && !tab.trace.last, 'nothing kept');
    assert.equal(await slotState(), 'free', 'slot released');
  }
});

test('trace_start with auto-stop: a refused file loaded during the recording discards it at the stop', async () => {
  const tab = fakeTab();
  tab.blockedPageAt = 5;
  setTimeout(() => { tab.blockedPageAt = 6; }, 10);
  await assert.rejects(tools.trace_start(tab, { reload: false, seconds: 0.05 }), /during the recording.*trace was discarded/);
  assert.ok(!tab.trace.startedAt && !tab.trace.last, 'nothing kept');
  assert.equal(await slotState(), 'free', 'slot released');
});

test('trace_stop: a refused Tracing.end stops waiting for tracingComplete and keeps the recording for a retry', async () => {
  const tab = fakeTab({ 'Tracing.end': (n) => (n === 1 ? 'end failed' : undefined) });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  await assert.rejects(tools.trace_stop(tab), /^Error: Chrome did not stop the recording: end failed\. Call trace_stop again\.$/);
  assert.equal(tab.browser.host.listenerCount('chrome.debugger.onEvent'), 0);
  assert.ok(tab.trace.startedAt, 'still tracked');
  assert.equal(tab.page.listenerCount('close'), 1);
  assert.equal(await slotState(), 'held', 'slot still held');
  const out = await tools.trace_stop(tab);
  fs.rmSync(/^File: (\S+)/m.exec(out)[1]);
  assert.match(out, /^INP: 231 ms /m);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(!tab.trace.startedAt);
  assert.equal(await slotState(), 'free', 'slot released by the retry');
});

test('trace_stop: a refused Tracing.end in a tab that closed meanwhile lets the recording go', async () => {
  const tab = fakeTab({ 'Tracing.end': 'end failed' });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  tab.page.isClosed = () => true;
  await assert.rejects(tools.trace_stop(tab), /^Error: end failed$/);
  assert.equal(tab.page.listenerCount('close'), 0);
  assert.ok(!tab.trace.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop: Chrome saying no trace is running lets the recording go', async () => {
  const tab = fakeTab({ 'Tracing.end': 'Tracing is not started' });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  await assert.rejects(tools.trace_stop(tab), /^Error: Tracing is not started$/);
  assert.ok(!tab.trace.startedAt);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('trace_stop: a failing IO.read still closes the stream', async () => {
  const tab = fakeTab({ 'IO.read': 'read failed' });
  await tools.trace_start(tab, { reload: false, auto_stop: false });
  await assert.rejects(tools.trace_stop(tab), /read failed/);
  assert.deepEqual(tab.sent, ['Tracing.start', 'Tracing.end', 'IO.read', 'IO.close']);
  assert.notEqual(await slotIsFree(), null, 'slot released');
});

test('a short trace with no page load, interaction or layout shift has no insight sets: the summary says so and still lists long tasks', async () => {
  const json = JSON.parse(clickTrace);
  const idle = await parseTrace((json.traceEvents ?? json).filter((e) => e.name !== 'EventTiming')); // the click taken out
  assert.equal(idle.insights.size, 0);
  const s = summaryText(idle, { file: 'f' });
  assert.match(s, /^No metrics or insights: the trace engine reports none for a trace under 5 s without a page load, an interaction or a layout shift\.$/m);
  assert.match(s, /^Long tasks: 2 over 50 ms, longest 204 ms$/m);
  assert.ok(!/trace_insight/.test(s), 'no pointer to insight details that do not exist');
  assert.throws(() => insightText(idle, 'INPBreakdown'), /^Error: No metrics or insights: .*, so the last trace has no insight details\.$/);
});

test('trace_start never reloads the user\'s page: a claimed tab, one handed to them, or one kept for them (a child of their tab)', async () => {
  for (const info of [{ origin: 'user' }, { origin: 'agent', kept: true, handedOver: true }, { origin: 'agent', kept: true }]) {
    const tab = fakeTab();
    const request = tab.browser.host.request;
    tab.browser.host.request = async (method, args) => (method === 'tabs.info' ? { owner: 'you', kept: false, handedOver: false, ...info } : request(method, args));
    const result = await tools.trace_start(tab, { reload: true, auto_stop: false }).then(() => 'reloaded', (e) => e.message);
    if (result === 'reloaded') await tools.trace_stop(tab);
    assert.match(result, /user's own tab, so it was not reloaded/, JSON.stringify(info));
    assert.deepEqual(tab.page.gotos, []);
  }
});
