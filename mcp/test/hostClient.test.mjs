// HostClient against a fake host socket: a rename (extension.hello) during the handshake is kept in hello.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostclient-'));
fs.writeFileSync(path.join(dir, 'token'), 'token');
process.env.FOWLBROWSER_DIR = dir;
const { HostClient } = await import('../src/hostClient.mjs');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

test('a rename between host.hello and extension.initialized is not lost', async () => {
  const extension = { version: '0.1.0', instanceId: 'x', userAgent: 'Chrome/1' };
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: 'chrome', extension: { ...extension, label: 'Old' } } }));
      else if (message.method === 'client.hello') {
        socket.write(frame({ method: 'extension.hello', params: { ...extension, label: 'Work' } }));
        socket.write(frame({ id: message.id, result: { ok: true } }));
        socket.write(frame({ method: 'extension.initialized', params: [] }));
      }
    });
  });
  const socketPath = path.join(dir, 'chrome.sock');
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const host = new HostClient(socketPath);
  try {
    await host.connect('unit');
    assert.equal(host.hello.extension.label, 'Work');
  } finally {
    host.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extension errors name tabs as agents know them, with the browser ("helium:648140042")', async () => {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: 'helium', extension: null } }));
      else if (message.method === 'client.hello') {
        socket.write(frame({ id: message.id, result: { ok: true } }));
        socket.write(frame({ method: 'extension.initialized', params: [] }));
      } else socket.write(frame({ id: message.id, error: { message: `Tab ${message.params[0]} is closed already` } }));
    });
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token'), 'token');
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostclient-ids-'));
  after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  const socketPath = path.join(socketDir, 'helium.sock');
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const host = new HostClient(socketPath);
  try {
    await host.connect('unit');
    await assert.rejects(host.request('chrome.tabs.remove', [648140042]), { message: 'Tab helium:648140042 is closed already' });
  } finally {
    host.close();
    server.close();
  }
});

test('host requests time out after 40 s, CDP commands only once the host\'s own 120 s limit has had its say', async (t) => {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      for (buffer = Buffer.concat([buffer, chunk]); buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0); buffer = buffer.subarray(4 + buffer.readUInt32LE(0))) {
        const message = JSON.parse(buffer.subarray(4, 4 + buffer.readUInt32LE(0)).toString());
        if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: 'chrome', extension: null } }));
        else if (message.method === 'client.hello') {
          socket.write(frame({ id: message.id, result: { ok: true } }));
          socket.write(frame({ method: 'extension.initialized', params: [] }));
        } // anything else: never answered
      }
    });
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token'), 'token');
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostclient-wait-'));
  after(() => fs.rmSync(socketDir, { recursive: true, force: true }));
  const socketPath = path.join(socketDir, 'chrome.sock');
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const host = new HostClient(socketPath);
  try {
    await host.connect('unit');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const outcome = (promise) => promise.then(() => 'answered', (error) => error.message);
    const info = outcome(host.request('tabs.info', { tabId: 1 }));
    const evaluation = outcome(host.request('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Runtime.callFunctionOn', { awaitPromise: true }]));
    t.mock.timers.tick(40_000);
    assert.equal(await info, 'tabs.info timed out');
    t.mock.timers.tick(90_000); // 130 s: the host answers by then (its 120 s, checked every 10 s)
    assert.equal(await Promise.race([evaluation, Promise.resolve('waiting')]), 'waiting');
    t.mock.timers.tick(5_000);
    assert.equal(await evaluation, 'chrome.debugger.sendCommand timed out');
  } finally {
    t.mock.timers.reset();
    host.close();
    server.close();
  }
});

test('a frame of several megabytes arriving in small chunks, then two frames in one chunk, come through whole and fast', async () => {
  const big = { method: 'chrome.debugger.onEvent', params: [{ tabId: 1 }, 'Tracing.dataCollected', { value: 'x'.repeat(6 * 1024 * 1024) }] };
  const small = [{ method: 'tabs.changed', params: [] }, { method: 'tabs.changed', params: [1] }];
  let socketIn;
  const server = net.createServer((socket) => {
    socketIn = socket;
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: 'chrome', extension: null } }));
      else if (message.method === 'client.hello') { socket.write(frame({ id: message.id, result: { ok: true } })); socket.write(frame({ method: 'extension.initialized', params: [] })); }
    });
  });
  fs.mkdirSync(dir, { recursive: true }); // the token the client reads (the test above removes its dir at the end)
  fs.writeFileSync(path.join(dir, 'token'), 'token');
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hostclient-big-')), 'big.sock');
  await new Promise((resolve) => server.listen(sock, resolve));
  const client = new HostClient(sock);
  await client.connect('unit');
  const got = [];
  client.on('event', (method, params) => got.push({ method, params }));
  try {
    const started = Date.now();
    const whole = frame(big);
    for (let at = 0; at < whole.length; at += 16 * 1024) socketIn.write(whole.subarray(at, at + 16 * 1024));
    socketIn.write(Buffer.concat(small.map(frame)));
    for (let i = 0; i < 200 && got.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(got.length, 3, `events: ${got.map((e) => e.method).join(', ')}`);
    assert.equal(got[0].params[2].value.length, 6 * 1024 * 1024);
    assert.deepEqual(got.slice(1).map((e) => e.params), [[], [1]]);
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  } finally {
    client.close();
    server.close();
  }
});
