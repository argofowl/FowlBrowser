#!/usr/bin/env node
// Runs the end-to-end scenarios through one FowlBrowser MCP server.
//   node test/run.mjs --browser chrome|helium|both --parallel N [--only name,name] [--local] [--gui]
// --local skips the real-site scenarios. gui scenarios (real mouse and keyboard on this Mac) run only with --gui, which
// needs the GUI to itself (a test Mac's lock). exclusive scenarios run alone after the others. The test site is started if
// it isn't already up.
import { browsersFrom, connect, ensureSite, loadScenarios, parseArgs, parseTabs, pool, printTable, runJob, sweepLeaks } from './lib.mjs';

const args = parseArgs(process.argv.slice(2), { browser: 'both', parallel: '2' });
const browsers = browsersFrom(args.browser);
let scenarios = await loadScenarios(args.only);
if (args.local) scenarios = scenarios.filter(s => !s.real);
if (!args.gui) scenarios = scenarios.filter(s => !s.gui);
if (!scenarios.length) { console.error(`no scenarios match --only ${args.only}`); process.exit(2); }

const stopSite = await ensureSite();
const server = await connect(`e2e-${process.pid}`).catch(e => { stopSite(); throw e; });
let exitCode = 0;
try {
  const jobs = scenarios.flatMap(s => browsers.map(b => [s, b]));
  const started = Date.now();
  const rows = [
    ...await pool(jobs.filter(([s]) => !s.exclusive), Number(args.parallel), ([s, b]) => runJob(server, s, b)),
    ...await pool(jobs.filter(([s]) => s.exclusive), 1, ([s, b]) => runJob(server, s, b)),
  ];
  printTable(rows, `FowlBrowser e2e: ${browsers.join(' + ')}, parallel ${args.parallel}, ${((Date.now() - started) / 1000).toFixed(1)}s total`);
  if (rows.some(r => !r.ok)) exitCode = 1;

  // Nothing may be left owned by this server once every scenario has cleaned up.
  for (const browser of browsers) {
    const left = parseTabs(await server.call('tab_list', { browser, scope: 'mine' }));
    if (left.length) {
      exitCode = 1;
      console.log(`LEAK ${browser}: ${left.map(x => `${x.tab} ${x.url}`).join(', ')}`);
      for (const x of left) await server.call('tab_close', { tab: x.tab, confirm_close_users_tab: true }).catch(() => {});
    }
  }
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
