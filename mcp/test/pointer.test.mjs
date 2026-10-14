// Pointer actions that can't happen: the reason read from Playwright's call log, and which box a scroll by ref moves.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Tab } from '../src/browsers.mjs';
import { blockedState, describeCover, NATIVE_UI_FN, onRef, performed, quickly, REF_POINT_FN, registerTools, SCROLL_TARGET_FN, selectOnce } from '../src/tools.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...lines) => `locator.click: Timeout 1000ms exceeded.\nCall log:\n${lines.map((l) => `\x1b[2m  - ${l}\x1b[22m`).join('\n')}`;

test('blockedState: a cover, disabled or hidden element is named from the last matching log line', () => {
  const banner = '<button id="accept">Accept all</button> from <div id="cookies" role="region">…</div> subtree';
  assert.deepEqual(blockedState(log('attempting click action', 'element is visible, enabled and stable', `${banner} intercepts pointer events`, 'retrying click action', 'waiting 20ms')),
    { kind: 'covered', by: '<button id="accept">Accept all</button> in <div id="cookies" role="region">…</div>' });
  assert.deepEqual(blockedState(log('attempting click action', '<span class="name">Express</span> intercepts pointer events')),
    { kind: 'covered', by: '<span class="name">Express</span>' });
  assert.deepEqual(blockedState(log('waiting for element to be visible, enabled and stable', 'element is not enabled', 'retrying click action')), { kind: 'disabled' });
  assert.deepEqual(blockedState(log('waiting for element to be visible, enabled and stable', '2 × element is not visible')), { kind: 'hidden' });
  assert.deepEqual(blockedState(log('element is outside of the viewport')), { kind: 'hidden' });
  // The latest state wins: covered first, then disabled.
  assert.deepEqual(blockedState(log('<div> intercepts pointer events', 'retrying click action', 'element is not enabled')), { kind: 'disabled' });
  // Not stable (animating), or no call log at all: no reason, so the action keeps its normal timeout.
  assert.equal(blockedState(log('waiting for element to be visible, enabled and stable', 'element is not stable')), null);
  assert.equal(blockedState('locator.click: Timeout 1000ms exceeded.'), null);
});

test('performed: done only with the "action done" line; performing without it is uncertain', () => {
  assert.equal(performed(log('element is visible, enabled and stable', 'performing click action', 'click action done', 'waiting for scheduled navigations to finish')), 'done');
  assert.equal(performed(log('element is visible, enabled and stable', 'performing click action')), 'started');
  assert.equal(performed(log('performing click action', '<div> intercepts pointer events', 'retrying click action', 'waiting 20ms')), null);
  assert.equal(performed(log('<div> intercepts pointer events', 'retrying click action')), null);
});

// A tab whose cursor is never shown, so pointed() only runs the action.
const tab = { tabId: 1, browser: { host: { request: async () => ({ shown: false }) } } };
const timeout = (...lines) => new Error(log(...lines));

test('quickly: a timeout while performing the input is an error and is never retried', async () => {
  let attempts = 0;
  const loc = { count: async () => 1 };
  await assert.rejects(quickly(tab, 'e5', loc, async () => { attempts++; throw timeout('performing click action'); }), /e5 started but did not finish .* may or may not have happened\. Call snapshot/);
  assert.equal(attempts, 1);
  attempts = 0;
  assert.equal(await quickly(tab, 'e5', loc, async () => { attempts++; throw timeout('performing click action', 'click action done', 'waiting for scheduled navigations to finish'); }), undefined, 'done: act() waits for the navigation');
  assert.equal(attempts, 1);
});

test('selectOnce: selectOption runs once even when it times out after dispatching; blocked states fail before it', async () => {
  const calls = [];
  const loc = (state) => ({
    count: async () => 1,
    evaluate: async () => state,
    selectOption: async (values, options) => { calls.push([values, options]); throw new Error('locator.selectOption: Timeout 10000ms exceeded.'); },
  });
  await assert.rejects(selectOnce(tab, 'e7', loc(null), ['Lisbon']), /Timeout 10000ms/);
  assert.deepEqual(calls, [[['Lisbon'], { timeout: undefined }]], 'one selectOption, with the normal timeout');
  calls.length = 0;
  await assert.rejects(selectOnce(tab, 'e7', loc('disabled'), ['Lisbon']), /e7 is disabled/);
  await assert.rejects(selectOnce(tab, 'e7', loc('hidden'), ['Lisbon']), /e7 is not visible/);
  assert.equal(calls.length, 0);
  const gone = { count: async () => 0, evaluate: async () => { throw new Error('locator.evaluate: Timeout 1000ms exceeded.'); }, selectOption: async () => calls.push(1) };
  await assert.rejects(selectOnce(tab, 'e7', gone, ['Lisbon']), /older snapshot/);
  assert.equal(calls.length, 0);
});

// A hidden checkbox or radio (state) whose label click does `onLabelClick` to it.
function hiddenInput(state, onLabelClick) {
  const clicks = [];
  const label = {
    evaluate: async () => ({ x: 12, y: 30, w: 200, h: 24, position: { x: 4, y: 12 } }), // LABEL_POINT_FN
    click: async (options) => { clicks.push(options); onLabelClick(state); },
  };
  let lookedUp = false;
  const loc = {
    count: async () => 1,
    evaluate: async () => ({ ...state }),
    evaluateHandle: async () => { lookedUp = true; return { asElement: () => label, dispose: async () => {} }; },
    elementHandle: async () => ({ dispose: async () => {} }),
  };
  const attempt = async () => { throw timeout('waiting for element to be visible, enabled and stable', 'element is not visible', 'retrying click action'); };
  return { loc, attempt, clicks, lookedUp: () => lookedUp };
}

test('label fallback: only for a plain click, and only when the label click set the state', async () => {
  const toggles = (s) => { s.checked = s.type === 'radio' ? true : !s.checked; };
  // right, middle, double or modified clicks: no fallback (want undefined), the clear error instead.
  const plainOnly = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  await assert.rejects(onRef(tab, 'e3', plainOnly.loc, plainOnly.attempt, undefined, undefined), /e3 is not visible/);
  assert.equal(plainOnly.lookedUp(), false);

  const works = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  assert.match(await onRef(tab, 'e3', works.loc, works.attempt, undefined, 'toggle'), /Clicked the label of e3 \(the checkbox itself is hidden under it\)/);
  assert.deepEqual(works.clicks[0].position, { x: 4, y: 12 }, "at the label's point nearest the input");

  const link = hiddenInput({ type: 'radio', checked: false }, () => {}); // a link in the label took the click
  await assert.rejects(onRef(tab, 'e4', link.loc, link.attempt, undefined, 'toggle'), /Clicked the label of e4 but the radio is still unchecked \(the label may hold a link/);

  const fill = hiddenInput({ type: 'checkbox', checked: false }, () => {});
  await assert.rejects(onRef(tab, 'e5', fill.loc, fill.attempt, undefined, true), /checkbox is still unchecked/);
  const filled = hiddenInput({ type: 'checkbox', checked: false }, toggles);
  assert.match(await onRef(tab, 'e5', filled.loc, filled.attempt, undefined, true), /Clicked the label of e5/);
});

test('describeCover: a candidate ref locator() refuses (s ref) is skipped, the cover is still named', async () => {
  const cover = { evaluate: async () => ({ tag: '<div#cookies>', name: 'Accept', text: 'Accept' }) };
  const loc = { evaluateHandle: async () => ({ asElement: () => cover, dispose: async () => {} }) };
  const coverTab = { documentGeneration: 1, snapshotBaseline: { generation: 1, text: '- button "Accept" [ref=s4]' } };
  assert.equal(await describeCover(coverTab, loc, 'fallback'), '<div#cookies> "Accept"');
});

// A tiny DOM: nodes with overflow, sizes and parents (a shadow host via getRootNode).
function node(name, { overflowY = 'visible', overflowX = 'visible', scroll = 0, scrollX = 0, parent = null, host = null } = {}) {
  return { name, style: { overflowY, overflowX }, scrollHeight: 100 + scroll, clientHeight: 100, scrollWidth: 100 + scrollX, clientWidth: 100,
    parentElement: parent, getRootNode: () => ({ host }) };
}

test('SCROLL_TARGET_FN: the element if it scrolls, else its nearest scrolling ancestor, never the page', () => {
  const body = node('body', { overflowY: 'auto', scroll: 5000 });
  globalThis.document = { body, documentElement: node('html') };
  globalThis.getComputedStyle = (n) => n.style;
  try {
    const list = node('list', { overflowY: 'auto', scroll: 35000, parent: body });
    const row = node('row', { parent: list });
    assert.equal(SCROLL_TARGET_FN(row, true)?.name, 'list');
    assert.equal(SCROLL_TARGET_FN(list, true)?.name, 'list');
    // Horizontal asks about the other axis: the list doesn't scroll sideways, so only the page is left.
    assert.equal(SCROLL_TARGET_FN(row, false), null);
    // overflow hidden with room is not a scroll box; one inside a shadow root reaches its host's box.
    const clipped = node('clipped', { overflowY: 'hidden', scroll: 500, parent: list });
    assert.equal(SCROLL_TARGET_FN(node('inner', { parent: clipped }), true)?.name, 'list');
    const host = node('host', { parent: list });
    assert.equal(SCROLL_TARGET_FN(node('shadowChild', { host }), true)?.name, 'list');
    // overflow auto whose content fits: nothing to scroll, skipped.
    const fits = node('fits', { overflowY: 'auto', parent: body });
    assert.equal(SCROLL_TARGET_FN(node('x', { parent: fits }), true), null);
  } finally {
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test('REF_POINT_FN: scrolls the element into view if needed and returns its box centre and size in one call', () => {
  let scrolled = 0;
  const el = { scrollIntoViewIfNeeded() { scrolled++; }, getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 40 }) };
  assert.deepEqual(REF_POINT_FN(el), { x: 60, y: 40, w: 100, h: 40 });
  assert.equal(scrolled, 1);
  assert.equal(REF_POINT_FN({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }), null);
});

test('REF_POINT_FN: on a page with smooth scrolling the element still out of view goes there at once, centred', () => {
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 780;
  try {
    let top = 1020; // smooth scrolling: scrollIntoViewIfNeeded only starts the scroll
    const calls = [];
    const el = {
      scrollIntoViewIfNeeded() { calls.push('ifNeeded'); },
      scrollIntoView(options) { calls.push(options); top = 370; },
      getBoundingClientRect: () => ({ left: 1000, top, right: 1064, bottom: top + 40, width: 64, height: 40 }),
    };
    assert.deepEqual(REF_POINT_FN(el), { x: 1032, y: 390, w: 64, h: 40 });
    assert.deepEqual(calls, ['ifNeeded', { block: 'center', inline: 'center', behavior: 'instant' }]);
  } finally {
    delete globalThis.innerWidth;
    delete globalThis.innerHeight;
  }
});

// fn(classes) with stand-ins for the DOM classes NATIVE_UI_FN checks (elements with no links or labels around them).
function withDom(fn) {
  const classes = { Node: class {}, Element: null, HTMLInputElement: null, HTMLSelectElement: null };
  classes.Element = class extends classes.Node {
    closest() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }; }
  };
  classes.HTMLInputElement = class extends classes.Element {};
  classes.HTMLSelectElement = class extends classes.Element {};
  Object.assign(globalThis, classes);
  try {
    return fn(classes);
  } finally {
    for (const name of Object.keys(classes)) delete globalThis[name];
  }
}
const classify = (make) => withDom((classes) => NATIVE_UI_FN(make(classes)));

test('NATIVE_UI_FN: a colour input or dropdown is refused while disabled too (the click waits for it to be enabled)', () => {
  const colour = (disabled) => classify(({ HTMLInputElement }) => Object.assign(new HTMLInputElement(), { type: 'color', value: '#3366ff', disabled }));
  const select = (disabled) => classify(({ HTMLSelectElement }) => Object.assign(new HTMLSelectElement(), { multiple: false, size: 0, disabled,
    options: [{ label: 'Free' }, { label: 'Pro' }] }));
  assert.deepEqual(colour(false), { kind: 'color', value: '#3366ff' });
  assert.deepEqual(colour(true), { kind: 'color', value: '#3366ff' });
  assert.deepEqual(select(true), { kind: 'select', options: ['Free', 'Pro'], more: 0 });
  assert.equal(classify(({ HTMLInputElement }) => Object.assign(new HTMLInputElement(), { type: 'text', disabled: true })), null);
});

test('a click on a page whose script hangs fails within its timeout, saying the page does not answer', async () => {
  let hung = false; // the page's main thread stuck in a script: nothing evaluated in it answers
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://app.example/', mainFrame: () => page, isClosed: () => false,
    ariaSnapshot: async () => '- button "Save" [ref=e1]',
    getByRef: () => ({ count: () => (hung ? new Promise(() => {}) : Promise.resolve(1)) }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false };
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'App' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 9, page);
  browser.tabs.set(9, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  await tools.snapshot({ tab: tab.id });
  hung = true;
  const started = Date.now();
  const result = await Promise.race([tools.click({ tab: tab.id, ref: 'e1', timeout_ms: 1000 }), new Promise((resolve) => setTimeout(resolve, 3000, null).unref())]);
  assert.ok(result, 'the call was still waiting after 3 s');
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /The page did not answer within 1 s \(its script is busy or stuck\)/);
});

test('a dropdown inside a closed shadow root (an s ref) is refused like any other: click and its opening keys', async () => {
  const clicks = [];
  const keys = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://travel.example/', mainFrame: () => page, isClosed: () => false,
    ariaSnapshot: async () => '- heading "Book" [level=1] [ref=e1]',
    mouse: { click: async (x, y) => { clicks.push([x, y]); } },
    keyboard: { press: async (key) => { keys.push(key); } },
  });
  // The page as the debugger sees it: host 10 holds a closed root with a <select> (backend node 101).
  const cdp = {
    'Target.getTargetInfo': () => ({ targetInfo: { title: 'Book' } }),
    'DOM.getDocument': () => ({ root: { backendNodeId: 1, children: [{ backendNodeId: 10, shadowRoots: [{ backendNodeId: 11, shadowRootType: 'closed', children: [{ backendNodeId: 101 }] }] }] } }),
    'Accessibility.queryAXTree': () => ({ nodes: [{ backendDOMNodeId: 101, role: { value: 'combobox' }, name: { value: 'Cabin' } }] }),
    'DOM.resolveNode': () => ({ object: { objectId: 'select-101' } }),
    // Runs the page function on a stand-in <select>, as Chrome would on the node.
    'Runtime.callFunctionOn': ({ functionDeclaration }) => withDom((classes) => {
      const select = Object.assign(new classes.HTMLSelectElement(), { multiple: false, size: 0, options: [{ label: 'Economy' }, { label: 'Business' }] });
      // eslint-disable-next-line no-new-func
      return { result: { value: new Function(`return (${functionDeclaration})`)().call(select) } };
    }),
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { pageX: 0, pageY: 0 } }),
    'DOM.getBoxModel': () => ({ model: { border: [90, 40, 110, 40, 110, 60, 90, 60] } }),
    'DOM.getNodeForLocation': () => ({ backendNodeId: 101 }),
  };
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand') return cdp[params[1]]?.(params[2]) ?? {};
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 12, page);
  browser.tabs.set(12, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const text = async (name, args) => (await tools[name]({ tab: tab.id, ...args })).content.map((c) => c.text).join('\n');
  assert.match(await text('snapshot', {}), /combobox "Cabin" \[ref=s1\]/);
  assert.match(await text('click', { ref: 's1', snapshot: false }), /Error: Ref s1 is a dropdown \(<select>\)\. A click opens its menu .*options: Economy, Business/);
  assert.match(await text('press_key', { ref: 's1', key: 'Space', snapshot: false }), /Error: .* is a dropdown .*Pressing Space on it opens its menu/);
  assert.deepEqual([clicks, keys], [[], []], 'nothing reached the page');
});

test('a click x,y on a dropdown in an iframe shown scaled (a zoomed preview) is refused: the point is mapped by the scale too', async () => {
  const clicks = [];
  // The iframe: 800x600 inside, shown at half size from (50, 50). Its <select> is at (200, 100) in its own page.
  const child = {
    evaluate: async (fn, at) => (at && Math.abs(at.x - 200) < 20 && Math.abs(at.y - 100) < 10
      ? { kind: 'select', options: ['Small', 'Large'], more: 0 } : null),
  };
  const iframe = (classes) => Object.assign(new classes.Element(), { localName: 'iframe', offsetWidth: 800, offsetHeight: 600, clientLeft: 0, clientTop: 0,
    getBoundingClientRect: () => ({ left: 50, top: 50, width: 400, height: 300 }) });
  const main = {
    evaluate: async (fn, at) => withDom((classes) => {
      globalThis.document = { elementFromPoint: () => iframe(classes) };
      try { return fn(at); } finally { delete globalThis.document; }
    }),
    evaluateHandle: async () => ({ asElement: () => ({ contentFrame: async () => child }), dispose: async () => {} }),
  };
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://storybook.example/', mainFrame: () => main, isClosed: () => false,
    mouse: { click: async (x, y) => { clicks.push([x, y]); } },
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Preview' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 13, page);
  browser.tabs.set(13, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  const result = await tools.click({ tab: tab.id, x: 150, y: 100, snapshot: false });
  assert.match(result.content[0].text, /Error: The element at 150,100 is a dropdown \(<select>\)/);
  assert.deepEqual(clicks, []);
});

test('a click on a dropdown while the page stalls past a second is still refused: the check waits as the click would', async () => {
  const clicks = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://plans.example/', mainFrame: () => page, isClosed: () => false,
    ariaSnapshot: async () => '- combobox "Plan" [ref=e1]',
    getByRef: () => ({
      count: async () => 1,
      // The page's thread is stuck for 1.5 s: an evaluate answers then, or fails at its own timeout.
      async evaluate(fn, arg, { timeout } = {}) {
        await sleep(Math.min(1500, timeout));
        if (timeout < 1500) throw new Error(`locator.evaluate: Timeout ${timeout}ms exceeded.`);
        return withDom((classes) => fn(Object.assign(new classes.HTMLSelectElement(), { multiple: false, size: 0, options: [{ label: 'Free' }, { label: 'Pro' }] })));
      },
      async click() { clicks.push('click'); },
    }),
  });
  const host = {
    async request(method, params) {
      if (method === 'tabs.isShown') return { shown: false };
      if (method === 'tabs.expectChild') return {};
      if (method === 'chrome.debugger.sendCommand' && params[1] === 'Target.getTargetInfo') return { targetInfo: { title: 'Plans' } };
      throw new Error(`not in this double: ${method}`);
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), relay: { viewports: new Map(), model: { hasTab: () => true, _knownTabs: new Map() } } };
  browser.waitForTab = async (id) => browser.tabs.get(id);
  const tab = new Tab(browser, 15, page);
  browser.tabs.set(15, tab);
  const tools = {};
  registerTools({ registerTool: (name, meta, handler) => { tools[name] = handler; } }, { get: async () => browser, all: async () => [browser] });
  await tools.snapshot({ tab: tab.id });
  const result = await tools.click({ tab: tab.id, ref: 'e1', snapshot: false });
  assert.match(result.content[0].text, /Error: Ref e1 is a dropdown/);
  assert.deepEqual(clicks, []);
});
