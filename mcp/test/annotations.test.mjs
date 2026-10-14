// Claude Code runs a batch of MCP tool calls at once only when the tools say they only read (readOnlyHint); every
// other tool runs one after another. The reading tools say so, and no tool that acts does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerTools } from '../src/tools.mjs';

test('reading tools are marked read-only, acting tools are not', () => {
  const configs = new Map();
  registerTools({ registerTool: (name, config) => configs.set(name, config) }, { get: async () => null, all: async () => [] });
  const readOnly = [...configs].filter(([, config]) => config.annotations?.readOnlyHint === true).map(([name]) => name).sort();
  assert.deepEqual(readOnly, ['browser_data', 'browser_list', 'console', 'downloads', 'export', 'memory', 'network', 'screenshot', 'snapshot',
    'tab_list', 'trace_insight', 'wait_for']);
  for (const acting of ['click', 'type', 'navigate', 'evaluate', 'tab_open', 'tab_close', 'download', 'lighthouse', 'trace_start']) {
    assert.ok(configs.has(acting) && !configs.get(acting).annotations, `${acting} is not marked read-only`);
  }
});
