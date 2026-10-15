// Record mode (mcp/src/record.mjs): the journal writer, frames, and the cursor hooks it relies on, against fake tabs
// (no browser). FOWLBROWSER_RECORD is set before the modules load, as the server would have it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-record-'));
process.env.FOWLBROWSER_RECORD = dir;
const record = await import('../src/record.mjs');
const cursor = await import('../src/cursor/index.mjs');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const lines = () => fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const lastOf = (type) => lines().filter((l) => l.type === type).at(-1);

let nextTab = 1;
// A tab whose overlay answers state() with `state`, and whose screenshot takes screenshotMs.
function fakeTab({ state = { visible: true, x: 10, y: 20, opacity: 1 }, screenshotMs = 0, shown } = {}) {
  const evaluated = [];
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') {
        if (shown === undefined) throw new Error('isShown asked');
        return { shown };
      }
      const [, cdp, args] = params;
      if (cdp === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (cdp === 'Page.createIsolatedWorld') return { executionContextId: 5 };
      const call = args.expression.startsWith('globalThis.__fbCursor.') ? args.expression.slice('globalThis.__fbCursor.'.length) : 'overlay source';
      evaluated.push(call);
      if (call === 'state()') return { result: { value: state } };
      if (call === 'drainClicks()') return { result: { value: [{ t: 1234, x: 5, y: 6 }] } };
      return { result: { value: true } };
    },
  };
  const tabId = nextTab++;
  const page = Object.assign(new EventEmitter(), { screenshot: async () => { await sleep(screenshotMs); return JPEG; } });
  return { tab: { id: `chrome:${tabId}`, tabId, documentGeneration: 0, page, browser: { host } }, evaluated };
}

test('a call line per tool call: tab, time, ok, and string args cut at 200 chars (nested too)', async () => {
  const long = 'x'.repeat(500);
  const result = await record.recordCall('fill_form', { tab: 'chrome:1', fields: [{ ref: long, value: 'v' }], snapshot: false }, async () => 'done');
  assert.equal(result, 'done');
  const line = lastOf('call');
  assert.equal(line.tool, 'fill_form');
  assert.equal(line.tab, 'chrome:1');
  assert.equal(line.ok, true);
  assert.equal(line.error, undefined);
  assert.ok(Number.isFinite(line.t) && Number.isFinite(line.ms));
  assert.equal(line.args.fields[0].ref.length, 200);
  assert.equal(line.args.snapshot, false);
});

test('typed text and form values are redacted as in the debug log; the folder is 0700 and its files 0600', async () => {
  await record.recordCall('type', { tab: 'chrome:1', ref: 'e2', text: 'hunter2' }, async () => 'ok');
  assert.deepEqual(lastOf('call').args, { tab: 'chrome:1', ref: 'e2', text: '[redacted]' });
  await record.recordCall('fill_form', { tab: 'chrome:1', fields: [{ ref: 'e3', value: 'secret@example.com' }, { ref: 'e4', value: 482916 }] }, async () => 'ok');
  assert.deepEqual(lastOf('call').args.fields, [{ ref: 'e3', value: '[redacted]' }, { ref: 'e4', value: '[redacted]' }]);
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
  for (const secret of ['hunter2', 'secret@example.com', '482916']) assert.ok(!journal.includes(secret), secret);

  const mode = (file) => fs.statSync(file).mode & 0o777;
  const fresh = path.join(dir, 'fresh');
  const existing = fs.mkdtempSync(path.join(dir, 'existing-'));
  fs.chmodSync(existing, 0o755); // made by a harness with the usual umask
  for (const folder of [fresh, existing]) {
    const journal = record.openJournal(folder);
    journal.record({ type: 'x' });
    await journal.frame(fakeTab().tab);
    assert.deepEqual([mode(folder), mode(path.join(folder, 'frames'))], [0o700, 0o700], folder);
    assert.deepEqual([mode(path.join(folder, 'journal.jsonl')), mode(path.join(folder, 'frames', '0001.jpg'))], [0o600, 0o600], folder);
  }
});

test('a failed call: an error result or a throw, the error cut at 300 chars', async () => {
  await record.recordCall('click', { tab: 'helium:2' }, async () => ({ isError: true, content: [{ type: 'text', text: `Error: ${'y'.repeat(400)}` }] }));
  let line = lastOf('call');
  assert.equal(line.ok, false);
  assert.equal(line.error.length, 300);
  await assert.rejects(record.recordCall('browser_list', {}, async () => { throw new Error('boom'); }), /boom/);
  line = lastOf('call');
  assert.deepEqual([line.tool, line.tab, line.ok, line.error], ['browser_list', null, false, 'boom']);
});

test('a point line names the running tool, the target, the cursor report and its frame', async () => {
  const { tab } = fakeTab();
  await record.recordCall('click', { tab: tab.id }, async () => {
    const target = await cursor.moveTo(tab, { x: 10, y: 20, w: 30, h: 8 });
    const seen = await record.pointSeen(tab, target, () => cursor.state(tab));
    record.pointDone(seen, null);
  });
  const line = lastOf('point');
  assert.equal(line.tool, 'click');
  assert.equal(line.tab, tab.id);
  assert.deepEqual(line.target, { x: 10, y: 20, w: 30, h: 8 });
  assert.deepEqual(line.cursor, { visible: true, x: 10, y: 20, opacity: 1 });
  assert.match(line.frame, /^frames\/\d{4}\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(dir, line.frame)), JPEG);
  assert.ok(line.captureMs >= 0 && line.captureMs < 500);
  // Lines are written in order: the point before its call.
  const all = lines();
  assert.ok(all.indexOf(all.find((l) => l.type === 'point')) < all.length - 1 && all.at(-1).type === 'call');
});

test('no overlay: cursor null; an action error is on the point line', async () => {
  const { tab } = fakeTab();
  const seen = await record.pointSeen(tab, null, async () => undefined);
  record.pointDone(seen, new Error('covered'));
  const line = lastOf('point');
  assert.deepEqual([line.target, line.cursor, line.error], [null, null, 'covered']);
});

test('a capture slower than 2.5 s is not waited for: frame null, captureMs about 2500', async () => {
  const { tab } = fakeTab({ screenshotMs: 3200 });
  const started = Date.now();
  const seen = await record.pointSeen(tab, { x: 1, y: 1 }, async () => null);
  assert.ok(Date.now() - started < 2900, `waited ${Date.now() - started} ms`);
  assert.equal(seen.frame, null);
  assert.ok(seen.captureMs >= 2490 && seen.captureMs < 2900, `captureMs ${seen.captureMs}`);
});

test('the whole observation is capped at 2.5 s: a late state counts as missing, the frame gets what is left', async () => {
  const { tab } = fakeTab({ screenshotMs: 300 });
  let started = Date.now();
  let seen = await record.pointSeen(tab, { x: 1, y: 1 }, () => sleep(3500).then(() => ({ visible: true, x: 1, y: 1, opacity: 1 })));
  assert.ok(Date.now() - started < 2800, `waited ${Date.now() - started} ms`);
  assert.deepEqual([seen.cursor, seen.frame], [null, null]);
  started = Date.now();
  seen = await record.pointSeen(tab, { x: 1, y: 1 }, () => sleep(2300).then(() => ({ visible: true, x: 1, y: 1, opacity: 1 })));
  assert.ok(Date.now() - started < 2800, `state 2300 ms + frame 300 ms took ${Date.now() - started} ms`);
  assert.equal(seen.cursor.visible, true);
  assert.equal(seen.frame, null, 'only 200 ms were left for the 300 ms capture');
});

test('evaluate call lines keep the script source up to 4000 chars; other strings stay at 200', async () => {
  const source = `() => ${'a'.repeat(5000)}`;
  await record.recordCall('evaluate', { tab: 'chrome:1', function: source, ref: 'e1'.repeat(150) }, async () => 'ok');
  let line = lastOf('call');
  assert.equal(line.args.function.length, 4000);
  assert.equal(line.args.ref.length, 200);
  await record.recordCall('type', { tab: 'chrome:1', function: source }, async () => 'ok');
  line = lastOf('call');
  assert.equal(line.args.function.length, 200);
});

test('a download line once per download id when it completes or is interrupted, with the file inode', () => {
  const file = path.join(dir, 'file.bin');
  fs.writeFileSync(file, 'abc');
  const before = lines().filter((l) => l.type === 'download').length;
  record.downloadDone('chrome', { id: 7, tabId: 52, filename: file, state: 'in_progress', bytesReceived: 1 });
  record.downloadDone('chrome', { id: 7, tabId: 52, filename: file, state: 'complete', fileSize: 3, bytesReceived: 3 });
  record.downloadDone('chrome', { id: 7, tabId: 52, filename: file, state: 'complete', fileSize: 3, bytesReceived: 3 }); // the download tool
  record.downloadDone('helium', { id: 7, tabId: null, filename: path.join(dir, 'gone.bin'), state: 'interrupted', totalBytes: 9, bytesReceived: 2 });
  const downloads = lines().filter((l) => l.type === 'download').slice(before).map(({ t, ...rest }) => rest);
  assert.deepEqual(downloads, [
    { type: 'download', id: 7, tab: 'chrome:52', path: file, bytes: 3, state: 'complete', ino: fs.statSync(file).ino },
    { type: 'download', id: 7, tab: null, path: path.join(dir, 'gone.bin'), bytes: 2, state: 'interrupted', ino: null },
  ]);
});

test('at most 400 frames a session, then frame null', async () => {
  const journal = record.openJournal(fs.mkdtempSync(path.join(dir, 'cap-')));
  const { tab } = fakeTab();
  const frames = [];
  for (let i = 0; i < 401; i++) frames.push((await journal.frame(tab)).frame);
  assert.equal(frames[0], 'frames/0001.jpg');
  assert.equal(frames[399], 'frames/0400.jpg');
  assert.equal(frames[400], null);
});

test('script clicks, tab events and other modules\' lines', async () => {
  const { tab } = fakeTab();
  record.scriptClicks(tab, await cursor.drainClicks(tab)); // no overlay yet: nothing
  record.tabEvent('open', 'chrome:9', 'https://example.com/', { forUser: false });
  record.record({ type: 'turnEnded', closed: ['chrome:9'], released: [], skipped: [] });
  const tail = lines().slice(-2);
  assert.deepEqual({ ...tail[0], t: 0 }, { t: 0, type: 'tab', event: 'open', tab: 'chrome:9', url: 'https://example.com/', forUser: false });
  assert.deepEqual(tail[1].closed, ['chrome:9']);
  cursor.cue(tab, 'observe'); // an overlay now
  await sleep(20);
  record.scriptClicks(tab, await cursor.drainClicks(tab));
  assert.deepEqual(lastOf('scriptClick'), { t: 1234, type: 'scriptClick', tab: tab.id, x: 5, y: 6 });
});

test('drainClicks gives up after 300 ms; follow asks the overlay to keep clicks in record mode', async () => {
  const { tab, evaluated } = fakeTab();
  await cursor.follow(tab, true);
  assert.equal(evaluated.at(-1), 'follow(true, true)');
  const request = tab.browser.host.request;
  tab.browser.host.request = (method, params) => (params?.[2]?.expression?.endsWith('drainClicks()') ? new Promise(() => {}) : request(method, params));
  const started = Date.now();
  assert.deepEqual(await cursor.drainClicks(tab), []);
  assert.ok(Date.now() - started < 500, `waited ${Date.now() - started} ms`);
});

test('record mode shows the cursor in every controlled tab without asking the extension', async () => {
  const { tab } = fakeTab({ shown: undefined }); // asking would throw
  assert.equal(await cursor.isShown(tab), true);
});

test('overlay state(): nothing injected without an overlay, the overlay\'s own report with one', async () => {
  const { tab, evaluated } = fakeTab({ state: { attached: true, displayed: true, opacity: 0.8, x: 3, y: 4, visible: true } });
  assert.equal(await cursor.state(tab), undefined);
  assert.deepEqual(evaluated, []);
  assert.deepEqual(await cursor.moveTo(tab, { x: 3, y: 4 }), { x: 3, y: 4 });
  assert.deepEqual(await cursor.state(tab), { attached: true, displayed: true, opacity: 0.8, x: 3, y: 4, visible: true });
  assert.deepEqual(evaluated.map((c) => c.split('(')[0]), ['overlay source', 'move', 'land', 'state']);
});

test('prepare injects the overlay in every controlled tab while recording, without asking whether it is shown', async () => {
  const { tab, evaluated } = fakeTab(); // isShown throws if asked
  cursor.prepare(tab);
  await sleep(20);
  assert.deepEqual(evaluated, ['overlay source']);
});

test('unset, record mode is off and calls just run', () => {
  const env = { ...process.env };
  delete env.FOWLBROWSER_RECORD;
  const script = `const r = await import(${JSON.stringify(new URL('../src/record.mjs', import.meta.url).href)});
    r.record({ type: 'x' }); console.log(r.recording, await r.recordCall('t', {}, async () => 7));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' }).trim(), 'false 7');
});
