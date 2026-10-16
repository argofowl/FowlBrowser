// Adds or removes FowlBrowser's Claude Code hooks in a settings file: turn-ended.mjs for Stop, SubagentStart and
// SubagentStop, shell-guard.mjs for PreToolUse on Bash. Used by install.sh and uninstall.sh:
//   node tools/claude-hooks.mjs add <settings.json> <node> <turn-ended.mjs> [<shell-guard.mjs>]
//   node tools/claude-hooks.mjs remove <settings.json> <turn-ended.mjs> [<shell-guard.mjs>]
// A hook is ours only when its whole command runs one of those exact scripts with one program: `<node> <script>`, either
// part optionally quoted. Every other hook and key is left as it is. A hook of ours with an old node path is updated.
import fs from 'node:fs';
import path from 'node:path';

const EVENTS = ['Stop', 'SubagentStart', 'SubagentStop'];
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const unquote = (s) => s.replace(/^'(.*)'$/s, '$1').replace(/^"(.*)"$/s, '$1').replaceAll("'\\''", "'");

export function isOurs(command, script) {
  const match = /^\s*('[^']*(?:'\\''[^']*)*'|"[^"]*"|\S+)\s+('[^']*(?:'\\''[^']*)*'|"[^"]*"|\S+)\s*$/.exec(command ?? '');
  return !!match && unquote(match[2]) === script;
}

export function addHooks(settings, node, script, guard) {
  const changes = [];
  const wanted = EVENTS.map((event) => [event, script]);
  if (guard) wanted.push(['PreToolUse', guard, 'Bash']);
  for (const [event, file, matcher] of wanted) {
    const command = `${quote(node)} ${quote(file)}`;
    const entries = (settings.hooks ??= {})[event] ??= [];
    const ours = entries.flatMap((entry) => entry.hooks ?? []).filter((h) => isOurs(h.command, file));
    if (!ours.length) {
      entries.push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command, timeout: 5 }] });
      changes.push(`added a ${event} hook`);
    }
    for (const hook of ours) {
      if (hook.command === command) continue;
      hook.command = command;
      changes.push(`updated the ${event} hook`);
    }
  }
  return changes;
}

export function removeHooks(settings, ...scripts) {
  let removed = 0;
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      const hooks = (entry.hooks ?? []).filter((h) => !scripts.some((script) => isOurs(h.command, script)));
      removed += (entry.hooks?.length ?? 0) - hooks.length;
      if (hooks.length === (entry.hooks?.length ?? 0)) kept.push(entry);
      else if (hooks.length) kept.push({ ...entry, hooks });
    }
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return removed;
}

if (import.meta.main) {
  const [mode, file, ...rest] = process.argv.slice(2);
  const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const write = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`); };
  if (mode === 'add') {
    const [node, ...scripts] = rest;
    const changes = addHooks(settings, node, ...scripts);
    if (changes.length) {
      write();
      for (const change of changes) console.log(`Claude Code: ${change} in ${file}`);
    } else console.log(`Claude Code: FowlBrowser hooks already in ${file}`);
  } else if (mode === 'remove') {
    const removed = removeHooks(settings, ...rest);
    if (removed) { write(); console.log(`Claude Code: removed ${removed} FowlBrowser hooks from ${file}`); }
  } else {
    console.error('usage: claude-hooks.mjs add <settings> <node> <script> [<guard>] | remove <settings> <script> [<guard>]');
    process.exit(2);
  }
}
