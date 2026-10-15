// Turn-end cleanup (src/turns.mjs) against doubles: which tabs close, which go back to the user, which are skipped,
// subagents deferring it, and the hook (bin/turn-ended.mjs) finding the socket of its first `claude` ancestor.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock, test } from 'node:test';
import { findSocket } from '../bin/turn-ended.mjs';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';
import { callsByTab, endTurn, listenForTurns, SUBAGENTS_STALE_MS, turnSocketPath } from '../src/turns.mjs';

const page = Object.assign(new EventEmitter(), { setDefaultTimeout() {}, setDefaultNavigationTimeout() {} });
page.setMaxListeners(0);

// A browser whose extension knows tabs 1-8: 1 an unkept agent tab, 2 kept, 3 claimed, 4 busy, 5 the user's own,
// 6 a popup child of a claimed tab (agent origin, kept, not handed over), 7 owned but not mapped yet (tab_open in
// progress), 8 mapped with a tool call naming it in flight (not on the Tab queue yet).
function fakeBrowser() {
  const owners = new Map([
    [1, { origin: 'agent', handedOver: false, kept: false }],
    [2, { origin: 'agent', handedOver: true, kept: true }],
    [3, { origin: 'user', handedOver: false, kept: false }],
    [4, { origin: 'agent', handedOver: false, kept: false }],
    [6, { origin: 'agent', handedOver: false, kept: true }],
    [7, { origin: 'agent', handedOver: false, kept: false }],
    [8, { origin: 'agent', handedOver: false, kept: false }],
  ]);
  const calls = [];
  const host = {
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'tabs.listAll' || method === 'tabs.info') {
        await new Promise((resolve) => setTimeout(resolve, 0)); // the extension answers later
        const all = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((id) => ({ id, owner: owners.has(id) ? 'you' : null, ...owners.get(id) }));
        return method === 'tabs.info' ? all.find((t) => t.id === params.tabId) ?? null : all;
      }
      await new Promise((resolve) => setTimeout(resolve, 50)); // slow enough for a concurrent request to join the run
      if (method === 'chrome.tabs.remove') return void owners.delete(params[0]);
      if (method === 'tabs.release') return void owners.delete(params.tabId);
      throw new Error(`unexpected ${method}`);
    },
  };
  const browser = { key: 'chrome', host, tabs: new Map(), calls, owners, forget(tabId) { this.tabs.delete(tabId); } };
  for (const id of [1, 2, 3, 4, 6, 8]) browser.tabs.set(id, new Tab({ ...browser, key: 'chrome' }, id, page));
  return browser;
}

const managerOf = (browser) => ({ browsers: new Map([[browser.key, browser]]) });
const sorted = (reply) => Object.fromEntries(Object.entries(reply).map(([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v]));

const ask = (socketPath, line = 'turn_ended') => new Promise((resolve, reject) => {
  let reply = '';
  const socket = net.connect(socketPath, () => socket.write(`${line}\n`));
  socket.on('data', (chunk) => { reply += chunk; });
  socket.on('end', () => resolve(JSON.parse(reply)));
  socket.on('error', reject);
});

test('closes unkept agent tabs, releases kept, claimed and kept children, skips busy and unmapped ones', async () => {
  const browser = fakeBrowser();
  const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}.sock`;
  const server = listenForTurns(managerOf(browser), socketPath);

  let finish;
  browser.tabs.get(4).run(() => new Promise((resolve) => { finish = resolve; })); // a subagent's call still running
  callsByTab.set('chrome:8', 1);

  const [first, concurrent] = await Promise.all([ask(socketPath), ask(socketPath)]);
  assert.deepEqual(sorted(first), { closed: ['chrome:1'], released: ['chrome:2', 'chrome:3', 'chrome:6'], skipped: ['chrome:4', 'chrome:7', 'chrome:8'] });
  assert.deepEqual(concurrent, first, 'concurrent requests share one run');
  assert.equal(browser.calls.filter(([m]) => m === 'chrome.tabs.remove').length, 1);
  assert.deepEqual([...browser.tabs.keys()].sort(), [4, 8], 'closed and released tabs leave the session');

  finish();
  await browser.tabs.get(4).run(() => {});
  callsByTab.delete('chrome:8');
  assert.deepEqual(sorted(await ask(socketPath)), { closed: ['chrome:4', 'chrome:8'], released: [], skipped: ['chrome:7'] });
  browser.owners.delete(7);
  assert.deepEqual(await ask(socketPath), { closed: [], released: [], skipped: [] });
  server.close();
  fs.rmSync(socketPath, { force: true });
});

test('a browser the session has no tabs in is not asked: the turn ends at once', async () => {
  const browser = fakeBrowser();
  browser.tabs.clear();
  browser.host.request = () => new Promise(() => {}); // a busy browser that never answers
  const waited = new Promise((resolve) => setTimeout(resolve, 1000, 'waited for the browser').unref());
  assert.deepEqual(await Promise.race([endTurn(managerOf(browser)), waited]), { closed: [], released: [], skipped: [] });
});

test('takes the tab ids before any await: a tab mapped meanwhile is left alone', async () => {
  const browser = fakeBrowser();
  const running = endTurn(managerOf(browser));
  browser.owners.set(9, { origin: 'agent', handedOver: false, kept: false });
  browser.tabs.set(9, new Tab({ ...browser, key: 'chrome' }, 9, page)); // a later turn's tab_open
  const result = await running;
  assert.ok(result.skipped.includes('chrome:9'));
  assert.ok(!browser.calls.some(([m, p]) => m === 'chrome.tabs.remove' && p[0] === 9));
  assert.ok(browser.tabs.has(9));
});

test('a tab a later turn released and reclaimed under the same id is left alone', async () => {
  const browser = fakeBrowser();
  const running = endTurn(managerOf(browser));
  const reclaimed = new Tab({ ...browser, key: 'chrome' }, 3, page); // the old Tab object is still in the turn's copy
  browser.tabs.set(3, reclaimed);
  const result = await running;
  assert.ok(result.skipped.includes('chrome:3'));
  assert.ok(!browser.calls.some(([m, p]) => m === 'tabs.release' && p.tabId === 3), 'not released');
  assert.equal(browser.tabs.get(3), reclaimed, 'the new mapping is not forgotten');
});

test('tool calls count under "<browser>:<id>" however the tab id was typed', async () => {
  const handlers = {};
  let unblock;
  const manager = { get: () => new Promise((resolve) => { unblock = resolve; }) };
  registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, manager);
  const call = handlers.snapshot({ tab: ' Chrome:52 ' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(callsByTab.get('chrome:52'), 1);
  unblock({ relay: { model: { hasTab: () => false } }, tabs: new Map(), host: { request: async () => [] }, key: 'chrome' });
  await call;
  assert.equal(callsByTab.has('chrome:52'), false);
});

test('an older extension without kept: handedOver decides, as before', async () => {
  const browser = fakeBrowser();
  const request = browser.host.request;
  browser.host.request = async (method, params) => {
    const reply = await request(method, params);
    return method === 'tabs.listAll' ? reply.map(({ kept, ...rest }) => rest) : reply;
  };
  const result = await endTurn(managerOf(browser));
  assert.ok(result.released.includes('chrome:2'));
  assert.ok(result.closed.includes('chrome:1'));
});

test('while subagents run, turn ends are deferred; the count never goes below zero', async () => {
  const browser = fakeBrowser();
  const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}-sub.sock`;
  const server = listenForTurns(managerOf(browser), socketPath);
  assert.deepEqual(await ask(socketPath, 'subagent_start'), { subagents: 1 });
  assert.deepEqual(await ask(socketPath), { closed: [], released: [], skipped: [], deferred: true });
  assert.equal(browser.calls.length, 0, 'nothing touched');
  assert.deepEqual(await ask(socketPath, 'subagent_stop'), { subagents: 0 });
  assert.deepEqual(await ask(socketPath, 'subagent_stop'), { subagents: 0 });
  const after = await ask(socketPath);
  assert.equal(after.deferred, undefined);
  assert.deepEqual(after.closed.sort(), ['chrome:1', 'chrome:4', 'chrome:8']);
  assert.deepEqual(await ask(socketPath, 'subagent_start'), { subagents: 1 }, 'recovers from the extra stop');
  await ask(socketPath, 'subagent_stop');
  server.close();
  fs.rmSync(socketPath, { force: true });
});

test('a subagent count unchanged for over 30 min (a lost SubagentStop) no longer defers turn ends', async () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const browser = fakeBrowser();
  const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}-stale.sock`;
  const server = listenForTurns(managerOf(browser), socketPath);
  try {
    assert.deepEqual(await ask(socketPath, 'subagent_start'), { subagents: 1 });
    mock.timers.tick(SUBAGENTS_STALE_MS - 1000);
    assert.equal((await ask(socketPath)).deferred, true, 'still running as far as we know');
    mock.timers.tick(2000);
    const after = await ask(socketPath);
    assert.equal(after.deferred, undefined);
    assert.deepEqual(after.closed.sort(), ['chrome:1', 'chrome:4', 'chrome:8']);
    assert.deepEqual(await ask(socketPath, 'subagent_start'), { subagents: 1 }, 'counted from 0 again');
    await ask(socketPath, 'subagent_stop');
  } finally {
    mock.timers.reset();
    server.close();
    fs.rmSync(socketPath, { force: true });
  }
});

test('a failing tab is listed, not thrown', async () => {
  const browser = fakeBrowser();
  const request = browser.host.request;
  browser.host.request = async (method, params) => {
    if (method === 'tabs.release' && params.tabId === 3) throw new Error('boom');
    return request(method, params);
  };
  const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}-2.sock`;
  const server = listenForTurns(managerOf(browser), socketPath);
  const reply = await ask(socketPath);
  assert.deepEqual(reply.errors, [{ tab: 'chrome:3', error: 'boom' }]);
  assert.deepEqual(reply.released.sort(), ['chrome:2', 'chrome:6']);
  assert.ok(browser.tabs.has(3), 'still ours, so still controlled');
  server.close();
  fs.rmSync(socketPath, { force: true });
});

test('on exit the socket is removed only while it is still ours', () => {
  const turns = new URL('../src/turns.mjs', import.meta.url).href;
  const run = (takeOver) => {
    const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}-exit-${takeOver}.sock`;
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import net from 'node:net';
      const { listenForTurns } = await import(${JSON.stringify(turns)});
      const server = listenForTurns({ browsers: new Map() }, ${JSON.stringify(socketPath)});
      await new Promise((resolve) => server.on('listening', resolve));
      if (${takeOver}) { fs.rmSync(${JSON.stringify(socketPath)}); await new Promise((resolve) => net.createServer().listen(${JSON.stringify(socketPath)}, resolve)); }
      process.exit(0);
    `]);
    const left = fs.existsSync(socketPath);
    fs.rmSync(socketPath, { force: true });
    return left;
  };
  assert.equal(run(false), false, 'our own socket is removed');
  assert.equal(run(true), true, 'a socket another server took over stays');
});

test('the hook stops at the first claude ancestor and never looks further up', () => {
  const chain = { 300: ['zsh', 200], 200: ['/home/x/.local/share/claude/versions/2.1/claude', 100], 100: ['claude', 1] };
  const asked = [];
  const ps = ([, field, , pid]) => {
    asked.push(Number(pid));
    return String(field === 'comm=' ? chain[pid][0] : chain[pid][1]);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-turns-'));
  fs.mkdirSync(path.join(dir, 'turns'));
  const outer = turnSocketPath(100, dir);
  fs.writeFileSync(outer, '');
  try {
    assert.equal(findSocket(300, ps, dir), null, 'no socket at the first claude: stop there');
    assert.ok(!asked.includes(100), 'the outer claude is never asked about');
    const inner = turnSocketPath(200, dir);
    fs.writeFileSync(inner, '');
    try { assert.equal(findSocket(300, ps, dir), inner); } finally { fs.rmSync(inner); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the turn socket is in the FowlBrowser folder, made private, else in the user\'s temp folder; never in /tmp', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-turns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(turnSocketPath(4321, dir), path.join(dir, 'turns', '4321.sock'));
  // Too long for a socket path: the user's own temp folder, never the shared /tmp.
  const long = `/tmp/${'x'.repeat(90)}`;
  assert.equal(turnSocketPath(4321, long), path.join(os.tmpdir(), 'fowlbrowser-turn-4321.sock'));
  const tmp = path.join(dir, 'T');
  fs.mkdirSync(tmp);
  const fallback = turnSocketPath(4322, long, tmp);
  assert.equal(fallback, path.join(tmp, 'fowlbrowser-turn-4322.sock'));
  const late = listenForTurns({ browsers: new Map() }, fallback);
  await new Promise((resolve) => late.listening ? resolve() : late.once('listening', resolve));
  try { assert.equal(findSocket(4322, () => 'claude', long, tmp), fallback); } finally { late.close(); }
  const server = listenForTurns({ browsers: new Map() }, turnSocketPath(4321, dir));
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  try {
    assert.equal(fs.statSync(path.join(dir, 'turns')).mode & 0o777, 0o700);
    const ps = ([, field]) => (field === 'comm=' ? 'claude' : '1');
    assert.equal(findSocket(4321, ps, dir), path.join(dir, 'turns', '4321.sock'));
  } finally { server.close(); }
  // Another user's socket in the shared /tmp is never contacted.
  const pid = 900_000 + (process.pid % 90_000); // a pid no claude has, so no real server's socket
  const legacy = `/tmp/fowlbrowser-turn-${pid}.sock`;
  fs.writeFileSync(legacy, '');
  try { assert.equal(findSocket(pid, () => 'claude', dir), null); } finally { fs.rmSync(legacy, { force: true }); }
});

test('a temp folder others can write to, or that is a symlink, is used by neither the server nor the hook', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-turns-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const long = `/tmp/${'x'.repeat(90)}`;
  const shared = path.join(dir, 'shared');
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o1777); // like /tmp
  fs.writeFileSync(path.join(shared, 'fowlbrowser-turn-4323.sock'), ''); // planted by another user
  const link = path.join(dir, 'link');
  fs.symlinkSync(os.tmpdir(), link);
  for (const tmp of [shared, link, '/tmp']) {
    assert.equal(turnSocketPath(4323, long, tmp), null, tmp);
    assert.equal(findSocket(4323, () => 'claude', long, tmp), null, tmp);
  }
  assert.equal(listenForTurns({ browsers: new Map() }, turnSocketPath(4323, long, shared)), null, 'no server, no crash');
});

test('a turn line longer than any the hook sends is dropped before its newline', async (t) => {
  const socketPath = `/tmp/fowlbrowser-turn-test-${process.pid}-long.sock`;
  const server = listenForTurns({ browsers: new Map() }, socketPath);
  t.after(() => { server.close(); fs.rmSync(socketPath, { force: true }); });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const closed = await new Promise((resolve) => {
    const socket = net.connect(socketPath, () => socket.write('x'.repeat(10_000)));
    socket.on('close', () => resolve(true));
    socket.on('error', () => {});
    setTimeout(() => resolve(false), 1000).unref();
  });
  assert.ok(closed, 'dropped without a newline');
  assert.deepEqual(await ask(socketPath, 'subagent_stop'), { subagents: 0 }, 'short lines still answered');
});

// A real process chain: this test process (with a socket named after it) -> a fake `claude` -> the hook. The hook
// reaches the fake claude's socket, sends the line for its event, and never contacts this process's socket.
test('the hook talks to its claude parent only, one line per known event, nothing for unknown ones', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-hook-'));
  const fakeClaude = path.join(dir, 'claude');
  fs.symlinkSync(process.execPath, fakeClaude);
  fs.mkdirSync(path.join(dir, 'turns'));
  const outerLines = [];
  const outer = net.createServer((socket) => socket.on('data', (chunk) => { outerLines.push(String(chunk)); socket.end('{}\n'); }));
  await new Promise((resolve) => outer.listen(turnSocketPath(process.pid, dir), resolve));
  const hook = fileURLToPath(new URL('../bin/turn-ended.mjs', import.meta.url));
  const script = `
    const net = require('node:net');
    const { execFile } = require('node:child_process');
    const lines = [];
    const server = net.createServer((s) => s.on('data', (c) => { lines.push(String(c).trim()); s.end('{}\\n'); }));
    server.listen(require('node:path').join(process.env.FOWLBROWSER_DIR, 'turns', process.pid + '.sock'), async () => {
      // null: no hook_event_name; 'not json': unreadable input. Neither may send anything.
      for (const event of ['SubagentStart', 'PreToolUse', null, 'not json', 'toString', 'SubagentStop', 'Stop']) {
        await new Promise((resolve) => {
          const child = execFile(${JSON.stringify(process.execPath)}, [${JSON.stringify(hook)}], (error, out) => { if (out) lines.push('stdout:' + out); resolve(); });
          child.stdin.end(event === 'not json' ? '{' : JSON.stringify(event === null ? {} : { hook_event_name: event }));
        });
      }
      server.close();
      console.log(JSON.stringify(lines));
    });`;
  try {
    const out = await new Promise((resolve, reject) => execFile(fakeClaude, ['-e', script], { env: { ...process.env, FOWLBROWSER_DIR: dir } },
      (error, stdout) => (error ? reject(error) : resolve(stdout))));
    assert.deepEqual(JSON.parse(out), ['subagent_start', 'subagent_stop', 'turn_ended'], 'printed nothing, one line per known event, none for the rest');
    assert.deepEqual(outerLines, [], 'the socket beyond the first claude ancestor was never contacted');
  } finally {
    outer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
