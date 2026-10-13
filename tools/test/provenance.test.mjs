// Codex teardown provenance and the --remote round's own resources (unique local dir, free ports, bed manifest).
import './fixtures/rounds-config.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { bedDiff, bedManifest, codexCreatedTabs, openRemote, parseTranscript, portsInUse, processGroup, remoteLocalDir } from '../rounds.mjs';

const t = 1_760_000_000_000;
const use = (at, id, code) => ({ t: at, type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__codex-cu__js', input: { code } }] } });
const result = (at, id, text) => ({ t: at, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

test('codex teardown: only the id a single creating call returned is the agent\'s; batched output and timing stay open', () => {
  const transcript = parseTranscript([
    use(t, 'a', "const tab = await cua.createBrowserTab(b.browserId, 'http://127.0.0.1:5420/t/x/shop/', { sessionName: '🧪 x' })"),
    result(t + 900, 'a', 'Browser tab: 101, Title: "Shop"\n0 AXWebArea Shop\nThe focused UI element is in Browser tab: 101'),
    // a click whose popup came into being during the call and is named in its result: timing only, not proven
    use(t + 2000, 'b', 'await tab.click(12)'),
    result(t + 3000, 'b', 'Browser tab: 102, Title: "Size guide"'),
    // a tab the agent only looked up (the user's, open before the call) is named but not created
    use(t + 4000, 'c', "const mine = await cua.getTab({ url: 'http://127.0.0.1:5420/t/x/shop/cart' }, { browser: b })"),
    result(t + 4500, 'c', 'Browser tab: 103, Title: "Cart"'),
    // one call creates 105 and gets the user's 106: its result names both, so neither is proven
    use(t + 5000, 'd', "const n = await cua.createBrowserTab(b.browserId, 'http://127.0.0.1:5420/t/x/shop/'); const u = await cua.getTab('106', { browser: b.browserId }); [n, u]"),
    result(t + 5500, 'd', 'Browser tab: 105, Title: "Shop"\nBrowser tab: 106, Title: "Mail"'),
    // a creation batched with a lookup names one tab: the lookup's, maybe
    use(t + 6000, 'e', "await cua.createBrowserTab(b.browserId); const u = await cua.getTab('108', { browser: b.browserId }); u"),
    result(t + 6200, 'e', 'Browser tab: 108'),
    // two creations in one call
    use(t + 7000, 'f', 'const p = await b.newTab(); const q = await b.newTab(); q'),
    result(t + 7200, 'f', 'Browser tab: 109'),
    // a tab open at round start, even from a creating call, is never the agent's
    use(t + 8000, 'g', 'await cua.createBrowserTab(b.browserId)'),
    result(t + 8200, 'g', 'Browser tab: 7'),
  ]);
  assert.deepEqual(transcript.namedTabs.map((n) => [n.ids, n.created]),
    [[[101], 101], [[102], null], [[103], null], [[105, 106], null], [[108], null], [[109], null], [[7], 7]]);
  const created = codexCreatedTabs({ browser: 'chrome', transcript, startKeys: new Set(['chrome:7']) });
  assert.deepEqual([...created], ['chrome:101']);
});

test('remote: a failed setup stops the ssh master and lock it started and removes its dir', async (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ssh-'));
  // A fake ssh: the master and the lock stay up (pids recorded), the control check passes, the bed check finds nothing.
  fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
case "$*" in
  *'echo $HOME'*) echo /nowhere ;;
  *' -N '*) echo $$ >> "${bin}/pids"; exec sleep 60 ;;
  *'-O check'*) exit 0 ;;
  *guilock*) echo $$ >> "${bin}/pids"; echo locked; exec sleep 60 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => { process.env.PATH = before; fs.rmSync(bin, { recursive: true, force: true }); });
  const dirs = () => new Set(fs.readdirSync('/tmp').filter((d) => d.startsWith('fb-remote-')));
  const had = dirs();
  await assert.rejects(openRemote('fakehost', { owner: 'test', ports: [], stamp: 'x', surface: 'codex' }), /test bed .* is not this tree/);
  const pids = fs.readFileSync(path.join(bin, 'pids'), 'utf8').trim().split('\n').map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.deepEqual([...dirs()].filter((d) => !had.has(d)), []);
});

test('processGroup: stop kills and waits for every process it started', async () => {
  const procs = processGroup();
  const a = procs.spawn('sleep', ['60']); const b = procs.spawn('sleep', ['60']); const done = procs.spawn('true');
  await new Promise((resolve) => done.once('exit', resolve));
  await procs.stop();
  for (const p of [a, b]) assert.equal(p.signalCode, 'SIGTERM');
});

test('remote: each round gets its own local dir; making one leaves another round\'s alone', () => {
  const a = remoteLocalDir();
  fs.writeFileSync(path.join(a, 'cm'), '');
  const b = remoteLocalDir();
  assert.notEqual(a, b);
  assert.match(path.basename(b), /^fb-remote-/);
  assert.ok(fs.existsSync(path.join(a, 'cm')));
  for (const dir of [a, b]) fs.rmSync(dir, { recursive: true });
});

test('remote: ports already taken locally are found before ssh tries to forward them', async (t) => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const free = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  assert.deepEqual(await portsInUse([port, free]), [port]);
});

test('remote: the bed manifest covers every runtime file of the surface, and a stale or missing one fails the check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bed-'));
  const files = { 'extension/core.js': 'core', 'extension/test/x.test.mjs': 't', 'extension/NOTES.md': 'n', 'mcp/src/takeover.mjs': 'take',
    'mcp/src/vendor/cdpRelay.mjs': 'relay', 'mcp/node_modules/z/index.js': 'z', 'mcp/package-lock.json': '{}', 'test/demo/server.mjs': 'demo',
    'tools/mcp-tee.mjs': 'tee', 'host/host.mjs': 'host' };
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), body); }
  const fb = bedManifest('fowlbrowser', root);
  assert.deepEqual(Object.keys(fb).sort(), ['extension/core.js', 'host/host.mjs', 'mcp/package-lock.json', 'mcp/src/takeover.mjs', 'mcp/src/vendor/cdpRelay.mjs', 'test/demo/server.mjs']);
  assert.deepEqual(Object.keys(bedManifest('codex', root)).sort(), ['extension/core.js', 'host/host.mjs', 'test/demo/server.mjs', 'tools/mcp-tee.mjs']);
  const md5 = (m) => Object.entries(m).map(([f, h]) => `${h} ${f}`).join('\n');
  assert.deepEqual(bedDiff(fb, md5(fb)), []);
  const stale = { ...fb, 'mcp/src/takeover.mjs': '0'.repeat(32) };
  delete stale['mcp/src/vendor/cdpRelay.mjs'];
  assert.deepEqual(bedDiff(fb, md5(stale)), ['mcp/src/takeover.mjs', 'mcp/src/vendor/cdpRelay.mjs']);
  fs.rmSync(root, { recursive: true });
});
