// Playwright runs every evaluation as a user gesture, which would leave the page a user activation after a mere
// snapshot or ref check (a page timer could then open the Mac's file panel or start sound). The relay strips it except
// while a call asks for it (the agent's evaluate, media playback).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserModel } from '../src/vendor/browserModel.mjs';

function model() {
  const sent = [];
  const m = new BrowserModel(async (method, params) => { sent.push([method, params]); return {}; });
  m._tabSessions.set(3, { tabId: 3, sessionId: 'pw-tab-1', targetInfo: {}, childSessions: new Set(['child-1']) });
  return { m, sent };
}

test('evaluations go to the page without a user gesture unless a call on that tab asks for one', async () => {
  const { m, sent } = model();
  await m.sendCommand('pw-tab-1', 'Runtime.callFunctionOn', { functionDeclaration: '() => 1', userGesture: true });
  await m.sendCommand('child-1', 'Runtime.evaluate', { expression: '1', userGesture: true });
  assert.deepEqual(sent.map(([, [, , params]]) => params.userGesture), [false, false]);
  m.gestures.set(3, 1);
  await m.sendCommand('pw-tab-1', 'Runtime.callFunctionOn', { functionDeclaration: '() => 1', userGesture: true });
  assert.equal(sent.at(-1)[1][2].userGesture, true);
  await m.sendCommand('pw-tab-1', 'Page.navigate', { url: 'https://a.example' });
  assert.deepEqual(sent.at(-1)[1][2], { url: 'https://a.example' }, 'other commands untouched');
});
