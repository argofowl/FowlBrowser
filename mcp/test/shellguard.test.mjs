// The Claude Code PreToolUse hook (bin/shell-guard.mjs) run as Claude Code runs it: hook JSON on stdin, a deny decision
// on stdout or nothing at all.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../bin/shell-guard.mjs', import.meta.url));
const CHROME = '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"';
const B = 'B="file:///Users/argo/Projects/nearby/nearby-prototype.html"';

function run(stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK], (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(stdin);
  });
}
const decide = async (command) => {
  const out = await run(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }));
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

const DENY = [
  `${B}; open -a "Google Chrome" "$B?variant=A" "$B?variant=B" "$B?variant=C" "$B?variant=D"`,
  `${B}\n${CHROME} "$B?variant=B" "$B?variant=C"`,
  'open https://example.com',
  'open ~/Desktop/proto.html',
  'open "file:///tmp/a b.htm#top"',
  'open -a Helium "$UNKNOWN?x=1"',
  'open -a "/Applications/Safari.app" index.html',
  'open -na "Google Chrome Canary" --args https://example.com',
  'open -b com.google.Chrome http://localhost:3000',
  'open -gna Helium "$X"',
  'cd site && npm run build && open dist/index.html',
  'U=http://localhost:5173; sleep 1; env FOO=1 nohup open "${U}/a"',
  'export P=/tmp/x.html && command open "$P"',
  'google-chrome https://example.com',
  `${CHROME} --new-window http://localhost:8080`,
  `osascript -e 'tell application "Google Chrome" to open location "https://a.b"'`,
  `osascript -e 'tell application "Safari"' -e 'make new document with properties {URL:"https://a.b"}' -e 'end tell'`,
  `osascript -e 'tell application "Arc" to set URL of active tab of front window to "https://a.b"'`,
  'python3 -m webbrowser https://example.com',
  `${CHROME} --app=http://localhost:3000`,
  'open -a Helium --args --app=http://localhost:3000',
  `python3 -c 'import webbrowser; webbrowser.open("http://localhost:3000")'`,
  `python -c "import webbrowser; webbrowser.open('http://localhost:8000')"`,
  'echo ok | (open https://example.com)',
];
const ALLOW = [
  `python3 -c 'from webbrowser import Error; print(Error.__name__)'`,
  `python3 -c 'import webbrowser; print("webbrowser.open(url)")'`,
  `python3 -c 'print(open("webbrowser.py").read())'`,
  `python3 -c 'text = open("README.md").read(); print("webbrowser" in text)'`,
  `${CHROME} --headless --app=http://localhost:3000 --screenshot`,
  'open .',
  'open -a Finder x',
  'open file.pdf',
  'open -R x',
  'open -R index.html',
  'open -Ra "Google Chrome" index.html',
  'open -a "Visual Studio Code" x.html',
  'open -e notes.html',
  'open -a "Google Chrome" --args --silent-debugger-extension-api',
  `${CHROME} --headless=new --screenshot=/tmp/s.png --window-size=1280,800 file:///tmp/proto.html`,
  `${CHROME} --headless --dump-dom https://example.com`,
  'echo "open https://example.com"',
  `grep -rn 'open -a "Google Chrome"' .`,
  'cat > /tmp/notes.md <<EOF\nopen https://example.com\nEOF\nls',
  'curl -s https://example.com > /tmp/page.html',
  'git commit -m "open index.html"',
  `osascript -e 'tell application "Finder" to open folder "Docs"'`,
  'python3 -c "print(1)"',
  'ls # open https://example.com',
];

test('shell-guard: commands that would show a page in a browser are denied, the rest pass', async () => {
  const results = await Promise.all([...DENY, ...ALLOW].map(async (command) => [command, await decide(command)]));
  const wrong = results.filter(([command, decision]) => decision !== (DENY.includes(command) ? 'deny' : 'allow'));
  assert.deepEqual(wrong, []);
});

test('shell-guard: the deny output is the PreToolUse decision with a reason naming tab_open', async () => {
  const out = JSON.parse(await run(JSON.stringify({ tool_input: { command: 'open https://example.com' } })));
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /tab_open with for_user: true and a group/);
});

test('shell-guard: bad input fails open with no output', async () => {
  for (const stdin of ['', 'not json', '{"tool_input":', '{}', '{"tool_input":{"command":42}}', JSON.stringify({ tool_input: { command: 'open "https://unclosed' } })]) {
    assert.equal(await run(stdin), '', stdin);
  }
});
