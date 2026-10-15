// FOWLBROWSER_DEBUG=<file> appends a timestamped trace of tool calls, host requests and relay traffic.
// Never throws: a part that can't be serialized or a file that can't be written is skipped.
import fs from 'node:fs';

const file = process.env.FOWLBROWSER_DEBUG;
export const debugging = !!file;

function show(part) {
  if (typeof part === 'string') return part;
  try { return JSON.stringify(part) ?? String(part); } catch { return '[unserializable]'; }
}

// Text an agent types (passwords, messages) and every form value (a PIN or code may be a number) stay out of the log:
// it gets attached to bug reports.
// Also record.mjs's, for its journal.
export function redactArgs(name, args) {
  if (!args) return args;
  if ((name === 'type' || name === 'dialog') && typeof args.text === 'string') return { ...args, text: '[redacted]' };
  if (name === 'fill_form' && Array.isArray(args.fields)) {
    return { ...args, fields: args.fields.map((f) => (f && 'value' in f ? { ...f, value: '[redacted]' } : f)) };
  }
  return args;
}

function redact(parts) {
  const [kind, name, args] = parts;
  return kind === 'tool >' && args ? [kind, name, redactArgs(name, args), ...parts.slice(3)] : parts;
}

// Page text (titles) goes in, so never through a symlink (another user's in /tmp, pointing at a shell profile) nor
// into a file others can read: created 0600, an older one of ours made 0600 too, and one another user owns (or a FIFO,
// a device) is left alone. Non-blocking: a FIFO there with no reader fails to open instead of hanging the server.
const FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
export const debug = file
  ? (...parts) => {
    let fd;
    try {
      fd = fs.openSync(file, FLAGS, 0o600);
      const stat = fs.fstatSync(fd);
      if (stat.uid !== process.getuid() || !stat.isFile()) return;
      if (stat.mode & 0o077) fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${redact(parts).map(show).join(' ').slice(0, 400)}\n`);
    } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  : () => {};
