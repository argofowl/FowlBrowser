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
function redact(parts) {
  const [kind, name, args] = parts;
  if (kind !== 'tool >' || !args) return parts;
  if ((name === 'type' || name === 'dialog') && typeof args.text === 'string') return [kind, name, { ...args, text: '[redacted]' }];
  if (name === 'fill_form' && Array.isArray(args.fields)) {
    return [kind, name, { ...args, fields: args.fields.map((f) => (f && 'value' in f ? { ...f, value: '[redacted]' } : f)) }];
  }
  return parts;
}

export const debug = file
  ? (...parts) => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString().slice(11, 23)} [${process.pid}] ${redact(parts).map(show).join(' ').slice(0, 400)}\n`);
    } catch {}
  }
  : () => {};
