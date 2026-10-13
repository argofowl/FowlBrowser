// Runs real Claude agents (claude -p) against FowlBrowser in parallel and checks that they don't step on each other.
//   node tools/agent-stress.mjs --tasks tools/agents/tasks.json [--dir /tmp/fb-stress] [--concurrency 10] [--only name,name] [--out folder]
// Each agent gets its own MCP server process (like separate Claude sessions). A task with "subagents": true lets one
// agent spawn Agent-tool subagents that share its server. Before and after the run it records every tab nobody owns
// (the "user's" tabs) and fails if any of them changed, and it fails if any agent tab is left open.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = args.dir || path.join(os.homedir(), '.fowlbrowser');
const CONCURRENCY = Number(args.concurrency || 10);
let tasks = JSON.parse(fs.readFileSync(args.tasks || path.join(ROOT, 'tools/agents/tasks.json'), 'utf8'));
// Task names become file paths.
const bad = tasks.map((t) => t.name).filter((name) => !/^[A-Za-z0-9_-]+$/.test(name ?? ''));
if (bad.length) { console.error(`task names may only have letters, digits, - and _: ${bad.map((n) => JSON.stringify(n)).join(', ')}`); process.exit(2); }
if (args.only) tasks = tasks.filter((t) => String(args.only).split(',').includes(t.name));
// A new private folder unless one is given: in a shared temp folder another account could plant the MCP configs.
const OUT = args.out ? path.resolve(args.out) : fs.mkdtempSync(path.join(os.tmpdir(), `fb-agents-${Date.now()}-`));
fs.mkdirSync(OUT, { recursive: true });

// --- Direct socket client, for the before/after tab inventory ---

async function listTabs(browser) {
  const socket = net.connect(path.join(DIR, `${browser}.sock`));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const send = (m) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); socket.write(Buffer.concat([h, b])); };
  let buffer = Buffer.alloc(0);
  const reply = new Promise((resolve) => socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const n = buffer.readUInt32LE(0); const m = JSON.parse(buffer.subarray(4, 4 + n)); buffer = buffer.subarray(4 + n);
      if (m.id === 1) resolve(m.result);
    }
  }));
  send({ method: 'host.auth', params: { token: fs.readFileSync(path.join(DIR, 'token'), 'utf8').trim() } });
  send({ id: 1, method: 'tabs.listAll', params: {} });
  const tabs = await reply;
  socket.end();
  return tabs;
}

const browsers = [...new Set(tasks.map((t) => t.browser).filter((b) => b !== 'both'))];
if (tasks.some((t) => t.browser === 'both')) for (const b of ['chrome', 'helium']) if (!browsers.includes(b)) browsers.push(b);
const userState = async () => Object.fromEntries(await Promise.all(browsers.map(async (b) => [b,
  (await listTabs(b)).filter((t) => !t.owner).map((t) => `${t.id}|${t.url}|${t.active}`).sort()])));

// --- One agent ---

function runAgent(task) {
  const config = path.join(OUT, `${task.name}.mcp.json`);
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { fowlbrowser: {
    command: path.join(ROOT, 'mcp/bin/fowlbrowser-mcp'),
    env: { FOWLBROWSER_DIR: DIR, FOWLBROWSER_LABEL: `🧪 ${task.name}` },
  } } }));
  const allowed = task.subagents ? 'mcp__fowlbrowser,Agent' : 'mcp__fowlbrowser';
  const prompt = `${task.prompt}\n\nUse only the fowlbrowser tools for the browser work. Close every tab you open before you finish. End your answer with one line starting with RESULT: that states the requested facts.`;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('claude', ['-p', '--model', task.model || 'haiku', '--strict-mcp-config', '--mcp-config', config,
      '--allowedTools', allowed, '--disallowedTools', 'Bash,WebFetch,WebSearch,Read,Write,Edit', '--max-turns', String(task.maxTurns || 60),
      '--output-format', 'json', prompt], { cwd: OUT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      fs.writeFileSync(path.join(OUT, `${task.name}.json`), stdout || stderr);
      let out = {};
      try { out = JSON.parse(stdout); } catch {}
      const text = String(out.result ?? stderr ?? '');
      const result = text.split('\n').filter((l) => l.includes('RESULT:')).pop() ?? text.slice(-300);
      const pass = code === 0 && !out.is_error && (task.expect || []).every((e) => new RegExp(e, 'i').test(text));
      resolve({ name: task.name, browser: task.browser, model: task.model || 'haiku', pass, seconds: ((Date.now() - started) / 1000).toFixed(0),
        turns: out.num_turns ?? '?', cost: out.total_cost_usd?.toFixed(3) ?? '?', result: result.replace(/\s+/g, ' ').slice(0, 160) });
    });
  });
}

async function pool(items, limit, fn) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i]); }
  }));
  return results;
}

const before = await userState();
console.log(`running ${tasks.length} agents, ${CONCURRENCY} at a time; transcripts in ${OUT}`);
const t0 = Date.now();
const results = await pool(tasks, CONCURRENCY, async (task) => {
  const r = await runAgent(task);
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.name} (${r.browser}, ${r.model}) ${r.seconds}s turns=${r.turns} $${r.cost} :: ${r.result}`);
  return r;
});
await new Promise((resolve) => setTimeout(resolve, 2000)); // let disconnect cleanup finish
const after = await userState();
const leftovers = Object.fromEntries(await Promise.all(browsers.map(async (b) => [b, (await listTabs(b)).filter((t) => t.owner)])));

console.log('\n| agent | browser | model | pass | s | turns | $ | result |\n|---|---|---|---|---|---|---|---|');
for (const r of results) console.log(`| ${r.name} | ${r.browser} | ${r.model} | ${r.pass ? 'yes' : 'NO'} | ${r.seconds} | ${r.turns} | ${r.cost} | ${r.result} |`);
let ok = results.every((r) => r.pass);
for (const b of browsers) {
  const changed = JSON.stringify(before[b]) !== JSON.stringify(after[b]);
  const left = leftovers[b].length;
  if (changed) { ok = false; console.log(`\n${b}: the user's tabs changed\n before ${JSON.stringify(before[b])}\n after  ${JSON.stringify(after[b])}`); }
  if (left) { ok = false; console.log(`\n${b}: ${left} agent tab(s) still open: ${leftovers[b].map((t) => t.url).join(', ')}`); }
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} agents passed in ${((Date.now() - t0) / 1000).toFixed(0)} s; user tabs ${browsers.every((b) => JSON.stringify(before[b]) === JSON.stringify(after[b])) ? 'untouched' : 'CHANGED'}; ${ok ? 'ALL GOOD' : 'PROBLEMS ABOVE'}`);
process.exit(ok ? 0 : 1);
