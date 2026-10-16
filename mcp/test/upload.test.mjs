// upload_files on a button that opens a file chooser: the chooser is held off the user's screen however long the click
// takes to happen (Playwright waits for a button that is disabled a moment, covered or on a busy page), and one that
// opens a while after the click is held too instead of showing the Mac's file panel.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// clickMs: how long the click takes to happen; chooserMs: how long after it the page's handler opens the chooser.
function setup({ clickMs, chooserMs = 0 }) {
  let usersClick;
  const events = []; // 'native' (the Mac's panel: no one intercepted the chooser), 'chose <names>', 'dropped'
  const chooser = { isMultiple: () => false, setFiles: async (files) => { events.push(`chose ${files.map((f) => path.basename(f)).join(',')}`); } };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://cms.example/media', mainFrame: () => page, frames: () => [page], isClosed: () => false,
    ariaSnapshot: async () => '- button "Upload image" [ref=e1]',
    waitForTimeout: sleep,
    // An evaluate right after an action: the page still has that action's user activation, so a script click on a file input opens its chooser.
    evaluate: async () => { usersClick(); return null; },
    // Like Playwright's: a listener while it waits, removed when it times out (choosers are intercepted only while one listens).
    waitForEvent(name, { timeout }) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { page.off(name, resolve); reject(new Error(`Timeout ${timeout}ms exceeded while waiting for event "${name}"`)); }, timeout);
        page.once(name, (value) => { clearTimeout(timer); resolve(value); });
      });
    },
    getByRef: () => ({
      count: async () => 1,
      async evaluate(fn) {
        if (String(fn).includes('dataTransfer') || String(fn).includes('DataTransfer')) { events.push('dropped'); return undefined; }
        return false; // not a file input
      },
      async click() {
        await sleep(clickMs);
        setTimeout(() => {
          if (page.listenerCount('filechooser')) page.emit('filechooser', chooser);
          else events.push('native');
        }, chooserMs);
      },
    }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Media' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 6, page);
  browser.tabs.set(6, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: tab.id, ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text).join('\n') };
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-upload-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'photo.png');
  fs.writeFileSync(file, 'png');
  // The user's own click on their upload button: their chooser, intercepted only if someone listens.
  usersClick = () => { if (page.listenerCount('filechooser')) page.emit('filechooser', chooser); else events.push('native'); };
  return { call, events, file, tab, usersClick };
}

test('a button whose click takes longer than the chooser wait: its chooser is still held and gets the files', async () => {
  const { call, events, file } = setup({ clickMs: 1800 });
  await call('snapshot', {});
  const result = await call('upload_files', { ref: 'e1', paths: [file], snapshot: false });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(events, ['chose photo.png'], 'the files went to the chooser, never the Mac\'s panel or a drop');
  assert.match(result.text, /Uploaded 1 file\./);
});

test('a chooser that opens a while after the click (the page asked its server first) is held, not shown', async () => {
  const { call, events, file, tab } = setup({ clickMs: 0, chooserMs: 2500 });
  await call('snapshot', {});
  const result = await call('upload_files', { ref: 'e1', paths: [file], snapshot: false });
  assert.equal(result.error, false, result.text);
  await sleep(2700);
  assert.ok(!events.includes('native'), `the Mac's file panel opened: ${events}`);
  assert.ok(tab.fileChooser, 'held for upload_files without ref');
});

test('a wait sends no input: the user\'s own upload click during it opens their file panel, not a held chooser', async () => {
  const { call, events, tab, usersClick } = setup({ clickMs: 0 });
  setTimeout(usersClick, 150);
  const result = await call('wait_for', { seconds: 0.4, snapshot: false });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(events, ['native'], 'the user\'s panel opened');
  assert.equal(tab.fileChooser ?? null, null);
  assert.doesNotMatch(result.text, /file chooser/);
});

test('an evaluate whose script clicks a file input gets its chooser held, never the Mac\'s panel', async () => {
  const { call, events, tab } = setup({ clickMs: 0 });
  const result = await call('evaluate', { function: '() => document.querySelector("input[type=file]").click()' });
  assert.equal(result.error, false, result.text);
  assert.deepEqual(events, [], 'the Mac\'s file panel opened');
  assert.ok(tab.fileChooser, 'held for upload_files without ref');
  assert.match(result.text, /The page opened a file chooser; FowlBrowser kept it off the user's screen/);
});
