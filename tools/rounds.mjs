// One round of real Claude agents doing the user's everyday browser tasks, graded the way the user would grade them.
//   node tools/rounds.mjs [--tasks tools/agents/example.json] [--swap] [--only a,b] [--model opus] [--effort medium]
//                         [--surface fowlbrowser|codex|codex-agent|devtools] [--codex-browsers chrome=<id>,helium=<id>|auto]
//                         [--mcp repo|installed] [--out <dir>] [--keep-tabs] [--serve "<command>"] [--gui]
//                         [--remote <host> [--remote-owner fb-rounds | --remote-held]]
// All agents start at once, each its own `claude -p` session. --surface picks its browser tools: FowlBrowser (its own
// MCP server, record mode on), Codex's browser extension (ChatGPT.app's cua_repl through the user's codex-cu proxy) or
// Chrome DevTools MCP through the user's own launcher (devtools); a task's own `surface` overrides it, so one round can mix.
// codex-agent: Codex itself is the agent (`codex exec`, gpt-6.1-sol unless --model) with its own browser extension.
// Both run through the same spawner, monitor and grading. While they run, a monitor logs the frontmost app, active
// tabs, windows, audible tabs and the extension's exact activation events. Then every run is graded (outcome, cursor,
// focus, flashes, sound, tabs, checks, time, calls, tokens), the round's leftovers are cleaned up and checked, and
// report.md and report.html are written. Exit code 1 when the round is not clean. --gui lets the harness act as the
// user in an agent's tab (takeover tasks): only on a test Mac under its GUI lock, never on the user's own.
// --remote <host>: the agents' browsers are on another Mac (its test bed, ~/Projects/FowlBrowser there, must be this
// tree). `claude -p` still runs here; every agent's MCP server, the --serve site and the takeover act run there over one
// ssh connection, which also forwards that Mac's FowlBrowser sockets (the monitor) and the graded site ports. The round
// holds that Mac's GUI lock throughout (implies --gui); --remote-held: the caller already holds it (a deploy script's
// command, so no other tree lands in the bed meanwhile).
// What only the user's own Macs have lives in local/rounds.json (git-ignored; FOWLBROWSER_ROUNDS_CONFIG names another
// file), read at startup. Keys, each needed only by its feature ("~/" is the home of the Mac it runs on):
//   codexBrowsers {helium, chrome}: Codex's extensionInstanceId of each browser here (default of --codex-browsers)
//   codexProxy: the codex-cu proxy.mjs, when ~/.claude.json has no codex-cu entry or with --remote
//   devtools {command, env: {helium, chrome}}: the DevTools MCP launcher and each browser's env for it
//   guiDriver: the cua-driver binary (takeover tasks)
//   remoteGuiLock: the GUI lock command on a second test Mac (--remote without --remote-held)
//   remoteDeploy: the script that deploys a tree to that Mac's test bed (named when the bed differs)
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOCKET_DIR = path.join(os.homedir(), '.fowlbrowser');
// Set by --remote: { host, ssh (ssh args through the shared connection), dir (local forwards), home, bed, runDir }.
let remote = null;
const BROWSERS = ['helium', 'chrome'];
const BROWSER_APP = { helium: 'Helium', chrome: 'Google Chrome' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const labelOf = (name) => `🧪 ${name}`;
const keyOf = (browser, tab) => `${browser}:${tab.id}`;
// Demo site pages carry the task's name in their path (test/demo/server.mjs), so a tab on one belongs to that task.
const tagged = (name, url) => String(url ?? '').includes(`/t/${name}/`);

const CONFIG_FILE = process.env.FOWLBROWSER_ROUNDS_CONFIG || path.join(ROOT, 'local/rounds.json');
const CONFIG = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
// A config value; missing, the round stops with the key to set (main prints the message alone).
export function setting(key) {
  if (CONFIG[key] === undefined) throw Object.assign(new Error(`set "${key}" in ${CONFIG_FILE} (see the top of tools/rounds.mjs)`), { setting: key });
  return CONFIG[key];
}
const homePath = (p, home = os.homedir()) => p.replace(/^~(?=\/|$)/, home);

// Task names become folder and remote shell paths.
export const badTaskNames = (tasks) => tasks.map((t) => t.name).filter((name) => !/^[A-Za-z0-9_-]+$/.test(name ?? ''));

// --- Grading (pure, unit-tested in tools/test/rounds.test.mjs) ---

export function readJsonl(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

// Every tab an agent touched: tab ids in its journal, plus tabs the monitor saw in its tab group or on a demo site page
// tagged with its name (both work without a journal, so for any surface). tabMatch (a DevTools task on a real site):
// new tabs whose url matches it and that no FowlBrowser session owned when they appeared.
export function agentTabs(name, journal, monitor, tabMatch = null) {
  const tabs = new Set((journal || []).map((e) => e.tab).filter(Boolean));
  for (const e of monitor) {
    if (e.kind === 'group' && e.label === labelOf(name)) tabs.add(e.tab);
    if (e.kind === 'tab' && tagged(name, e.url)) tabs.add(e.tab);
    if (e.kind === 'tab' && e.event === 'new' && tabMatch && !e.owner && new RegExp(tabMatch, 'i').test(e.url)) tabs.add(e.tab);
  }
  return tabs;
}

// Codex's browser extension, driven by a Claude agent (codex) or by Codex itself (codex-agent): graded alike.
export const isCodex = (surface) => surface === 'codex' || surface === 'codex-agent';

// Whether a tab is still under an agent's control in an inventory. FowlBrowser says so (`owner`); Codex's tabs are
// never FowlBrowser's, but an agent's tab stays in its session's tab group (sessionName) while Codex holds it.
export function controlledBy(surface, name) {
  if (surface === 'devtools') return () => false; // DevTools MCP never owns a tab: whatever it leaves open is left for the user
  return isCodex(surface) ? (k, inv) => inv[k]?.groupTitle === labelOf(name) : (k, inv) => !!inv[k]?.owner;
}

// journal: FowlBrowser's journal, or for Codex synthesized download lines (downloadsDiff). controlled: controlledBy().
export function gradeOutcome({ task, run, journal, after, startKeys, grade, controlled = controlledBy('fowlbrowser') }) {
  const problems = [];
  if (run.timedOut) problems.push(`stopped after ${task.budgetSeconds ? `${AGENT_CAP} times its budget` : '10 min'} without a result`);
  if (run.exitCode !== 0) problems.push(`exit ${run.exitCode ?? 'none'}${run.killed ? ' (killed after 20 s)' : ''}`);
  if (!run.result) problems.push('no result event');
  else if (run.result.is_error) problems.push(`is_error: ${String(run.result.result).slice(0, 120)}`);
  const text = String(run.result?.result ?? '');
  for (const e of task.expect || []) if (!new RegExp(e, 'i').test(text)) problems.push(`answer does not match /${e}/`);
  for (const e of task.forbid || []) if (new RegExp(e, 'i').test(text)) problems.push(`answer matches /${e}/: ${text.match(new RegExp(e, 'i'))[0]}`);
  if (task.downloads) {
    const done = (journal || []).filter((e) => e.type === 'download' && e.state === 'complete' && e.bytes >= (task.downloads.minBytes || 0)).length;
    if (done < (task.downloads.min || 1)) problems.push(`${done} complete downloads, wanted ${task.downloads.min || 1}`);
  }
  if (task.keepMin) {
    const kept = [...run.tabs].filter((k) => after[k] && !controlled(k, after) && !startKeys.has(k) && keepMatches(task, after[k].url)).length;
    if (kept < task.keepMin) problems.push(`${kept} tabs left for the user, wanted ${task.keepMin}`);
  }
  // A form task (task.grade) also needs the site's grade: the cell gets its score, the problems each wrong field.
  const form = task.grade ? gradeForm(grade) : null;
  const ok = problems.length === 0 && (!form || form.ok);
  const cell = [ok ? 'ok' : problems.length ? `FAIL: ${problems.join('; ')}` : 'FAIL', form?.cell].filter(Boolean).join(', ');
  return { ok, cell, problems: [...problems, ...(form?.problems || [])] };
}

// grade: the JSON of GET task.grade (test/forms/server.mjs), or {error} when it could not be read.
export function gradeForm(grade) {
  if (!grade || grade.error) return { ok: false, cell: 'no grade', problems: [`grade unavailable: ${grade?.error ?? 'not fetched'}`] };
  const problems = [];
  if (!grade.submissions) problems.push('nothing submitted');
  else if (grade.submittedForm !== grade.form) problems.push(`submitted to ${grade.submittedForm}, wanted ${grade.form}`);
  if (grade.submissions) for (const f of grade.fields.filter((f) => !f.ok)) problems.push(`${f.name}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`);
  for (const c of grade.crossTalk) problems.push(`cross-talk: ${c.field} has ${c.persona}'s ${JSON.stringify(c.value)}`);
  const talk = grade.crossTalk.length ? `, crossTalk ${grade.crossTalk.map((c) => `${c.field}=${c.persona}`).join(' ')}` : '';
  return { ok: !!grade.ok, cell: `score ${grade.score}/${grade.total}${talk}`, problems };
}

const scriptedClick = /\.click\(|dispatchEvent|\.submit\(/;
// Errors from the server's own checks before any input is sent: the action certainly did not happen.
const noInputSent = /older snapshot|not a ref|is covered by|is disabled|is not visible|Invalid frame|from an earlier page|not from a snapshot|is inside a closed shadow root/;

export function gradeCursor({ task, journal }) {
  if (!journal) return { ok: false, cell: 'no journal', problems: ['no journal'] };
  // A scroll with no target (by direction, nothing to aim at) has nothing to judge, nor has an action stopped by a
  // pre-check (no input was sent); any other point without one failed, including other errors (input may have gone).
  const points = journal.filter((e) => e.type === 'point' && (e.target || (e.tool !== 'scroll' && !noInputSent.test(e.error ?? ''))));
  const bad = points.filter((p) => !(p.target && p.cursor?.visible && Math.hypot(p.cursor.x - p.target.x, p.cursor.y - p.target.y) <= 4));
  const scriptClicks = journal.filter((e) => e.type === 'scriptClick');
  const scriptEvals = journal.filter((e) => e.type === 'call' && e.tool === 'evaluate' && scriptedClick.test(JSON.stringify(e.args || {})));
  const problems = [
    ...bad.map((p) => `${time(p.t)} ${p.tool} on ${p.tab}: ${p.target ? `${p.cursor ? `cursor ${p.cursor.visible ? '' : 'hidden '}at ${Math.round(p.cursor.x)},${Math.round(p.cursor.y)}` : 'no cursor'}, target ${Math.round(p.target.x)},${Math.round(p.target.y)}` : 'no cursor target'}${p.error ? ` (${p.error})` : ''}`),
    ...scriptClicks.map((e) => `${time(e.t)} page script clicked at ${e.x},${e.y} on ${e.tab}`),
    ...scriptEvals.map((e) => `${time(e.t)} evaluate clicks by script on ${e.tab}: ${JSON.stringify(e.args).slice(0, 120)}`),
  ];
  if ((task.needsClicks ?? true) && points.length === 0) problems.push('no pointer actions recorded');
  const extra = [scriptClicks.length && `${scriptClicks.length} script clicks`, scriptEvals.length && `${scriptEvals.length} scripted evaluates`].filter(Boolean);
  return { ok: problems.length === 0, cell: `${points.length - bad.length}/${points.length}${extra.length ? `, ${extra.join(', ')}` : ''}`, problems };
}

// Focus changes during the round. One counts against an agent (blame) only when the agent caused it: it asked for
// focus (tab_focus, tab_open with focus), a window opened with its tab, one of its tabs flashed active and back within
// FLASH_MS (the browser activating a new tab), the active tab changed while that browser was in the background (an
// agent's tab, else a round problem), or the browser came to the front within FRONT_MS of one of those. Everything
// else is the user using their Mac while they watch (switching apps, clicking through tabs): listed, not counted.
// calls: journal call lines (or parseTranscript focusCalls) with the agent's name in `agent`.
const FLASH_MS = 1500;
const USER_BROWSING_MS = 15_000; // after the user focused a window themselves, the activations there are theirs
const CLOSED_MS = 2000;
const FRONT_MS = 2000;

// The user can only switch tabs in the frontmost browser. A tick reads the front app before the tabs, so a click that
// brings the browser forward can log its front change just after the tab change: allow FRONT_NEAR_MS either side.
// No front entry yet (lsappinfo failed): assume frontmost, so nothing is blamed on a guess.
const FRONT_NEAR_MS = 1000;
function browserFront(monitor, browser, t) {
  const fronts = monitor.filter((e) => e.kind === 'front');
  const current = fronts.filter((e) => e.t <= t).pop();
  return !current || current.app === BROWSER_APP[browser]
    || fronts.some((e) => e.app === BROWSER_APP[browser] && Math.abs(e.t - t) <= FRONT_NEAR_MS);
}
// closedAt: tab -> when its agent closed it; the browser then activates a neighbour of a tab the user was watching.
export function focusEvents(monitor, owners, calls = [], closedAt = new Map()) {
  const events = [];
  for (const c of calls) {
    // tool 'focus': a Codex js call whose code shows a tab or focuses a window (parseTranscript).
    if (c.tool === 'tab_focus' || c.tool === 'focus' || (c.tool === 'tab_open' && c.args?.focus)) {
      events.push({ t: c.t, kind: 'call', owner: c.agent, blame: true, text: `${time(c.t)} ${c.tool} asked to focus ${c.args?.tab ?? c.args?.url ?? c.args?.code ?? ''}` });
    }
  }
  const actives = monitor.filter((e) => e.kind === 'active');
  for (const e of monitor) {
    if (e.initial) continue;
    if (e.kind === 'window' && e.event === 'open') {
      const owner = e.tabs.map((k) => owners.get(k)).find(Boolean);
      events.push({ ...e, owner: owner || 'user', blame: !!owner, text: `${time(e.t)} ${e.browser} window ${e.windowId} opened with ${e.tabs.join(', ')}` });
    }
    if (e.kind === 'active') {
      const sameWindow = actives.filter((a) => a.browser === e.browser && a.windowId === e.windowId);
      const i = sameWindow.indexOf(e);
      const before = sameWindow[i - 1]; const after = sameWindow[i + 1];
      const flash = owners.has(e.tab) && before && after?.tab === before.tab && after.t - e.t <= FLASH_MS;
      const text = `${time(e.t)} active tab of ${e.browser} window ${e.windowId} became ${e.tab} ${e.url}`;
      const closed = before && closedAt.has(before.tab) && Math.abs(closedAt.get(before.tab) - e.t) <= CLOSED_MS;
      if (flash) events.push({ ...e, owner: owners.get(e.tab), blame: true, text: `${text} and flashed back` });
      else if (closed) events.push({ ...e, owner: 'user', blame: false, text: `${text} (its agent closed ${before.tab}, which the user had open)` });
      else if (!browserFront(monitor, e.browser, e.t)) {
        events.push({ ...e, owner: owners.get(e.tab) || 'round', blame: true, text: `${text} while ${BROWSER_APP[e.browser]} was in the background${owners.has(e.tab) ? '' : ' (programmatic, unknown cause)'}` });
      } else events.push({ ...e, owner: 'user', blame: false, text });
    }
  }
  const causes = events.filter((e) => e.blame);
  for (const e of monitor) {
    if (e.kind !== 'front' || e.initial || !Object.values(BROWSER_APP).includes(e.app)) continue;
    const cause = causes.find((c) => Math.abs(c.t - e.t) <= FRONT_MS);
    events.push({ ...e, owner: cause ? cause.owner : 'user', blame: !!cause, text: `${time(e.t)} ${e.app} came to the front` });
  }
  return events.sort((a, b) => a.t - b.t);
}

// Sound in a tab no agent's journal or tab group names is the user's own playback: listed, not counted.
export function soundEvents(monitor, owners) {
  return monitor.filter((e) => e.kind === 'audio' && e.event === 'start' && !e.initial)
    .map((e) => ({ ...e, owner: owners.get(e.tab) || 'user', text: `${time(e.t)} ${e.tab} started playing sound ${e.url}` }));
}

const keepMatches = (task, url) => (task.keep || []).some((re) => new RegExp(re, 'i').test(url));

// atTurnEnd (A) and afterExit (B): inventories keyed "browser:id". startKeys: tabs open at round start (the user's).
// A tab handed to the user (FowlBrowser `parked`, or for a handoff task its page) may stay with the agent at A.
export function gradeTabs({ task, tabs, atTurnEnd, afterExit, startKeys, controlled: isControlled = controlledBy('fowlbrowser') }) {
  const mine = [...tabs];
  const handedOff = (k) => atTurnEnd[k]?.parked || (task.handoff && new RegExp(task.handoff.url, 'i').test(atTurnEnd[k]?.url));
  const left = mine.filter((k) => isControlled(k, atTurnEnd) && !handedOff(k));
  const extra = mine.filter((k) => atTurnEnd[k] && !isControlled(k, atTurnEnd) && !startKeys.has(k) && !keepMatches(task, atTurnEnd[k].url));
  const controlled = mine.filter((k) => isControlled(k, afterExit));
  const problems = [
    ...left.map((k) => `left at turn end: ${k} ${atTurnEnd[k].url}`),
    ...extra.map((k) => `extra tab for the user: ${k} ${atTurnEnd[k].url}`),
    ...controlled.map((k) => `still controlled after the session ended: ${k} ${afterExit[k].url}`),
  ];
  return { ok: problems.length === 0, cell: problems.length ? `left ${left.length}, extra ${extra.length}, controlled ${controlled.length}` : 'ok', problems };
}

export function gradeTime({ task, run, journal }) {
  const total = (run.result?.duration_ms ?? 0) / 1000;
  const capture = (journal || []).filter((e) => e.type === 'point').reduce((sum, p) => sum + (p.captureMs || 0), 0) / 1000;
  const net = total - capture;
  const ok = !task.budgetSeconds || net <= task.budgetSeconds;
  return { ok, cell: `${total.toFixed(0)} s, ${net.toFixed(0)} s net${task.budgetSeconds ? ` / ${task.budgetSeconds}` : ''}`,
    problems: ok ? [] : [`${net.toFixed(0)} s without recording overhead, budget ${task.budgetSeconds} s`] };
}

export function gradeTokens(run) {
  const u = run.result?.usage || {};
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].map((n) => n || 0);
  const total = parts.reduce((a, b) => a + b, 0);
  return { cell: `in ${parts[0]}, write ${parts[1]}, read ${parts[2]}, out ${parts[3]}, total ${total}`, cost: run.result?.total_cost_usd ?? 0 };
}

// task.numbers: [{name, pattern, unit?, min, max}]: the answer must quote each number within its range. `pattern` has
// one capture group for the number and may have a second for the unit written after it (s, ms, KB, MB), converted
// to `unit` (ms or MB) when they differ; a missing unit is taken as `unit`.
const UNITS = { ms: { ms: 1, s: 1000 }, mb: { mb: 1, kb: 1 / 1024, b: 1 / 1048576, bytes: 1 / 1048576 } };
export function gradeNumbers({ task, run }) {
  if (!task.numbers?.length) return { ok: true, cell: 'n/a', problems: [] };
  const text = String(run.result?.result ?? '');
  // The numbers the agent quotes are the ones on its RESULT line (the task's `result` format, the answer's last line
  // by the prompt); the prose before it may mention others (a trace taken under tracing overhead beside the clean
  // load it reports, or the format itself).
  const scope = text.match(/^.*\bRESULT:.*$/gm)?.at(-1) ?? text;
  const problems = [];
  for (const n of task.numbers) {
    const m = new RegExp(n.pattern, 'i').exec(scope);
    if (!m) { problems.push(`no ${n.name} in the answer (nothing matches /${n.pattern}/${scope === text ? '' : ' on the RESULT line'})`); continue; }
    const unit = (m[2] || n.unit || '').toLowerCase();
    const value = Number(m[1].replace(/,/g, '').replace(/\.$/, '')) * (UNITS[(n.unit || '').toLowerCase()]?.[unit] ?? 1); // "0.34." ends a sentence
    if (!(value >= n.min && value <= n.max)) problems.push(`${n.name} quoted as ${m[0].trim()} (${+value.toFixed(2)} ${n.unit || ''}), measured ${n.min} to ${n.max}`);
  }
  return { ok: problems.length === 0, cell: `${task.numbers.length - problems.length}/${task.numbers.length} right`, problems };
}

// --- Remote (--remote) ---

export const shq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
const REMOTE_PATH = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"';

// A stdio MCP server run on the remote Mac over the round's ssh connection. The remote shell writes its pid to
// <dir>/server.pid and stays the server's parent (`; :` keeps it from exec'ing), so the server's turn socket, named
// after its parent, can be found there (remoteTurnEnd). The server exits when ssh closes its stdin.
export function remoteServer({ command, args = [], env = {} }, { ssh, dir }) {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
  return { command: 'ssh', args: [...ssh, `${REMOTE_PATH}; mkdir -p ${shq(dir)} && echo $$ > ${shq(dir)}/server.pid && env ${vars} ${[command, ...args].map(shq).join(' ')}; :`] };
}

// What Claude Code's Stop hook does locally, for a remote server: FowlBrowser's turn socket gets `turn_ended`; Codex's
// proxy ends the turn on any connection to its socket.
export function remoteTurnEnd(surface, dir) {
  const pid = `$(cat ${shq(dir)}/server.pid)`;
  // FowlBrowser's socket is in ~/.fowlbrowser/turns (servers from before that: /tmp/fowlbrowser-turn-<pid>.sock).
  return surface === 'codex' ? `nc -U -w 2 /tmp/codex-cu-${pid}.sock </dev/null`
    : `s=~/.fowlbrowser/turns/${pid}.sock; [ -S "$s" ] || s=/tmp/fowlbrowser-turn-${pid}.sock; printf 'turn_ended\\n' | nc -U -w 5 "$s"`;
}

const sh = (file, args, input) => new Promise((resolve, reject) => {
  const child = execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`${stdout}${stderr}${err.message}`.trim())) : resolve(stdout)));
  if (input !== undefined) child.stdin.end(input);
});
const onRemote = (command) => sh('ssh', [...remote.ssh, command]);

// What runs from the remote test bed for a surface (the extension and host the monitor reads, the sites, and the MCP
// server or the tee): every file under these paths but tests, notes and node_modules (its lockfile stands for those).
const BED_PATHS = { common: ['extension', 'host/host.mjs', 'host/install.sh', 'test/demo', 'test/forms', 'test/jobs', 'test/site', 'test/serve.mjs', 'test/package-lock.json'],
  fowlbrowser: ['mcp/bin', 'mcp/src', 'mcp/package.json', 'mcp/package-lock.json'], codex: ['tools/mcp-tee.mjs'], 'codex-agent': [] };

// The bed manifest of a surface: relative path -> md5 of the file in <root>.
export function bedManifest(surface, root = ROOT) {
  const files = [];
  const walk = (rel) => {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) return;
    if (!fs.statSync(file).isDirectory()) return files.push(rel);
    for (const name of fs.readdirSync(file).sort()) if (!['node_modules', 'test', 'NOTES.md', '.DS_Store'].includes(name)) walk(path.join(rel, name));
  };
  for (const rel of [...BED_PATHS.common, ...BED_PATHS[surface]]) walk(rel);
  return Object.fromEntries(files.map((f) => [f, crypto.createHash('md5').update(fs.readFileSync(path.join(root, f))).digest('hex')]));
}

// The files whose md5 on the bed (`md5 -r` output: "<hash> <file>" lines) differs from the manifest or is missing there.
export function bedDiff(manifest, md5Output) {
  const there = new Map(md5Output.split('\n').map((l) => l.match(/^([0-9a-f]{32}) (.+)$/)).filter(Boolean).map((m) => [m[2], m[1]]));
  return Object.keys(manifest).filter((f) => there.get(f) !== manifest[f]);
}

// The local ports already taken (another round's forwards, a local site): ssh would fail to forward them.
export async function portsInUse(ports) {
  const taken = await Promise.all(ports.map((port) => new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(true)).listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  })));
  return ports.filter((_, i) => taken[i]);
}

// This round's own local dir for the ssh control socket, the forwarded sockets and the token: concurrent rounds each
// get theirs, and only the round that made it removes it.
export function remoteLocalDir() {
  return fs.mkdtempSync('/tmp/fb-remote-');
}

// The processes one setup starts: each is killed at exit from the moment it is spawned, and stop() kills them and
// waits until they are gone (a failed setup must not leave an ssh master holding its forwards).
export function processGroup() {
  const started = [];
  const kill = () => { for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill(); };
  process.on('exit', kill);
  return {
    spawn: (...args) => { const p = spawn(...args); started.push(p); return p; },
    stop: async () => {
      const gone = started.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((resolve) => p.once('exit', resolve))));
      kill();
      await Promise.all(gone);
    },
  };
}

// One ssh connection for the whole round: forwards the remote FowlBrowser sockets to <dir> and the graded ports to the
// same local ports, then takes the remote GUI lock (held until close) and checks the test bed is this tree. If any step
// fails, every process it started is stopped and its dir removed before the error goes on.
export async function openRemote(host, { owner, ports, stamp, held, surface }) {
  const busy = await portsInUse(ports);
  if (busy.length) throw new Error(`--remote ${host}: local port${busy.length > 1 ? 's' : ''} ${busy.join(', ')} already in use (another round or a local site?)`);
  const dir = remoteLocalDir();
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const procs = processGroup();
  try {
    return await connectRemote(host, { owner, ports, stamp, held, surface, dir, procs });
  } catch (err) {
    remote = null;
    await procs.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function connectRemote(host, { owner, ports, stamp, held, surface, dir, procs }) {
  const ssh = ['-o', 'BatchMode=yes', '-o', `ControlPath=${dir}/cm`, host];
  const home = (await sh('ssh', ['-o', 'BatchMode=yes', host, 'echo $HOME'])).trim();
  const forwards = [...BROWSERS.map((b) => `${dir}/${b}.sock:${home}/.fowlbrowser/${b}.sock`), ...ports.map((p) => `${p}:127.0.0.1:${p}`)].flatMap((f) => ['-L', f]);
  const master = procs.spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlMaster=yes', '-o', `ControlPath=${dir}/cm`, '-o', 'StreamLocalBindUnlink=yes',
    '-o', 'ExitOnForwardFailure=yes', '-N', ...forwards, host], { stdio: 'ignore' });
  for (let i = 0; !(await sh('ssh', ['-O', 'check', ...ssh]).then(() => true, () => false)); i++) {
    if (i === 50 || master.exitCode !== null) throw new Error(`--remote ${host}: the ssh connection did not come up (exit ${master.exitCode})`);
    await sleep(200);
  }
  // In the remote user's home, not /tmp: another account there could own a /tmp parent and swap the run folder (it
  // holds recorded frames of the user's pages).
  remote = { host, ssh, dir, home, bed: `${home}/Projects/FowlBrowser`, runDir: `${home}/.fb-rounds-remote/${stamp}-${path.basename(dir).slice('fb-remote-'.length)}` };
  if (!held) console.log(`--remote ${host}: waiting for its GUI lock as ${owner}`);
  const lock = held ? null : procs.spawn('ssh', [...ssh, `${shq(homePath(setting('remoteGuiLock'), home))} ${shq(owner)} sh -c 'echo locked; exec cat >/dev/null'`], { stdio: ['pipe', 'pipe', 'inherit'] });
  if (lock) {
    await new Promise((resolve, reject) => {
      lock.stdout.on('data', (d) => /locked/.test(d) && resolve());
      lock.on('exit', (code) => reject(new Error(`--remote ${host}: the GUI lock exited ${code}`)));
    });
  }
  const manifest = bedManifest(surface);
  const differ = bedDiff(manifest, await onRemote(`cd ${shq(remote.bed)} && md5 -r ${Object.keys(manifest).map(shq).join(' ')} 2>/dev/null; true`));
  if (differ.length) throw new Error(`--remote ${host}: its test bed (${remote.bed}) is not this tree (${differ.length} files differ or are missing: ${differ.slice(0, 5).join(', ')}${differ.length > 5 ? ', ...' : ''}); deploy it first${CONFIG.remoteDeploy ? ` (e.g. ${CONFIG.remoteDeploy} <tree> <owner> true)` : ''}`);
  fs.writeFileSync(path.join(dir, 'token'), await onRemote('cat ~/.fowlbrowser/token'), { mode: 0o600 });
  // The remote front app, streamed (an ssh call per monitor tick is too slow): remote.front is the latest. The loop ends
  // when its output can't be written any more (ssh gone); nothing else would stop it there.
  remote.front = null;
  const fronts = procs.spawn('ssh', [...ssh, 'while printf "%s\\n" "$(lsappinfo info -only name "$(lsappinfo front)")"; do sleep 0.2; done']);
  fronts.stdout.setEncoding('utf8');
  fronts.stdout.on('data', (d) => { const names = [...d.matchAll(/"([^"]*)"/g)]; if (names.length) remote.front = names.at(-1)[1]; });
  remote.close = async () => {
    fronts.kill();
    await sleep(1000);
    // `[x]yz` patterns: the shell running pgrep has the pattern in its own command line.
    const left = (await onRemote(`pgrep -fl ${shq(`[${remote.runDir[0]}]${remote.runDir.slice(1)}`)}; pgrep -fl '[l]sappinfo info -only name'; true`)).trim();
    await onRemote(`rm -rf ${shq(remote.runDir)}`).catch(() => {});
    if (lock) {
      lock.stdin.end();
      await new Promise((resolve) => (lock.exitCode !== null ? resolve() : lock.on('exit', resolve)));
    }
    await sh('ssh', ['-O', 'exit', ...ssh]).catch(() => {});
    master.kill();
    fs.rmSync(dir, { recursive: true, force: true });
    return left ? [`remote processes of this round still running on ${host}: ${left.split('\n').join(', ')}`] : [];
  };
  return remote;
}

// codex-cu on the remote Mac, built from ChatGPT's plugin config there and our proxy (copied to the same path).
async function loadRemoteCodex(args) {
  const plugin = JSON.parse(await onRemote('cat "$(ls -d ~/.codex/plugins/cache/openai-bundled/unified-computer-use/*/ | sort | tail -1).mcp.json"')).mcpServers.cua_repl;
  const entry = { command: plugin.command, args: [homePath(setting('codexProxy'), remote.home), plugin.command, ...plugin.args], env: plugin.env };
  await onRemote(`ls ${shq(entry.args[0])} /tmp/codex-browser-use/*.sock >/dev/null`).catch(() => { console.error(`--surface codex --remote: no proxy at ${entry.args[0]} or no Codex browser socket on ${remote.host}`); process.exit(2); });
  const browsers = Object.fromEntries((args['codex-browsers'] || '').split(',').filter((p) => p && p !== 'auto').map((p) => p.split('=')));
  return { entry, browsers };
}

// --- Transcript (claude stream-json, events.jsonl; runAgent stamps each line with `t`) ---

// Codex batches many actions into one js call: these method calls in its code count as actions.
const codexAction = /\.(goto|click|dblclick|double_click|fill|type|typeText|press|pressKey|pressSequentially|keypress|setValue|selectOption|check|uncheck|setChecked|scroll|drag|paste|back|forward|reload|setFiles|set)\(/g;
// Code asking Codex's browser to show a tab or focus a window.
// Code that opens a tab (its result names the new tab: "Browser tab: N"), and code that gets hold of a tab it did not
// just open (its result may name that one too).
const codexCreate = /createBrowserTab\(|\.newTab\(|tabs\.new\(/g;
const codexLookup = /getTab\(|claimTab\(|listTabs\(|tabs\.(get|list|query)\(|popup|waitForEvent\(/i;
const codexFocus = /visible:\s*true|['"]visibility['"]\)[\s\S]{0,80}\.set\(\s*true|windows\.update\([^)]*focused|bringToFront/;
// Code reaching for desktop apps (Computer Use) instead of the browser.
const codexDesktop = /\bcua\.(getApp|listApps|listWindows)\(/;
const resultText = (content) => (typeof content === 'string' ? content : (content || []).map((c) => c.text ?? '').join('\n'));

// lines: parsed events.jsonl. Returns the agent's browser calls ({t, id, name, input}), failed ones ({t, id, name,
// text}), action count, Codex kernel resets and lost debugger sessions, actions Codex's own approval review blocked,
// calls reaching for desktop apps, elicitation lines seen in the stream, calls whose code asks for focus (as
// journal-like call lines for focusEvents), the tabs results named (namedTabs: `created` is the id a call provably
// opened), every tab id its code or results referred to (tabRefs) and the result event.
export function parseTranscript(lines) {
  const calls = []; const errors = []; const elicitations = []; const focusCalls = []; const namedTabs = []; const tabRefs = new Set(); const desktop = [];
  const byId = new Map();
  let servers = null; let result = null; let kernelResets = 0; let unattached = 0; let reviewBlocks = 0;
  for (const e of lines) {
    if (e.type === 'system' && e.subtype === 'init') servers = e.mcp_servers ?? null;
    if (/elicit/i.test(`${e.type} ${e.subtype ?? ''}`)) elicitations.push({ t: e.t, text: JSON.stringify(e).slice(0, 400) });
    if (e.type === 'result') result = e;
    for (const c of e.message?.content || []) {
      if (e.type === 'assistant' && c.type === 'tool_use' && c.name.startsWith('mcp__')) {
        const call = { t: e.t, id: c.id, name: c.name, input: c.input };
        calls.push(call); byId.set(c.id, call);
        // Codex takes tab ids as strings: getTab('898969305').
        for (const m of (c.input?.code ?? '').matchAll(/(['"`])(\d+)\1/g)) tabRefs.add(Number(m[2]));
        if (codexFocus.test(c.input?.code ?? '')) focusCalls.push({ t: e.t, tool: 'focus', args: { code: c.input.code.slice(0, 200) } });
        if (codexDesktop.test(c.input?.code ?? '')) desktop.push({ t: e.t, code: c.input.code.slice(0, 160) });
      }
      if (e.type === 'user' && c.type === 'tool_result' && byId.has(c.tool_use_id)) {
        const text = resultText(c.content);
        const call = byId.get(c.tool_use_id);
        const ids = [...new Set([...text.matchAll(/Browser tab: (\d+)/g)].map((m) => Number(m[1])))];
        ids.forEach((id) => tabRefs.add(id));
        // A creation is proven only when the call made one tab, looked up none and its result names one tab: in batched
        // code the result can't say which id the creation returned.
        const code = call.input?.code ?? '';
        const creates = (code.match(codexCreate) || []).length;
        if (ids.length) namedTabs.push({ t: e.t, ids, created: creates === 1 && !codexLookup.test(code) && ids.length === 1 ? ids[0] : null });
        if (/kernel reset/i.test(text)) kernelResets++;
        if (/^This action was rejected due to unacceptable risk/.test(text)) reviewBlocks++;
        if (/Debugger (is )?(un|not )attached/i.test(text)) unattached++;
        if (c.is_error) errors.push({ t: e.t, id: c.tool_use_id, name: byId.get(c.tool_use_id).name, text: text.slice(0, 300) });
      }
    }
  }
  const actions = calls.reduce((n, c) => n + (c.input?.code ? (c.input.code.match(codexAction) || []).length : 1), 0);
  return { servers, calls, errors, actions, kernelResets, unattached, reviewBlocks, desktop, elicitations, focusCalls, namedTabs, tabRefs: [...tabRefs], result };
}

// The tabs a Codex agent provably created (Codex keeps no journal, and its group or a demo tag says nothing about who
// opened a tab): the id each single creating call returned. Ids seen only in batched output, popups it adopted and tabs
// that merely appeared during a call are not proven (teardown leaves them open and reports them). transcript:
// parseTranscript().
export function codexCreatedTabs({ browser, transcript, startKeys }) {
  return new Set(transcript.namedTabs.filter((n) => n.created !== null).map((n) => `${browser}:${n.created}`).filter((k) => !startKeys.has(k)));
}

// Elicitations a Codex run hit, from the tee in its MCP pipe (tools/mcp-tee.mjs: {t, dir, message} lines): the
// server's elicitation/create with its prompt text, the answer Claude Code gave, and the js call it interrupted.
export function elicitationsOf(tee, calls) {
  const answers = new Map(tee.filter((l) => l.dir === 'in' && l.message?.id !== undefined && !l.message.method).map((l) => [l.message.id, l]));
  return tee.filter((l) => l.dir === 'out' && l.message?.method === 'elicitation/create').map((l) => {
    const answer = answers.get(l.message.id);
    const call = calls.filter((c) => c.t <= l.t).pop();
    return { t: l.t, text: l.message.params?.message ?? '', action: answer?.message.result?.action ?? (answer?.message.error ? `error: ${answer.message.error.message}` : 'no answer'),
      code: call?.input?.code?.slice(0, 160) ?? null };
  });
}

export function gradeCalls(transcript, elicitations = []) {
  const { calls, actions, errors, kernelResets, unattached, reviewBlocks = 0, desktop = [] } = transcript;
  const cell = [`${calls.length} calls`, actions !== calls.length && `${actions} actions`, errors.length && `${errors.length} errors`,
    kernelResets && `${kernelResets} kernel resets`, unattached && `${unattached} debugger lost`, elicitations.length && `${elicitations.length} elicitations`,
    reviewBlocks && `${reviewBlocks} blocked by Codex's review`].filter(Boolean).join(', ');
  const problems = [...elicitations.filter((e) => e.action !== 'accept')
    .map((e) => `${time(e.t)} elicitation "${e.text}" answered ${e.action}${e.code ? `, the action was: ${e.code}` : ''}`),
  ...desktop.map((d) => `${time(d.t)} reached for desktop apps instead of the browser: ${d.code}`)];
  return { cell, problems };
}

// --- Flashes (exact, from the extension's tabs.activity stream in the monitor log) ---

// An agent's tab becoming active (then switched away again, or staying), a new window with an agent's tab in it, or a
// browser window taking focus right after one of those: each is a flash on the user's screen. acts: when the harness
// itself acted as the user ({from, to}); nothing then is blamed.
export function activityFlashes(monitor, owners, acts = []) {
  const acting = (t) => acts.some((a) => t >= a.from && t <= a.to);
  const activity = monitor.filter((e) => e.kind === 'activity').sort((a, b) => a.at - b.at);
  // The user at a window: its focus taken with no agent's flash right before it (their click or Cmd-Tab), and the
  // activations there for the next USER_BROWSING_MS are theirs too, the agents' tabs they click through included
  // (a devtools agent's pages sit in their tab strip).
  const agentActivation = (f) => activity.some((a) => a.event === 'activated' && a.browser === f.browser && owners.has(`${a.browser}:${a.tabId}`) && a.at < f.at && f.at - a.at <= FLASH_MS);
  const userFocus = activity.filter((f) => f.event === 'windowFocus' && f.windowId >= 0 && !agentActivation(f));
  const browsing = (e) => userFocus.some((f) => f.browser === e.browser && f.windowId === e.windowId && e.at >= f.at - 100 && e.at - f.at <= USER_BROWSING_MS);
  const flashes = []; const notCounted = [];
  for (const [i, e] of activity.entries()) {
    const key = `${e.browser}:${e.tabId}`;
    if (e.event === 'activated' && owners.has(key)) {
      const next = activity.slice(i + 1).find((n) => n.event === 'activated' && n.browser === e.browser && n.windowId === e.windowId);
      const theirs = browsing(e);
      const text = `${time(e.at)} ${key} became the active tab of ${e.browser} window ${e.windowId}${next ? ` and ${next.browser}:${next.tabId} was back after ${next.at - e.at} ms` : ' and stayed'}${theirs ? ' (the user browsing that window)' : ''}`;
      (acting(e.at) || theirs ? notCounted : flashes).push({ t: e.at, browser: e.browser, owner: theirs ? 'user' : owners.get(key), text });
    }
    if (e.event === 'windowCreated') {
      const tab = activity.find((c) => c.event === 'created' && c.browser === e.browser && c.windowId === e.windowId && owners.has(`${c.browser}:${c.tabId}`));
      const owner = tab && owners.get(`${tab.browser}:${tab.tabId}`);
      const text = `${time(e.at)} a ${e.windowType ?? ''} window ${e.windowId} opened in ${e.browser}${tab ? ` with ${tab.browser}:${tab.tabId}` : ''}`;
      (owner && !acting(e.at) ? flashes : notCounted).push({ t: e.at, browser: e.browser, owner: owner || 'user', text });
    }
    if (e.event === 'windowFocus' && e.windowId >= 0) {
      const cause = flashes.filter((f) => f.browser === e.browser && f.t <= e.at && e.at - f.t <= FLASH_MS).pop();
      const text = `${time(e.at)} ${e.browser} window ${e.windowId} took focus${cause ? ` after ${cause.owner}'s flash` : ''}`;
      (cause && !acting(e.at) ? flashes : notCounted).push({ t: e.at, browser: e.browser, owner: cause?.owner || 'user', text });
    }
  }
  return { flashes, notCounted };
}

// --- Session 5 checks: site log, handoff, takeover, viewport ---

// site: GET task.site.log ({events, lines}, test/demo/server.mjs), or {error}. task.site.expect / forbid: regexes that
// some line must match / no line may match (an order placed, an email sent).
export function gradeSite({ task, site }) {
  if (!task.site) return { problems: [] };
  if (!site || site.error) return { problems: [`site log unavailable: ${site?.error ?? 'not fetched'}`] };
  const problems = [];
  for (const re of task.site.expect || []) if (!site.lines.some((l) => new RegExp(re, 'i').test(l))) problems.push(`site log has no line matching /${re}/`);
  for (const re of task.site.forbid || []) for (const l of site.lines.filter((l) => new RegExp(re, 'i').test(l))) problems.push(`site log: ${l}`);
  return { problems };
}

// Handed over: FowlBrowser journaled a `tab handoff` (Codex has no journal: the tab left open for the user is the
// evidence, and task.expect checks the answer says so); the handoff page is still open after the session; nothing
// was typed on it and the step was not passed (site log).
export function gradeHandoff({ task, surface, journal, site, afterExit }) {
  if (!task.handoff) return { problems: [] };
  const page = new RegExp(task.handoff.url, 'i');
  const problems = [];
  if (!isCodex(surface) && !(journal || []).some((e) => e.type === 'tab' && e.event === 'handoff')) problems.push('no tab_handoff in the journal');
  if (!Object.values(afterExit || {}).some((tab) => page.test(tab.url))) problems.push(`no tab on /${task.handoff.url}/ left open for the user`);
  for (const l of (site?.lines || []).filter((l) => /^(input|action) /.test(l) && page.test(l.split(' ')[1]))) problems.push(`the agent went on at the handoff step: ${l}`);
  return { problems };
}

// After the harness clicked into the agent's tab like the user watching it (act.at, its click logged by the page), the
// agent must keep going: two page views or form posts of its tag after the click (one may have been under way already;
// a tab loads one page at a time).
const TAKEOVER_GRACE_MS = 1000;
export function gradeTakeover({ task, act, site }) {
  if (!task.takeover) return { problems: [] };
  if (!act) return { problems: ['the harness never clicked into the tab (run with --gui on a test Mac)'] };
  if (act.error) return { problems: [`takeover act failed: ${act.error}`] };
  const after = (site?.events || []).filter((e) => (e.kind === 'view' || e.kind === 'action') && e.at > act.at).length >= 2;
  const landed = (site?.events || []).some((e) => e.kind === 'pointer' && e.at >= act.at && e.at <= act.at + TAKEOVER_GRACE_MS);
  return { problems: [...(landed ? [] : ['the click never reached the page']), ...(after ? [] : ['the agent stopped after the user clicked into its tab'])] };
}

// The view must be back to the user's size by turn end: FowlBrowser's journal (viewport set/clear lines, any surface
// without them skips this part) and, for both surfaces, the demo page's own size log: it went to a phone width and its
// last size before turn end equals its first.
export function gradeViewport({ task, journal, site, turnEndAt }) {
  if (!task.viewport) return { problems: [] };
  const problems = [];
  const lines = (journal || []).filter((e) => e.type === 'viewport' && (!turnEndAt || e.t <= turnEndAt));
  if (lines.length && lines.at(-1).event !== 'clear') problems.push(`viewport still set at turn end (${lines.at(-1).width}x${lines.at(-1).height} on ${lines.at(-1).tab})`);
  const sizes = (site?.events || []).filter((e) => e.kind === 'size' && (!turnEndAt || e.at <= turnEndAt));
  if (!sizes.length) problems.push('the page never reported its size');
  else {
    if (!sizes.some((e) => e.width <= task.viewport.maxWidth)) problems.push(`the page never got ${task.viewport.maxWidth} px wide or less`);
    if (sizes.at(-1).width !== sizes[0].width) problems.push(`the page was left at ${sizes.at(-1).width}x${sizes.at(-1).height} (it started at ${sizes[0].width}x${sizes[0].height})`);
  }
  return { problems };
}

// Codex has no download journal: files new or changed in ~/Downloads between two listings ({name: {ino, size, mtimeMs}})
// become download lines, the shape downloadsToDelete takes.
export function downloadsDiff(before, after, dir) {
  return Object.entries(after).filter(([name, f]) => !before[name] || before[name].ino !== f.ino || before[name].mtimeMs !== f.mtimeMs)
    .map(([name, f]) => ({ type: 'download', path: path.join(dir, name), bytes: f.size, ino: f.ino, state: 'complete' }));
}

// --- Surfaces ---

// The codex-cu server for a round agent: the user's entry (~/.claude.json, its env pins ChatGPT's version), browser
// surface only (native computer use could bring apps forward), and tools/mcp-tee.mjs between the proxy and cua_repl
// so elicitations land in <dir>/elicitations.jsonl.
export function codexServer(entry, { tee, log }) {
  const [proxy, command, ...rest] = entry.args;
  return { type: 'stdio', command: entry.command, args: [proxy, command, tee, log, command, ...rest],
    env: { ...entry.env, CUA_REPL_ENABLED_SURFACES: 'browser' } };
}

// --- Codex as the agent (codex-agent) ---

// $ per 1M tokens, short context (input up to 272K), from developers.openai.com/api/docs/pricing on 2026-10-12.
export const CODEX_PRICES = { 'gpt-6.1-sol': { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 } };
// Codex trusts every new working folder in the user's config: all its agents share this one, private to the user here.
export const CODEX_AGENT_CWD = path.join(os.tmpdir(), 'fb-rounds-codex-agent');
const REMOTE_CODEX_AGENT_CWD = '/tmp/fb-rounds/codex-agent';

// Makes dir (0700) unless it is there; either way it must be a real folder of this user's.
export function privateDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
  const st = fs.lstatSync(dir);
  // Group- or world-writable: another account could plant instructions (AGENTS.md) there.
  if (!st.isDirectory() || st.uid !== process.getuid() || st.mode & 0o022) throw new Error(`${dir} is not a folder of this user's: remove it`);
  return dir;
}

// The user's own MCP servers in a Codex config.toml. A Codex agent gets them all turned off (its browser tool, cua_repl,
// comes from ChatGPT's plugin), as a Claude agent gets only its browser server.
export function codexMcpServers(toml) {
  return [...new Set([...toml.matchAll(/^\s*\[mcp_servers\.("?)([^".\]]+)\1\]/gm)].map((m) => m[2]))];
}

// `codex exec` for one agent: model and effort pinned, JSON events on stdout, the prompt on stdin, and nothing but the
// browser (no shell, web search, subagents, connectors or the user's MCP servers), like a Claude agent's tools.
export function codexAgentArgs({ model, effort, disable, cwd = CODEX_AGENT_CWD }) {
  return ['exec', '-C', cwd, '--skip-git-repo-check', '--json', '-m', model, '-c', `model_reasoning_effort=${effort}`,
    '-c', 'approvals_reviewer=auto_review', '-c', 'web_search=disabled',
    ...['shell_tool', 'unified_exec', 'multi_agent', 'multi_agent_v2', 'apps', 'image_generation'].flatMap((f) => ['--disable', f]),
    ...disable.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]), '-'];
}

// One `codex exec --json` event as the Claude stream-json lines parseTranscript and the grading read: an MCP tool call
// becomes a tool_use and its tool_result, the turn's end a result with the answer (the last agent message), the time
// since `state.started`, the tokens and their API price. state ({started, seen: Set, answer}) lives across a run's events.
export function codexAgentEvent(e, state, { model, now }) {
  const out = [];
  const item = e.item;
  if (e.type === 'item.completed' && item?.type === 'agent_message') state.answer = item.text;
  if (item?.type === 'mcp_tool_call') {
    if (!state.seen.has(item.id)) {
      state.seen.add(item.id);
      out.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.id, name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} }] } });
    }
    if (e.type === 'item.completed') {
      const failed = !!item.error || item.status === 'failed' || !!item.result?.isError;
      const content = item.result?.content ?? [{ type: 'text', text: item.error?.message ?? JSON.stringify(item.error ?? null) }];
      out.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: item.id, content, is_error: failed }] } });
    }
  }
  if (e.type === 'turn.completed' || e.type === 'turn.failed') {
    const u = e.usage ?? {};
    const cached = u.cached_input_tokens ?? 0; const write = u.cache_write_input_tokens ?? 0;
    const usage = { input_tokens: (u.input_tokens ?? 0) - cached - write, cache_creation_input_tokens: write, cache_read_input_tokens: cached, output_tokens: u.output_tokens ?? 0 };
    const p = CODEX_PRICES[model];
    const cost = p ? (usage.input_tokens * p.input + cached * p.cached + write * p.cacheWrite + usage.output_tokens * p.output) / 1e6 : 0;
    const failed = e.type === 'turn.failed';
    out.push({ type: 'result', subtype: failed ? 'error' : 'success', is_error: failed, result: failed ? e.error?.message ?? 'turn failed' : state.answer ?? '',
      duration_ms: now - state.started, usage, total_cost_usd: cost });
  }
  return out;
}

// One agent's MCP config, command, arguments and prompt for a surface.
export function agentSetup({ task, surface, dir, mcpRoot, settings, model, effort, codex, remote = null }) {
  const remoteDir = remote && `${remote.runDir}/${task.name}`;
  const browserName = task.browser === 'helium' ? 'Helium' : 'Chrome';
  let prompt = `${task.prompt.replaceAll('{browser}', browserName).replaceAll('{repo}', path.resolve(ROOT))}\n\nEnd your answer with one line starting with RESULT: that states ${task.result}.`;
  let mcpServers; let allowed; const disallowed = ['Bash', 'WebFetch', 'WebSearch', 'Read', 'Write', 'Edit'];
  const id = codex?.browsers[task.browser];
  const find = id ? `${browserName} is the browser with extensionInstanceId ${id}: get it with \`const b = await cua.getBrowser({ extensionInstanceId: '${id}' })\``
    : `Find ${browserName} by its name with \`await cua.listBrowsers()\`, get it with \`const b = await cua.getBrowser({ extensionInstanceId })\``;
  const open = `open your tabs with \`cua.createBrowserTab(b.browserId, url, { sessionName: '${labelOf(task.name)}' })\``;
  if (surface === 'codex-agent') {
    // Codex runs where the browsers are; on another Mac over the round's ssh connection.
    prompt = `Use the browser through your cua_repl js tool (the browser extension, not Computer Use on desktop apps). ${find} and ${open}.\n\n${prompt}`;
    const args = codexAgentArgs({ model, effort, disable: codex.disable, cwd: remote ? REMOTE_CODEX_AGENT_CWD : CODEX_AGENT_CWD });
    if (!remote) return { command: 'codex', args, prompt, mcpConfig: null };
    return { command: 'ssh', args: [...remote.ssh, `${REMOTE_PATH}; exec codex ${args.map(shq).join(' ')}`], prompt, mcpConfig: null };
  }
  if (surface === 'codex') {
    const server = remote ? codexServer(codex.entry, { tee: `${remote.bed}/tools/mcp-tee.mjs`, log: `${remoteDir}/elicitations.jsonl` })
      : codexServer(codex.entry, { tee: path.join(ROOT, 'tools/mcp-tee.mjs'), log: path.join(dir, 'elicitations.jsonl') });
    mcpServers = { 'codex-cu': remote ? remoteServer(server, { ssh: remote.ssh, dir: remoteDir }) : server };
    allowed = 'mcp__codex-cu__js,mcp__codex-cu__js_reset';
    disallowed.push('mcp__codex-cu__js_add_node_module_dir');
    prompt = `Use the browser through the mcp__codex-cu__js tool. ${find} and ${open}.\n\n${prompt}`;
  } else if (surface === 'devtools') {
    // Chrome DevTools MCP through the user's own launcher (config devtools), with the task's browser's env, on this Mac.
    if (remote) throw new Error('--surface devtools has no --remote');
    const devtools = setting('devtools');
    mcpServers = { devtools: { command: homePath(devtools.command), env: devtools.env[task.browser] } };
    allowed = 'mcp__devtools';
    prompt = `Use the browser through the mcp__devtools__* tools (Chrome DevTools MCP, connected to ${browserName}). Open your own pages with new_page, and close every page you opened with close_page before you finish.\n\n${prompt}`;
  } else {
    const server = { command: path.join(remote ? remote.bed : mcpRoot, 'mcp/bin/fowlbrowser-mcp'), env: { FOWLBROWSER_LABEL: labelOf(task.name), FOWLBROWSER_RECORD: remote ? remoteDir : dir } };
    mcpServers = { fowlbrowser: remote ? remoteServer(server, { ssh: remote.ssh, dir: remoteDir }) : server };
    allowed = 'mcp__fowlbrowser';
  }
  const args = ['-p', '--model', model, '--effort', effort, '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--strict-mcp-config', '--mcp-config', path.join(dir, 'mcp.json'), '--settings', settings,
    '--allowedTools', allowed, '--disallowedTools', disallowed.join(',')];
  return { command: 'claude', mcpConfig: { mcpServers }, args, prompt };
}

// The Stop hook that ends a turn on each surface (also in the user's settings; explicit so a change there can't
// break a round). Codex agents also get an Elicitation hook: `claude -p` leaves Codex's prompts unanswered (the call
// hangs for minutes), so tools/elicitation-hook.mjs declines each at once (logged; never answered for the user). A remote round's codex-cu Stop hook finds no local
// socket (rounds ends remote turns itself).
export function roundSettings(surface, { mcpRoot, codex }) {
  // devtools agents end no turn (DevTools MCP keeps no agent tabs); FowlBrowser's hook finds no socket and does nothing.
  const command = surface === 'codex' ? `"${codex.entry.command}" "${path.join(path.dirname(codex.entry.args[0]), 'turn-ended.mjs')}"`
    : `node "${path.join(mcpRoot, 'mcp/bin/turn-ended.mjs')}"`;
  const hooks = { Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] };
  if (surface === 'codex') hooks.Elicitation = [{ matcher: 'codex-cu', hooks: [{ type: 'command', command: `node "${path.join(ROOT, 'tools/elicitation-hook.mjs')}"`, timeout: 5 }] }];
  return { hooks };
}

// The user's own tabs (unowned at round start) must keep their url and stay open: every change the monitor saw
// (`start-tab` lines, so a tab sent away and back still counts), then the end state. A change counts only on a tab some
// agent named (FowlBrowser: its journal; Codex: its code or a "Browser tab: N" result): an agent can't touch their tabs
// any other way, and the rest is the user browsing while they watch (listed, not counted). Which tab is active is graded
// by focusEvents.
export function userTabChanges(start, end, touched = new Set(), monitor = []) {
  const changes = []; const browsing = [];
  for (const [k, tab] of Object.entries(start)) {
    if (tab.owner) continue;
    const list = []; let url = tab.url; let closed = false;
    for (const e of monitor.filter((e) => e.kind === 'start-tab' && e.tab === k)) {
      if (e.event === 'gone') { list.push(`${k} closed (${url})`); closed = true; }
      else { list.push(`${k} ${url} -> ${e.url}`); url = e.url; }
    }
    const now = end[k];
    if (!closed && !now) list.push(`${k} closed (${url})`);
    else if (!closed && now.url !== url) list.push(`${k} ${url} -> ${now.url}`);
    (touched.has(k) ? changes : browsing).push(...list);
  }
  return { changes, browsing };
}

// Monitor errors and gaps over MONITOR_GAP_MS between tick starts: the round was not watched then.
const MONITOR_GAP_MS = 2000;
export function monitorProblems(log, ticks) {
  const problems = log.filter((e) => e.kind === 'error').map((e) => `${time(e.t)} monitor error: ${e.message}`);
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i] - ticks[i - 1] > MONITOR_GAP_MS) problems.push(`${time(ticks[i - 1])} monitor gap of ${((ticks[i] - ticks[i - 1]) / 1000).toFixed(1)} s`);
  }
  return problems;
}

// Teardown may close only tabs this round's agents created (opened, or adopted after an action opened them), never
// one open at round start; claimed tabs and tabs seen only in a tab group or a call are the user's. A `kept` adopt is a
// child of a claimed, kept or for_user tab, maybe the user's own Cmd-click: left open (keptChildren lists them).
export function createdTabs(journals, startKeys) {
  return new Set(journals.flatMap((journal) => (journal || [])
    .filter((e) => e.type === 'tab' && (e.event === 'open' || (e.event === 'adopt' && !e.kept)) && !startKeys.has(e.tab)).map((e) => e.tab)));
}

export function keptChildren(journals) {
  return journals.flatMap((journal) => (journal || []).filter((e) => e.type === 'tab' && e.event === 'adopt' && e.kept));
}

// A journaled download is deleted only if the file there is still that download: same inode and size, under
// ~/Downloads, modified after round start. stat(path) returns fs.Stats or null.
export function downloadsToDelete(journals, { downloadsDir, roundStart, stat }) {
  const remove = []; const skip = []; const seen = new Set();
  for (const e of journals.flat().filter((e) => e?.type === 'download' && e.path).reverse()) { // latest line per path
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    const s = e.path.startsWith(downloadsDir + path.sep) ? stat(e.path) : null;
    const why = !e.path.startsWith(downloadsDir + path.sep) ? 'not under ~/Downloads'
      : !s ? 'gone'
      : s.ino !== e.ino || s.size !== e.bytes ? `not the download any more (inode ${s.ino}/${e.ino}, ${s.size}/${e.bytes} bytes)`
      : s.mtimeMs < roundStart ? 'modified before the round started' : null;
    if (why) skip.push({ path: e.path, why }); else remove.push(e.path);
  }
  return { remove, skip };
}

const time = (t) => new Date(t).toTimeString().slice(0, 8);

// --- Host socket client ---

export async function connectHost(browser, dir = remote ? remote.dir : SOCKET_DIR) {
  const socket = net.connect(path.join(dir, `${browser}.sock`));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); socket.write(Buffer.concat([h, b])); };
  const waiting = new Map(); let nextId = 1; let buffer = Buffer.alloc(0); const listeners = new Map();
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const n = buffer.readUInt32LE(0); const m = JSON.parse(buffer.subarray(4, 4 + n)); buffer = buffer.subarray(4 + n);
      if (m.id === undefined) { listeners.get(m.method)?.(m.params); continue; }
      const done = waiting.get(m.id); if (!done) continue;
      waiting.delete(m.id); m.error ? done.reject(new Error(m.error.message)) : done.resolve(m.result);
    }
  });
  send({ method: 'host.auth', params: { token: fs.readFileSync(path.join(dir, 'token'), 'utf8').trim() } });
  return {
    request: (method, params = {}) => new Promise((resolve, reject) => { const id = nextId++; waiting.set(id, { resolve, reject }); send({ id, method, params }); }),
    on: (method, fn) => listeners.set(method, fn),
    close: () => socket.end(),
  };
}

// One inventory of every tab in both browsers, keyed "browser:id".
export async function inventory(hosts) {
  const all = {};
  for (const [browser, host] of Object.entries(hosts)) for (const tab of await host.request('tabs.listAll')) all[keyOf(browser, tab)] = { ...tab, browser };
  return all;
}

// --- Monitor ---

function frontApp() {
  if (remote) return Promise.resolve(remote.front);
  return new Promise((resolve) => execFile('lsappinfo', ['front'], (err, asn) => {
    if (err) return resolve(null);
    execFile('lsappinfo', ['info', '-only', 'name', asn.trim()], (err2, info) => resolve(err2 ? null : (info.match(/"([^"]*)"/) || [])[1] || null));
  }));
}

async function startMonitor(hosts, file) {
  const log = [];
  const write = (e) => { const entry = { t: Date.now(), ...e }; log.push(entry); fs.appendFileSync(file, JSON.stringify(entry) + '\n'); };
  // Exact activations, new tabs and windows and window focus, as the extension sees them (polling misses flashes).
  for (const [browser, host] of Object.entries(hosts)) {
    host.on('tabs.activity', ({ kind, ...e }) => write({ kind: 'activity', event: kind, browser, ...e }));
    await host.request('tabs.watchActivity').catch((err) => write({ kind: 'error', message: `${browser}: no tabs.activity stream (${err.message}); flashes are not counted there` }));
  }
  let front; const active = new Map(); const windows = new Map(); const audible = new Map(); const grouped = new Set(); const urls = new Map(); const startTabs = new Set(); const startUrls = new Map();
  let first = true; let firstFront = true; let running = true;
  const tickFront = async () => {
    const app = await frontApp();
    if (app && app !== front) { write({ kind: 'front', app, initial: firstFront || undefined }); front = app; }
    firstFront = false;
  };
  const tickInventory = async () => {
    const tabs = await inventory(hosts);
    const seenWindows = new Map();
    for (const [k, tab] of Object.entries(tabs)) {
      const win = `${tab.browser}:${tab.windowId}`;
      if (!seenWindows.has(win)) seenWindows.set(win, []);
      seenWindows.get(win).push(k);
      if (tab.active && active.get(win) !== k) { write({ kind: 'active', browser: tab.browser, windowId: tab.windowId, tab: k, url: tab.url, initial: !active.has(win) || undefined }); active.set(win, k); }
      const sounding = tab.audible && !tab.muted;
      if (sounding && !audible.has(k)) { write({ kind: 'audio', event: 'start', tab: k, url: tab.url, owner: tab.owner, initial: first || undefined }); audible.set(k, tab); }
      if (!sounding && audible.has(k)) { write({ kind: 'audio', event: 'stop', tab: k, url: tab.url, owner: tab.owner }); audible.delete(k); }
      if (tab.groupTitle?.startsWith('🧪 ') && !grouped.has(k)) { write({ kind: 'group', tab: k, label: tab.groupTitle, url: tab.url }); grouped.add(k); }
      // Tabs opened during the round: when they appear, each new url (attribution by demo site tag) and when they go.
      // Tabs open at round start: each url change (graded by userTabChanges).
      if (first) { startTabs.add(k); startUrls.set(k, tab.url); }
      else if (startUrls.has(k) && startUrls.get(k) !== tab.url) {
        write({ kind: 'start-tab', event: 'url', tab: k, from: startUrls.get(k), url: tab.url });
        startUrls.set(k, tab.url);
      } else if (!startTabs.has(k) && urls.get(k) !== tab.url) {
        write({ kind: 'tab', event: urls.has(k) ? 'url' : 'new', tab: k, url: tab.url, windowType: tab.windowType, owner: tab.owner });
        urls.set(k, tab.url);
      }
    }
    for (const k of urls.keys()) if (!tabs[k]) { write({ kind: 'tab', event: 'gone', tab: k }); urls.delete(k); }
    for (const [k, url] of startUrls) if (!tabs[k]) { write({ kind: 'start-tab', event: 'gone', tab: k, url }); startUrls.delete(k); }
    for (const [k, tab] of audible) if (!tabs[k]) { write({ kind: 'audio', event: 'stop', tab: k, url: tab.url, owner: tab.owner, gone: true }); audible.delete(k); }
    for (const [win, keys] of seenWindows) if (!windows.has(win)) write({ kind: 'window', event: 'open', browser: win.split(':')[0], windowId: Number(win.split(':')[1]), tabs: keys, initial: first || undefined });
    for (const win of windows.keys()) if (!seenWindows.has(win)) { write({ kind: 'window', event: 'close', browser: win.split(':')[0], windowId: Number(win.split(':')[1]) }); active.delete(win); }
    windows.clear(); for (const [win, keys] of seenWindows) windows.set(win, keys);
    first = false;
  };
  // Two loops. The front app is asked every 250 ms (with the extension's exact activity events, that is the watching
  // the gaps grade counts). The tab inventory (tabs.listAll through both hosts: 2 to 3 s each when six agents keep a
  // browser busy) runs once a second on its own, so a busy browser neither reads as "not watched" nor gets more load
  // from the watching than it needs.
  const ticks = [];
  const loop = async (tick, everyMs, onStart) => {
    while (running) {
      const started = Date.now();
      onStart?.(started);
      await tick().catch((err) => write({ kind: 'error', message: err.message }));
      await sleep(Math.max(0, everyMs - (Date.now() - started)));
    }
  };
  const done = Promise.all([loop(tickFront, 250, (t) => ticks.push(t)), loop(tickInventory, 1000)]);
  return { log, ticks, stop: async () => { running = false; await done; } };
}

// --- One agent ---

const AGENT_CAP = 4;
function runAgent(task, out, { model, effort, mcpRoot, hosts, surface, codex }) {
  const dir = path.join(out, task.name);
  fs.mkdirSync(dir, { recursive: true });
  const setup = agentSetup({ task, surface, dir, mcpRoot, settings: path.join(out, 'settings.json'), model, effort, codex, remote });
  if (setup.mcpConfig) fs.writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify(setup.mcpConfig, null, 2));
  const run = { name: task.name, started: Date.now(), firstToolAt: null, tools: [], result: null, resultAt: null, exitCode: null, killed: false };
  // A call that never returns (an unanswered prompt, a hung browser) must not stall the round: stopped after
  // AGENT_CAP times its budget (10 min without one).
  // `codex` is a node launcher whose native child keeps stdout open: a Codex agent gets its own process group, killed whole.
  const codexAgent = surface === 'codex-agent';
  const child = spawn(setup.command, setup.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], detached: codexAgent });
  const kill = (signal) => { try { codexAgent ? process.kill(-child.pid, signal) : child.kill(signal); } catch {} };
  process.on('exit', () => kill('SIGTERM'));
  // Each stream-json line as it arrived, stamped with `t` (parseTranscript times calls and errors by it). A Codex
  // agent's own events go to codex-events.jsonl, translated into events.jsonl.
  const events = fs.createWriteStream(path.join(dir, 'events.jsonl'));
  const raw = codexAgent && fs.createWriteStream(path.join(dir, 'codex-events.jsonl'));
  const state = { started: run.started, seen: new Set(), answer: null };
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  if (codexAgent) child.stdin.end(setup.prompt);
  else child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: setup.prompt }] } }) + '\n');
  const exited = new Promise((resolve) => child.on('close', (code) => { run.exitCode = code; resolve(); }));
  let pending = '';
  const gotResult = new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) {
        let e; try { e = JSON.parse(line); } catch { (raw || events).write(line + '\n'); continue; }
        if (raw) raw.write(JSON.stringify({ t: Date.now(), ...e }) + '\n');
        for (const ev of codexAgent ? codexAgentEvent(e, state, { model, now: Date.now() }) : [e]) {
          events.write(JSON.stringify({ t: Date.now(), ...ev }) + '\n');
          if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'tool_use') {
            run.firstToolAt ??= Date.now();
            run.tools.push({ t: Date.now(), name: c.name });
          }
          if (ev.type === 'result') { run.result = ev; run.resultAt = Date.now(); resolve(); }
        }
      }
    });
    exited.then(resolve);
  });
  const cap = setTimeout(() => { run.timedOut = true; kill('SIGKILL'); }, (task.budgetSeconds ? task.budgetSeconds * AGENT_CAP : 600) * 1000);
  return (async () => {
    await gotResult;
    clearTimeout(cap);
    // The Stop hook can't reach a remote server: end its turn from here (a Codex agent ends its own).
    if (remote && run.result && !codexAgent) await onRemote(remoteTurnEnd(surface, `${remote.runDir}/${task.name}`)).catch((err) => { run.turnEndError = err.message; });
    await sleep(1000);
    run.atTurnEnd = await inventory(hosts);
    child.stdin.end();
    const timer = setTimeout(() => { run.killed = true; kill('SIGKILL'); }, 20000);
    await exited; clearTimeout(timer);
    await sleep(2000);
    run.afterExit = await inventory(hosts);
    // A remote server's record dir (journal, frames, elicitations) comes back next to the transcript.
    if (remote && !codexAgent) await sh('rsync', ['-a', '-e', `ssh ${remote.ssh.slice(0, -1).join(' ')}`, `${remote.host}:${remote.runDir}/${task.name}/`, `${dir}/`]).catch((err) => { run.pullError = err.message; });
    events.end();
    if (raw) raw.end();
    if (stderr) fs.writeFileSync(path.join(dir, 'stderr.txt'), stderr);
    return run;
  })();
}

// --- Reports ---

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function htmlReport(rows) {
  const parts = ['<!doctype html><meta charset="utf-8"><title>Round report</title><style>body{font-family:system-ui;background:#fff;color:#111;margin:24px}',
    'figure{margin:0 0 24px;display:inline-block}.shot{position:relative;display:inline-block;border:2px solid #ccc}.shot.bad{border-color:#d00}',
    '.shot img{display:block}.ring{position:absolute;width:24px;height:24px;margin:-12px 0 0 -12px;border:2px solid #07f;border-radius:50%}',
    '.dot{position:absolute;width:8px;height:8px;margin:-4px 0 0 -4px;background:#f80;border-radius:50%}</style>'];
  for (const { task, journal, cursor } of rows) {
    parts.push(`<h2>${escapeHtml(task.name)} (${task.browser}) — cursor ${escapeHtml(cursor.cell)}</h2>`);
    const frames = (journal || []).filter((e) => e.type === 'point' && e.frame);
    if (!frames.length) parts.push(`<p>${journal ? 'No frames.' : 'No journal.'}</p>`);
    frames.forEach((p, i) => {
      const ok = p.target && p.cursor?.visible && Math.hypot(p.cursor.x - p.target.x, p.cursor.y - p.target.y) <= 4;
      parts.push(`<figure><div class="shot${ok ? '' : ' bad'}"><img src="${escapeHtml(`${task.name}/${p.frame}`)}">`
        + (p.target ? `<span class="ring" style="left:${p.target.x}px;top:${p.target.y}px"></span>` : '')
        + (p.cursor ? `<span class="dot" style="left:${p.cursor.x}px;top:${p.cursor.y}px"></span>` : '')
        + `</div><figcaption>${i + 1}. ${escapeHtml(p.tool)} ${time(p.t)}${ok ? '' : ' (not ok)'}</figcaption></figure>`);
    });
  }
  return parts.join('\n');
}

// --- Codex surface and the user's part ---

// Codex's browser ids here: the config's, required unless --codex-browsers names them.
const defaultCodexBrowsers = (args) => (args['codex-browsers'] ? CONFIG.codexBrowsers ?? {} : setting('codexBrowsers'));

// codex-cu as the user registered it (~/.claude.json), else built from ChatGPT's bundled plugin config and our proxy
// (a Mac without the user entry). Preflight: the proxy, ChatGPT's node and a live Codex browser socket.
function loadCodex(args) {
  const home = os.homedir();
  let entry = readJson(path.join(home, '.claude.json'))?.mcpServers?.['codex-cu'];
  if (!entry) {
    const pluginDir = path.join(home, '.codex/plugins/cache/openai-bundled/unified-computer-use');
    const version = fs.existsSync(pluginDir) ? fs.readdirSync(pluginDir).sort().at(-1) : null;
    const plugin = version && readJson(path.join(pluginDir, version, '.mcp.json'))?.mcpServers?.cua_repl;
    if (plugin) entry = { command: plugin.command, args: [homePath(setting('codexProxy')), plugin.command, ...plugin.args], env: plugin.env };
  }
  const missing = !entry ? ['a codex-cu entry in ~/.claude.json or ChatGPT\'s unified-computer-use plugin']
    : [entry.command, entry.args[0], path.join(path.dirname(entry.args[0]), 'turn-ended.mjs')].filter((f) => !fs.existsSync(f));
  const sockets = fs.existsSync('/tmp/codex-browser-use') ? fs.readdirSync('/tmp/codex-browser-use').filter((f) => f.endsWith('.sock')) : [];
  if (!sockets.length) missing.push('/tmp/codex-browser-use/*.sock (is ChatGPT running with its browser extension?)');
  if (missing.length) { console.error(`--surface codex: missing ${missing.join(', ')}`); process.exit(2); }
  // `--codex-browsers auto`: no ids (another Mac), the agent finds its browser by name.
  const browsers = args['codex-browsers'] === 'auto' ? {}
    : { ...defaultCodexBrowsers(args), ...Object.fromEntries((args['codex-browsers'] || '').split(',').filter(Boolean).map((p) => p.split('='))) };
  return { entry, browsers };
}

// codex-agent: the Codex CLI and a live Codex browser socket where the browsers are, the MCP servers its config adds
// (turned off per agent) and the browser ids (as for codex, but none by default on another Mac).
async function loadCodexAgent(args) {
  const run = (command) => (remote ? onRemote(`${REMOTE_PATH}; ${command}`) : sh('sh', ['-c', command]));
  const version = await run('codex --version').catch(() => null);
  const socket = await run('ls /tmp/codex-browser-use/*.sock').then(() => true, () => false);
  if (!version || !socket) {
    console.error(`--surface codex-agent: ${!version ? 'no codex CLI' : 'no /tmp/codex-browser-use/*.sock (is ChatGPT running with its browser extension?)'}${remote ? ` on ${remote.host}` : ''}`);
    process.exit(2);
  }
  if (remote) await run(`mkdir -p ${REMOTE_CODEX_AGENT_CWD}`);
  else privateDir(CODEX_AGENT_CWD);
  const disable = codexMcpServers(await run('cat ~/.codex/config.toml').catch(() => ''));
  const given = Object.fromEntries((args['codex-browsers'] || '').split(',').filter((p) => p && p !== 'auto').map((p) => p.split('=')));
  const browsers = args['codex-browsers'] === 'auto' ? {} : remote ? given : { ...defaultCodexBrowsers(args), ...given };
  return { version: version.trim(), disable, browsers };
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const getJson = (url) => fetch(url).then((r) => r.json()).catch((err) => ({ error: err.message }));
const cua = (tool, params) => (remote ? onRemote(`${shq(homePath(setting('guiDriver'), remote.home))} call ${tool} ${shq(JSON.stringify(params))}`) : sh(homePath(setting('guiDriver')), ['call', tool, JSON.stringify(params)]))
  .then((stdout) => JSON.parse(stdout), (err) => { throw new Error(`${tool}: ${err.message}`); });

// --gui only (a test Mac under its GUI lock): once a takeover task's agent has made task.takeover.afterViews page views
// (its site log), the harness acts as the user: brings the agent's tab to the front (raw tabs.focus) and clicks into
// the page with cua-driver. Returns {at, from, to, tab} (`from`..`to`: blame nothing on agents then) or {error}.
export async function takeoverAct(task, hosts, finished) {
  const want = task.takeover.afterViews ?? 3;
  for (;;) {
    if (finished()) return { error: `the agent finished before it made ${want} page views` };
    const site = await getJson(task.site.log);
    if ((site.events || []).filter((e) => e.kind === 'view').length >= want) break;
    await sleep(300);
  }
  let from;
  const session = `fb-rounds-${process.pid}-${Date.now()}`; // a driver session label is spent once it ends
  try {
    const tab = Object.values(await inventory(hosts)).filter((t) => tagged(task.name, t.url)).sort((a, b) => b.id - a.id)[0];
    if (!tab) return { error: 'no tab of the agent on the demo site' };
    from = Date.now();
    await hosts[tab.browser].request('tabs.focus', { tabId: tab.id });
    await sleep(600);
    const windows = (await cua('list_windows', { on_screen_only: true })).windows
      .filter((w) => w.app_name === BROWSER_APP[tab.browser]).sort((a, b) => (b.z_index ?? 0) - (a.z_index ?? 0));
    const win = windows.find((w) => w.title.includes(tab.title)) ?? windows[0];
    // A pixel click is in the coordinates of the window's latest screenshot, which must be taken first. Through the HID
    // (foreground) like a person's: a click posted to the app arrives with event.timeStamp 0 (measured on a second test Mac's Chrome),
    // which dates it to the page's load.
    const shot = await cua('get_window_state', { session, pid: win.pid, window_id: win.window_id, include_accessibility_tree: false });
    const at = Date.now();
    await cua('click', { session, pid: win.pid, window_id: win.window_id, capture_id: shot.capture_id,
      x: Math.round(shot.screenshot_width / 2), y: Math.round(shot.screenshot_height * 0.6), delivery_mode: 'foreground' });
    await cua('end_session', { session }).catch(() => {});
    return { at, from, to: Date.now() + 1500, tab: keyOf(tab.browser, tab) };
  } catch (err) {
    // The tab may already be in front: that much was still the harness, not the agent.
    return { error: err.message, ...(from && { from, to: Date.now() + 1500 }) };
  }
}

function listDownloads(dir) {
  const files = {};
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try { const st = fs.statSync(path.join(dir, name)); if (st.isFile()) files[name] = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }; } catch {}
  }
  return files;
}

// --- Main ---

async function main() {
  const flags = new Set(['swap', 'keep-tabs', 'gui', 'remote-held']);
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i].slice(2);
    args[a] = flags.has(a) ? true : process.argv[++i];
  }
  if (args.remote) args.gui = true; // the round holds the remote Mac's GUI lock
  // Stopped by hand: still run the exit handlers (agents, the remote connection and its lock, the site).
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
  let tasks = JSON.parse(fs.readFileSync(args.tasks || path.join(ROOT, 'tools/agents/example.json'), 'utf8'));
  const bad = badTaskNames(tasks);
  if (bad.length) { console.error(`task names may only have letters, digits, - and _: ${bad.map((n) => JSON.stringify(n)).join(', ')}`); process.exit(2); }
  if (args.only) tasks = tasks.filter((t) => args.only.split(',').includes(t.name));
  if (args.swap) tasks = tasks.map((t) => ({ ...t, browser: t.browser === 'helium' ? 'chrome' : 'helium' }));
  if (!args.gui && tasks.some((t) => t.takeover)) {
    console.log(`skipped (they need --gui on a test Mac): ${tasks.filter((t) => t.takeover).map((t) => t.name).join(', ')}`);
    tasks = tasks.filter((t) => !t.takeover);
  }
  const surface = args.surface || 'fowlbrowser';
  const surfaces = ['fowlbrowser', 'codex', 'codex-agent', 'devtools'];
  if (!surfaces.includes(surface)) { console.error(`--surface ${surface}: use ${surfaces.join(', ')}`); process.exit(2); }
  for (const t of tasks) if (t.surface && !surfaces.includes(t.surface)) { console.error(`${t.name}: surface ${t.surface}: use ${surfaces.join(', ')}`); process.exit(2); }
  const surfaceOf = (t) => t.surface ?? surface;
  const anySurface = (name) => tasks.some((t) => surfaceOf(t) === name);
  // Config values the agents' setup needs, before anything starts.
  if (anySurface('devtools')) setting('devtools');
  if (tasks.some((t) => t.takeover)) setting('guiDriver');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const graded = tasks.flatMap((t) => [t.grade, t.site?.log].filter(Boolean)).map((u) => new URL(u));
  if (args.remote) await openRemote(args.remote, { owner: args['remote-owner'] || 'fb-rounds', ports: [...new Set(graded.map((u) => u.port))], stamp, held: args['remote-held'], surface });
  const codex = anySurface('codex') ? (remote ? await loadRemoteCodex(args) : loadCodex(args)) : null;
  const codexAgent = anySurface('codex-agent') ? await loadCodexAgent(args) : null;
  // A Codex agent runs a Codex model, the others Claude.
  const modelOf = (t) => args.model || (surfaceOf(t) === 'codex-agent' ? 'gpt-6.1-sol' : 'opus');
  const model = modelOf({});
  const effort = args.effort || 'medium';
  const mcpRoot = args.mcp === 'installed' ? path.join(os.homedir(), 'Library/Application Support/FowlBrowser') : ROOT;
  const out = path.resolve(args.out || fs.mkdtempSync(path.join(os.tmpdir(), `fb-rounds-${stamp}-`)));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'settings.json'), JSON.stringify(roundSettings(anySurface('codex') ? 'codex' : 'fowlbrowser', { mcpRoot, codex }), null, 2));

  // --serve: the sites the tasks grade against (forms.json, codex-h2h.json), up before the agents and killed after grading.
  let server = null;
  if (args.serve) {
    const log = fs.openSync(path.join(out, 'serve.log'), 'a');
    // Remote: the site runs in the test bed there (its browsers load it), until this ssh closes its stdin.
    server = remote ? spawn('ssh', [...remote.ssh, `${REMOTE_PATH}; cd ${shq(remote.bed)} && { ${args.serve} & S=$!; cat >/dev/null; kill $S; }`], { stdio: ['pipe', log, log] })
      : spawn('sh', ['-c', `exec ${args.serve}`], { cwd: ROOT, stdio: ['ignore', log, log] });
    process.on('exit', () => server.kill());
    for (const origin of new Set(graded.map((u) => u.origin))) {
      for (let i = 0; ; i++) {
        if (await fetch(origin).then(() => true, () => false)) break;
        if (i === 50) throw new Error(`--serve: ${origin} did not answer within 10 s (see ${out}/serve.log)`);
        await sleep(200);
      }
    }
  }

  // Only browsers with FowlBrowser connected are watched; a task in one that isn't stops the round before it starts.
  const hosts = Object.fromEntries((await Promise.all(BROWSERS.map(async (b) => [b, await connectHost(b).catch(() => null)]))).filter(([, host]) => host));
  const missing = [...new Set(tasks.map((t) => t.browser))].filter((b) => !hosts[b]);
  if (missing.length) {
    console.error(`Not connected: ${missing.join(', ')} (no FowlBrowser socket in ${remote ? `${remote.host}:~/.fowlbrowser` : SOCKET_DIR}). Open the browser with the extension loaded, ` +
      'or pick tasks with --only, or move them to the other browser with --swap.');
    process.exit(2);
  }
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const downloadsBefore = remote ? {} : listDownloads(downloadsDir);
  const roundStart = Date.now();
  const start = await inventory(hosts);
  const startKeys = new Set(Object.keys(start));
  const monitor = await startMonitor(hosts, path.join(out, 'monitor.jsonl'));
  console.log(`round of ${tasks.length} agents (${surface}, ${model}, ${effort}${surface === 'fowlbrowser' ? `, mcp ${args.mcp || 'repo'}` : ''}${codexAgent ? `, ${codexAgent.version}` : ''}); output in ${out}`);
  const acts = new Array(tasks.length).fill(null);
  const runs = await Promise.all(tasks.map(async (task, i) => {
    let done = false;
    const act = task.takeover && takeoverAct(task, hosts, () => done).then((a) => { acts[i] = a; console.log(`${task.name}: ${a.error ? `takeover act failed: ${a.error}` : `took ${a.tab} over at ${time(a.at)}`}`); });
    const run = await runAgent(task, out, { model: modelOf(task), effort, mcpRoot, hosts, surface: surfaceOf(task), codex: surfaceOf(task) === 'codex-agent' ? codexAgent : codex });
    done = true; await act;
    console.log(`${task.name} finished in ${((Date.now() - run.started) / 1000).toFixed(0)} s`);
    return run;
  }));
  await monitor.stop();
  const end = await inventory(hosts);
  const grades = await Promise.all(tasks.map((t) => t.grade && getJson(t.grade)));
  const sites = await Promise.all(tasks.map((t) => t.site && getJson(t.site.log)));
  sites.forEach((site, i) => site && fs.writeFileSync(path.join(out, tasks[i].name, 'site.json'), JSON.stringify(site, null, 1)));
  server?.stdin?.end();
  server?.kill();

  // Grade
  const journals = tasks.map((t) => readJsonl(path.join(out, t.name, 'journal.jsonl')));
  const transcripts = tasks.map((t) => parseTranscript(readJsonl(path.join(out, t.name, 'events.jsonl')) || []));
  const elicitations = tasks.map((t, i) => elicitationsOf(readJsonl(path.join(out, t.name, 'elicitations.jsonl')) || [], transcripts[i].calls));
  // Codex keeps no journal: its downloads are the new files in ~/Downloads whose names its transcript mentions.
  if (tasks.some((t) => isCodex(surfaceOf(t))) && !remote) {
    const fresh = downloadsDiff(downloadsBefore, listDownloads(downloadsDir), downloadsDir);
    tasks.forEach((t, i) => {
      if (!isCodex(surfaceOf(t))) return;
      const text = fs.readFileSync(path.join(out, t.name, 'events.jsonl'), 'utf8');
      journals[i] = fresh.filter((d) => text.includes(path.basename(d.path)));
    });
  }
  runs.forEach((run, i) => { run.tabs = agentTabs(tasks[i].name, journals[i], monitor.log, surfaceOf(tasks[i]) === 'devtools' ? tasks[i].tabMatch : null); });
  const owners = new Map(runs.flatMap((run) => [...run.tabs].map((k) => [k, run.name])));
  const calls = tasks.flatMap((t, i) => (isCodex(surfaceOf(t)) ? transcripts[i].focusCalls.map((c) => ({ ...c, agent: t.name }))
    : (journals[i] || []).filter((e) => e.type === 'call').map((e) => ({ ...e, agent: t.name }))));
  const closedAt = new Map([...monitor.log.filter((e) => e.kind === 'tab' && e.event === 'gone' && owners.has(e.tab)).map((e) => [e.tab, e.t]),
    ...journals.flatMap((journal) => (journal || []).filter((e) => e.type === 'tab' && e.event === 'close').map((e) => [e.tab, e.t]))]);
  // While the harness acted as the user (takeover tasks), nothing is blamed on an agent.
  const userActs = acts.filter((a) => a?.from);
  const acting = (t) => userActs.some((a) => t >= a.from && t <= a.to);
  const allFocus = focusEvents(monitor.log, owners, calls, closedAt).map((e) => (acting(e.t) ? { ...e, blame: false, text: `${e.text} (the harness acting as the user)` } : e));
  const focus = allFocus.filter((e) => e.blame);
  const flashes = activityFlashes(monitor.log, owners, userActs);
  const sound = soundEvents(monitor.log, owners);
  const problems = [];
  const rows = tasks.map((task, i) => {
    const run = runs[i]; const journal = journals[i]; const site = sites[i]; const mySurface = surfaceOf(task);
    const controlled = controlledBy(mySurface, task.name);
    const outcome = gradeOutcome({ task, run, journal, after: run.afterExit, startKeys, grade: grades[i], controlled });
    const cursor = mySurface !== 'fowlbrowser' ? { ok: true, cell: 'n/a', problems: [] } : gradeCursor({ task, journal });
    const checks = Object.entries({
      site: gradeSite({ task, site }),
      handoff: gradeHandoff({ task, surface: mySurface, journal, site, afterExit: run.afterExit }),
      takeover: gradeTakeover({ task, act: acts[i], site }),
      viewport: gradeViewport({ task, journal, site, turnEndAt: run.resultAt }),
      numbers: gradeNumbers({ task, run }),
    }).flatMap(([column, { problems: list }]) => list.map((p) => `${column} · ${p}`));
    const myFocus = focus.filter((e) => e.owner === task.name);
    const myFlashes = flashes.flashes.filter((e) => e.owner === task.name);
    const mySound = sound.filter((e) => e.owner === task.name);
    const tabs = gradeTabs({ task, tabs: run.tabs, atTurnEnd: run.atTurnEnd, afterExit: run.afterExit, startKeys, controlled });
    const timing = gradeTime({ task, run, journal });
    const tokens = gradeTokens(run);
    const callCell = gradeCalls(transcripts[i], elicitations[i]);
    const toolAt = (t) => { const call = transcripts[i].calls.filter((c) => c.t <= t).pop(); return call ? `, last tool ${call.name.split('__').pop()}` : ''; };
    for (const p of outcome.problems) problems.push(`${task.name} · outcome · ${p}`);
    for (const p of checks) problems.push(`${task.name} · ${p}`);
    for (const p of cursor.problems) problems.push(`${task.name} · cursor · ${p}`);
    for (const e of myFocus) problems.push(`${task.name} · focus · ${e.text}${toolAt(e.t)}`);
    for (const e of myFlashes) problems.push(`${task.name} · flash · ${e.text}${toolAt(e.t)}`);
    for (const e of mySound) problems.push(`${task.name} · sound · ${e.text}${toolAt(e.t)}`);
    for (const p of tabs.problems) problems.push(`${task.name} · tabs · ${p}`);
    for (const p of timing.problems) problems.push(`${task.name} · time · ${p}`);
    for (const p of callCell.problems) problems.push(`${task.name} · calls · ${p}`);
    for (const p of [run.turnEndError && `turn end on ${remote.host} failed: ${run.turnEndError}`, run.pullError && `could not pull its record dir: ${run.pullError}`].filter(Boolean)) problems.push(`${task.name} · remote · ${p}`);
    return { task, surface: mySurface, journal, outcome, checks, cursor, focus: myFocus, flashes: myFlashes, sound: mySound, tabs, timing, tokens, calls: callCell };
  });
  const touched = new Set([...journals.flatMap((journal) => (journal || []).map((e) => e.tab).filter(Boolean)),
    ...tasks.flatMap((t, i) => (isCodex(surfaceOf(t)) ? transcripts[i].tabRefs.map((id) => `${t.browser}:${id}`) : surfaceOf(t) === 'devtools' ? [...runs[i].tabs] : []))]);
  const userTabs = userTabChanges(start, end, touched, monitor.log);
  for (const c of userTabs.changes) problems.push(`round · the user's tabs · ${c}`);
  for (const e of focus.filter((e) => e.owner === 'round')) problems.push(`round · focus · ${e.text}`);
  for (const p of monitorProblems(monitor.log, monitor.ticks)) problems.push(`round · monitor · ${p}`);

  // Cleanup before the report, so its failures count: tabs this round's agents created and left for the user, then this
  // round's downloads in ~/Downloads, then a final inventory. FowlBrowser's journals name the tabs its agents opened;
  // for Codex, the tabs its transcript proves it created (codexCreatedTabs). Other new tabs seen in an agent's group or on
  // its demo pages may be the user's: left open and reported.
  // DevTools agents' tabs (tagged pages, or tabMatch) are nobody's: closed like the rest.
  const created = new Set(tasks.flatMap((t, i) => (isCodex(surfaceOf(t)) ? [...codexCreatedTabs({ browser: t.browser, transcript: transcripts[i], startKeys })]
    : surfaceOf(t) === 'devtools' ? [...runs[i].tabs].filter((k) => !startKeys.has(k)) : [...createdTabs([journals[i]], startKeys)])));
  if (!args['keep-tabs']) {
    const now = await inventory(hosts);
    for (const [i, run] of runs.entries()) {
      if (!isCodex(surfaceOf(tasks[i]))) continue;
      for (const k of run.tabs) if (now[k] && !startKeys.has(k) && !created.has(k)) problems.push(`round · teardown · left open, not proven ${tasks[i].name}'s: ${k} ${now[k].url}`);
    }
    for (const k of created) {
      if (!now[k] || now[k].owner) continue;
      try { await hosts[now[k].browser].request('tabs.closeUnowned', { tabId: now[k].id }); console.log(`closed ${k} ${now[k].url}`); }
      catch (err) { problems.push(`round · teardown · could not close ${k}: ${err.message}`); }
    }
  }
  for (const e of keptChildren(journals)) console.log(`left open (may be the user's): ${e.tab} ${e.url}`);
  // Remote downloads are on the other Mac: never deleted from here.
  const { remove, skip } = downloadsToDelete(remote ? [] : journals, { downloadsDir, roundStart,
    stat: (file) => { try { return fs.statSync(file); } catch { return null; } } });
  for (const { path: file, why } of skip) console.log(`kept ${file}: ${why}`);
  for (const file of remove) {
    try { fs.rmSync(file); console.log(`deleted ${file}`); }
    catch (err) { problems.push(`round · teardown · could not delete ${file}: ${err.message}`); }
  }
  if (!args['keep-tabs']) {
    const final = await inventory(hosts).catch((err) => { problems.push(`round · teardown · final inventory failed: ${err.message}`); return {}; });
    for (const k of created) if (final[k]) problems.push(`round · teardown · still open after cleanup: ${k} ${final[k].url}${final[k].owner ? ' (controlled)' : ''}`);
  }

  for (const host of Object.values(hosts)) host.close();
  if (remote) for (const p of await remote.close()) problems.push(`round · remote · ${p}`);

  const cell = (events) => (events.length ? `FAIL: ${events.length}` : 'ok');
  const lines = ['| agent | surface | browser | outcome | checks | cursor | focus | flashes | sound | tabs | time | calls | tokens | $ |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    lines.push(`| ${r.task.name} | ${r.surface} | ${r.task.browser} | ${r.outcome.cell} | ${cell(r.checks)} | ${r.cursor.cell} | ${cell(r.focus)} | ${cell(r.flashes)} | ${cell(r.sound)} | ${r.tabs.cell} | ${r.timing.cell} | ${r.calls.cell} | ${r.tokens.cell} | ${r.tokens.cost.toFixed(3)} |`);
  }
  lines.push('', problems.length ? `ROUND NOT CLEAN: ${problems.length} problems` : 'ROUND CLEAN', '', ...problems.map((p) => `- ${p}`));
  const notCounted = [...allFocus.filter((e) => !e.blame), ...flashes.notCounted, ...sound.filter((e) => e.owner === 'user')].sort((a, b) => a.t - b.t);
  if (notCounted.length || userTabs.browsing.length) {
    lines.push('', 'Not counted, no agent caused it (the user using their Mac):', ...notCounted.map((e) => `- ${e.text}`), ...userTabs.browsing.map((c) => `- their tab ${c}`));
  }
  const allElicitations = elicitations.flatMap((list, i) => list.map((e) => `- ${tasks[i].name}: ${time(e.t)} "${e.text}" -> ${e.action}${e.code ? ` (during: ${e.code})` : ''}`));
  if (allElicitations.length) lines.push('', 'Elicitations (MCP prompts to the user):', ...allElicitations);
  lines.push('', 'Answers:');
  for (const [i, run] of runs.entries()) {
    const answer = String(run.result?.result ?? '').split('\n').filter((l) => l.includes('RESULT:')).pop() ?? '(none)';
    lines.push(`- ${tasks[i].name}: ${answer.trim()}`);
  }
  const report = lines.join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'report.md'), report);
  fs.writeFileSync(path.join(out, 'report.html'), htmlReport(rows));
  console.log('\n' + report);
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.main) await main().catch((err) => { if (!err.setting) throw err; console.error(err.message); process.exit(2); });
