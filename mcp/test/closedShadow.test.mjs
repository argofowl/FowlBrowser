// s refs of closed shadow roots, against a fake tab answering the CDP calls closedShadow.mjs makes.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { closedShadowSection, focusShadowRef, shadowRefPoint } from '../src/closedShadow.mjs';

// A claimed-tab fake: host 10 has a closed root while there are `controls` (backendNodeIds, each a button) in it.
function fakeTab() {
  const tab = { documentGeneration: 0, controls: [], focused: [], scans: 0, page: { url: () => 'https://example.test/' } };
  const answers = {
    'DOM.getDocument': () => {
      tab.scans++;
      const shadowRoots = tab.controls.length ? [{ backendNodeId: 11, shadowRootType: 'closed', children: tab.controls.map((id) => ({ backendNodeId: id })) }] : [];
      return { root: { backendNodeId: 1, children: [{ backendNodeId: 10, shadowRoots }] } };
    },
    'Accessibility.queryAXTree': () => ({ nodes: tab.controls.map((id) => ({ backendDOMNodeId: id, role: { value: 'button' }, name: { value: `b${id}` } })) }),
    'DOM.focus': (params) => { tab.focused.push(params.backendNodeId); return {}; },
  };
  tab.browser = { host: { request: async (_, [, method, params]) => answers[method]?.(params) ?? {} } };
  return tab;
}

const refsOf = (section) => [...section.matchAll(/"b(\d+)" \[ref=(s\d+)\]/g)].map(([, id, ref]) => `${ref}=${id}`);

test('closed shadow s refs: stable within a document, never reused across documents', async () => {
  const tab = fakeTab();
  tab.controls = [101, 102];
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s1=101', 's2=102']);
  // Same document, a control added before the others: existing ones keep their numbers.
  tab.controls = [103, 101, 102];
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s3=103', 's1=101', 's2=102']);
  await focusShadowRef(tab, 's1');
  assert.deepEqual(tab.focused, [101]);

  // New document: old refs are refused before and after its scan; its controls get new numbers.
  tab.documentGeneration = 1;
  tab.controls = [201, 101]; // even a backendNodeId seen on the old document gets a new number
  await assert.rejects(focusShadowRef(tab, 's1'), /from an earlier page/);
  assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s4=201', 's5=101']);
  await assert.rejects(focusShadowRef(tab, 's1'), /from an earlier page/);
  await assert.rejects(focusShadowRef(tab, 's3'), /from an earlier page/);
  await focusShadowRef(tab, 's4');
  assert.deepEqual(tab.focused, [101, 201]);
  await assert.rejects(focusShadowRef(tab, 's9'), /unknown, stale/);

  // A document without closed roots still leaves the old numbers refused.
  tab.documentGeneration = 2;
  tab.controls = [];
  assert.equal(await closedShadowSection(tab), '');
  await assert.rejects(focusShadowRef(tab, 's4'), /from an earlier page/);
});

test('claimed tab without closed roots: a root attached later to an existing host is found once RESCAN_MS passed', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  try {
    const tab = fakeTab();
    assert.equal(await closedShadowSection(tab), '');
    assert.equal(tab.scans, 1);
    // The page attaches a closed root to host 10, already in the DOM: no light-DOM change to notice.
    tab.controls = [101];
    mock.timers.tick(9_999);
    assert.equal(await closedShadowSection(tab), '');
    assert.equal(tab.scans, 1);
    mock.timers.tick(1);
    assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s1=101']);
    assert.equal(tab.scans, 2);
    // A tab with roots scans on every snapshot.
    assert.deepEqual(refsOf(await closedShadowSection(tab)), ['s1=101']);
    assert.equal(tab.scans, 3);
  } finally {
    mock.timers.reset();
  }
});

// The cover check before an s ref click: the page scrolled by 1000 px, the control's box at (100, 50) in the viewport.
function hitTab(hitAt) {
  const tab = fakeTab();
  tab.controls = [101];
  const answers = {
    'Page.getLayoutMetrics': () => ({ cssLayoutViewport: { pageX: 0, pageY: 1000 } }),
    'DOM.getBoxModel': () => ({ model: { border: [90, 40, 110, 40, 110, 60, 90, 60] } }),
    // Document coordinates: only the scrolled point finds the node.
    'DOM.getNodeForLocation': ({ x, y }) => (x === 100 && y === 1050 ? { backendNodeId: hitAt } : {}),
    // The button's own ::after knob is a pseudo-element of it; 900 is something else.
    'DOM.describeNode': ({ backendNodeId }) => ({ node: backendNodeId === 101
      ? { backendNodeId: 101, pseudoElements: [{ backendNodeId: 1011, nodeName: '::after' }] }
      : { backendNodeId, localName: 'div', nodeName: 'DIV', attributes: ['id', 'banner'] } }),
  };
  const request = tab.browser.host.request;
  tab.browser.host.request = async (name, [target, method, params]) => (answers[method] ? answers[method](params) : request(name, [target, method, params]));
  return tab;
}

test('closed shadow click: hit test in document coordinates, the control\'s own pseudo-element is no cover', async () => {
  const knob = hitTab(1011);
  await closedShadowSection(knob);
  assert.deepEqual(await shadowRefPoint(knob, 's1'), { x: 100, y: 50 });

  const covered = hitTab(900);
  await closedShadowSection(covered);
  await assert.rejects(shadowRefPoint(covered, 's1'), /covered at its centre \(100, 50\) by <div#banner>/);
});

// An agent tab: each frame's document is a vm context the hook really runs in. The main frame got the init script and
// made one closed root; the cross-origin iframe (its own session, so no init script) is joined late by the snapshot.
test('agent tab: a late cross-origin iframe is not counted as holding the main frame\'s closed roots', async () => {
  const { EventEmitter } = await import('node:events');
  const vm = await import('node:vm');
  const { watchClosedShadow } = await import('../src/closedShadow.mjs');
  const documentContext = () => vm.createContext({ document: {}, Element: class { attachShadow({ mode }) { return { mode }; } }, ShadowRoot: class {}, Document: class {} });
  const frameOf = (context) => ({
    evaluate: async (fn, arg) => (typeof fn === 'string' ? vm.runInContext(fn, context) : vm.runInContext(`(${fn})`, context)(arg)),
  });
  const main = documentContext();
  const iframe = documentContext();
  const tab = fakeTab();
  tab.controls = [101];
  tab.page = Object.assign(new EventEmitter(), { url: () => 'https://example.test/', frames: () => [frameOf(main), frameOf(iframe)] });
  const request = tab.browser.host.request;
  let initScript;
  tab.browser.host.request = async (name, [target, method, params]) => {
    if (method === 'Page.addScriptToEvaluateOnNewDocument') { initScript = params.source; return {}; }
    return request(name, [target, method, params]);
  };
  await watchClosedShadow(tab, true);
  vm.runInContext(initScript, main);
  vm.runInContext('new Element().attachShadow({ mode: "closed" })', main);

  const first = await closedShadowSection(tab);
  assert.deepEqual(refsOf(first), ['s1=101']);
  assert.ok(!/cannot reach/.test(first));
  const second = await closedShadowSection(tab);
  assert.deepEqual(refsOf(second), ['s1=101']);
  assert.ok(!/cannot reach/.test(second), `a note about roots that do not exist:\n${second}`);
});

test('closed shadow controls: a password input shows a mask instead of its value; other fields keep theirs', async () => {
  const tab = fakeTab();
  const answers = {
    'DOM.getDocument': () => ({ root: { backendNodeId: 1, children: [{ backendNodeId: 10, shadowRoots: [{ backendNodeId: 11, shadowRootType: 'closed',
      children: [{ backendNodeId: 101 }, { backendNodeId: 102 }, { backendNodeId: 103 }] }] }] } }),
    'Accessibility.queryAXTree': () => ({ nodes: [101, 102, 103].map((id) => ({ backendDOMNodeId: id, role: { value: 'textbox' }, name: { value: `f${id}` },
      value: { value: id === 101 ? 'me@example.com' : 'hunter2-test' } })) }),
    // 101 is an email input, 102 a password input (type written in capitals), 103 can't be looked up (gone meanwhile).
    'DOM.describeNode': ({ backendNodeId }) => {
      if (backendNodeId === 103) throw new Error('No node with given id found');
      return { node: { localName: 'input', attributes: ['name', 'x', 'type', backendNodeId === 101 ? 'email' : 'PASSWORD'] } };
    },
  };
  tab.browser = { host: { request: async (_, [, method, params]) => answers[method]?.(params) ?? {} } };
  const section = await closedShadowSection(tab);
  assert.match(section, /- textbox "f101" \[ref=s\d+\]: "me@example\.com"/);
  assert.match(section, /- textbox "f102" \[ref=s\d+\]: "••••••••"/);
  assert.match(section, /- textbox "f103" \[ref=s\d+\]: "••••••••"/);
  assert.doesNotMatch(section, /hunter2/);
});
