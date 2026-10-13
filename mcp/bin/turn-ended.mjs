// Claude Code hook for Stop, SubagentStart and SubagentStop: tells this session's FowlBrowser MCP server
// (src/turns.mjs) that the turn ended (it closes its agent tabs and gives claimed and kept ones back to the user) or that
// a subagent started or stopped (turn ends wait while one runs). The server listens on
// ~/.fowlbrowser/turns/<claude pid>.sock, or <temp folder>/fowlbrowser-turn-<claude pid>.sock when that path is too long
// (servers from before that: /tmp/fowlbrowser-turn-<claude pid>.sock); the hook
// runs a few processes below Claude, so walk up to it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MESSAGES = { Stop: 'turn_ended', SubagentStart: 'subagent_start', SubagentStop: 'subagent_stop' };

// The socket of the FIRST ancestor named `claude` (ps shows a full path when it was started by path), or null.
// Never looks past it: a nested `claude -p` without FowlBrowser must not reach the outer session's server.
export function findSocket(pid = process.ppid, ps = (args) => execFileSync('ps', args).toString(),
  dir = process.env.FOWLBROWSER_DIR || join(homedir(), '.fowlbrowser'), tmp = tmpdir()) {
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      if (basename(ps(['-o', 'comm=', '-p', String(pid)]).trim()) === 'claude') {
        return [join(dir, 'turns', `${pid}.sock`), join(tmp, `fowlbrowser-turn-${pid}.sock`), `/tmp/fowlbrowser-turn-${pid}.sock`]
          .find((path) => existsSync(path)) ?? null;
      }
      pid = Number(ps(['-o', 'ppid=', '-p', String(pid)]).trim());
    } catch { return null; }
  }
  return null;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) { // run, not imported by a test
  // An unknown or unreadable event sends nothing: a wrong turn_ended would close tabs mid-turn.
  let event = null;
  try { event = JSON.parse(readFileSync(0, 'utf8')).hook_event_name; } catch {}
  const message = Object.hasOwn(MESSAGES, event) ? MESSAGES[event] : null;
  const socketPath = message && findSocket();
  if (!socketPath) process.exit(0);
  const socket = connect(socketPath, () => socket.write(`${message}\n`));
  socket.on('data', (chunk) => { if (chunk.includes('\n')) process.exit(0); });
  socket.on('error', () => process.exit(0));
  socket.on('close', () => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
