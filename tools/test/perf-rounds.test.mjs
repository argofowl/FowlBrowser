// The performance round pieces of tools/rounds.mjs: the devtools surface, number checks and url-matched tabs.
import './fixtures/rounds-config.mjs';
import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { agentSetup, agentTabs, controlledBy, gradeNumbers } from '../rounds.mjs';

const t = 1_760_000_000_000;

test('devtools surface: the relay MCP of the task\'s browser, only its tools, and the prompt asks to close pages', () => {
  const setup = agentSetup({ task: { name: 'slow-dt', browser: 'helium', prompt: 'why is {browser} slow', result: 'x' }, surface: 'devtools', dir: '/tmp/x', mcpRoot: '/r', settings: '/s', model: 'opus', effort: 'medium' });
  const server = setup.mcpConfig.mcpServers.devtools;
  assert.equal(server.command, `${os.homedir()}/bin/devtools-mcp.sh`);
  assert.deepEqual(server.env, { PORT: '9002' });
  assert.deepEqual(agentSetup({ task: { name: 'a', browser: 'chrome', prompt: 'p', result: 'x' }, surface: 'devtools', dir: '/tmp/x', mcpRoot: '/r', settings: '/s', model: 'opus', effort: 'medium' }).mcpConfig.mcpServers.devtools.env, { PORT: '9001' });
  assert.equal(setup.args[setup.args.indexOf('--allowedTools') + 1], 'mcp__devtools');
  assert.match(setup.prompt, /mcp__devtools__\* tools .*connected to Helium/);
  assert.match(setup.prompt, /close every page you opened with close_page/);
  assert.match(setup.prompt, /why is Helium slow/);
  assert.throws(() => agentSetup({ task: { name: 'a', browser: 'chrome', prompt: 'p', result: 'x' }, surface: 'devtools', dir: '/tmp/x', mcpRoot: '/r', settings: '/s', model: 'opus', effort: 'medium', remote: { ssh: [], runDir: '/r', bed: '/b' } }), /no --remote/);
});

test('devtools tabs are never controlled: left open means left for the user', () => {
  assert.equal(controlledBy('devtools', 'a')('chrome:1', { 'chrome:1': { owner: 'you' } }), false);
  assert.equal(controlledBy('fowlbrowser', 'a')('chrome:1', { 'chrome:1': { owner: 'you' } }), true);
});

test('numbers: in range, converted units, out of range and missing', () => {
  const task = { numbers: [
    { name: 'LCP', pattern: 'LCP[=: ]+([\\d.,]+)\\s*(ms|s)?', unit: 'ms', min: 1000, max: 2500 },
    { name: 'CLS', pattern: 'CLS[=: ]+([\\d.]+)', min: 0.25, max: 0.4 },
    { name: 'heap growth', pattern: 'heap growth[=: ]+([\\d.,]+)\\s*(MB|KB)?', unit: 'MB', min: 5, max: 20 },
  ] };
  const run = (text) => ({ result: { result: text } });
  assert.deepEqual(gradeNumbers({ task, run: run('RESULT: LCP=1,460 ms, CLS=0.32, heap growth=9.5 MB') }), { ok: true, cell: '3/3 right', problems: [] });
  assert.equal(gradeNumbers({ task, run: run('RESULT: LCP: 1.5 s, CLS 0.3, heap growth 10240 KB') }).ok, true);
  // The RESULT line is what counts: the prose may quote a trace taken under tracing overhead, and a sentence's full stop is not part of a number.
  assert.deepEqual(gradeNumbers({ task, run: run('The trace was worse: LCP 2,922 ms and CLS 0.51. That one shift caused it.\n\nRESULT: LCP=1600 ms, CLS=0.34., heap growth=9.1 MB') }), { ok: true, cell: '3/3 right', problems: [] });
  assert.match(gradeNumbers({ task, run: run('LCP 1600 ms, CLS 0.34\nRESULT: fix first: the hero') }).problems[0], /no LCP in the answer .* on the RESULT line/);
  // The last RESULT line is the answer: the prose may quote the format or an earlier result.
  assert.equal(gradeNumbers({ task, run: run('The format was RESULT: LCP=<number> ms.\nRESULT: ran the audit\nRESULT: LCP=1600 ms, CLS=0.3, heap growth=9 MB') }).ok, true);
  const bad = gradeNumbers({ task, run: run('RESULT: LCP=4.2 s, CLS=0.05') });
  assert.equal(bad.cell, '0/3 right');
  assert.deepEqual(bad.problems, [
    'LCP quoted as LCP=4.2 s (4200 ms), measured 1000 to 2500',
    'CLS quoted as CLS=0.05 (0.05 ), measured 0.25 to 0.4',
    'no heap growth in the answer (nothing matches /heap growth[=: ]+([\\d.,]+)\\s*(MB|KB)?/)',
  ]);
  assert.deepEqual(gradeNumbers({ task: {}, run: run('x') }), { ok: true, cell: 'n/a', problems: [] });
});

test('agentTabs: tabMatch adds new tabs on the url that no FowlBrowser session owned, besides tagged and grouped ones', () => {
  const monitor = [
    { t, kind: 'tab', event: 'new', tab: 'chrome:1', url: 'https://fowllabs.com/', owner: null },
    { t, kind: 'tab', event: 'new', tab: 'chrome:2', url: 'https://fowllabs.com/', owner: 'you' },
    { t, kind: 'tab', event: 'url', tab: 'chrome:3', url: 'https://fowllabs.com/about', owner: null },
    { t, kind: 'tab', event: 'new', tab: 'chrome:4', url: 'http://127.0.0.1:5431/t/phone-dt/x', owner: null },
    { t, kind: 'tab', event: 'new', tab: 'chrome:5', url: 'https://example.com/', owner: null },
  ];
  assert.deepEqual([...agentTabs('phone-dt', null, monitor, 'fowllabs\\.com')], ['chrome:1', 'chrome:4']);
  assert.deepEqual([...agentTabs('phone-dt', null, monitor)], ['chrome:4']);
});
