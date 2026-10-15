#!/usr/bin/env node
// Plays the browser + extension for host/host.mjs, so the host can be exercised without a browser.
//   node tools/fake-extension.mjs          run the host against a fake extension in a temp dir; prints the socket
//                                          path and logs traffic; use tools/fb.mjs -b <path> to talk to it
//   node tools/fake-extension.mjs --test   run the host self-test and exit non-zero on failure
// The fake extension answers every request with { result: { method, params, client } }, answers
// "fake.big" with a ~3 MB result, "fake.sink" with { ok: true }, never answers "fake.hang", and on "fake.emit" emits params.event (to params.to,
// or everyone).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hostPath = fileURLToPath(new URL('../host/host.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fowlbrowser-'));
// Hosts whose extension never says hello live here, so they don't hold node-2.sock for the rest of the test.
const helloDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fowlbrowser-hello-'));
const testMode = process.argv.includes('--test');

// --- Framing ---

function encode(message, le = true) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  le ? header.writeUInt32LE(body.length) : header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function reader(onMessage, onSize = () => {}) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      onSize(length);
      onMessage(JSON.parse(buffer.subarray(4, 4 + length).toString()));
      buffer = buffer.subarray(4 + length);
    }
  };
}

// --- Fake extension driving the host over stdio ---

function startHost(env = {}, { hello = true } = {}) {
  const host = spawn(process.execPath, [hostPath], {
    env: { ...process.env, FOWLBROWSER_DIR: dir, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const fromHost = []; // every message the host sent the extension (chunks reassembled)
  const chunks = new Map();
  let maxFrame = 0;
  let splitSurrogates = 0; // chunks that end in half a surrogate pair
  const toHost = (message) => host.stdin.write(encode(message));

  const handle = (message) => {
    if (message.method === 'host.chunk') {
      const { id, index, total, data } = message.params;
      if (/[\ud800-\udbff]$/.test(data)) splitSurrogates++;
      const parts = chunks.get(id) ?? [];
      parts[index] = data;
      chunks.set(id, parts);
      if (parts.filter((p) => p !== undefined).length === total) {
        chunks.delete(id);
        handle(JSON.parse(parts.join('')));
      }
      return;
    }
    fromHost.push(message);
    if (!testMode) console.log('ext <-', JSON.stringify(message).slice(0, 300));
    if (message.id === undefined) return;
    if (message.method === 'fake.emit') {
      const { event, to } = message.params;
      toHost(to === undefined ? event : { ...event, client: to });
      toHost({ id: message.id, result: { ok: true } });
    } else if (message.method === 'fake.big') {
      toHost({ id: message.id, result: { data: 'x'.repeat(3_000_000) } });
    } else if (message.method === 'fake.sink') {
      toHost({ id: message.id, result: { ok: true } });
    } else if (message.method === 'fake.hang') {
      // never answered
    } else if (message.method === 'fake.error') {
      toHost({ id: message.id, error: { message: 'boom' } });
    } else {
      toHost({ id: message.id, result: { method: message.method, params: message.params, client: message.client } });
    }
  };
  host.stdout.on('data', reader(handle, (size) => { maxFrame = Math.max(maxFrame, size); }));
  const sayHello = () => toHost({ method: 'extension.hello', params: { version: '0.1.0', instanceId: 'fake-instance', userAgent: 'fake' } });
  if (hello) sayHello();
  return { host, sayHello, fromHost, toHost, get maxFrame() { return maxFrame; }, get splitSurrogates() { return splitSurrogates; } };
}

// The host's browser name comes from its parent: this node process.
const sockName = (n = 1) => path.join(dir, n === 1 ? 'node.sock' : `node-${n}.sock`);
const waitFor = async (check, label, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// --- A socket client ---

async function connect(socketPath) {
  const socket = net.connect(socketPath);
  const messages = [];
  let closed = false;
  socket.on('close', () => { closed = true; });
  socket.on('error', () => {});
  socket.on('data', reader((m) => messages.push(m)));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const token = fs.readFileSync(path.join(path.dirname(socketPath), 'token'), 'utf8').trim();
  socket.write(encode({ method: 'host.auth', params: { token } }));
  let nextId = 1;
  return {
    socket,
    messages,
    send: (m) => socket.write(encode(m)),
    get closed() { return closed; },
    async request(method, params = {}, id = nextId++) {
      socket.write(encode({ id, method, params }));
      await waitFor(() => messages.some((m) => m.id === id), `response ${method}`);
      return messages.find((m) => m.id === id);
    },
    events: () => messages.filter((m) => m.id === undefined),
  };
}

// --- Self-test ---

async function selfTest() {
  const a = startHost({ FOWLBROWSER_ROUTE_TIMEOUT_MS: '1500' });
  await waitFor(() => fs.existsSync(sockName()), 'node.sock');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'dir mode');
  assert.equal(fs.statSync(sockName()).mode & 0o777, 0o600, 'socket mode');
  assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600, 'token mode');

  // A client with a wrong token is dropped before anything reaches the extension.
  const stranger = net.connect(sockName());
  await new Promise((resolve) => stranger.once('connect', resolve));
  stranger.write(encode({ method: 'host.auth', params: { token: 'wrong' } }));
  stranger.write(encode({ id: 1, method: 'tabs.listAll', params: {} }));
  await new Promise((resolve) => stranger.once('close', resolve));
  assert.ok(!a.fromHost.some((m) => m.method === 'tabs.listAll' || m.method === 'host.clientConnected'), 'stranger reached extension');

  // Before auth a frame over 4 KB drops the client at its header: it never makes the host buffer the body.
  const bulky = net.connect(sockName());
  await new Promise((resolve) => bulky.once('connect', resolve));
  bulky.on('error', () => {});
  const bulkyHeader = Buffer.alloc(4);
  bulkyHeader.writeUInt32LE(4097);
  bulky.write(bulkyHeader);
  const bulkyStart = Date.now();
  await new Promise((resolve) => bulky.once('close', resolve));
  assert.ok(Date.now() - bulkyStart < 1000, 'dropped at the header, not by the 5 s auth timeout');

  // A token file that holds no real token (empty, short) is replaced at startup, and an empty token never gets in.
  for (const bad of ['', 'abc\n']) {
    const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fowlbrowser-token-'));
    fs.writeFileSync(path.join(tokenDir, 'token'), bad, { mode: 0o600 });
    const h = startHost({ FOWLBROWSER_DIR: tokenDir });
    await waitFor(() => fs.existsSync(path.join(tokenDir, 'node.sock')), 'socket for the bad-token host');
    assert.match(fs.readFileSync(path.join(tokenDir, 'token'), 'utf8'), /^[0-9a-f]{64}$/, `token ${JSON.stringify(bad)} replaced`);
    assert.equal(fs.statSync(path.join(tokenDir, 'token')).mode & 0o777, 0o600, 'replaced token mode');
    const empty = net.connect(path.join(tokenDir, 'node.sock'));
    await new Promise((resolve) => empty.once('connect', resolve));
    empty.write(encode({ method: 'host.auth', params: { token: bad.trim() } }));
    await new Promise((resolve) => empty.once('close', resolve));
    assert.ok(!h.fromHost.some((m) => m.method === 'host.clientConnected'), 'a client with the old token got in');
    const good = await connect(path.join(tokenDir, 'node.sock'));
    await waitFor(() => good.messages[0]?.method === 'host.hello', 'hello with the new token');
    good.socket.destroy();
    h.host.stdin.end();
    await new Promise((r) => (h.host.exitCode !== null ? r() : h.host.once('exit', r)));
    fs.rmSync(tokenDir, { recursive: true, force: true });
  }

  // A socket that never authenticates is dropped after 5 s (checked at the end).
  const silent = net.connect(sockName());
  let silentClosed = false;
  silent.on('close', () => { silentClosed = true; });
  silent.on('error', () => {});
  // A malformed first frame drops only that socket.
  const nullFirst = net.connect(sockName());
  await new Promise((resolve) => nullFirst.once('connect', resolve));
  nullFirst.write(encode(null));
  await new Promise((resolve) => nullFirst.once('close', resolve));

  const c1 = await connect(sockName());
  const c2 = await connect(sockName());
  await waitFor(() => c1.messages.length && c2.messages.length, 'host.hello');
  const hello = c1.messages[0];
  assert.equal(hello.method, 'host.hello');
  assert.equal(hello.params.browser, 'node');
  assert.equal(hello.params.browserPid, process.pid);
  assert.equal(hello.params.silentDebugger, false);
  assert.equal(hello.params.extension.instanceId, 'fake-instance');
  await waitFor(() => a.fromHost.filter((m) => m.method === 'host.clientConnected').length === 2, 'clientConnected x2');
  const [id1, id2] = a.fromHost.filter((m) => m.method === 'host.clientConnected').map((m) => m.params.client);
  assert.notEqual(id1, id2);

  // host.hello waits for the extension's hello, so a client never gets a host.hello without the real user agent.
  const helloSock = path.join(helloDir, 'node.sock');
  const late = startHost({ FOWLBROWSER_DIR: helloDir }, { hello: false });
  await waitFor(() => fs.existsSync(helloSock), 'socket for the late-hello host');
  const early = await connect(helloSock);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(early.messages.length, 0, 'host.hello sent before extension.hello');
  late.sayHello();
  await waitFor(() => early.messages.length, 'host.hello after extension.hello');
  assert.equal(early.messages[0].method, 'host.hello');
  assert.equal(early.messages[0].params.extension.userAgent, 'fake');
  early.socket.destroy();
  late.host.stdin.end();
  await new Promise((r) => (late.host.exitCode !== null ? r() : late.host.once('exit', r)));
  // Without an extension.hello, the client is greeted after 5 s anyway (checked at the end).
  const mute = startHost({ FOWLBROWSER_DIR: helloDir }, { hello: false });
  await waitFor(() => fs.existsSync(helloSock), 'socket for the silent-extension host');
  const patient = await connect(helloSock);

  // The host numbers requests itself and routes replies back with the client's original id, whatever its
  // type: 7 and "7" from one client and 7 from another never collide.
  const [r1, r1s, r2, r3] = await Promise.all([c1.request('tabs.listAll', {}, 7), c1.request('tabs.listAll', {}, '7'),
    c2.request('tabs.listAll', {}, 7), c2.request('x', [1], 'abc')]);
  assert.deepEqual(r1, { id: 7, result: { method: 'tabs.listAll', params: {}, client: id1 } });
  assert.deepEqual(r1s, { id: '7', result: { method: 'tabs.listAll', params: {}, client: id1 } });
  assert.equal(r2.result.client, id2);
  assert.equal(r3.id, 'abc');
  const wireIds = a.fromHost.filter((m) => m.method === 'tabs.listAll' || m.method === 'x').map((m) => m.id);
  assert.equal(wireIds.length, 4);
  assert.ok(wireIds.every((id) => typeof id === 'number'), 'host-numbered ids on the wire');
  assert.equal(new Set(wireIds).size, 4);
  assert.deepEqual(await c1.request('fake.error'), { id: 1, error: { message: 'boom' } });

  // host.* messages from a client never reach the extension, and a client can't pick its client id.
  c1.send({ method: 'host.clientDisconnected', params: { client: id2 } });
  const smuggled = JSON.stringify({ id: 99, method: 'tabs.remove', params: [1], client: id2 });
  const chunkReply = await c1.request('host.chunk', { id: 'x', index: 0, total: 1, data: smuggled });
  assert.match(chunkReply.error.message, /reserved for the host/);
  assert.equal((await c1.request('who', {}, 'who')).result.client, id1);
  c1.send({ id: 'who2', method: 'who', params: {}, client: id2 });
  await waitFor(() => c1.messages.some((m) => m.id === 'who2'), 'who2');
  assert.equal(c1.messages.find((m) => m.id === 'who2').result.client, id1);
  const fromHostItself = ['host.clientConnected', 'host.listening'];
  assert.ok(!a.fromHost.some((m) => m.method?.startsWith('host.') && !fromHostItself.includes(m.method)), 'host.* from a client reached the extension');
  // The host tells the extension (its popup) that it is installed and which socket name agents reach it by.
  assert.deepEqual(a.fromHost.find((m) => m.method === 'host.listening')?.params, { browser: 'node', key: 'node', silentDebugger: false });
  assert.ok(!c1.closed, 'a reserved method only drops the message');

  // A later extension.hello (the user renamed the browser in the popup) reaches connected clients, and new ones get
  // it in host.hello.
  a.toHost({ method: 'extension.hello', params: { version: '0.1.0', instanceId: 'fake-instance', userAgent: 'fake', label: 'Work' } });
  await waitFor(() => [c1, c2].every((c) => c.messages.some((m) => m.method === 'extension.hello')), 'extension.hello to clients');
  assert.equal(c1.messages.find((m) => m.method === 'extension.hello').params.label, 'Work');
  const renamed = await connect(sockName());
  await waitFor(() => renamed.messages.length, 'host.hello after rename');
  assert.equal(renamed.messages[0].params.extension.label, 'Work');
  renamed.socket.destroy();

  // Malformed frames drop only the client that sent them; the host and everyone else carry on.
  const badFrames = [encode(null), encode(5), encode([1]), encode({ id: 1 }), encode('text'),
    Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from('{x}')])];
  for (const bad of badFrames) {
    const victim = await connect(sockName());
    await waitFor(() => victim.messages.length, 'hello for victim');
    victim.socket.write(bad);
    await waitFor(() => victim.closed, `drop after ${bad.subarray(4).toString()}`);
  }
  // An oversized frame header drops the client before it can make the host buffer 64 MB.
  const huge = await connect(sockName());
  const header = Buffer.alloc(4);
  header.writeUInt32LE(64 * 1024 * 1024 + 1);
  huge.socket.write(Buffer.concat([header, Buffer.from('{"id":1,')]));
  await waitFor(() => huge.closed, 'drop on oversized frame');
  assert.equal((await c2.request('still.alive')).result.method, 'still.alive');
  assert.equal(a.host.exitCode, null, 'host still running');
  // A client that stops reading is dropped once 64 MB are waiting for it.
  const stalled = await connect(sockName());
  await waitFor(() => stalled.messages.length, 'hello for stalled');
  const disconnects = () => a.fromHost.filter((m) => m.method === 'host.clientDisconnected').length;
  const before = disconnects();
  stalled.socket.pause();
  for (let i = 0; i < 30; i++) stalled.send({ id: 1000 + i, method: 'fake.big', params: {} });
  await waitFor(() => disconnects() === before + 1, 'drop on write backlog', 10000);
  stalled.socket.destroy();
  assert.equal((await c2.request('still.alive')).result.method, 'still.alive');

  // At most 256 requests in flight per client; abandoned routes expire with an error reply.
  const flood = await connect(sockName());
  await waitFor(() => flood.messages.length, 'hello for flood');
  for (let i = 0; i < 256; i++) flood.send({ id: `hang-${i}`, method: 'fake.hang', params: {} });
  const refused = await flood.request('fake.hang', {}, 'hang-256');
  assert.match(refused.error.message, /over 256 requests in flight/);
  assert.equal((await c2.request('still.alive')).result.method, 'still.alive', 'other clients unaffected');
  await waitFor(() => flood.messages.filter((m) => /No reply from the extension/.test(m.error?.message)).length === 256,
    'expired routes answered', 5000);
  assert.equal((await flood.request('after.expiry')).result.method, 'after.expiry');
  flood.socket.destroy();

  // A browser that stops reading: requests are refused once 64 MB wait unsent, and nothing is lost before that.
  a.host.stdout.pause();
  const pusher = await connect(sockName());
  await waitFor(() => pusher.messages.length, 'hello for pusher');
  const blob = 'y'.repeat(1024 * 1024);
  for (let i = 0; i < 80; i++) pusher.send({ id: `push-${i}`, method: 'fake.sink', params: { blob } });
  await waitFor(() => pusher.messages.some((m) => /not keeping up/.test(m.error?.message)), 'refused on native backlog', 10000);
  a.host.stdout.resume();
  await waitFor(() => pusher.messages.filter((m) => m.id?.startsWith?.('push-')).length === 80, 'every push answered', 10000);
  assert.ok(pusher.messages.filter((m) => m.result?.ok).length >= 60, 'requests under the limit went through');
  pusher.socket.destroy();

  // Events: targeted vs broadcast, client field stripped.
  await c1.request('fake.emit', { event: { method: 'only.c2', params: [1] }, to: id2 });
  await c1.request('fake.emit', { event: { method: 'tabs.changed', params: [] } });
  await waitFor(() => c2.events().some((m) => m.method === 'tabs.changed') && c1.events().some((m) => m.method === 'tabs.changed'), 'broadcast');
  assert.deepEqual(c2.events().find((m) => m.method === 'only.c2'), { method: 'only.c2', params: [1] });
  assert.ok(!c1.events().some((m) => m.method === 'only.c2'), 'targeted event leaked');

  // Large extension->host response passes through; large host->extension message is chunked under 1 MB frames.
  const big = await c1.request('fake.big');
  assert.equal(big.result.data.length, 3_000_000);
  const payload = '"\\é😀'.repeat(400_000);
  const echoed = await c1.request('big.request', { payload });
  assert.equal(echoed.result.params.payload, payload);
  assert.ok(a.maxFrame < 1024 * 1024, `host->extension frame ${a.maxFrame} bytes`);
  // Astral characters at every chunk boundary offset: never split a surrogate pair.
  for (const pad of ['', 'x']) {
    const emoji = pad + '😀'.repeat(300_000);
    const reply = await c1.request('big.emoji', { emoji }, `emoji-${pad.length}`);
    assert.ok(reply.result?.params.emoji === emoji, `emoji payload (pad ${pad.length}) came back changed: ${JSON.stringify(reply).slice(0, 200)}`);
  }
  assert.equal(a.splitSurrogates, 0, 'a chunk ended in half a surrogate pair');

  // Disconnect notifies the extension.
  c2.socket.destroy();
  await waitFor(() => a.fromHost.some((m) => m.method === 'host.clientDisconnected' && m.params.client === id2), 'clientDisconnected');

  // A second host for the same browser name takes -2 while the first is live.
  const b = startHost();
  await waitFor(() => fs.existsSync(sockName(2)), 'node-2.sock');

  // Stale socket file is replaced: kill -9 leaves node-2.sock behind.
  b.host.kill('SIGKILL');
  await new Promise((r) => b.host.once('exit', r));
  assert.ok(fs.existsSync(sockName(2)), 'stale socket left behind');
  const c = startHost();
  let c3;
  for (let tries = 0; !c3; tries++) {
    c3 = await connect(sockName(2)).catch(() => null);
    if (!c3) { assert.ok(tries < 100, 'replacement host never listened'); await new Promise((r) => setTimeout(r, 20)); }
  }

  await waitFor(() => c3.messages[0]?.method === 'host.hello', 'hello from replacement host');

  await waitFor(() => silentClosed, 'unauthenticated socket dropped after 5 s', 7000);
  await waitFor(() => patient.messages.length, 'host.hello without extension.hello', 7000);
  assert.equal(patient.messages[0].params.extension, null);
  patient.socket.destroy();
  mute.host.stdin.end();

  // stdin close (browser port disconnect) removes our socket and exits.
  c1.socket.destroy();
  c3.socket.destroy();
  a.host.stdin.end();
  c.host.stdin.end();
  await Promise.all([a, c].map((h) => new Promise((r) => (h.host.exitCode !== null ? r() : h.host.once('exit', r)))));
  assert.ok(!fs.existsSync(sockName(1)) && !fs.existsSync(sockName(2)), 'sockets removed on exit');

  // A host that is still letting go of the name (a slow exit) doesn't push the new one to -2.
  const lingering = net.createServer((s) => s.destroy());
  await new Promise((resolve) => lingering.listen(sockName(1), resolve));
  const d = startHost();
  await new Promise((r) => setTimeout(r, 250));
  await new Promise((resolve) => lingering.close(resolve));
  const c4 = await (async () => {
    for (let tries = 0; ; tries++) {
      const client = fs.existsSync(sockName(1)) ? await connect(sockName(1)).catch(() => null) : null;
      if (client) return client;
      assert.ok(tries < 100, 'host never took the name back');
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  await waitFor(() => c4.messages[0]?.method === 'host.hello', 'hello on the reused name');
  assert.ok(!fs.existsSync(sockName(2)), 'fell back to -2');
  c4.socket.destroy();
  d.host.stdin.end();
  await new Promise((r) => (d.host.exitCode !== null ? r() : d.host.once('exit', r)));
  assert.ok(fs.readFileSync(path.join(dir, 'logs', 'node.log'), 'utf8').includes('listening'), 'log written');
  console.log('host self-test passed');
}

if (testMode) {
  try { await selfTest(); }
  catch (error) { console.error(error); process.exitCode = 1; }
  finally { for (const d of [dir, helloDir]) fs.rmSync(d, { recursive: true, force: true }); process.exit(); }
} else {
  const { host } = startHost();
  await waitFor(() => fs.existsSync(sockName()), 'socket');
  console.log(`fake extension running; socket: ${sockName()}\n  node tools/fb.mjs -b ${sockName()} tabs.listAll`);
  const stop = () => { host.stdin.end(); host.once('exit', () => { for (const d of [dir, helloDir]) fs.rmSync(d, { recursive: true, force: true }); process.exit(); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
