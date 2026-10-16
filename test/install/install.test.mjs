// install.sh then uninstall.sh in a temp HOME with spaces in its path, run from a copy of the repo that has spaces too.
// The user's own node (a folder first on PATH) is the one baked into the launchers; FOWLBROWSER_SKIP_CLAUDE=1 keeps
// Claude Code's settings untouched; uninstall.sh leaves HOME exactly as it found it. A second round with Claude Code
// registers the hooks and removes them again. Needs the network (npm ci).
//   node --test test/install/
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Every path under dir with a hash of each file, so any file added, removed or changed shows up.
function tree(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((rel) => {
    const file = path.join(dir, rel);
    const stat = fs.lstatSync(file);
    return stat.isFile() ? `${rel} ${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex')}` : `${rel}/`;
  });
}

test('install.sh and uninstall.sh with spaces in every path, a fake node first on PATH, Claude Code skipped, then not', { timeout: 600_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fb install ')));
  const home = path.join(tmp, 'home with spaces');
  const repo = path.join(tmp, 'my code', 'FowlBrowser');
  const fakeBin = path.join(tmp, 'fake node', 'bin');
  const settings = path.join(home, '.claude', 'settings.json');
  const app = path.join(home, 'Library', 'Application Support', 'FowlBrowser');
  // A FowlBrowser hook from an earlier install with Claude Code: skipping Claude Code means it stays too.
  const ourHook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `node '${app}/mcp/bin/turn-ended.mjs'` }] }] } };
  const settingsText = `${JSON.stringify(ourHook, null, 2)}\n`;
  fs.mkdirSync(path.join(home, 'Library', 'Application Support'), { recursive: true });
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, settingsText);
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(fakeBin, 'node'));
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('rsync', ['-a', '--exclude', 'node_modules', '--exclude', '.git', '--exclude', 'local', `${ROOT}/`, `${repo}/`]);
  const before = tree(home);

  const env = {
    ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, FOWLBROWSER_SKIP_CLAUDE: '1',
    npm_config_cache: path.join(tmp, 'npm cache'),
  };
  delete env.CLAUDE_SETTINGS;
  const out = execFileSync('sh', [path.join(repo, 'install.sh'), '--lite'], { env, encoding: 'utf8' });
  assert.match(out, /Claude Code: skipped/);

  const node = path.join(fakeBin, 'node');
  const launcher = path.join(app, 'mcp', 'bin', 'fowlbrowser-mcp');
  assert.ok(fs.readFileSync(launcher, 'utf8').includes(`exec '${node}' '${path.join(app, 'mcp', 'src', 'server.mjs')}' "$@"`));
  assert.ok(fs.readFileSync(path.join(app, 'host', 'fowlbrowser-host'), 'utf8').includes(`exec '${node}' `));
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsText);
  assert.ok(!fs.existsSync(path.join(home, '.claude.json')));

  // A desktop app's minimal PATH has no node on it: the installed launcher still starts the server.
  const client = new Client({ name: 'install-test', version: '0' });
  await client.connect(new StdioClientTransport({
    command: launcher, env: { PATH: '/usr/bin:/bin', HOME: home, FOWLBROWSER_DIR: path.join(tmp, 'sockets') },
  }));
  assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'browser_list'));
  await client.close();
  fs.rmSync(path.join(tmp, 'sockets'), { recursive: true, force: true });

  execFileSync('sh', [path.join(repo, 'uninstall.sh')], { env, encoding: 'utf8' });
  assert.deepEqual(tree(home), before);

  // Again with Claude Code (a stand-in `claude` that accepts the mcp commands): the old Stop hook gets the current node,
  // the other hooks and the shell guard are added, and uninstall.sh takes all of them out again.
  fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const withClaude = { ...env };
  delete withClaude.FOWLBROWSER_SKIP_CLAUDE;
  execFileSync('sh', [path.join(repo, 'install.sh'), '--lite'], { env: withClaude, encoding: 'utf8' });
  const hooks = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks;
  const run = (script) => `'${node}' '${path.join(app, 'mcp', 'bin', script)}'`;
  for (const event of ['Stop', 'SubagentStart', 'SubagentStop']) assert.equal(hooks[event][0].hooks[0].command, run('turn-ended.mjs'));
  assert.deepEqual(hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: run('shell-guard.mjs'), timeout: 5 }] }]);
  execFileSync('sh', [path.join(repo, 'uninstall.sh')], { env: withClaude, encoding: 'utf8' });
  assert.equal(fs.readFileSync(settings, 'utf8'), '{}\n');
  assert.ok(!fs.existsSync(app));
  fs.rmSync(tmp, { recursive: true, force: true });
});
