// perf.mjs helpers: the process-wide tracing slot (traces and Lighthouse runs take turns).
import assert from 'node:assert/strict';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { privateDir, readStream, startTracing, tracingSlot, waitForTracing } from '../src/perf.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('tracingSlot: the second holder waits for the first release, the third for the second', async () => {
  const order = [];
  const first = await tracingSlot();
  const second = tracingSlot().then((release) => { order.push('second'); return release; });
  const third = tracingSlot().then((release) => { order.push('third'); return release; });
  await tick();
  assert.deepEqual(order, []);
  first();
  const releaseSecond = await second;
  await tick();
  assert.deepEqual(order, ['second']);
  releaseSecond();
  (await third)();
  assert.deepEqual(order, ['second', 'third']);
});

test('tracingSlot: releasing twice is harmless and a free slot resolves at once', async () => {
  const release = await tracingSlot();
  release();
  release();
  let got = false;
  const next = await tracingSlot().then((r) => { got = true; return r; });
  assert.ok(got);
  next();
});

// --- Another session's trace: waiting for the browser's tracing to be free ---

const BUSY = 'Tracing has already been started (possibly in another tab).';

test('startTracing: a busy browser is retried until the start goes through, and says how long the retries took', async () => {
  let calls = 0;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const { result, waitedMs } = await startTracing(async () => { if (++calls < 3) throw new Error(BUSY); await sleep(100); return 'ok'; }, { waitMs: 500, retryMs: 10 });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.ok(waitedMs >= 15 && waitedMs < 80, `waited ${waitedMs} ms: the start that went through is not counted`);
});

test('startTracing: still busy at the end of the wait throws the last error; any other error throws at once', async () => {
  let calls = 0;
  await assert.rejects(startTracing(async () => { calls++; throw new Error(BUSY); }, { waitMs: 50, retryMs: 10 }), /already been started/);
  assert.ok(calls >= 2 && calls <= 7, `retried ${calls} times`);
  calls = 0;
  await assert.rejects(startTracing(async () => { calls++; throw new Error('Not allowed'); }, { waitMs: 50, retryMs: 10 }), /Not allowed/);
  assert.equal(calls, 1);
});

test('waitForTracing: an empty trace is started (retried while busy) and ended at once, its stream closed', async () => {
  const host = new EventEmitter();
  const sent = [];
  let starts = 0;
  host.request = async (name, [, command, params]) => {
    sent.push([command, params]);
    if (command === 'Tracing.start' && ++starts < 3) throw new Error(BUSY);
    if (command === 'Tracing.end') setImmediate(() => host.emit('chrome.debugger.onEvent', [{ tabId: 3 }, 'Tracing.tracingComplete', { stream: 's3' }]));
    return {};
  };
  const waited = await waitForTracing({ tabId: 3, id: 'chrome:3', browser: { host } }, { waitMs: 500, retryMs: 5 });
  assert.ok(waited >= 5 && waited < 500, `waited ${waited} ms`);
  assert.deepEqual(sent.map(([c]) => c), ['Tracing.start', 'Tracing.start', 'Tracing.start', 'Tracing.end', 'IO.close']);
  assert.deepEqual(sent[0][1], { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: ['__metadata'], excludedCategories: ['*'] } });
  assert.deepEqual(sent[4][1], { handle: 's3' });
  assert.equal(host.listenerCount('chrome.debugger.onEvent'), 0);
});

test('waitForTracing: the empty trace failing to end is an error (it may still be recording), and the wait stops', async () => {
  const host = new EventEmitter();
  host.request = async (name, [, command]) => { if (command === 'Tracing.end') throw new Error('end failed'); return {}; };
  await assert.rejects(waitForTracing({ tabId: 3, id: 'chrome:3', browser: { host } }, { waitMs: 100, retryMs: 5 }), /could not be ended \(end failed\); it may be recording/);
  assert.equal(host.listenerCount('chrome.debugger.onEvent'), 0);
});

test('readStream: chunks are joined (base64 decoded) and the stream closed, also when a read fails', async () => {
  const reads = [{ data: Buffer.from('ab').toString('base64'), base64Encoded: true, eof: false }, { data: 'cd', base64Encoded: false, eof: true }];
  const sent = [];
  assert.equal((await readStream(async (method) => { sent.push(method); return method === 'IO.read' ? reads.shift() : {}; }, 'h')).toString(), 'abcd');
  assert.deepEqual(sent, ['IO.read', 'IO.read', 'IO.close']);
  sent.length = 0;
  await assert.rejects(readStream(async (method) => { sent.push(method); if (method === 'IO.read') throw new Error('gone'); return {}; }, 'h'), /gone/);
  assert.deepEqual(sent, ['IO.read', 'IO.close']);
});

test('tracingSlot: a holder that never releases is skipped once, 10 min after it got the slot; the callers behind it still take turns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
  const order = [];
  const take = (name) => tracingSlot().then((release) => { order.push(name); return release; });
  const stuck = await tracingSlot(); // a recording nobody stops
  const second = take('second');
  const third = take('third');
  t.mock.timers.tick(600_000);
  await settle();
  assert.deepEqual(order, ['second'], 'the third waits for the second, not just for its own 10 min');
  (await second)();
  await settle();
  assert.deepEqual(order, ['second', 'third']);
  const fourth = take('fourth');
  await settle();
  (await third)();
  await settle();
  assert.deepEqual(order, ['second', 'third', 'fourth'], 'the fourth gets the slot when the third releases, not 10 min later');
  (await fourth)();
  stuck();
});

test('privateDir: made 0700; a symlink or a folder others can write to is refused; ours others could only read is made private', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-outdir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mode = (dir) => fs.statSync(dir).mode & 0o777;
  assert.equal(mode(privateDir(path.join(root, 'fresh'))), 0o700);
  const elsewhere = path.join(root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(root, 'link'));
  assert.throws(() => privateDir(path.join(root, 'link')), /not a private folder of this user/);
  fs.mkdirSync(path.join(root, 'open'));
  fs.chmodSync(path.join(root, 'open'), 0o777);
  assert.throws(() => privateDir(path.join(root, 'open')), /not a private folder of this user/);
  fs.mkdirSync(path.join(root, 'old'));
  fs.chmodSync(path.join(root, 'old'), 0o755);
  assert.equal(mode(privateDir(path.join(root, 'old'))), 0o700);
});
