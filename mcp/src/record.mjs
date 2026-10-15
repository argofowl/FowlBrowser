// Record mode for test runs: with FOWLBROWSER_RECORD=<absolute dir> the server appends what agents did to
// <dir>/journal.jsonl (tool calls, where the agent cursor was at each pointer action, script clicks, tab control
// changes, downloads) and keeps a frame per pointer action in <dir>/frames/, so a harness can grade whether the
// cursor showed up and moved to every click. Unset, none of this runs.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { redactArgs } from './debug.mjs';

const MAX_FRAMES = 400;
// Record mode only (rounds): a busy browser answers the overlay's state in seconds, and a point without it would read
// as a cursor that never showed; the action waits for the capture that long at most.
const CAPTURE_CAP_MS = 2500;
const ARG_MAX_CHARS = 200;
const SOURCE_MAX_CHARS = 4000;
const ERROR_MAX_CHARS = 300;

const cut = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);
// String args cut at 200 chars, also inside arrays and objects (fill_form fields).
function shortArgs(value) {
  if (typeof value === 'string') return cut(value, ARG_MAX_CHARS);
  if (Array.isArray(value)) return value.map(shortArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shortArgs(v)]));
  return value;
}

// A journal in dir: record(entry) appends one line (synchronously, so lines keep the order they were made in),
// frame(tab) captures the next frame.
// Frames show the user's pages: the folder and files are this user's alone.
export function openJournal(dir) {
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true, mode: 0o700 });
  for (const folder of [dir, path.join(dir, 'frames')]) fs.chmodSync(folder, 0o700); // mkdir's mode skips existing ones
  const file = path.join(dir, 'journal.jsonl');
  let frames = 0;
  return {
    record(entry) {
      fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...entry })}\n`, { mode: 0o600 });
    },
    // A viewport JPEG with the cursor in it (agent screenshots hide it), waited for at most capMs.
    // frame is null once MAX_FRAMES are taken or when the capture is late or fails.
    async frame(tab, capMs = CAPTURE_CAP_MS) {
      if (frames >= MAX_FRAMES || capMs <= 0) return { frame: null, captureMs: 0 };
      const name = `frames/${String(++frames).padStart(4, '0')}.jpg`;
      const started = Date.now();
      let timer;
      const image = await Promise.race([
        tab.page.screenshot({ type: 'jpeg', quality: 60, scale: 'css' }).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(resolve, capMs, null); }),
      ]).finally(() => clearTimeout(timer));
      if (image) fs.writeFileSync(path.join(dir, name), image, { mode: 0o600 });
      return { frame: image ? name : null, captureMs: Date.now() - started };
    },
  };
}

const journal = process.env.FOWLBROWSER_RECORD ? openJournal(process.env.FOWLBROWSER_RECORD) : null;
export const recording = journal !== null;
const calls = new AsyncLocalStorage(); // the tool a pointer action belongs to

// One journal line (no-op when not recording). Other modules write their own line types through this.
export function record(entry) {
  journal?.record(entry);
}

// The registration wrapper's part: runs the handler as the named tool and writes its call line.
export async function recordCall(name, args, handler) {
  if (!journal) return handler();
  const started = Date.now();
  let result, error;
  try {
    result = await calls.run(name, handler);
    return result;
  } catch (thrown) {
    error = String(thrown?.message ?? thrown);
    throw thrown;
  } finally {
    if (result?.isError) error = result.content?.find((c) => c.type === 'text')?.text;
    record({ type: 'call', tool: name, tab: typeof args?.tab === 'string' ? args.tab : null, ms: Date.now() - started, ok: error === undefined,
      ...(error !== undefined && { error: cut(error, ERROR_MAX_CHARS) }), args: callArgs(name, args ?? {}) });
  }
}

// evaluate keeps its script source (function or expression) up to SOURCE_MAX_CHARS, so a harness can read it. Typed
// text and form values (passwords) are redacted as in the debug log.
function callArgs(name, args) {
  const short = shortArgs(redactArgs(name, args));
  if (name !== 'evaluate') return short;
  for (const key of ['function', 'expression']) if (typeof args[key] === 'string') short[key] = cut(args[key], SOURCE_MAX_CHARS);
  return short;
}

// One line per download of this session once it is complete or interrupted (ino lets a harness tell the file from
// one that replaced it). Called for every downloads.changed item and by the download tool; each id is written once.
const downloadsDone = new Set();
export function downloadDone(browserKey, item) {
  if (!journal || !item || (item.state !== 'complete' && item.state !== 'interrupted')) return;
  const key = `${browserKey}:${item.id}`;
  if (downloadsDone.has(key)) return;
  downloadsDone.add(key);
  let ino = null;
  try { if (item.filename) ino = fs.statSync(item.filename).ino; } catch {}
  record({ type: 'download', id: item.id, tab: item.tabId == null ? null : `${browserKey}:${item.tabId}`, path: item.filename,
    bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived, state: item.state, ino });
}

// Right after the cursor arrived, before the action: the overlay's own report (readState resolves to its state())
// and a frame, both within CAPTURE_CAP_MS (a late state counts as missing). Returns the point line to finish with
// pointDone once the action is over.
export async function pointSeen(tab, target, readState) {
  const started = Date.now();
  let timer;
  const state = await Promise.race([
    readState().catch(() => null),
    new Promise((resolve) => { timer = setTimeout(resolve, CAPTURE_CAP_MS, null); }),
  ]).finally(() => clearTimeout(timer));
  const { frame } = await journal.frame(tab, CAPTURE_CAP_MS - (Date.now() - started));
  const cursor = state ? { visible: state.visible, x: state.x, y: state.y, opacity: state.opacity } : null;
  // captureMs: the whole observation (state and frame), which the action waited for; rounds take it off the agent's time.
  return { type: 'point', tool: calls.getStore() ?? null, tab: tab.id, target: target ?? null, cursor, frame, captureMs: Date.now() - started };
}

export function pointDone(line, error) {
  record(error ? { ...line, error: cut(String(error?.message ?? error), ERROR_MAX_CHARS) } : line);
}

// Clicks the overlay showed for a page script during evaluate ({t, x, y} each, t from the page's clock).
export function scriptClicks(tab, clicks) {
  for (const { t, x, y } of clicks ?? []) journal?.record({ type: 'scriptClick', tab: tab.id, x, y, ...(t && { t }) });
}

export function tabEvent(event, tab, url, extra = {}) {
  record({ type: 'tab', event, tab, url: url ?? '', ...extra });
}

// A viewport override set or cleared (viewport.mjs); reason: tool, release, turn end, handoff.
export function viewportEvent(event, tab, { width, height, mobile }, reason) {
  record({ type: 'viewport', event, tab: tab.id, width, height, mobile, reason });
}
