import './fixtures/rounds-config.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readJsonl } from '../rounds.mjs';

// A server that, on a tools/call, asks the client a question (elicitation/create) and answers the call once it hears back.
const fakeServer = `
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'tools/call') console.log(JSON.stringify({ jsonrpc: '2.0', id: 'e1', method: 'elicitation/create', params: { message: 'Allow Browser use to access http://127.0.0.1:5420?' } }));
    if (m.id === 'e1') console.log(JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'done ' + m.result.action }] } }));
  }
});`;

test('mcp-tee passes every line through and logs elicitations with their answers', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tee-')), 'elicitations.jsonl');
  const tee = spawn(process.execPath, [fileURLToPath(new URL('../mcp-tee.mjs', import.meta.url)), log, process.execPath, '-e', fakeServer]);
  const out = [];
  tee.stdout.setEncoding('utf8');
  const answered = new Promise((resolve) => tee.stdout.on('data', (d) => {
    for (const line of d.split('\n').filter(Boolean)) {
      const m = JSON.parse(line); out.push(m);
      if (m.method === 'elicitation/create') tee.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { action: 'decline' } }) + '\n');
      if (m.id === 7) resolve();
    }
  }));
  tee.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'js', arguments: { code: '1' } } }) + '\n');
  await answered;
  tee.stdin.end();
  await new Promise((resolve) => tee.on('exit', resolve));
  assert.equal(out.at(-1).result.content[0].text, 'done decline');
  const lines = readJsonl(log);
  assert.deepEqual(lines.map((l) => [l.dir, l.message.method ?? l.message.result.action]), [['out', 'elicitation/create'], ['in', 'decline']]);
});
