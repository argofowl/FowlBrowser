// Performance traces: trace_start, trace_stop, trace_insight. Recorded on the tab's own debugger session (Tracing, IO),
// parsed with DevTools' trace engine, which also computes the insights of DevTools' Performance panel.
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { z } from 'zod';
import { debug } from './debug.mjs';
import { cdp, cdpEvent, fileTab, isUsersTab, outputDir, readStream, stamp, startTracing, traceBusy, tracingSlot, waitForTracing } from './perf.mjs';
import { cap } from './snapshots.mjs';
import { notice } from './takeover.mjs';
import { sleep, within } from './util.mjs';

const INSIGHT_MAX_CHARS = 20_000;
const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

// DevTools' default timeline categories plus JS sampling and screenshots (what DevTools and chrome-devtools-mcp record).
const CATEGORIES = ['-*', 'blink.console', 'blink.user_timing', 'loading', 'devtools.timeline', 'disabled-by-default-devtools.target-rundown',
  'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack', 'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.v8-source-rundown-sources', 'disabled-by-default-devtools.v8-source-rundown', 'disabled-by-default-layout_shift.debug',
  'disabled-by-default-v8.inspector', 'disabled-by-default-v8.cpu_profiler.hires', 'disabled-by-default-lighthouse', 'v8.execute', 'v8', 'cppgc',
  'navigation', 'rail', 'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-devtools.screenshot'];

// --- Parsing ---

let engine;
async function traceEngine() {
  if (!engine) {
    // The engine measures layout shift rects with DOMRect, which Node lacks.
    globalThis.DOMRect ??= class DOMRect {
      constructor(x = 0, y = 0, width = 0, height = 0) { Object.assign(this, { x, y, width, height }); }
      get left() { return Math.min(this.x, this.x + this.width); }
      get right() { return Math.max(this.x, this.x + this.width); }
      get top() { return Math.min(this.y, this.y + this.height); }
      get bottom() { return Math.max(this.y, this.y + this.height); }
    };
    engine = await import('@paulirish/trace_engine');
  }
  return engine;
}

// A new model per trace: a model keeps every trace it parsed. The engine's handlers and its active synthetic events
// manager are module state, so two parses at once would corrupt each other; they never overlap because every caller
// holds the process-wide tracingSlot (trace_stop parses before it releases, Lighthouse runs inside it). After the parse,
// the resets drop that module state (the last trace's raw events): the handlers reassign their maps on reset, so the
// parsed data kept per tab stays intact.
export async function parseTrace(json) {
  const Trace = await traceEngine();
  const model = Trace.TraceModel.Model.createWithAllHandlers();
  try {
    await model.parse(json.traceEvents ?? json);
    return model.parsedTrace();
  } finally {
    model.resetProcessor();
    Trace.Helpers.SyntheticEvents.SyntheticEventsManager.reset();
  }
}

// Drops the engine's module state after someone else parsed with it (Lighthouse does, in-process).
export async function resetEngine() {
  const Trace = await traceEngine();
  Trace.TraceModel.Model.createWithAllHandlers().resetProcessor();
  Trace.Helpers.SyntheticEvents.SyntheticEventsManager.reset();
}

// --- The traced tab only ---

// Chrome traces the whole browser: other tabs' renderer processes, and browser process events about every tab's
// navigations (their URLs, origins, frame tree nodes and processes). Before a trace is saved or read, everything that
// isn't the traced tab's goes: kept are the renderer processes of its frames (TracingStartedInBrowser lists them at the
// start, FrameCommittedInBrowser adds the ones committed later, children included) without events about other frames,
// and the browser, GPU and other non-renderer processes' events that name only its frames, frame tree node, renderer
// processes and pages (an event with URLs and none of those: only its frames' URLs and origins; another tab of the same
// site has other URLs). A renderer process it shares with a same-site tab still holds that tab's frameless events
// (JS samples). A trace without TracingStartedInBrowser can't be told apart, so nothing of it is kept.
const FRAME_KEYS = new Set(['frame', 'frameId', 'parent', 'page']);
const NODE_KEYS = new Set(['frame_tree_node_id', 'frameTreeNodeId']);
const PROCESS_KEYS = new Set(['child_process_id', 'processId']);
// URLs: a value under a URL key (url, documentLoaderURL, latest_url, site_url, origin...), a value that starts with a
// scheme (data:, blob:, about:, javascript:... have no //), and any scheme:// inside other text.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'{},]*/gi;
const URL_KEY = /url|uri|origin|site|href|location|filename/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\S/i;

function references(args) {
  const found = { frames: [], nodes: [], processes: [], urls: [] };
  const walk = (value, key) => {
    if (typeof value === 'string') {
      if (FRAME_KEYS.has(key)) found.frames.push(value);
      if (URL_KEY.test(key) || SCHEME.test(value)) found.urls.push(value);
      else found.urls.push(...(value.match(URL_PATTERN) ?? []));
    } else if (typeof value === 'number') {
      if (NODE_KEYS.has(key)) found.nodes.push(value);
      if (PROCESS_KEYS.has(key)) found.processes.push(value);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, Array.isArray(value) ? key : k);
    }
  };
  walk(args, '');
  return found;
}

const originOf = (u) => { try { const { origin } = new URL(u); return origin === 'null' ? null : origin; } catch { return null; } };

export function tracedTabOnly(json) {
  const events = json.traceEvents ?? json;
  const started = events.find((e) => e.name === 'TracingStartedInBrowser')?.args?.data;
  const keep = (kept) => (Array.isArray(json) ? kept : { ...json, traceEvents: kept });
  if (!started) return keep([]);
  const node = started.frameTreeNodeId;
  const frames = new Set();
  const pids = new Set();
  const urls = new Set(); // its frames' URLs and origins
  const add = (f) => {
    frames.add(f.frame);
    if (f.processId) pids.add(f.processId);
    if (typeof f.url === 'string') urls.add(f.url); // about:blank and data: frames too
    const origin = originOf(f.url);
    if (origin) urls.add(origin).add(`${origin}/`);
  };
  for (const f of started.frames ?? []) add(f);
  // Frames committed later (a navigation to another process, a child frame), in one pass per level of the tree.
  const commits = events.filter((e) => e.name === 'FrameCommittedInBrowser' && e.args?.data?.frame);
  for (let size = -1; size !== frames.size + pids.size;) {
    size = frames.size + pids.size;
    for (const { args: { data } } of commits) if (frames.has(data.frame) || frames.has(data.parent)) add(data);
  }
  const renderers = new Set(events.filter((e) => e.ph === 'M' && e.name === 'process_name' && /renderer/i.test(e.args?.name ?? '')).map((e) => e.pid));
  return keep(events.filter((e) => {
    if (renderers.has(e.pid) && !pids.has(e.pid)) return false; // another tab's renderer
    const refs = references(e.args);
    if (!refs.frames.every((f) => frames.has(f))) return false;
    if (pids.has(e.pid)) return true;
    if (!refs.nodes.every((n) => n === node) || !refs.processes.every((p) => pids.has(p))) return false;
    return refs.frames.length > 0 || refs.nodes.length > 0 || refs.urls.every((u) => urls.has(u));
  }));
}

// --- Formatting ---

const ms = (micro) => `${Math.round(micro / 1000).toLocaleString('en-US')} ms`;
const msOf = (milli) => `${Math.round(milli).toLocaleString('en-US')} ms`;
function bytes(n) {
  if (!(n >= 0)) return '?';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}
const url = (u) => (u?.startsWith('data:') && u.length > 80 ? `${u.slice(0, 80)}…` : u);
const reqUrl = (req) => url(req.args.data.url);

// The engine's labels are i18n objects ({i18nId: 'Server responds quickly (observed {PH1})', values}).
function label(l) {
  if (typeof l === 'string') return l;
  return String(l?.i18nId ?? '').replace(/\{(\w+)\}/g, (_, key) => {
    const v = l.values?.[key];
    if (v?.__i18nMillis != null) return msOf(v.__i18nMillis);
    if (v?.__i18nBytes != null) return bytes(v.__i18nBytes);
    return v ?? '';
  });
}

function savings(insight, prefix = '') {
  const parts = [];
  for (const [metric, v] of Object.entries(insight.metricSavings ?? {})) {
    if (v > 0) parts.push(`${prefix}${metric} -${metric === 'CLS' ? v.toFixed(2) : msOf(v)}`);
  }
  if (insight.wastedBytes > 0) parts.push(`wasted ${bytes(insight.wastedBytes)}`);
  return parts;
}

const checklist = (list) => Object.values(list ?? {}).map((item) => `- [${item.value ? 'pass' : 'FAIL'}] ${label(item.label)}`);

function lcpElement(lcp) {
  const data = lcp.lcpEvent?.args?.data;
  const node = data?.nodeName ? `${data.nodeName} (node ${data.nodeId})` : data?.nodeId != null ? `node ${data.nodeId}` : 'unknown';
  return lcp.lcpRequest ? `${node} · image ${reqUrl(lcp.lcpRequest)}` : `${node} · text`;
}

const SUBPARTS = { ttfb: 'TTFB', loadDelay: 'load delay', loadDuration: 'load duration', renderDelay: 'render delay' };

function lcpLine(lcp) {
  if (!lcp?.lcpMs) return 'LCP: n/a (no LCP in this trace: it holds no page load)';
  const parts = Object.entries(lcp.subparts ?? {}).map(([key, s]) => `${SUBPARTS[key] ?? key} ${ms(s.range)}`);
  return `LCP: ${msOf(lcp.lcpMs)}${parts.length ? ` (${parts.join(' · ')})` : ''} · element: ${lcpElement(lcp)}`;
}

function inpLine(event) {
  if (!event) return 'INP: n/a (no interactions)';
  return `INP: ${ms(event.dur)} (${event.type}: input delay ${ms(event.inputDelay)} · processing ${ms(event.mainThreadHandling)} · presentation delay ${ms(event.presentationDelay)})`;
}

// Main-thread tasks over 50 ms inside the bounds, from every renderer process of the main frame.
function longTasks(parsed, bounds) {
  const tasks = [];
  for (const proc of parsed.data.Renderer.processes.values()) {
    if (!proc.isOnMainFrame) continue;
    for (const thread of proc.threads.values()) {
      if (thread.name !== 'CrRendererMain') continue;
      for (const e of thread.entries) if (e.name === 'RunTask' && e.dur > 50_000 && e.ts >= bounds.min && e.ts <= bounds.max) tasks.push(e);
    }
  }
  if (!tasks.length) return 'Long tasks: none over 50 ms';
  return `Long tasks: ${tasks.length} over 50 ms, longest ${ms(Math.max(...tasks.map((e) => e.dur)))}`;
}

// DuplicatedJavaScript reads the scripts' source maps, which are not fetched, so it always "passes": not shown as passed.
const NEEDS_SOURCE_MAPS = 'DuplicatedJavaScript';
const short = (error) => String(error?.message ?? error).split('\n')[0].slice(0, 120);
// The engine leaves out the set of a trace without a page load that is under 5 s, has no interaction or layout shift
// and passes every insight: then there is no set at all.
const NO_SETS = 'No metrics or insights: the trace engine reports none for a trace under 5 s without a page load, an interaction or a layout shift';

export function summaryText(parsed, { file, dataLoss }) {
  const { traceBounds, mainFrameURL } = parsed.data.Meta;
  const lines = [
    `Trace: ${mainFrameURL || '(no main frame URL)'} · ${(traceBounds.range / 1e6).toFixed(1)} s · ${parsed.traceEvents.length.toLocaleString('en-US')} events` +
      (dataLoss ? ' · some events were lost (buffer full)' : ''),
    `File: ${file} (loads in DevTools' Performance panel)`,
    'Throttling: CPU none · network none',
  ];
  if (!parsed.insights.size) {
    lines.push('', `${NO_SETS}.`, longTasks(parsed, traceBounds));
    return lines.join('\n');
  }
  for (const [id, set] of parsed.insights) {
    const start = set.bounds.min - traceBounds.min;
    lines.push('', `${id}: ${set.url?.href ?? set.url ?? ''} · ${ms(start)} to ${ms(start + set.bounds.range)} of the trace`);
    lines.push(lcpLine(set.model.LCPBreakdown));
    lines.push(inpLine(set.model.INPBreakdown?.longestInteractionEvent));
    lines.push(`CLS: ${(set.model.CLSCulprits?.worstCluster?.clusterCumulativeScore ?? 0).toFixed(2)}`);
    lines.push(longTasks(parsed, set.bounds));
    const insights = Object.entries(set.model).filter(([name]) => name !== NEEDS_SOURCE_MAPS);
    const flagged = [...insights.filter(([, m]) => m.state === 'fail'), ...insights.filter(([, m]) => m.state === 'informative')];
    if (flagged.length) lines.push('Insights:');
    for (const [name, m] of flagged) lines.push(`- ${name} (${m.state}): ${m.strings.title}${savings(m, 'est. ').map((s) => ` · ${s}`).join('')}`);
    const passed = insights.filter(([, m]) => m.state === 'pass').map(([name]) => name);
    if (passed.length) lines.push(`Passed: ${passed.join(', ')}`);
    if (NEEDS_SOURCE_MAPS in set.model) lines.push(`Not computed (needs source maps, which are not fetched): ${NEEDS_SOURCE_MAPS}`);
    const failed = Object.entries(set.modelErrors ?? {}).map(([name, error]) => `${name} (${short(error)})`);
    if (failed.length) lines.push(`Could not compute: ${failed.join(', ')}`);
  }
  lines.push('', `Details: trace_insight {tab, name${parsed.insights.size > 1 ? ', set' : ''}}`);
  return lines.join('\n');
}

// --- Insight details ---

const IMAGE_FIX = {
  ADJUST_COMPRESSION: 'compress more',
  MODERN_FORMAT_OR_COMPRESSION: 'use WebP or AVIF',
  VIDEO_FORMAT: 'use a video instead of an animated GIF',
  RESPONSIVE_SIZE: 'serve it closer to its displayed size',
};
const CULPRIT = ['web font', 'injected iframe', 'non-composited animation', 'unsized image'];

function frameText(frame) {
  if (!frame) return '(unattributed)';
  const where = frame.url ? `${url(frame.url)}:${frame.lineNumber + 1}:${frame.columnNumber + 1}` : 'unknown location';
  return `${frame.functionName || '(anonymous)'} @ ${where}`;
}

const DETAILS = {
  LCPBreakdown(m) {
    if (!m.lcpMs) return ['No LCP in this trace.'];
    return [`LCP: ${msOf(m.lcpMs)} · element: ${lcpElement(m)}`,
      ...Object.entries(m.subparts ?? {}).map(([key, s]) => `- ${SUBPARTS[key] ?? key}: ${ms(s.range)} (${Math.round(s.range / 10 / m.lcpMs)}%)`)];
  },
  LCPDiscovery(m) {
    if (!m.checklist || !m.lcpRequest) return [m.lcpEvent ? 'The LCP element is not an image: nothing to discover.' : 'No LCP in this trace.'];
    return [`LCP image: ${reqUrl(m.lcpRequest)}`, ...checklist(m.checklist)];
  },
  RenderBlocking(m) {
    if (!m.renderBlockingRequests.length) return ['No render-blocking requests.'];
    return m.renderBlockingRequests.map((r) => {
      const wasted = m.requestIdToWastedMs?.get(r.args.data.requestId);
      return `- ${reqUrl(r)} · ${ms(r.dur)} · ${bytes(r.args.data.encodedDataLength)}${wasted ? ` · est. ${msOf(wasted)} saved without it` : ''}`;
    });
  },
  DocumentLatency(m) {
    if (!m.data) return ['No document request in this trace.'];
    const d = m.data;
    return [`Document: ${d.documentRequest ? reqUrl(d.documentRequest) : '?'}`,
      `Server response ${msOf(d.serverResponseTime)} · redirects ${msOf(d.redirectDuration)} · compression would save ${bytes(d.uncompressedResponseBytes)}`,
      ...checklist(d.checklist)];
  },
  ImageDelivery(m) {
    if (!m.optimizableImages.length) return ['No images to optimize.'];
    return m.optimizableImages.map((img) => `- ${reqUrl(img.request)} · ${bytes(img.request.args.data.encodedDataLength)} · wasted ${bytes(img.byteSavings)} · ` +
      img.optimizations.map((o) => `${IMAGE_FIX[o.type] ?? o.type}${o.type === 'RESPONSIVE_SIZE'
        ? ` (file ${o.fileDimensions.width}x${o.fileDimensions.height}, shown ${o.displayDimensions.width}x${o.displayDimensions.height})` : ''} ${bytes(o.byteSavings)}`).join(', '));
  },
  INPBreakdown(m) {
    const e = m.longestInteractionEvent;
    if (!e) return ['No interactions in this trace.'];
    return [`Longest interaction: ${e.type}, ${ms(e.dur)}`, `- input delay: ${ms(e.inputDelay)}`, `- processing: ${ms(e.mainThreadHandling)}`,
      `- presentation delay: ${ms(e.presentationDelay)}`];
  },
  CLSCulprits(m, parsed) {
    const worst = m.worstCluster;
    if (!worst) return ['No layout shifts.'];
    const base = parsed.data.Meta.traceBounds.min;
    const lines = [`Worst cluster: score ${worst.clusterCumulativeScore.toFixed(3)} · ${ms(worst.ts - base)} to ${ms(worst.ts + worst.dur - base)} of the trace`];
    for (const item of m.topCulpritsByCluster.get(worst) ?? []) lines.push(`- culprit: ${label(item.description)}${item.url ? ` ${url(item.url)}` : ''}`);
    worst.events.forEach((shift, i) => {
      const nodes = (shift.rawSourceEvent?.args?.data?.impacted_nodes ?? []).map((n) => n.debug_name).filter(Boolean);
      lines.push(`Shift ${i + 1}: at ${ms(shift.ts - base)}, score ${shift.args.data?.weighted_score_delta?.toFixed(3)}${nodes.length ? ` · moved: ${nodes.join(', ')}` : ''}`);
      const causes = m.shifts.get(shift);
      for (const f of causes?.iframes ?? []) lines.push(`  - injected iframe ${url(f.url) ?? f.frame}`);
      for (const r of causes?.webFonts ?? []) lines.push(`  - web font ${reqUrl(r)}`);
      for (const a of causes?.nonCompositedAnimations ?? []) lines.push(`  - non-composited animation ${a.name ?? '(unnamed)'}: ${a.failureReasons.join(', ')}`);
      for (const img of causes?.unsizedImages ?? []) lines.push(`  - unsized image ${img.paintImageEvent.args.data.nodeName ?? ''} ${url(img.paintImageEvent.args.data.url) ?? `node ${img.backendNodeId}`}`);
    });
    for (const a of m.animationFailures ?? []) lines.push(`Non-composited animation ${a.name ?? '(unnamed)'}: ${a.failureReasons.join(', ')}`);
    return lines;
  },
  ThirdParties(m) {
    const others = m.entitySummaries.filter((s) => s.entity !== m.firstPartyEntity).sort((a, b) => b.transferSize - a.transferSize);
    if (!others.length) return ['No third parties.'];
    return [`First party: ${m.firstPartyEntity?.name ?? '?'}`, ...others.map((s) => `- ${s.entity.name} · ${bytes(s.transferSize)} transferred · ${msOf(s.mainThreadTime)} main thread`)];
  },
  DOMSize(m) {
    const lines = [];
    const stats = m.maxDOMStats?.args.data;
    if (stats) {
      lines.push(`Elements: ${stats.totalElements}`);
      if (stats.maxDepth) lines.push(`Deepest: ${stats.maxDepth.depth} levels, at ${stats.maxDepth.nodeName} (node ${stats.maxDepth.nodeId})`);
      if (stats.maxChildren) lines.push(`Most children: ${stats.maxChildren.numChildren}, under ${stats.maxChildren.nodeName} (node ${stats.maxChildren.nodeId})`);
    }
    for (const u of m.largeUpdates) lines.push(`- ${label(u.label)} · ${msOf(u.duration)}`);
    return lines.length ? lines : ['No DOM statistics in this trace.'];
  },
  ForcedReflow(m) {
    const lines = [];
    const top = m.topLevelFunctionCallData;
    if (top) lines.push(`Top caller: ${frameText(top.topLevelFunctionCall)} · ${ms(top.totalReflowTime)} of forced reflow`);
    for (const d of m.aggregatedBottomUpData.slice(0, 15)) lines.push(`- ${ms(d.totalTime)} in ${frameText(d.bottomUpData)}`);
    return lines.length ? lines : ['No forced reflows.'];
  },
  NetworkDependencyTree(m) {
    const lines = [];
    if (m.rootNodes.length) {
      lines.push(`Longest chain (${ms(m.maxTime)}):`);
      for (let node = m.rootNodes.find((n) => n.isLongest) ?? m.rootNodes[0]; node; node = node.children.find((c) => c.isLongest)) {
        lines.push(`- ${reqUrl(node.request)} · at ${ms(node.timeFromInitialRequest)}`);
      }
    } else lines.push('No chained critical requests.');
    for (const o of m.preconnectedOrigins ?? []) {
      lines.push(`Preconnected: ${o.url || '(empty href)'} (${o.source === 'DOM' ? 'link tag' : 'Link header'})${o.unused ? ' · unused' : ''}${o.crossorigin ? ' · crossorigin mismatch' : ''}`);
    }
    for (const c of m.preconnectCandidates ?? []) lines.push(`Preconnect candidate: ${c.origin} · est. ${msOf(c.wastedMs)} saved`);
    return lines;
  },
  LegacyJavaScript(m) {
    if (!m.legacyJavaScriptResults.size) return ['No legacy JavaScript.'];
    return [...m.legacyJavaScriptResults].map(([script, r]) => `- ${url(script.url ?? script.request?.args.data.url ?? script.scriptId)} · ${bytes(r.estimatedByteSavings)} · ` +
      [...new Set(r.matches.map((x) => x.name))].join(', '));
  },
  FontDisplay(m) {
    if (!m.fonts.length) return ['No web fonts with a blocking font-display.'];
    return m.fonts.map((f) => `- ${f.name ?? reqUrl(f.request).split('/').pop()} · ${reqUrl(f.request)} · font-display: ${f.display} · wasted ${msOf(f.wastedTime)}`);
  },
  Viewport(m) {
    const content = m.viewportEvent?.args?.data?.content;
    return [`Mobile optimized: ${m.mobileOptimized == null ? 'unknown' : m.mobileOptimized ? 'yes' : 'no'}`, content ? `Viewport meta: ${content}` : 'No viewport meta tag.'];
  },
  Cache(m) {
    if (!m.requests.length) return ['Every static resource has an efficient cache lifetime.'];
    return m.requests.map((r) => `- ${reqUrl(r.request)} · TTL ${r.ttl ? `${r.ttl} s` : 'none'} · wasted ${bytes(r.wastedBytes)}`);
  },
  SlowCSSSelector(m) {
    if (!m.topSelectorElapsedMs && !m.topSelectorMatchAttempts) return ['No selector statistics in this trace (DevTools records them only with "Enable CSS selector stats").'];
    const lines = [`Total: ${msOf(m.totalElapsedMs)} · ${m.totalMatchAttempts} match attempts · ${m.totalMatchCount} matches`];
    if (m.topSelectorElapsedMs) lines.push(`Slowest: ${m.topSelectorElapsedMs.selector} · ${ms(m.topSelectorElapsedMs['elapsed (us)'])}`);
    if (m.topSelectorMatchAttempts) lines.push(`Most attempts: ${m.topSelectorMatchAttempts.selector} · ${m.topSelectorMatchAttempts.match_attempts}`);
    return lines;
  },
  ModernHTTP(m) {
    if (!m.http1Requests.length) return ['No requests over HTTP/1.'];
    return m.http1Requests.map((r) => `- ${reqUrl(r)} · ${r.args.data.protocol}`);
  },
  CharacterSet(m) {
    if (!m.data) return ['No document request in this trace.'];
    return [`HTTP charset: ${m.data.hasHttpCharset ? 'yes' : 'no'} · meta charset: ${m.data.metaCharsetDisposition ?? 'unknown'}`, ...checklist(m.data.checklist)];
  },
};

export function insightText(parsed, name, setId) {
  const sets = [...parsed.insights.keys()];
  if (!sets.length) throw new Error(`${NO_SETS}, so the last trace has no insight details.`);
  const set = parsed.insights.get(setId ?? sets[0]);
  if (!set) throw new Error(`No insight set "${setId}". Sets of the last trace: ${sets.join(', ')}`);
  const error = set.modelErrors?.[name];
  if (error) throw new Error(`The trace engine failed to compute ${name}: ${short(error)}`);
  const m = set.model[name];
  if (!m) throw new Error(`No insight "${name}". Insights of the last trace: ${Object.keys(set.model).join(', ')}`);
  if (name === NEEDS_SOURCE_MAPS) {
    return `${name}: not computed. It needs the scripts' source maps, which are not fetched, so the engine has nothing to compare and always reports it as passed.`;
  }
  const lines = [`${name} (${m.state}): ${m.strings.title}`, m.strings.description, `Estimated savings: ${savings(m).join(' · ') || 'none'}`, ''];
  lines.push(...(DETAILS[name]?.(m, parsed) ?? ['No details for this insight.']));
  return cap(lines.join('\n'), INSIGHT_MAX_CHARS, 'The trace file has everything: load it in DevTools\' Performance panel');
}

// --- Recording ---

async function stopRecording(tab) {
  const waiting = new AbortController();
  const complete = cdpEvent(tab, 'Tracing.tracingComplete', { timeoutMs: 60_000, signal: waiting.signal });
  try {
    await cdp(tab, 'Tracing.end');
  } catch (error) {
    waiting.abort();
    complete.catch(() => {});
    throw error;
  }
  // From here Chrome has stopped recording: a failure below loses the trace, not the recording's end.
  try {
    const { stream, dataLossOccurred } = await complete;
    return { gz: await readStream((method, params) => cdp(tab, method, params), stream), dataLoss: dataLossOccurred };
  } catch (error) {
    error.traceEnded = true;
    throw error;
  }
}

async function stop(tab, { header, text, blockedSince }) {
  if (!tab.trace?.startedAt) throw new Error('No trace is recording in this tab. Call trace_start first.');
  // A tab closing from here on ends the recording through this stop (endRecording releases): never mid-parse.
  tab.page.off('close', tab.trace.release);
  let recording;
  try {
    recording = await stopRecording(tab);
  } catch (error) {
    // Refused before Chrome stopped: it may still record, so the recording stays tracked (slot, close listener) for a
    // retry. One Chrome did stop (the trace itself was lost), says is not running, or whose tab is gone is let go of,
    // as trace_start does.
    if (error.traceEnded || /not started/i.test(error.message) || tab.page.isClosed?.()) {
      endRecording(tab);
      throw error;
    }
    tab.page.on('close', tab.trace.release);
    throw new Error(`Chrome did not stop the recording: ${error.message.replace(/\.$/, '')}. Call trace_stop again.`);
  }
  // The tab showed, framed or loaded (an <img>, a <script>: browsers.mjs Tab.loaded) a refused local file while it
  // recorded, or while the recording was set up (trace.before, read as trace_start began): its screenshots and sources
  // may hold the file, so nothing is kept.
  if (blockedSince(tab, tab.trace.before)) {
    endRecording(tab);
    throw new Error('The tab showed or loaded a local file agents can\'t open during the recording, which FowlBrowser doesn\'t record, so the trace was discarded. ' +
      'Start a new one on a web page or an allowed local file.');
  }
  try {
    const { gz, dataLoss } = recording;
    const file = path.join(outputDir('traces'), `trace-${stamp()}-${fileTab(tab)}.json.gz`);
    const trace = tracedTabOnly(JSON.parse((await gunzip(gz)).toString('utf8')));
    await fs.writeFile(file, await gzip(JSON.stringify(trace))); // gzipped, as Chrome wrote it
    const parsed = await parseTrace(trace);
    tab.trace.last = { parsed, file };
    const waited = tab.trace.waitedMs >= 1000 ? `Waited ${Math.round(tab.trace.waitedMs / 1000)} s for another session's trace to end before recording.\n` : '';
    return text(`${await header(tab)}\n${waited}${summaryText(parsed, { file, dataLoss })}`);
  } finally {
    endRecording(tab);
  }
}

// Before a page-load trace (and a Lighthouse navigation run) the page itself goes to about:blank, so the blank page stays
// in the page's renderer process (with its origin) and the reload commits there too: a process recording from the
// start. A blank page the debugger opens takes the extension's origin (Chrome counts the extension as the navigation's
// initiator) and lives in the extension's process, so the reload then needs another renderer: Chrome's spare one, which
// a busy browser lacks, and one started during the recording loses its first events, the load's navigationStart among
// them (the trace engine then finds no page load, NO_NAVIGATION only; Lighthouse fails with NO_NAVSTART). No page script
// runs for it (location can't be overridden; the reply comes before the navigation commits). A page that doesn't go
// within BLANK_MS (a busy main thread, a navigate handler that cancels it) is blanked the debugger's way, as before.
const BLANK_MS = 5000;
export async function blank(tab) {
  const deadline = Date.now() + BLANK_MS;
  const evaluated = await within(cdp(tab, 'Runtime.evaluate', { expression: 'location.replace("about:blank")' }), BLANK_MS, null);
  if (evaluated && !evaluated.exceptionDetails
    && await tab.page.waitForURL('about:blank', { waitUntil: 'load', timeout: Math.max(1, deadline - Date.now()) }).then(() => true, () => false)) return;
  debug('blank: the page did not go to about:blank itself', tab.id);
  await tab.page.goto('about:blank', { waitUntil: 'load' });
}

function endRecording(tab) {
  tab.trace.startedAt = null;
  if (tab.trace.release) tab.page.off('close', tab.trace.release);
  tab.trace.release?.();
  tab.trace.release = null;
}

export function registerTrace(tool, manager, helpers) {
  const { withTab, header, text, tabArg, refuseBlockedPage } = helpers;
  tool('trace_start',
    'Record a performance trace of a tab, as DevTools\' Performance panel does (timeline, JS samples, screenshots), and analyze it with DevTools\' own insights: ' +
    'LCP with its subparts, INP, CLS, long tasks, and what fails (render-blocking requests, image delivery, caching, DOM size, third parties, layout shift culprits...). ' +
    'By default it reloads the page and stops 5 s after the load (a page-load trace). For an interaction, pass reload false and auto_stop false, do the clicks or typing ' +
    'with the other tools, then call trace_stop. The trace is saved to a .json.gz file that loads in DevTools.',
    {
      tab: tabArg,
      reload: z.boolean().optional().describe('Reload the page while recording (default true). false: record the page as it is, e.g. to trace interactions.'),
      auto_stop: z.boolean().optional().describe('Stop on its own after `seconds` and return the analysis (default true). false: keep recording until trace_stop.'),
      seconds: z.number().min(1).max(60).optional().describe('With auto_stop: how long to record after the load (or the start), 1-60 (default 5).'),
    },
    withTab(async (tab, { reload = true, auto_stop: autoStop = true, seconds = 5 }) => {
      if (tab.trace?.startedAt) throw new Error('A trace is already recording in this tab. Call trace_stop to end it.');
      const before = tab.blockedPageAt; // before any wait: a refused file the page loads during the set-up is seen too
      const url = tab.page.url();
      if (reload && await isUsersTab(tab)) {
        throw new Error('This is the user\'s own tab, so it was not reloaded. Open the URL in your own tab (tab_open) and trace there, or pass reload false to record the page as it is.');
      }
      const release = await tracingSlot();
      let blanked = false;
      let waitedMs = 0;
      // The slot and the waits below can take a while: a user who took the tab over meanwhile keeps it as it is.
      const takenOver = () => { const n = notice(tab.id); if (n) throw new Error(n); };
      try {
        takenOver();
        // Chrome records one trace per browser (this server's own runs take turns; another session's or DevTools'
        // recording is waited for, on the page as it is, so a reload does not leave the tab blank meanwhile; the start
        // itself retries a little for one that began just now).
        if (reload) {
          waitedMs = await waitForTracing(tab);
          takenOver();
          blanked = true; // from here the page may have changed, even if the load wait fails
          await blank(tab);
        }
        // As puppeteer records (what chrome-devtools-mcp uses): a 1.2 GB buffer, so a busy page's load is not cut short.
        // Gzipped by Chrome: many times fewer bytes through the extension and the host (a 39 MB trace is 2.8 MB).
        waitedMs += (await startTracing(() => cdp(tab, 'Tracing.start', { transferMode: 'ReturnAsStream', streamCompression: 'gzip', traceConfig: {
          includedCategories: CATEGORIES.filter((c) => !c.startsWith('-')), excludedCategories: ['*'], traceBufferSizeInKb: 1_200_000 } }),
        reload ? { waitMs: 10_000 } : {})).waitedMs;
      } catch (error) {
        release();
        if (blanked && !notice(tab.id)) await tab.page.goto(url, { waitUntil: 'load' }).catch(() => {});
        if (traceBusy(error)) {
          throw new Error('Chrome records one trace at a time and something else kept recording (a trace or Lighthouse run of another session, or DevTools) for as long as this call waited. Try again when it ends.');
        }
        throw error;
      }
      tab.trace = { ...tab.trace, startedAt: Date.now(), before, url, release, waitedMs }; // before, not startedAt, decides the stop's discard
      tab.page.on('close', release); // a closed tab ends Chrome's recording too; endRecording removes it
      if (tab.page.isClosed?.()) { endRecording(tab); throw new Error('The tab closed while the trace started.'); } // closed before the listener
      try {
        takenOver(); // during the start: the recording ends, the user's page is left alone
        if (reload) await tab.page.goto(url, { waitUntil: 'load' });
        refuseBlockedPage(tab, before); // it loaded a refused file while the recording was set up: it is ended unkept
      } catch (error) {
        // A recording still live because its end was refused stays tracked, with the slot: trace_stop ends it (or
        // its tab's close). One Chrome did stop (the trace itself was lost) or whose tab is gone is let go of.
        try {
          await stopRecording(tab);
          endRecording(tab);
        } catch (stopError) {
          if (stopError.traceEnded || tab.page.isClosed?.()) endRecording(tab);
          else error.message += `\nThe recording could not be ended (${stopError.message}): call trace_stop to end it.`;
        }
        throw error;
      }
      if (!autoStop) {
        return text(`${await header(tab)}\nTrace recording${reload ? ' (page reloaded)' : ''}. Do what you want to measure, then call trace_stop.`);
      }
      await sleep(seconds * 1000);
      return stop(tab, helpers);
    }));

  tool('trace_stop',
    'Stop the trace recording in a tab (started by trace_start with auto_stop false), save it and return the analysis: LCP with subparts, INP, CLS, long tasks, ' +
    'failing insights with estimated savings, and the path of the trace file. Then trace_insight gives the details of one insight.',
    { tab: tabArg },
    withTab((tab) => stop(tab, helpers)));

  tool('trace_insight',
    'Details of one insight from the tab\'s last trace (trace_start or trace_stop): what it checks, its state, estimated savings, and its data, ' +
    'e.g. the LCP subparts, the render-blocking requests with durations, the layout shift culprits, the longest interaction\'s phases, third parties.',
    {
      tab: tabArg,
      name: z.string().describe('Insight name as listed by trace_stop, e.g. "LCPBreakdown", "RenderBlocking", "DocumentLatency", "INPBreakdown", "CLSCulprits".'),
      set: z.string().optional().describe('Insight set as listed, e.g. "NAVIGATION_1" (default the first).'),
    },
    withTab(async (tab, { name, set }) => {
      if (!tab.trace?.last) throw new Error('No trace of this tab yet. Call trace_start first.');
      return text(`${await header(tab)}\n${insightText(tab.trace.last.parsed, name, set)}`);
    }));
}
