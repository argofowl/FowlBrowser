// FOWLBROWSER_DEBUG logs: what an agent types never reaches the file; everything else about the call does.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('the debug log redacts the text of type and dialog and every fill_form value, and keeps the rest', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-debug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'debug.log');
  process.env.FOWLBROWSER_DEBUG = file;
  const { debug } = await import('../src/debug.mjs?redact'); // a fresh copy that reads the variable
  delete process.env.FOWLBROWSER_DEBUG;
  debug('tool >', 'type', { tab: 'chrome:5', ref: 'e3', text: 'hunter2', submit: true });
  debug('tool >', 'dialog', { tab: 'chrome:5', accept: true, text: 'my answer' });
  debug('tool >', 'fill_form', { tab: 'chrome:5', fields: [{ ref: 'e4', value: 'secret@example.com' }, { ref: 'e5', value: true }, { ref: 'e6', value: 482916 }] });
  debug('tool >', 'navigate', { tab: 'chrome:5', url: 'https://example.com/' });
  const log = fs.readFileSync(file, 'utf8');
  for (const secret of ['hunter2', 'my answer', 'secret@example.com', '482916']) assert.ok(!log.includes(secret), secret);
  assert.match(log, /tool > type \{"tab":"chrome:5","ref":"e3","text":"\[redacted\]","submit":true\}/);
  assert.match(log, /"fields":\[\{"ref":"e4","value":"\[redacted\]"\},\{"ref":"e5","value":"\[redacted\]"\},\{"ref":"e6","value":"\[redacted\]"\}\]/);
  assert.match(log, /tool > navigate \{"tab":"chrome:5","url":"https:\/\/example\.com\/"\}/);
});
