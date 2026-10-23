#!/usr/bin/env node
// Runs every read-all variant (test/scenarios/read-all.mjs) many times with fresh random seeds, for pass rates.
//   node test/read-all-runs.mjs --browser chrome|helium|both --runs 25 [--only dm,mail] [--parallel 2] [--log runs.jsonl]
// --only takes variant names or pages. Prints variant × browser: passed/runs, average time and the first failure with
// its seed (the URL in it replays the run). --log writes every run (its error in full, and this Mac's load when it
// ended: a starved Mac makes pages stop answering). Exits 1 if any run failed.
import fs from 'node:fs';
import os from 'node:os';
import { browsersFrom, connect, ensureSite, parseArgs, pool, runJob, sweepLeaks } from './lib.mjs';
import { readVariant, VARIANTS } from './scenarios/read-all.mjs';

const args = parseArgs(process.argv.slice(2), { browser: 'both', runs: '25', parallel: '2' });
const browsers = browsersFrom(args.browser);
const only = args.only ? String(args.only).split(',') : null;
const variants = VARIANTS.filter(v => !only || only.includes(v.name) || only.includes(v.page));
if (!variants.length) { console.error(`no variants match --only ${args.only}`); process.exit(2); }

const stopSite = await ensureSite();
const server = await connect(`e2e-read-all-${process.pid}`).catch(e => { stopSite(); throw e; });
let exitCode = 0;
try {
  const jobs = [];
  for (let run = 0; run < Number(args.runs); run++) {
    for (const v of variants) for (const browser of browsers) jobs.push({ v, browser, seed: Math.floor(Math.random() * 1e6) });
  }
  const started = Date.now();
  const results = await pool(jobs, Number(args.parallel), async ({ v, browser, seed }) => {
    const r = await runJob(server, { name: `read-all-${v.name}`, run: t => readVariant(t, v, seed) }, browser);
    process.stdout.write(r.ok ? '.' : 'F');
    if (args.log) fs.appendFileSync(args.log, JSON.stringify({ variant: v.name, browser, seed, ok: r.ok, ms: r.ms, load: os.loadavg()[0], error: r.error }) + '\n');
    return { ...r, variant: v.name, seed };
  });
  console.log(`\nread_all runs: ${browsers.join(' + ')}, ${args.runs} per variant, parallel ${args.parallel}, ${((Date.now() - started) / 1000).toFixed(0)}s total`);
  const cells = [];
  for (const v of variants) {
    for (const browser of browsers) {
      const rs = results.filter(r => r.variant === v.name && r.browser === browser);
      const failed = rs.find(r => !r.ok);
      cells.push([v.name, browser, `${rs.filter(r => r.ok).length}/${rs.length}`, `${(rs.reduce((s, r) => s + r.ms, 0) / rs.length / 1000).toFixed(1)}s`,
        failed ? `seed ${failed.seed}: ${failed.error.replace(/\s+/g, ' ').slice(0, 300)}` : '']);
    }
  }
  const head = ['variant', 'browser', 'passed', 'avg', 'first failure'];
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map(c => (i < 4 ? c[i].length : 0))));
  const line = c => c.map((x, i) => (i < 4 ? x.padEnd(widths[i]) : x)).join('  ');
  console.log([line(head), line(widths.map(w => '-'.repeat(w))), ...cells.map(line)].join('\n'));
  if (results.some(r => !r.ok)) exitCode = 1;
  const leaked = await sweepLeaks(server, browsers);
  if (leaked.length) { exitCode = 1; console.log(`LEAK unowned tabs from this run (closed now): ${leaked.join(', ')}`); }
} catch (e) {
  exitCode = 1;
  console.error(`harness error: ${e.message}`);
  console.error(`server stderr (tail):\n${server.stderr().slice(-3000)}`);
} finally {
  await server.close();
  stopSite();
}
process.exit(exitCode);
