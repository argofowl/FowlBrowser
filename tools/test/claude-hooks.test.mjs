import assert from 'node:assert/strict';
import test from 'node:test';
import { addHooks, isOurs, removeHooks } from '../claude-hooks.mjs';

const SCRIPT = '/Users/Alex Doe/Library/Application Support/FowlBrowser/mcp/bin/turn-ended.mjs';
const GUARD = '/Users/Alex Doe/Library/Application Support/FowlBrowser/mcp/bin/shell-guard.mjs';
const NODE = '/Users/Alex Doe/.nvm/versions/node/v22.0.0/bin/node';
const other = { hooks: [{ type: 'command', command: '/usr/bin/true', timeout: 5 }] };
const lookalike = { hooks: [{ type: 'command', command: 'echo "FowlBrowser/mcp/bin/turn-ended.mjs"' }] };

test('ours: exactly <program> <our script>, quoted or not', () => {
  assert.equal(isOurs(`'${NODE}' '${SCRIPT}'`, SCRIPT), true);
  assert.equal(isOurs(`/opt/homebrew/bin/node "${SCRIPT}"`, SCRIPT), true);
  assert.equal(isOurs('echo "FowlBrowser/mcp/bin/turn-ended.mjs"', SCRIPT), false);
  assert.equal(isOurs(`node "${SCRIPT}" && rm -rf x`, SCRIPT), false);
  assert.equal(isOurs(`node '/other/checkout/FowlBrowser/mcp/bin/turn-ended.mjs'`, SCRIPT), false);
});

test('add: three hooks once, paths with spaces quoted, other hooks and keys untouched', () => {
  const settings = { env: { A: '1' }, hooks: { Stop: [other, lookalike] } };
  assert.deepEqual(addHooks(settings, NODE, SCRIPT), ['added a Stop hook', 'added a SubagentStart hook', 'added a SubagentStop hook']);
  assert.equal(settings.hooks.Stop[2].hooks[0].command, `'${NODE}' '${SCRIPT}'`);
  assert.deepEqual(settings.hooks.Stop.slice(0, 2), [other, lookalike]);
  assert.deepEqual(settings.env, { A: '1' });
  assert.deepEqual(addHooks(settings, NODE, SCRIPT), []);
});

test('add: the shell guard as a PreToolUse hook on Bash, once, next to the user\'s own PreToolUse hooks', () => {
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/lint-bash' }] };
  const settings = { hooks: { PreToolUse: [mine] } };
  assert.deepEqual(addHooks(settings, NODE, SCRIPT, GUARD),
    ['added a Stop hook', 'added a SubagentStart hook', 'added a SubagentStop hook', 'added a PreToolUse hook']);
  assert.deepEqual(settings.hooks.PreToolUse, [mine, { matcher: 'Bash', hooks: [{ type: 'command', command: `'${NODE}' '${GUARD}'`, timeout: 5 }] }]);
  assert.equal(settings.hooks.Stop[0].matcher, undefined);
  assert.deepEqual(addHooks(settings, NODE, SCRIPT, GUARD), []);
});

test('add: an install from before the guard gets just the guard; an old guard gets the current node', () => {
  const settings = {};
  addHooks(settings, NODE, SCRIPT);
  assert.deepEqual(addHooks(settings, NODE, SCRIPT, GUARD), ['added a PreToolUse hook']);
  settings.hooks.PreToolUse[0].hooks[0].command = `/opt/homebrew/bin/node "${GUARD}"`;
  assert.deepEqual(addHooks(settings, NODE, SCRIPT, GUARD), ['updated the PreToolUse hook']);
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `'${NODE}' '${GUARD}'`);
});

test('add: an old hook of ours gets the current node, keeping its other fields', () => {
  const old = { type: 'command', command: `/opt/homebrew/bin/node "${SCRIPT}"`, timeout: 7 };
  const settings = { hooks: { Stop: [{ hooks: [old] }] } };
  assert.deepEqual(addHooks(settings, NODE, SCRIPT), ['updated the Stop hook', 'added a SubagentStart hook', 'added a SubagentStop hook']);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', command: `'${NODE}' '${SCRIPT}'`, timeout: 7 }] }]);
});

test('remove: only our hooks, empty events and hooks dropped, lookalikes kept', () => {
  const settings = { env: { A: '1' }, hooks: { Stop: [other, lookalike] } };
  addHooks(settings, NODE, SCRIPT);
  assert.equal(removeHooks(settings, SCRIPT), 3);
  assert.deepEqual(settings, { env: { A: '1' }, hooks: { Stop: [other, lookalike] } });
  const only = {};
  addHooks(only, NODE, SCRIPT);
  assert.equal(removeHooks(only, SCRIPT), 3);
  assert.deepEqual(only, {});
});

test('remove: both scripts go, the user\'s own PreToolUse hook stays', () => {
  const mine = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/lint-bash' }] };
  const settings = { hooks: { PreToolUse: [mine], Stop: [other] } };
  addHooks(settings, NODE, SCRIPT, GUARD);
  assert.equal(removeHooks(settings, SCRIPT, GUARD), 4);
  assert.deepEqual(settings, { hooks: { PreToolUse: [mine], Stop: [other] } });
});
