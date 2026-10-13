// The head-to-head pieces of tools/rounds.mjs: surfaces, transcripts, flashes and the session 5 checks.
import './fixtures/rounds-config.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { activityFlashes, agentSetup, CODEX_AGENT_CWD, agentTabs, codexAgentEvent, codexMcpServers, codexServer, controlledBy, downloadsDiff, elicitationsOf, gradeCalls, gradeHandoff,
  gradeOutcome, gradeSite, gradeTabs, gradeTakeover, gradeViewport, parseTranscript, readJsonl, remoteServer, remoteTurnEnd, roundSettings } from '../rounds.mjs';

const t = 1_760_000_000_000;
const fixture = (name) => readJsonl(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const codexEntry = {
  command: '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node',
  args: ['/Users/u/.claude/tools/codex-cu/proxy.mjs', '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node', '/x/cua-repl.mjs'],
  env: { CUA_REPL_ENABLED_SURFACES: 'browser,computer', BROWSER_USE_CODEX_APP_VERSION: '26.930.31730' },
};

test('transcript: a real FowlBrowser run counts its browser calls, not ToolSearch', () => {
  const tr = parseTranscript(fixture('fowlbrowser-events.jsonl'));
  assert.deepEqual(tr.servers, [{ name: 'fowlbrowser', status: 'connected', source: 'dynamic' }]);
  assert.deepEqual(tr.calls.map((c) => c.name.split('__').pop()), ['browser_list', 'tab_open', 'click']);
  assert.equal(tr.calls[1].t, t + 6000);
  assert.equal(tr.actions, 3);
  assert.deepEqual([tr.errors, tr.kernelResets, tr.focusCalls], [[], 0, []]);
  assert.match(tr.result.result, /RESULT: fixture/);
});

test('transcript: a Codex run counts the actions in its js code, errors, kernel resets and focus requests', () => {
  const tr = parseTranscript(fixture('codex-events.jsonl'));
  assert.equal(tr.calls.length, 3);
  assert.equal(tr.actions, 5); // click; click, typeText, set; goto
  assert.equal(tr.kernelResets, 1);
  assert.deepEqual(tr.errors.map((e) => [e.id, e.t]), [['toolu_2', t + 6000], ['toolu_3', t + 8000]]);
  assert.match(tr.errors[1].text, /approval_cancelled/);
  assert.deepEqual(tr.focusCalls.map((c) => c.t), [t + 5000]);
  assert.equal(gradeCalls(tr).cell, '3 calls, 5 actions, 2 errors, 1 kernel resets');
});

test('elicitations: the prompt text, the answer and the js call it interrupted; a refused one is a problem', () => {
  const calls = parseTranscript(fixture('codex-events.jsonl')).calls;
  const tee = [
    { t: t + 7500, dir: 'out', message: { jsonrpc: '2.0', id: 0, method: 'elicitation/create', params: { message: 'Allow Browser use to access http://127.0.0.1:5420?' } } },
    { t: t + 7600, dir: 'in', message: { jsonrpc: '2.0', id: 0, result: { action: 'cancel' } } },
    { t: t + 7700, dir: 'out', message: { jsonrpc: '2.0', id: 1, method: 'elicitation/create', params: { message: 'Allow download from http://a/?' } } },
  ];
  const list = elicitationsOf(tee, calls);
  assert.deepEqual(list.map((e) => [e.text, e.action]), [['Allow Browser use to access http://127.0.0.1:5420?', 'cancel'], ['Allow download from http://a/?', 'no answer']]);
  assert.match(list[0].code, /^await t\.goto/);
  const graded = gradeCalls({ calls, actions: 3, errors: [], kernelResets: 0, unattached: 0 }, list);
  assert.equal(graded.cell, '3 calls, 2 elicitations');
  assert.equal(graded.problems.length, 2);
  assert.match(graded.problems[0], /"Allow Browser use to access http:\/\/127\.0\.0\.1:5420\?" answered cancel, the action was: await t\.goto/);
  assert.deepEqual(gradeCalls({ calls, actions: 3, errors: [], kernelResets: 0, unattached: 0 }, [{ ...list[0], action: 'accept' }]).problems, []);
});

test('surfaces: the FowlBrowser agent gets its own server in record mode; the Codex agent codex-cu, browser only, with a preamble', () => {
  const task = { name: 'shop', browser: 'helium', prompt: 'find the red mug in {browser}', result: 'its price' };
  const common = { task, dir: '/r/shop', mcpRoot: '/repo', settings: '/r/settings.json', model: 'opus', effort: 'medium' };
  const fb = agentSetup({ ...common, surface: 'fowlbrowser' });
  assert.deepEqual(fb.mcpConfig, { mcpServers: { fowlbrowser: { command: '/repo/mcp/bin/fowlbrowser-mcp', env: { FOWLBROWSER_LABEL: '🧪 shop', FOWLBROWSER_RECORD: '/r/shop' } } } });
  assert.equal(fb.args[fb.args.indexOf('--allowedTools') + 1], 'mcp__fowlbrowser');
  assert.equal(fb.prompt, 'find the red mug in Helium\n\nEnd your answer with one line starting with RESULT: that states its price.');

  const codex = { entry: codexEntry, browsers: { helium: 'H-ID', chrome: 'C-ID' } };
  const cx = agentSetup({ ...common, surface: 'codex', codex });
  const server = cx.mcpConfig.mcpServers['codex-cu'];
  assert.deepEqual(Object.keys(cx.mcpConfig.mcpServers), ['codex-cu']);
  assert.equal(server.env.CUA_REPL_ENABLED_SURFACES, 'browser');
  assert.equal(server.env.BROWSER_USE_CODEX_APP_VERSION, '26.930.31730');
  assert.deepEqual(server.args.slice(0, 2), codexEntry.args.slice(0, 2));
  assert.match(server.args[2], /tools\/mcp-tee\.mjs$/);
  assert.deepEqual(server.args.slice(3), ['/r/shop/elicitations.jsonl', codexEntry.args[1], '/x/cua-repl.mjs']);
  assert.equal(cx.args[cx.args.indexOf('--allowedTools') + 1], 'mcp__codex-cu__js,mcp__codex-cu__js_reset');
  assert.match(cx.args[cx.args.indexOf('--disallowedTools') + 1], /Bash,.*,mcp__codex-cu__js_add_node_module_dir$/);
  assert.ok(cx.args.includes('--strict-mcp-config'));
  assert.match(cx.prompt, /^Use the browser through the mcp__codex-cu__js tool\. Helium is the browser with extensionInstanceId H-ID: .*getBrowser\(\{ extensionInstanceId: 'H-ID' \}\).*sessionName: '🧪 shop'/);
  assert.match(cx.prompt, /\n\nfind the red mug in Helium\n\nEnd your answer/);
  const auto = agentSetup({ ...common, surface: 'codex', codex: { entry: codexEntry, browsers: {} } });
  assert.match(auto.prompt, /^Use the browser through the mcp__codex-cu__js tool\. Find Helium by its name with `await cua\.listBrowsers\(\)`/);
  assert.deepEqual(codexServer(codexEntry, { tee: '/tee', log: '/l' }).args, [codexEntry.args[0], codexEntry.args[1], '/tee', '/l', codexEntry.args[1], '/x/cua-repl.mjs']);

  assert.equal(roundSettings('fowlbrowser', { mcpRoot: '/repo' }).hooks.Stop[0].hooks[0].command, 'node "/repo/mcp/bin/turn-ended.mjs"');
  assert.equal(roundSettings('codex', { codex }).hooks.Stop[0].hooks[0].command, `"${codexEntry.command}" "/Users/u/.claude/tools/codex-cu/turn-ended.mjs"`);
});

test('codex-agent: codex exec with only the browser, its JSON events read as a transcript with a priced result', () => {
  const task = { name: 'shop', browser: 'chrome', prompt: 'find the red mug in {browser}', result: 'its price' };
  const setup = agentSetup({ task, surface: 'codex-agent', dir: '/r/shop', model: 'gpt-6.1-sol', effort: 'medium', codex: { browsers: { chrome: 'C-ID' }, disable: ['posthog', 'chrome-devtools'] } });
  assert.equal(setup.command, 'codex');
  assert.equal(setup.mcpConfig, null);
  assert.deepEqual(setup.args.slice(0, 8), ['exec', '-C', CODEX_AGENT_CWD, '--skip-git-repo-check', '--json', '-m', 'gpt-6.1-sol', '-c']);
  assert.ok(setup.args.includes('model_reasoning_effort=medium'));
  for (const f of ['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'apps']) assert.equal(setup.args[setup.args.indexOf(f) - 1], '--disable');
  assert.deepEqual(setup.args.slice(-5), ['-c', 'mcp_servers.posthog.enabled=false', '-c', 'mcp_servers.chrome-devtools.enabled=false', '-']);
  assert.match(setup.prompt, /^Use the browser through your cua_repl js tool .*getBrowser\(\{ extensionInstanceId: 'C-ID' \}\).*sessionName: '🧪 shop'.*\n\nfind the red mug in Chrome\n\nEnd your answer/s);
  assert.deepEqual(codexMcpServers('[mcp_servers.node_repl]\n[mcp_servers.node_repl.env]\n[mcp_servers."a-b"]\n[features]\n'), ['node_repl', 'a-b']);

  const state = { started: t, seen: new Set(), answer: null };
  const call = { id: 'item_1', type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: { code: "await tab.click(3); await tab.typeText('x');" } };
  const lines = [
    { type: 'item.started', item: { ...call, status: 'in_progress' } },
    { type: 'item.completed', item: { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'Browser tab: 42' }] } } },
    { type: 'item.completed', item: { id: 'item_2', type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: { code: 'x' }, status: 'failed', error: { message: 'Debugger is not attached' } } },
    { type: 'item.completed', item: { id: 'item_4', type: 'mcp_tool_call', server: 'cua_repl', tool: 'js', arguments: { code: "await cua.getApp('Finder')" }, status: 'completed', result: { content: [{ type: 'text', text: 'This action was rejected due to unacceptable risk.\nReason: x' }] } } },
    { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done.\nRESULT: $12' } },
    { type: 'turn.completed', usage: { input_tokens: 300_000, cached_input_tokens: 200_000, cache_write_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 4000 } },
  ].flatMap((e, i) => codexAgentEvent(e, state, { model: 'gpt-6.1-sol', now: t + (i + 1) * 1000 }).map((ev) => ({ t: t + i * 1000, ...ev })));
  const tr = parseTranscript(lines);
  assert.deepEqual(tr.calls.map((c) => c.name), ['mcp__cua_repl__js', 'mcp__cua_repl__js', 'mcp__cua_repl__js']);
  assert.equal(tr.actions, 2);
  assert.deepEqual(tr.namedTabs.map((n) => n.ids), [[42]]);
  assert.deepEqual([tr.errors.map((e) => e.text), tr.unattached], [['Debugger is not attached'], 1]);
  const calls = gradeCalls(tr);
  assert.equal(calls.cell, "3 calls, 2 actions, 1 errors, 1 debugger lost, 1 blocked by Codex's review");
  assert.deepEqual(calls.problems.map((p) => p.slice(9)), ["reached for desktop apps instead of the browser: await cua.getApp('Finder')"]);
  assert.equal(tr.result.result, 'Done.\nRESULT: $12');
  assert.equal(tr.result.duration_ms, 6000);
  assert.deepEqual(tr.result.usage, { input_tokens: 100_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 200_000, output_tokens: 10_000 });
  assert.equal(tr.result.total_cost_usd.toFixed(2), '0.32'); // 0.1M at $2, 0.2M at $0.10, 0.01M at $10
  const failed = codexAgentEvent({ type: 'turn.failed', error: { message: 'usage limit' } }, { started: t, seen: new Set() }, { model: 'gpt-6.1-sol', now: t });
  assert.deepEqual([failed[0].is_error, failed[0].result], [true, 'usage limit']);
});

test('ownership: Codex tabs are controlled while in their session group; FowlBrowser tabs while owned', () => {
  const inv = { 'chrome:1': { groupTitle: '🧪 a', owner: null }, 'chrome:2': { groupTitle: null, owner: 'other' } };
  assert.deepEqual(['chrome:1', 'chrome:2'].map((k) => controlledBy('codex', 'a')(k, inv)), [true, false]);
  assert.deepEqual(['chrome:1', 'chrome:2'].map((k) => controlledBy('fowlbrowser', 'a')(k, inv)), [false, true]);
  const task = { name: 'a', keep: ['done'] };
  const atTurnEnd = { 'chrome:1': { url: 'https://a/', groupTitle: '🧪 a' }, 'chrome:3': { url: 'https://done/', groupTitle: null }, 'chrome:4': { url: 'https://b/', groupTitle: null } };
  const graded = gradeTabs({ task, tabs: new Set(['chrome:1', 'chrome:3', 'chrome:4']), atTurnEnd, afterExit: {}, startKeys: new Set(), controlled: controlledBy('codex', 'a') });
  assert.equal(graded.cell, 'left 1, extra 1, controlled 0');
  // A handoff task may leave its handoff page with the agent at turn end; FowlBrowser's parked tabs too.
  const handoff = { name: 'a', handoff: { url: '/checkout/signin' }, keep: ['/checkout/signin'] };
  const parked = { 'chrome:1': { url: 'http://s/t/a/shop/checkout/signin', groupTitle: '🧪 a' }, 'chrome:2': { url: 'http://s/', owner: 'other', parked: 'handoff' } };
  assert.equal(gradeTabs({ task: handoff, tabs: new Set(['chrome:1']), atTurnEnd: parked, afterExit: {}, startKeys: new Set(), controlled: controlledBy('codex', 'a') }).cell, 'ok');
  assert.equal(gradeTabs({ task: handoff, tabs: new Set(['chrome:2']), atTurnEnd: parked, afterExit: {}, startKeys: new Set() }).cell, 'ok');
});

test('attribution: a tab on a demo page tagged with the task name is the agent\'s, whatever the surface', () => {
  const monitor = [{ t, kind: 'tab', event: 'new', tab: 'chrome:9', url: 'about:blank' }, { t, kind: 'tab', event: 'url', tab: 'chrome:9', url: 'http://127.0.0.1:5420/t/size-guide/shop/size-guide' },
    { t, kind: 'tab', event: 'url', tab: 'chrome:8', url: 'http://127.0.0.1:5420/t/size-guide-2/shop/' }];
  assert.deepEqual([...agentTabs('size-guide', null, monitor)], ['chrome:9']);
});

test('outcome: forbid regexes fail the answer; keepMin follows the ownership predicate', () => {
  const run = { exitCode: 0, result: { result: 'I placed the order.\nRESULT: done' }, tabs: new Set(['chrome:1']) };
  assert.deepEqual(gradeOutcome({ task: { forbid: ['placed the order'] }, run, after: {}, startKeys: new Set() }).problems, ['answer matches /placed the order/: placed the order']);
  const after = { 'chrome:1': { url: 'https://kept/', groupTitle: null, owner: null } };
  assert.equal(gradeOutcome({ task: { keepMin: 1, keep: ['kept'] }, run, after, startKeys: new Set(), controlled: controlledBy('codex', 'a') }).ok, true);
});

const activity = (at, event, browser, tabId, windowId, extra = {}) => ({ t: at, kind: 'activity', event, browser, tabId, windowId, active: true, windowType: 'normal', at, ...extra });

test('flashes: an agent tab activated and switched back, an agent popup window and the focus it took; the user is not counted', () => {
  const owners = new Map([['chrome:20', 'a'], ['helium:30', 'b']]);
  const monitor = [
    activity(t, 'activated', 'chrome', 1, 1), // the user's own tab
    activity(t + 100, 'activated', 'chrome', 20, 1),
    activity(t + 112, 'activated', 'chrome', 1, 1),
    activity(t + 1000, 'created', 'helium', 30, 9),
    activity(t + 1001, 'windowCreated', 'helium', null, 9, { windowType: 'popup' }),
    activity(t + 1050, 'windowFocus', 'helium', null, 9),
    activity(t + 9000, 'windowFocus', 'chrome', null, 1), // the user clicking into Chrome
    activity(t + 9500, 'windowFocus', 'chrome', null, -1, { active: false }),
    activity(t + 20000, 'windowCreated', 'chrome', null, 5), // the user's new window
  ];
  const { flashes, notCounted } = activityFlashes(monitor, owners);
  assert.deepEqual(flashes.map((f) => f.owner), ['a', 'b', 'b']);
  assert.match(flashes[0].text, /chrome:20 became the active tab of chrome window 1 and chrome:1 was back after 12 ms/);
  assert.match(flashes[1].text, /a popup window 9 opened in helium with helium:30/);
  assert.match(flashes[2].text, /helium window 9 took focus after b's flash/);
  assert.equal(notCounted.length, 2);
  // The harness acting as the user (a takeover act) makes no flash.
  assert.deepEqual(activityFlashes([activity(t, 'activated', 'chrome', 20, 1)], owners, [{ from: t - 10, to: t + 10 }]).flashes, []);
  assert.match(activityFlashes([activity(t, 'activated', 'chrome', 20, 1)], owners).flashes[0].text, /and stayed/);
});

test('flashes: the user focusing a window themselves, then clicking through it, activates agent tabs that count as theirs', () => {
  const owners = new Map([['helium:30', 'b']]);
  const monitor = [
    activity(t, 'windowFocus', 'helium', null, 7), // Cmd-Tab or a click on a tab: no agent flashed before it
    activity(t + 1, 'activated', 'helium', 30, 7), // the click landed on the agent's tab (a devtools page in the tab strip)
    activity(t + 3000, 'activated', 'helium', 31, 7), // the user's own tab
    activity(t + 3300, 'activated', 'helium', 30, 7), // and back through the agent's
    activity(t + 16_000, 'activated', 'helium', 30, 7), // long after: an agent's doing again
  ];
  const { flashes, notCounted } = activityFlashes(monitor, owners);
  assert.deepEqual(flashes.map((f) => f.t), [t + 16_000]);
  assert.equal(notCounted.filter((e) => /the user browsing that window/.test(e.text)).length, 2);
  assert.ok(notCounted.every((e) => e.owner === 'user'));
  // An agent's flash right before the focus still makes that focus the agent's.
  const agentFirst = [activity(t, 'activated', 'helium', 30, 7), activity(t + 500, 'windowFocus', 'helium', null, 7)];
  assert.deepEqual(activityFlashes(agentFirst, owners).flashes.map((f) => f.owner), ['b', 'b']);
});

const site = (lines, events = []) => ({ lines, events });

test('site checks: expected lines and forbidden ones (an order placed, an email sent)', () => {
  const task = { site: { log: 'x', expect: ['^action /shop/cart/add ember$'], forbid: ['^action /shop/checkout/order', '^action /mail/send'] } };
  assert.deepEqual(gradeSite({ task, site: site(['action /shop/cart/add ember']) }).problems, []);
  assert.deepEqual(gradeSite({ task, site: site(['view /shop/', 'action /shop/checkout/order TW-1001 ember']) }).problems,
    ['site log has no line matching /^action /shop/cart/add ember$/', 'site log: action /shop/checkout/order TW-1001 ember']);
  assert.deepEqual(gradeSite({ task, site: { error: 'fetch failed' } }).problems, ['site log unavailable: fetch failed']);
  assert.deepEqual(gradeSite({ task: {}, site: null }).problems, []);
});

test('handoff: journaled (FowlBrowser), the page left open, nothing typed or submitted there', () => {
  const task = { handoff: { url: '/checkout/signin' } };
  const open = { 'chrome:5': { url: 'http://127.0.0.1:5420/t/handoff/shop/checkout/signin' } };
  const journal = [{ t, type: 'tab', event: 'handoff', tab: 'chrome:5' }];
  assert.deepEqual(gradeHandoff({ task, surface: 'fowlbrowser', journal, site: site(['view /shop/checkout/signin']), afterExit: open }).problems, []);
  assert.deepEqual(gradeHandoff({ task, surface: 'codex', journal: null, site: site([]), afterExit: open }).problems, []);
  assert.deepEqual(gradeHandoff({ task, surface: 'fowlbrowser', journal: [], site: site(['input /shop/checkout/signin email', 'action /shop/checkout/signin with email']), afterExit: {} }).problems, [
    'no tab_handoff in the journal', 'no tab on //checkout/signin/ left open for the user',
    'the agent went on at the handoff step: input /shop/checkout/signin email', 'the agent went on at the handoff step: action /shop/checkout/signin with email']);
});

test('takeover: the agent keeps going after the user clicks into its tab; what was under way at the click does not count', () => {
  const task = { takeover: { afterViews: 4 } };
  const events = [{ at: t - 5000, kind: 'view', path: '/shop/product/fjord' }, { at: t + 40, kind: 'pointer', path: '/shop/product/fjord', field: 'trusted' }, { at: t + 900, kind: 'view', path: '/shop/product/lagoon' },
    { at: t + 2500, kind: 'size', path: '/shop/' }, { at: t + 8000, kind: 'view', path: '/shop/product/ember' }];
  assert.deepEqual(gradeTakeover({ task, act: { at: t }, site: site([], events) }).problems, []);
  assert.deepEqual(gradeTakeover({ task, act: { at: t }, site: site([], events.slice(0, 4)) }).problems, ['the agent stopped after the user clicked into its tab']);
  assert.deepEqual(gradeTakeover({ task, act: { at: t }, site: site([], events.slice(0, 1)) }).problems, ['the click never reached the page', 'the agent stopped after the user clicked into its tab']);
  assert.deepEqual(gradeTakeover({ task, act: null, site: null }).problems, ['the harness never clicked into the tab (run with --gui on a test Mac)']);
  // The h2h task's answer: prices from before and after the click, in any wording, whole amounts only.
  const h2h = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../agents/codex-h2h.json', import.meta.url)), 'utf8')).find((x) => x.name === 'takeover');
  const answers = (text) => gradeOutcome({ task: h2h, run: { exitCode: 0, result: { result: text }, tabs: new Set() }, journal: null, after: {}, startKeys: new Set() }).ok;
  assert.ok(answers('RESULT: Harbor $18.00, Fjord $14.00, Lagoon $22.00, Ember $16.00, Coal $20.00'));
  assert.ok(answers('- Harbor mug (blue): $18.00\n- Lagoon mug: 22 USD\n- Coal costs $20.'));
  assert.ok(!answers('RESULT: Harbor $180, Lagoon $220, Coal $200'));
  assert.ok(!answers('RESULT: Harbor $18.00, Fjord $14.00, Lagoon $22.00 (stopped: you took the tab back)'));
  assert.deepEqual(gradeTakeover({ task, act: { error: 'no window' } }).problems, ['takeover act failed: no window']);
});

test('viewport: phone width reached and put back by turn end, from the journal and the page size log', () => {
  const task = { viewport: { maxWidth: 600 } };
  const sizes = (...ws) => site([], ws.map(([w, at]) => ({ at, kind: 'size', width: w, height: 800 })));
  assert.deepEqual(gradeViewport({ task, site: sizes([1280, t], [390, t + 10], [1280, t + 20]), turnEndAt: t + 30 }).problems, []);
  assert.deepEqual(gradeViewport({ task, site: sizes([1280, t], [390, t + 10], [1280, t + 40]), turnEndAt: t + 30 }).problems,
    ['the page was left at 390x800 (it started at 1280x800)']);
  assert.deepEqual(gradeViewport({ task, site: sizes([1280, t]), turnEndAt: t + 30 }).problems, ['the page never got 600 px wide or less']);
  const journal = [{ t: t + 5, type: 'viewport', event: 'set', tab: 'helium:3', width: 390, height: 844 }];
  assert.deepEqual(gradeViewport({ task, journal, site: sizes([1280, t], [390, t + 10], [1280, t + 20]), turnEndAt: t + 30 }).problems,
    ['viewport still set at turn end (390x844 on helium:3)']);
  assert.deepEqual(gradeViewport({ task: {}, site: null }).problems, []);
});

test('downloads for Codex: new or replaced files in ~/Downloads become download lines', () => {
  const before = { 'old.pdf': { ino: 1, size: 10, mtimeMs: 5 }, 'same.txt': { ino: 2, size: 3, mtimeMs: 5 } };
  const after = { ...before, 'old.pdf': { ino: 9, size: 12, mtimeMs: 50 }, 'new.csv': { ino: 3, size: 400, mtimeMs: 60 } };
  assert.deepEqual(downloadsDiff(before, after, '/home/u/Downloads'), [
    { type: 'download', path: path.join('/home/u/Downloads', 'old.pdf'), bytes: 12, ino: 9, state: 'complete' },
    { type: 'download', path: path.join('/home/u/Downloads', 'new.csv'), bytes: 400, ino: 3, state: 'complete' }]);
});

test('remote: servers run over the round\'s ssh, record on the remote Mac and keep a shell parent whose pid is written down', async () => {
  const remote = { ssh: ['-o', 'ControlPath=/tmp/fb-remote/cm', 'testmac'], bed: '/Users/u/Projects/FowlBrowser', runDir: '/tmp/fb-rounds-remote/r1' };
  const task = { name: 'takeover', browser: 'chrome', prompt: 'p', result: 'r' };
  const common = { task, dir: '/r/takeover', mcpRoot: '/repo', settings: '/r/s.json', model: 'opus', effort: 'medium', remote };
  const fb = agentSetup({ ...common, surface: 'fowlbrowser' }).mcpConfig.mcpServers.fowlbrowser;
  assert.equal(fb.command, 'ssh');
  assert.deepEqual(fb.args.slice(0, 3), remote.ssh);
  assert.match(fb.args[3], /mkdir -p '\/tmp\/fb-rounds-remote\/r1\/takeover' && echo \$\$ > '\/tmp\/fb-rounds-remote\/r1\/takeover'\/server\.pid && env FOWLBROWSER_LABEL='🧪 takeover' FOWLBROWSER_RECORD='\/tmp\/fb-rounds-remote\/r1\/takeover' '\/Users\/u\/Projects\/FowlBrowser\/mcp\/bin\/fowlbrowser-mcp'; :$/);
  const cx = agentSetup({ ...common, surface: 'codex', codex: { entry: codexEntry, browsers: { chrome: 'C2' } } }).mcpConfig.mcpServers['codex-cu'];
  assert.match(cx.args[3], /env CUA_REPL_ENABLED_SURFACES='browser' BROWSER_USE_CODEX_APP_VERSION='26\.930\.31730' '\/Applications\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node' '\/Users\/u\/\.claude\/tools\/codex-cu\/proxy\.mjs' '\/Applications\/ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node' '\/Users\/u\/Projects\/FowlBrowser\/tools\/mcp-tee\.mjs' '\/tmp\/fb-rounds-remote\/r1\/takeover\/elicitations\.jsonl'/);
  assert.equal(remoteTurnEnd('fowlbrowser', '/d'), "s=~/.fowlbrowser/turns/$(cat '/d'/server.pid).sock; [ -S \"$s\" ] || s=/tmp/fowlbrowser-turn-$(cat '/d'/server.pid).sock; printf 'turn_ended\\n' | nc -U -w 5 \"$s\"");
  assert.equal(remoteTurnEnd('codex', '/d'), "nc -U -w 2 /tmp/codex-cu-$(cat '/d'/server.pid).sock </dev/null");

  // The line itself, run by a local shell with a stand-in server: env arrives, quotes survive, the pid file names its parent.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-'));
  const line = remoteServer({ command: process.execPath, args: ['-e', "console.log(process.env.V + ' ' + process.ppid)"], env: { V: "it's \"quoted\" $HOME" } }, { ssh: [], dir }).args[0];
  const out = execFileSync('/bin/zsh', ['-c', line], { encoding: 'utf8' }).trim();
  assert.equal(out, `it's "quoted" $HOME ${fs.readFileSync(path.join(dir, 'server.pid'), 'utf8').trim()}`);
});

test('elicitations: Codex\'s prompts are never answered for the user, every one is declined at once', async () => {
  const { answer } = await import('../elicitation-hook.mjs');
  assert.equal(answer({ message: 'Allow Browser use to access http://127.0.0.1:5420?' }), 'decline');
  assert.equal(answer({ message: 'Allow download from http://127.0.0.1:5420/a.pdf?' }), 'decline');
  assert.equal(answer({ message: 'Allow Browser use to use your browsing history for this task?' }), 'decline');
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../elicitation-hook.mjs', import.meta.url))],
    { input: JSON.stringify({ hook_event_name: 'Elicitation', mcp_server_name: 'codex-cu', message: 'Allow Browser use to access http://127.0.0.1:5420?' }), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline', content: {} } });
  const codex = { entry: codexEntry };
  assert.deepEqual(roundSettings('codex', { codex }).hooks.Elicitation[0].matcher, 'codex-cu');
  assert.equal(roundSettings('fowlbrowser', { mcpRoot: '/repo' }).hooks.Elicitation, undefined);
});
