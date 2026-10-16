// Claude Code PreToolUse hook (matcher Bash): refuses shell commands that would show a page in a browser window
// (`open` a URL or .html with the default or a named browser, a browser's own binary without --headless, osascript
// telling a browser to open something, Python's webbrowser). Loose tabs opened that way can't be told apart or reused;
// pages for the user go through FowlBrowser's tab_open instead. Runs on every Bash call, so node builtins only, and it
// fails open: anything it can't read or parse is allowed. Not a sandbox, just a guard against the habit.
import { readFileSync } from 'node:fs';

export const REASON = 'Pages for the user open through FowlBrowser, not the shell: use tab_open with for_user: true and ' +
  'a group named for the project (local files work, e.g. file:///.../proto.html). On a redo, open the same URLs with the ' +
  'same group and the old tabs reload in place. If FowlBrowser isn\'t connected, tell the user instead of opening the ' +
  'page another way.';

const BROWSER = /^(google chrome( (canary|beta|dev))?|chrome|chromium|helium|safari( technology preview)?|arc|brave browser( (beta|nightly))?|microsoft edge( (beta|dev|canary))?|vivaldi|firefox( (developer edition|nightly))?|orion|dia)$/;
const BUNDLE = /^(com\.google\.chrome|org\.chromium\.chromium|net\.imput\.helium|com\.apple\.safari|company\.thebrowser\.(browser|dia)|com\.brave\.browser|com\.microsoft\.edgemac|com\.vivaldi\.vivaldi|org\.mozilla\.firefox|com\.kagi\.kagimacos)/;
const BINARIES = new Set(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
// Words that run the next word as the command: their own options and NAME=value words are skipped too.
const PREFIXES = new Set(['env', 'command', 'exec', 'nohup', 'time', '!', '{', 'if', 'then', 'else', 'elif', 'do', 'while', 'until']);
const OPEN_VALUE = new Set(['-a', '-b', '-s', '--env', '--stdin', '--stdout', '--stderr', '--arch']);
const OPEN_NOT_BROWSER = new Set(['-e', '-t', '-f', '-R', '-h']); // TextEdit, text editor, stdin, reveal, header

const isBrowser = (app) => BROWSER.test(app.replace(/\/+$/, '').split('/').pop().replace(/\.app$/i, '').toLowerCase());
const isPage = (arg) => /^(https?|file):/i.test(arg) || /\.(html?|xhtml)([?#].*)?$/i.test(arg);
const base = (word) => word.split('/').pop();
// Chrome's --app=<url> opens the page in an app window: its URL counts as a page argument.
const appUrl = (arg) => (arg.startsWith('--app=') ? arg.slice('--app='.length) || arg : arg);

function openShowsPage(args) {
  let app = null;
  const targets = [];
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (/^-[a-zA-Z]{2,}$/.test(a)) { // -na App: the last letter takes the value
      if ([...a.slice(1)].some((f) => OPEN_NOT_BROWSER.has(`-${f}`))) return false;
      a = `-${a.at(-1)}`;
    }
    if (a === '--args') { targets.push(...args.slice(i + 1).map(appUrl).filter((x) => !x.startsWith('-'))); break; }
    if (OPEN_NOT_BROWSER.has(a)) return false;
    if (a === '-a') app = isBrowser(args[++i] ?? '') ? 'browser' : 'other';
    else if (a === '-b') app = BUNDLE.test((args[++i] ?? '').toLowerCase()) ? 'browser' : 'other';
    else if (a === '-u') targets.push(args[++i] ?? '');
    else if (OPEN_VALUE.has(a)) i++;
    else if (!a.startsWith('-')) targets.push(a);
  }
  if (app === 'browser') return targets.length > 0; // arguments are often `$VAR?x`, so any of them counts
  return app === null && targets.some(isPage);
}

function binaryShowsPage(cmd, args) {
  const app = /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(cmd);
  if (!(app ? isBrowser(app[1]) : BINARIES.has(base(cmd)))) return false;
  return !args.some((a) => a.startsWith('--headless')) && args.some((a) => isPage(a) || a.startsWith('--app='));
}

function osascriptShowsPage(args) {
  const script = args.join('\n');
  const browser = [...script.matchAll(/application\s+(id\s+)?"([^"]+)"/gi)]
    .some((m) => (m[1] ? BUNDLE.test(m[2].toLowerCase()) : isBrowser(m[2])));
  return /\bopen location\b/i.test(script) ||
    (browser && /\b(make\s+(new\s+)?(tab|window|document)|set\s+(the\s+)?url\b|\bopen\b)/i.test(script));
}

// Python source without its string literals (triple-quoted too) and comments.
const pythonCode = (src) => src.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|#[^\n]*/g, "''");

function pythonShowsPage(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m' && args[i + 1] === 'webbrowser' || args[i] === '-mwebbrowser') return true;
    // A call of webbrowser's own open in the code itself (strings and comments dropped first), not an import of it or
    // a script that only mentions it (reading webbrowser.py, say); anything less certain is allowed.
    if (args[i] === '-c' && /\bwebbrowser\s*\.\s*open(_new(_tab)?)?\s*\(/.test(pythonCode(args[i + 1] ?? ''))) return true;
  }
  return false;
}

// One simple command's words; NAME=value words before the command are remembered for later $NAME.
function showsPage(words, vars) {
  let i = 0;
  for (;;) {
    while (/^[A-Za-z_]\w*=/.test(words[i] ?? '')) { const eq = words[i].indexOf('='); vars[words[i].slice(0, eq)] = words[i++].slice(eq + 1); }
    if (!PREFIXES.has(words[i])) break;
    i++;
    while (words[i]?.startsWith('-')) i++;
  }
  const [cmd, ...args] = words.slice(i);
  if (!cmd) return false;
  if (cmd === 'export') {
    for (const a of args) { const eq = a.indexOf('='); if (/^[A-Za-z_]\w*=/.test(a)) vars[a.slice(0, eq)] = a.slice(eq + 1); }
    return false;
  }
  const name = base(cmd);
  if (name === 'open') return openShowsPage(args);
  if (name === 'osascript') return osascriptShowsPage(args);
  if (/^python(\d+(\.\d+)?)?$/.test(name)) return pythonShowsPage(args);
  return binaryShowsPage(cmd, args);
}

// Splits a command string the way sh would, far enough for this: quotes, backslashes, $NAME / ${NAME} from earlier
// assignments (unknown ones stay as written), $(...) and `...` kept as text, redirections, comments and heredoc bodies
// dropped, and ; & | ( ) and newlines ending a command. Returns true at the first command that shows a page.
export function guard(src) {
  const vars = Object.create(null); // no inherited names: $constructor stays as written
  const heredocs = [];
  let words = [], word = null, i = 0, redirect = false;
  const add = (s) => { word = (word ?? '') + s; };
  const endWord = () => {
    if (word !== null) { if (redirect) { redirect = false; if (heredocs.at(-1) === '') heredocs[heredocs.length - 1] = word; } else words.push(word); }
    word = null;
  };
  const endCommand = () => { endWord(); const hit = words.length && showsPage(words, vars); words = []; return hit; };
  const expand = () => {
    const m = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/.exec(src.slice(i));
    if (!m) return false;
    const name = m[1] ?? m[2];
    add(name in vars ? vars[name] : m[0]);
    i += m[0].length;
    return true;
  };
  const skipGroup = (open, close) => { // $(...) or `...`, nested parens counted, kept as literal text
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (open !== close && src[i] === open) depth++;
      else if (src[i] === close && (open === close ? i > start : --depth === 0)) { i++; break; }
    }
    add(src.slice(start, i));
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { if (src[i + 1] !== '\n') add(src[i + 1] ?? ''); i += 2; continue; }
    if (c === "'") { const end = src.indexOf("'", i + 1); if (end < 0) throw new Error('quote'); add(src.slice(i + 1, end)); i = end + 1; continue; }
    if (c === '"') {
      add('');
      for (i++; i < src.length && src[i] !== '"';) {
        if (src[i] === '\\' && '"\\$`'.includes(src[i + 1])) { add(src[i + 1]); i += 2; }
        else if (src.startsWith('$(', i)) { add('$'); i++; skipGroup('(', ')'); }
        else if (src[i] === '`') skipGroup('`', '`');
        else if (!(src[i] === '$' && expand())) add(src[i++]);
      }
      if (src[i] !== '"') throw new Error('quote');
      i++;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') { add('$'); i++; skipGroup('(', ')'); continue; }
    if (c === '$' && expand()) continue;
    if (c === '`') { skipGroup('`', '`'); continue; }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '<' || c === '>' || (c === '&' && src[i + 1] === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null; // the 2 in 2>
      endWord();
      if (src.startsWith('<<', i) && !src.startsWith('<<<', i)) heredocs.push('');
      i += /^(<<-|<<<|<<|>>|>&|<&|&>>|&>|>\||<>|<|>)/.exec(src.slice(i))[0].length;
      if (src[i] === '-' && /[\s;&|]/.test(src[i + 1] ?? ' ')) i++; // >&- closes a descriptor
      redirect = true;
      continue;
    }
    if (c === '\n' && heredocs.length) {
      if (endCommand()) return true;
      for (const tag of heredocs.splice(0).map((t) => t.replace(/^\s+/, ''))) { // drop each body up to its tag line
        for (;;) {
          const nl = src.indexOf('\n', i + 1);
          const line = src.slice(i + 1, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl;
          if (line.replace(/^\t+/, '') === tag || nl < 0) break;
        }
      }
      continue;
    }
    if (' \t'.includes(c)) { endWord(); i++; continue; }
    if (';&|()\n'.includes(c)) { if (endCommand()) return true; redirect = false; i++; continue; }
    add(c);
    i++;
  }
  return !!endCommand();
}

if (import.meta.main) {
  try {
    const command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command;
    if (typeof command === 'string' && guard(command)) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON },
      }));
    }
  } catch { /* fail open */ }
}
