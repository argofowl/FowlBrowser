// A browser whose last window closed keeps running but unloads FowlBrowser: naming it reopens it in the background
// (once, however many calls name it) and the call goes on once its host is back. A browser that isn't running is never
// started. Fake hosts and a fake Mac: nothing real is looked at or reopened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-revive-'));
fs.writeFileSync(path.join(dir, 'token'), 'token');
process.env.FOWLBROWSER_DIR = dir;
const { BrowserManager, ownProcesses } = await import('../src/browsers.mjs');

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

// A host that answers the handshake, listening on <name>.sock.
function fakeHost(name) {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      const message = JSON.parse(chunk.subarray(4).toString());
      if (message.method === 'host.auth') socket.write(frame({ method: 'host.hello', params: { browser: name, extension: null } }));
      else if (message.method === 'client.hello') {
        socket.write(frame({ id: message.id, result: { ok: true } }));
        socket.write(frame({ method: 'extension.initialized', params: [] }));
      }
    });
  });
  return new Promise((resolve) => server.listen(path.join(dir, `${name}.sock`), () => resolve(server)));
}

const CHROME = '/Applications/Google Chrome.app';
const HELPER = `${CHROME}/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper`;

// installed: Chrome and Helium; processes: what ps shows; a reopen of Chrome brings its host up 300 ms later (or never).
function fakeMac({ processes, hostComesBack = true }) {
  const reopened = [];
  const servers = [];
  return {
    reopened,
    servers,
    installed: ({ key }) => key === 'chrome' || key === 'helium',
    processes: () => processes,
    reopen: (bundle) => {
      reopened.push(bundle);
      if (hostComesBack) setTimeout(async () => servers.push(await fakeHost('chrome')), 300);
    },
  };
}

const stop = (manager) => { for (const browser of manager.browsers.values()) { browser.stop(); browser.host.close(); } };

test('a running browser with FowlBrowser asleep is reopened in the background, once for calls at once, and the calls go on', async () => {
  const mac = fakeMac({ processes: [`${CHROME}/Contents/MacOS/Google Chrome`, HELPER] });
  const manager = new BrowserManager({ system: mac });
  try {
    assert.deepEqual(manager.asleep().map(({ key, bundle }) => [key, bundle]), [['chrome', CHROME], ['helium', null]]);
    const [a, b] = await Promise.all([manager.get('chrome'), manager.get('chrome')]);
    assert.equal(a.key, 'chrome');
    assert.equal(a, b);
    assert.deepEqual(mac.reopened, [CHROME], 'one reopen, of the running bundle');
    assert.deepEqual(manager.asleep().map((s) => s.key), ['helium'], 'connected now');
  } finally {
    stop(manager);
    for (const server of mac.servers) server.close();
  }
});

test('a browser that is not running is never started: the error says to ask the user', async () => {
  const mac = fakeMac({ processes: [HELPER] }); // a helper alone is no running Chrome
  const manager = new BrowserManager({ system: mac });
  await assert.rejects(manager.get('chrome'), /Chrome isn't running, so FowlBrowser can't reach it \(it never starts a browser\)\. Ask the user to open Chrome\./);
  assert.deepEqual(mac.reopened, []);
});

test('a reopen that brings no host back fails after the wait and is not repeated for a while', async () => {
  const mac = fakeMac({ processes: [`${CHROME}/Contents/MacOS/Google Chrome`], hostComesBack: false });
  const manager = new BrowserManager({ system: mac });
  const started = Date.now();
  await assert.rejects(manager.get('chrome'), /Chrome is running but FowlBrowser didn't come up in it, even after opening a window there in the background/);
  assert.ok(Date.now() - started >= 4900, `waited ${Date.now() - started} ms`);
  await assert.rejects(manager.get('chrome'), /didn't come up/);
  assert.deepEqual(mac.reopened, [CHROME], 'not reopened again');
});

test("another account's running Chrome bundle is never reopened as this user: only our own processes count", async () => {
  const uid = process.getuid();
  const planted = `/Users/Shared/x/Google Chrome.app`;
  const ps = [`${uid + 1} ${planted}/Contents/MacOS/Google Chrome`, `  0 /usr/sbin/cfprefsd`, `${uid} ${HELPER}`].join('\n');
  const theirs = fakeMac({ processes: ownProcesses(ps) });
  const manager = new BrowserManager({ system: theirs });
  await assert.rejects(manager.get('chrome'), /Chrome isn't running/);
  assert.deepEqual(theirs.reopened, []);

  const ours = ownProcesses(`${ps}\n${uid} ${CHROME}/Contents/MacOS/Google Chrome\n`);
  assert.deepEqual(ours, [HELPER, `${CHROME}/Contents/MacOS/Google Chrome`]);
  assert.deepEqual(new BrowserManager({ system: fakeMac({ processes: ours }) }).asleep().map((s) => s.bundle), [CHROME, null]);
});

test('with its own FOWLBROWSER_DIR the server looks at no real browser', async () => {
  const manager = new BrowserManager();
  assert.deepEqual(manager.asleep(), []);
  await assert.rejects(manager.get('chrome'), /Browser "chrome" is not connected/);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
