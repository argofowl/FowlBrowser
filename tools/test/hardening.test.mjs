// What the public repo must not hold or allow: machine details in fixtures, the user's own setup in rounds.mjs, task
// names as paths, and the harness's files in folders other users can reach.
import './fixtures/rounds-config.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import zlib from 'node:zlib';
import { badTaskNames, CODEX_AGENT_CWD, privateDir, setting } from '../rounds.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// A short-lived rounds.mjs or agent-stress.mjs run with its own HOME and TMPDIR (no browser sockets there).
function run(script, args, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
  const tmp = path.join(dir, 'tmp'); fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const write = (name, value) => { fs.writeFileSync(path.join(dir, name), JSON.stringify(value)); return path.join(dir, name); };
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args(write, dir)], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: dir, TMPDIR: tmp, FOWLBROWSER_ROUNDS_CONFIG: path.join(dir, 'config.json') } });
  return { ...r, dir, tmp, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
const task = (name, more = {}) => ({ name, browser: 'chrome', prompt: 'p', result: 'r', ...more });

test('trace fixtures: no user folder, debugging port or machine model in their metadata', () => {
  for (const name of ['trace-click.json.gz', 'trace-load.json.gz']) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(ROOT, 'mcp/test/fixtures', name))).toString('utf8');
    assert.deepEqual([...new Set([...text.matchAll(/\/Users\/([^/"\s]+)/g)].map((m) => m[1]))], ['u'], name);
    const meta = JSON.parse(text).metadata;
    assert.doesNotMatch(meta.command_line, /remote-debugging-port|user-data-dir|load-extension/, name);
    assert.equal(meta['hardware-class'], 'Mac', name);
    assert.doesNotMatch(meta['gpu-gl-renderer'], /\bM\d|Build/, name);
    assert.equal(meta['physical-memory'], '16384', name);
  }
});

test('rounds config: values come from the config file, a missing one names its key in one line', () => {
  assert.deepEqual(setting('codexBrowsers'), { helium: 'H-ID', chrome: 'C-ID' });
  assert.throws(() => setting('nope'), (err) => err.setting === 'nope' && /^set "nope" in .*rounds-config\.json/.test(err.message) && !err.message.includes('\n'));
  const r = run('tools/rounds.mjs', (write) => ['--tasks', write('tasks.json', [task('slow')]), '--surface', 'devtools']);
  r.done();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^set "devtools" in .*config\.json \(see the top of tools\/rounds\.mjs\)\n$/);
});

test('task names that are not plain words stop both harnesses before any path is built', () => {
  const tasks = [task('ok-1'), task('../../escape'), task("a'b")];
  assert.deepEqual(badTaskNames(tasks), ['../../escape', "a'b"]);
  const rounds = run('tools/rounds.mjs', (write, dir) => ['--tasks', write('tasks.json', tasks), '--out', path.join(dir, 'out')]);
  rounds.done();
  assert.equal(rounds.status, 2);
  assert.equal(rounds.stderr, 'task names may only have letters, digits, - and _: "../../escape", "a\'b"\n');
  const stress = run('tools/agent-stress.mjs', (write, dir) => ['--tasks', write('tasks.json', tasks), '--dir', path.join(dir, 'none')]);
  const made = fs.readdirSync(stress.tmp);
  stress.done();
  assert.equal(stress.status, 2);
  assert.equal(stress.stderr, 'task names may only have letters, digits, - and _: "../../escape", "a\'b"\n');
  assert.deepEqual(made, []);
});

test('every checked-in task file uses plain task names', () => {
  const dir = path.join(ROOT, 'tools/agents');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    assert.deepEqual(badTaskNames(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))), [], file);
  }
});

test('the round\'s output goes to a new private folder under the user\'s temp dir; --out still picks it', () => {
  const r = run('tools/rounds.mjs', (write) => ['--tasks', write('tasks.json', [task('shop')])]);
  const made = fs.readdirSync(r.tmp);
  const mode = made.length === 1 ? fs.statSync(path.join(r.tmp, made[0])).mode & 0o777 : null;
  const settings = made.length === 1 && fs.existsSync(path.join(r.tmp, made[0], 'settings.json'));
  r.done();
  assert.match(r.stderr, /Not connected/); // got as far as the browsers, which this HOME has none of
  assert.equal(made.length, 1);
  assert.match(made[0], /^fb-rounds-\d{8}-\d{6}-\w{6}$/);
  assert.equal(mode, 0o700);
  assert.ok(settings);
  const given = run('tools/rounds.mjs', (write, dir) => ['--tasks', write('tasks.json', [task('shop')]), '--out', path.join(dir, 'mine')]);
  const there = fs.existsSync(path.join(given.dir, 'mine', 'settings.json'));
  given.done();
  assert.ok(there);
});

test('the Codex agents\' working folder: one stable private folder of the user\'s, never a link or someone else\'s', (t) => {
  assert.equal(path.dirname(CODEX_AGENT_CWD), os.tmpdir().replace(/\/$/, ''));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'codex-agent');
  assert.equal(privateDir(cwd), cwd);
  assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
  assert.equal(privateDir(cwd), cwd); // the next round finds it there
  fs.symlinkSync(cwd, path.join(dir, 'link'));
  assert.throws(() => privateDir(path.join(dir, 'link')), /is not a folder of this user's/);
  fs.writeFileSync(path.join(dir, 'file'), '');
  assert.throws(() => privateDir(path.join(dir, 'file')), /is not a folder of this user's/);
  for (const mode of [0o777, 0o770, 0o702]) {
    fs.chmodSync(cwd, mode);
    assert.throws(() => privateDir(cwd), /is not a folder of this user's/, mode.toString(8));
  }
});

test('agent-stress output goes to a new private folder under the user\'s temp dir; --out still picks it', () => {
  const r = run('tools/agent-stress.mjs', (write, dir) => ['--tasks', write('tasks.json', [task('shop')]), '--dir', path.join(dir, 'none')]);
  const made = fs.readdirSync(r.tmp);
  const mode = made.length === 1 ? fs.statSync(path.join(r.tmp, made[0])).mode & 0o777 : null;
  r.done();
  assert.equal(made.length, 1);
  assert.match(made[0], /^fb-agents-\d+-\w{6}$/);
  assert.equal(mode, 0o700);
  const given = run('tools/agent-stress.mjs', (write, dir) => ['--tasks', write('tasks.json', [task('shop')]), '--dir', path.join(dir, 'none'), '--out', path.join(dir, 'mine')]);
  const there = fs.existsSync(path.join(given.dir, 'mine'));
  const none = fs.readdirSync(given.tmp);
  given.done();
  assert.ok(there);
  assert.deepEqual(none, []);
});

test('event fixtures carry only synthetic ids: no real browser instance, session, message or request id', () => {
  for (const name of ['codex-events.jsonl', 'fowlbrowser-events.jsonl']) {
    const text = fs.readFileSync(path.join(ROOT, 'tools/test/fixtures', name), 'utf8');
    for (const [, id] of text.matchAll(/extensionInstanceId: '([^']*)'/g)) assert.match(id, /^[CH]-ID$/, name);
    for (const [id] of text.matchAll(/\b(?:msg|toolu|req)_\w+/g)) assert.match(id, /^(msg|toolu|req)_(fixture\d+|\d|s)$/, `${name}: ${id}`);
    for (const [id] of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) assert.match(id, /^00000000-0000-4000-8000-/, `${name}: ${id}`);
  }
});
