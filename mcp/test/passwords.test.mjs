// A password input's value never reaches the agent: not in a snapshot, find, nor the changes after an action (whose
// baseline never holds it either), whether or not Playwright gave the field a ref.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { registerTools } from '../src/tools.mjs';

const SECRET = 'hunter2-test';

function setup({ scanFails = false } = {}) {
  let filled = false; // the browser autofilled the saved password, which the page can read after a click
  const elements = { e1: { localName: 'input', type: 'email' }, e2: { localName: 'input', type: 'password' }, e5: { localName: 'input', type: 'password' } };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://example.com/login', mainFrame: () => page, isClosed: () => false,
    async evaluate() { return true; }, // document.readyState === 'complete' and the like
    waitForEvent: (name) => new Promise((resolve) => page.once(name, resolve)),
    waitForLoadState: async () => {},
    ariaSnapshot: async () => ['- textbox "Email" [ref=e1]: me@example.com',
      `- textbox "Password" [ref=e2]${filled ? `: ${SECRET}` : ''}`,
      // The same password in a field Playwright gives no ref (no pointer events while the form submits).
      `- textbox "Password again"${filled ? `: ${SECRET}` : ''}`,
      '- textbox "Code" [ref=e4]: 123456', // gone before it could be looked up: masked rather than guessed
      // A password with spaces Playwright collapses, in a field with no ref, and one with an explicit role (role="button").
      `- textbox "Spaced"${filled ? ': alpha beta' : ''}`,
      `- button "Reveal" [ref=e5]${filled ? `: ${SECRET}` : ''}`,
      // A password input with role=button and no pointer events (no ref), and plain page text.
      `- button "Hidden reveal"${filled ? `: ${SECRET}` : ''}`,
      '- generic:', '  - text: Forgot your password?',
      '- button "Sign in" [ref=e3]',
      ...Array.from({ length: 30 }, (_, i) => `- link "Help topic ${i}" [ref=e${i + 10}]`)].join('\n'), // a page big enough for a changes-only result
    getByRef: (ref) => ({ evaluate: async (fn) => fn(elements[ref]) }),
    locator: () => { throw new Error('no main-frame prefix here'); },
    frames: () => [{ evaluate: async (fn) => {
      if (!String(fn).includes('password')) return true;
      if (scanFails) throw new Error('Execution context was destroyed'); // a frame that didn't answer
      return filled ? [SECRET, ' alpha \t beta '] : [];
    } }],
    screenshot: async () => Buffer.from('jpeg'),
    mouse: { click: async () => { filled = true; }, move: async () => {} },
    keyboard: { down: async () => {}, up: async () => {} },
    on: EventEmitter.prototype.on, off: EventEmitter.prototype.off,
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false, focused: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Sign in' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(),
    relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 5, page);
  browser.tabs.set(5, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const call = async (name, args) => {
    const result = await tools[name]({ tab: 'chrome:5', ...args });
    return { error: !!result.isError, text: result.content.map((c) => c.text ?? `[${c.type}]`).join('\n') };
  };
  return { call, tab, fill: () => { filled = true; } };
}

test('the changes after a click that exposed an autofilled password show it masked, and the baseline never holds it', async () => {
  const { call, tab } = setup();
  assert.doesNotMatch((await call('snapshot', {})).text, /hunter2/);
  const clicked = await call('click', { x: 10, y: 10 });
  assert.equal(clicked.error, false, clicked.text);
  assert.match(clicked.text, /Changes since snapshot 1/);
  assert.match(clicked.text, /\+ - textbox "Password" \[ref=e2\]: "••••••••"/);
  assert.match(clicked.text, /\+ - textbox "Password again": "••••••••"/);
  assert.doesNotMatch(clicked.text, /hunter2/);
  assert.doesNotMatch(tab.snapshotBaseline.text, /hunter2/);
});

test('a filled password is masked in the whole snapshot and in find; other fields keep their values', async () => {
  const { call, fill } = setup();
  fill();
  const whole = await call('snapshot', {});
  assert.doesNotMatch(whole.text, /hunter2/);
  assert.match(whole.text, /- textbox "Email" \[ref=e1\]: me@example\.com/);
  assert.match(whole.text, /- textbox "Password" \[ref=e2\]: "••••••••"/);
  assert.match(whole.text, /- textbox "Code" \[ref=e4\]: "••••••••"/);
  assert.match(whole.text, /- textbox "Spaced": "••••••••"/);
  assert.match(whole.text, /- button "Reveal" \[ref=e5\]: "••••••••"/);
  assert.doesNotMatch(whole.text, /alpha/);
  const found = await call('snapshot', { find: 'Password' });
  assert.match(found.text, /textbox "Password" \[ref=e2\]: "••••••••"/);
  assert.doesNotMatch(found.text, /hunter2/);
  assert.match((await call('snapshot', { find: SECRET })).text, /no line contains "hunter2-test"/);
});

test('when a frame\'s password scan fails, every line with a ref is looked up: a button-role password is still masked', async () => {
  const { call, fill } = setup({ scanFails: true });
  fill();
  const whole = await call('snapshot', {});
  assert.doesNotMatch(whole.text, /hunter2/);
  assert.match(whole.text, /- button "Reveal" \[ref=e5\]: "••••••••"/);
  assert.match(whole.text, /- textbox "Password" \[ref=e2\]: "••••••••"/);
  assert.match(whole.text, /- textbox "Spaced": "••••••••"/); // a text field without a ref can't be checked: masked
  assert.match(whole.text, /- button "Hidden reveal": "••••••••"/); // no ref, but its value is on its own line
  assert.match(whole.text, /- text: Forgot your password\?/); // page text stays
  assert.match(whole.text, /- textbox "Email" \[ref=e1\]: me@example\.com/);
});
