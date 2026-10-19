// Shared harness: MCP client for the FowlBrowser server, scenario context, job pool and result table.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HostClient, SOCKET_DIR } from '../mcp/src/hostClient.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
// FOWLBROWSER_TEST_PORT moves the test site (and its second origin, one port up) so checkouts can test side by side.
const PORT = Number(process.env.FOWLBROWSER_TEST_PORT) || 5411;
export const SITE = `http://127.0.0.1:${PORT}`;
export const CROSS = `http://localhost:${PORT + 1}`;
const BROWSERS = ['chrome', 'helium'];

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseArgs(argv, defaults) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export const browsersFrom = arg => (arg === 'both' ? BROWSERS : [arg]);

// ---- MCP server connection ----

export class ToolError extends Error {}

export const MCP_BIN = process.env.FOWLBROWSER_MCP || `${ROOT}mcp/bin/fowlbrowser-mcp`;

// env: extra variables for this server, e.g. FOWLBROWSER_RECORD for a scenario that runs its own recording server.
// command and args start it another way. ownTurns: the server runs under its own sh, which stays its parent (the
// trailing ':' keeps sh from exec'ing it), so server.endTurn() can end this server's turn alone. Never end the shared
// e2e server's turn: it closes every job's tabs.
export async function connect(label, { ownTurns = false, env = {}, command = MCP_BIN, args = [] } = {}) {
  if (ownTurns) [command, args] = ['/bin/sh', ['-c', `'${command}'; :`]];
  const transport = new StdioClientTransport({
    command, args, stderr: 'pipe',
    env: { ...process.env, FOWLBROWSER_LABEL: label, ...env },
  });
  let stderr = '';
  transport.stderr?.on('data', d => { stderr = (stderr + d).slice(-20000); });
  const client = new Client({ name: 'fowlbrowser-e2e', version: '0.1.0' });
  await client.connect(transport).catch(e => { throw new Error(`${e.message}; server stderr: ${stderr.slice(-1500)}`); });
  const server = {
    // opened: tabs a running job holds now; everOpened: every tab any job of this server tracked.
    label, client, opened: new Set(), everOpened: new Set(),
    stderr: () => stderr,
    async call(name, args = {}, timeout = 90_000) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
      const text = (res.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const images = (res.content || []).filter(c => c.type === 'image');
      if (res.isError) throw new ToolError(`${name} failed: ${text.slice(0, 400)}`);
      return { text, images, structured: res.structuredContent, raw: res };
    },
    close: () => client.close(),
    // The turn-end hook's message to this server (ownTurns only); resolves to its JSON reply.
    endTurn: () => new Promise((resolve, reject) => {
      let reply = '';
      // Where the server listens (mcp/src/turns.mjs turnSocketPath): the FowlBrowser folder, the temp folder only for a long path.
      const turns = path.join(SOCKET_DIR, 'turns', `${transport.pid}.sock`);
      const fallback = path.join(os.tmpdir(), `fowlbrowser-turn-${transport.pid}.sock`);
      const socket = net.connect(Buffer.byteLength(turns) < 104 ? turns : fallback, () => socket.write('turn_ended\n'));
      socket.on('data', (chunk) => { reply += chunk; });
      socket.on('end', () => { try { resolve(JSON.parse(reply)); } catch (e) { reject(e); } });
      socket.on('error', reject);
    }),
  };
  return server;
}

// A raw host connection to a browser (as another client of the extension): tabs.listAll with every field
// (windowId, kept, handedOver, parked, owner as seen by this client), tabs.focus. Close it when done.
export async function rawHost(browser, label = 'e2e-raw') {
  const host = new HostClient(path.join(SOCKET_DIR, `${browser}.sock`));
  await host.connect(label);
  return host;
}

// ---- parsing tool output ----

// Pulls a JSON value out of tool text: the whole text, a fenced block, or the text after a "Result" heading.
export function parseJSON(text) {
  const tries = [text, /```(?:json)?\n([\s\S]*?)```/.exec(text)?.[1], /^Result:?\s*\n([\s\S]*)$/m.exec(text)?.[1]];
  for (const t of tries) {
    if (t == null) continue;
    try { return JSON.parse(t.trim()); } catch {}
  }
  return undefined;
}

export function tabIdsIn(text, browser) {
  const re = browser ? new RegExp(`\\b${browser}:\\d+\\b`, 'g') : /\b[a-z]+:\d+\b/g;
  return [...new Set(text.match(re) || [])].filter(id => !/^(https?|file|about|data):/.test(id));
}

// Parses tab_list text lines `- chrome:52 · Title · https://url · owner: you (agent tab) · active, muted`
// into [{tab, title, url, owner: "you"|"other"|null, active, muted, group, parked: "handoff"|"takeover"|null}].
export function parseTabs(res) {
  if (!/^Browser: /m.test(res.text) && !/No browsers connected/.test(res.text)) throw new Error(`cannot parse tab_list output: ${res.text.slice(0, 300)}`);
  const tabs = [];
  for (const line of res.text.split('\n')) {
    const m = /^- ([a-z0-9-]+:\d+) · (.*)$/.exec(line);
    if (!m) continue;
    const parts = m[2].split(' · ');
    const o = parts.findIndex(p => p.startsWith('owner: '));
    const ownerText = parts[o].slice(7);
    const flags = parts.slice(o + 1).join(' · ');
    tabs.push({
      tab: m[1],
      title: parts.slice(0, o - 1).join(' · '),
      url: parts[o - 1],
      owner: ownerText.startsWith('you') ? 'you' : ownerText.startsWith('another') ? 'other' : null,
      active: /\bactive\b/.test(flags),
      muted: /\bmuted\b/.test(flags),
      audible: /playing audio/.test(flags),
      group: /group "([^"]*)"/.exec(flags)?.[1] ?? null,
      parked: /; handed to the user\)$/.test(ownerText) ? 'handoff' : /; taken over by the user\)$/.test(ownerText) ? 'takeover' : null,
    });
  }
  return tabs;
}

// Finds a ref in an aria snapshot: `- role "name" ... [ref=e12]` or, for roles named by content,
// `- listitem [ref=e7]: Item 5`. name may be a string (exact) or RegExp.
export function findRefs(snapshot, role, name) {
  const roles = [].concat(role);
  const out = [];
  for (const line of snapshot.split('\n')) {
    const m = /^\s*-\s+([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*?\[ref=([\w-]+)\][^:]*(?::\s*(.*))?$/.exec(line);
    if (!m || !roles.includes(m[1])) continue;
    const label = m[2] != null ? m[2].replace(/\\(.)/g, '$1') : (m[4] || '').replace(/^"|"$/g, '');
    if (name == null || (name instanceof RegExp ? name.test(label) : label === name)) out.push(m[3]);
  }
  return out;
}

// ---- scenario context ----

export class AssertionError extends Error {}

export function makeContext({ server, browser, tag }) {
  const tabs = new Set();
  const t = {
    browser, tag, site: SITE, cross: CROSS, server, tabs, stepName: 'start',
    step(name) { t.stepName = name; },
    call: (name, args, timeout) => server.call(name, args, timeout),

    async open(url, extra = {}) {
      const res = await server.call('tab_open', { browser, url, ...extra }).catch((e) => {
        // Opened, then failed (its page never loaded): the tab is this job's all the same, to close and not to be taken
        // by a sibling job's ownership check for another session's.
        const opened = /\bTab ([a-z0-9-]+:\d+) was opened and is controlled by this session/.exec(e.message)?.[1];
        if (opened) t.track(opened);
        throw e;
      });
      // The result's own header first: notices about other tabs may come before it (a let-go tab's once made export
      // drive the security job's tab).
      const tab = res.structured?.tab ?? res.structured?.id ?? /^Browser: .*? · Tab: ([a-z0-9-]+:\d+)\b/m.exec(res.text)?.[1] ?? tabIdsIn(res.text, browser)[0];
      if (!tab) throw new Error(`tab_open returned no tab id: ${res.text.slice(0, 300)}`);
      t.track(tab);
      return tab;
    },
    track(tab) { tabs.add(tab); server.opened.add(tab); server.everOpened.add(tab); },
    closed: new Set(),
    async close(tab) { await server.call('tab_close', { tab }); t.closed.add(tab); },

    // A stand-in for one of the user's own tabs: opened through the extension directly (never attached, not grouped,
    // not muted), then let go, so nobody owns it. Closed by cleanup with the confirm flag.
    userTabs: new Set(),
    async userTab(url) {
      const host = await rawHost(browser, `user-${tag}`);
      try {
        const tab = await host.request('tabs.open', { url, forUser: true });
        await host.request('tabs.release', { tabId: tab.id });
        t.userTabs.add(`${browser}:${tab.id}`);
        server.everOpened.add(`${browser}:${tab.id}`); // a scenario may claim it; sibling jobs' ownership checks must not flag it
        return `${browser}:${tab.id}`;
      } finally {
        host.close();
      }
    },
    async listAll() { return parseTabs(await server.call('tab_list', { browser, scope: 'all' })); },
    // A raw host connection of the scenario's own (never this server's): tabs.listAll with windowId, index, kept and
    // handedOver, and tabs.focus for a witness tab. Closed by cleanup.
    async host() {
      t._host ??= (async () => {
        const host = new HostClient(path.join(SOCKET_DIR, `${browser}.sock`));
        await host.connect(`raw-${tag}`);
        return host;
      })();
      return t._host;
    },

    async snapshot(tab, ref) {
      return (await server.call('snapshot', ref ? { tab, ref } : { tab })).text;
    },
    ref(snapshot, role, name, nth = 0) {
      const refs = findRefs(snapshot, role, name);
      if (refs.length <= nth) throw new AssertionError(`no ${[].concat(role).join('/')} "${name}" (#${nth}) in snapshot:\n${snapshot.slice(0, 1500)}`);
      return refs[nth];
    },
    async refOf(tab, role, name, nth = 0) { return t.ref(await t.snapshot(tab), role, name, nth); },

    // Evaluate only to read state. The page function's value is JSON-encoded so it survives any output format.
    async eval(tab, fn) {
      const res = await server.call('evaluate', { tab, function: `() => JSON.stringify((${fn})())` });
      let v = res.structured?.result ?? parseJSON(res.text);
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
      if (v === undefined) throw new Error(`cannot parse evaluate output: ${res.text.slice(0, 300)}`);
      return v;
    },
    resultOf(tab) { return t.eval(tab, `() => { const t = document.querySelector('#result')?.textContent ?? ''; try { return JSON.parse(t); } catch { return t; } }`); },

    async listMine() { return parseTabs(await server.call('tab_list', { browser, scope: 'mine' })); },

    ok(cond, msg) { if (!cond) throw new AssertionError(msg); },
    eq(actual, expected, msg) {
      if (!isDeepStrictEqual(actual, expected)) throw new AssertionError(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    },
    // Polls fn until it returns truthy; the last value or error is reported on timeout.
    async until(fn, msg, timeout = 8000) {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e.message; }
        await sleep(250);
      }
      throw new AssertionError(`${msg} (timed out, last: ${typeof last === 'string' ? last : JSON.stringify(last)})`);
    },

    async cleanup() {
      for (const tab of tabs) {
        // The test's own tabs; some were handed over to the user on purpose, which tab_close only closes with the flag.
        if (!t.closed.has(tab)) try { await server.call('tab_close', { tab, confirm_close_users_tab: true }); } catch {}
        server.opened.delete(tab);
      }
      for (const tab of t.userTabs) {
        if (!t.closed.has(tab)) try { await server.call('tab_close', { tab, confirm_close_users_tab: true }); } catch {}
      }
      if (t._host) (await t._host.catch(() => null))?.close();
    },
  };
  return t;
}

// ---- scenarios and jobs ----

export async function loadScenarios(only) {
  const dir = new URL('./scenarios/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.mjs')).sort();
  const all = [];
  for (const f of files) all.push((await import(new URL(f, dir))).default);
  const wanted = only ? String(only).split(',') : null;
  return wanted ? all.filter(s => wanted.includes(s.name)) : all;
}

let tagCounter = 0;

// On a shared server a sibling job's tab is this server's before the call that opened it returns (tab_open, an action's
// popup), and the job tracks it only then: a slow page (a load running to its 30 s timeout) makes that long. Of `tabs`,
// the ones no job has tracked within the time such a call can take: opened by no job.
const SIBLING_GRACE_MS = 75_000;
async function untracked(server, tabs) {
  let left = tabs.filter(tab => !server.everOpened.has(tab));
  for (const end = Date.now() + SIBLING_GRACE_MS; left.length && Date.now() < end;) {
    await sleep(250);
    left = left.filter(tab => !server.everOpened.has(tab));
  }
  return left;
}

// Runs one scenario in one browser on its own tabs, then checks it only saw its own tabs and closes them.
// Tabs this server controls that no job opened (untracked); they are closed and remembered as seen.
async function foreignTabs(server, t) {
  const foreign = await untracked(server, (await t.listMine()).map(x => x.tab));
  for (const tab of foreign) {
    server.everOpened.add(tab);
    await server.call('tab_close', { tab, confirm_close_users_tab: true }).catch(() => {});
  }
  return foreign;
}

// ownServer: the scenario runs on a server of its own, so what it does to its session (notices about tabs FowlBrowser let
// go start the session's next results) never shows in another job's results.
export async function runJob(shared, scenario, browser) {
  const tag = `${scenario.name}-${browser}-${process.pid}-${++tagCounter}`;
  const started = Date.now();
  const own = scenario.ownServer ? await connect(`e2e-${tag}`).catch((e) => e) : null;
  if (own instanceof Error) return { scenario: scenario.name, browser, ok: false, ms: Date.now() - started, error: `[start] ${own.message}` };
  const server = own ?? shared;
  const t = makeContext({ server, browser, tag });
  let error = null;
  try {
    await scenario.run(t);
    t.step('ownership check');
    const mine = (await t.listMine()).map(x => x.tab);
    for (const tab of t.tabs) {
      // Tabs the scenario already closed itself are fine to be missing.
      if (!mine.includes(tab) && !t.closed?.has(tab)) throw new AssertionError(`own tab ${tab} missing from tab_list mine`);
    }
    const foreign = await untracked(server, mine);
    if (foreign.length) throw new AssertionError(`tab_list mine shows tabs this server never opened: ${foreign.join(', ')}`);
  } catch (e) {
    error = `[${t.stepName}] ${e.message}`;
    // A scenario that fails midway can leave a tab its own action opened (an adopted popup) that it never tracked. It is
    // this job's: closed and counted here, so it doesn't fail every later scenario's ownership check.
    const strays = await foreignTabs(server, t).catch(() => []);
    if (strays.length) error += ` (it left ${strays.join(', ')}, closed now)`;
  }
  await t.cleanup();
  await own?.close();
  return { scenario: scenario.name, browser, ok: !error, ms: Date.now() - started, error };
}

// Tabs that carry this process's run tags in their URL but nobody owns: a failed popup adoption leaks these.
// Reports and closes them (without claiming, so they never wake up).
export async function sweepLeaks(server, browsers) {
  const marker = `-${process.pid}-`;
  const leaked = [];
  for (const browser of browsers) {
    const all = parseTabs(await server.call('tab_list', { browser, scope: 'all' }));
    for (const x of all.filter(x => x.owner === null && x.url.includes(marker))) {
      leaked.push(`${x.tab} ${x.url}`);
      // Unowned tabs count as the user's, so closing one needs the explicit flag.
      await server.call('tab_close', { tab: x.tab, confirm_close_users_tab: true }).catch(() => {});
    }
  }
  return leaked;
}

export async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, limit) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
  return results;
}

export function printTable(rows, title) {
  if (title) console.log(`\n${title}`);
  const cells = rows.map(r => [r.scenario, r.browser, r.ok ? 'pass' : 'FAIL', `${(r.ms / 1000).toFixed(1)}s`, r.error ? r.error.replace(/\s+/g, ' ').slice(0, 220) : '']);
  const head = ['scenario', 'browser', 'result', 'time', 'failure'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(c => (i < 4 ? c[i].length : 0))));
  const line = c => c.map((v, i) => (i < 4 ? v.padEnd(widths[i]) : v)).join('  ');
  console.log(line(head));
  console.log(line(widths.map(w => '-'.repeat(w))));
  for (const c of cells) console.log(line(c));
  const passed = rows.filter(r => r.ok).length;
  console.log(`${passed}/${rows.length} passed`);
}

// ---- test site ----

// Starts test/serve.mjs unless the site is already up. Returns a stop function.
export async function ensureSite() {
  const up = async () => { try { return (await fetch(`${SITE}/index.html`)).ok; } catch { return false; } };
  if (await up()) return () => {};
  const child = spawn(process.execPath, [`${ROOT}test/serve.mjs`], { stdio: 'ignore' });
  for (let i = 0; i < 40 && !(await up()); i++) await sleep(100);
  if (!(await up())) throw new Error(`test site did not start on :${PORT}`);
  return () => child.kill();
}
