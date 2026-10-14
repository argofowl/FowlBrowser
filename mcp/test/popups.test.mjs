// Popup scripts (src/popups.mjs): what the MAIN-world script decides for each kind of open (run in a vm with a
// stand-in window), how they are installed and removed over raw CDP, the page's reports, and release removing them.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import vm from 'node:vm';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
import { Browser, Tab } from '../src/browsers.mjs';
import { BACKGROUND_CLICK_FN, backgroundClick, installPopups, openingLines, pageScripts, uninstallPopups } from '../src/popups.mjs';
import { USER_BINDING, watchUserInput } from '../src/takeover.mjs';
import { registerTools } from '../src/tools.mjs';

// A window with a native-looking open/close, and an isolated world that takes every open it is handed (unless
// `take` is false). Returns the vm context plus what reached the isolated world and the native functions.
function page({ active = true, take = true, frames = [], origin = 'https://site.example', before = '' } = {}) {
  const handed = [];
  const native = [];
  const order = []; // both, in turn
  const listeners = [];
  const context = vm.createContext({
    URL,
    navigator: { userActivation: { isActive: active } },
    document: {
      baseURI: 'https://site.example/dir/page.html',
      querySelectorAll: () => frames,
      querySelector: () => null,
    },
    // What reaches the isolated world (document only); window's listeners like the DOM: the same one is added once.
    hooks: {
      dispatch: (e) => { handed.push(JSON.parse(e.detail)); order.push(`handed ${handed.at(-1).type}`); return !(take && e.cancelable); },
      listen: (type, fn, capture) => listeners.some((l) => l.type === type && l.fn === fn && l.capture === !!capture) || listeners.push({ type, fn, capture: !!capture }),
      unlisten: (type, fn, capture) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture); if (i >= 0) listeners.splice(i, 1); },
    },
    record: (...call) => { native.push(call); order.push(`native ${call[0]}`); }, // arrays and objects of this realm, for deepEqual
    newWindow: () => ({ closed: false }),
    setTimeout, clearTimeout,
    origin,
  });
  vm.runInContext(`
    globalThis.window = globalThis; globalThis.parent = globalThis; globalThis.top = globalThis; globalThis.name = '';
    globalThis.clock = null; const realNow = Date.now; Date.now = () => clock ?? realNow(); // set clock to move time
    globalThis.EventTarget = class {};
    EventTarget.prototype.dispatchEvent = function (e) { return hooks.dispatch(e); };
    EventTarget.prototype.addEventListener = function (...a) { return hooks.listen(...a); };
    EventTarget.prototype.removeEventListener = function (...a) { return hooks.unlisten(...a); };
    globalThis.addEventListener = EventTarget.prototype.addEventListener; globalThis.removeEventListener = EventTarget.prototype.removeEventListener;
    document.dispatchEvent = EventTarget.prototype.dispatchEvent;
    globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
    globalThis.Event = class { stopImmediatePropagation() { this.stopped = true; } composedPath() { return this.path ?? []; } };
    // Modifiers behind native-like accessors, as in Blink (instances have no own metaKey).
    globalThis.MouseEvent = class extends Event {
      #keys;
      constructor({ metaKey = false, ctrlKey = false, ...init } = {}) { super(); this.#keys = { metaKey, ctrlKey }; Object.assign(this, { button: 0 }, init); }
      get metaKey() { return this.#keys.metaKey; }
      get ctrlKey() { return this.#keys.ctrlKey; }
      getModifierState(key) { return key === 'Meta' ? this.#keys.metaKey : key === 'Control' ? this.#keys.ctrlKey : false; }
    };
    const accessor = (key) => Object.getOwnPropertyDescriptor(MouseEvent.prototype, key).get;
    globalThis.mouseNow = () => [accessor('metaKey'), accessor('ctrlKey'), MouseEvent.prototype.getModifierState];
    globalThis.mouseNatives = mouseNow();
    globalThis.open = function open() { record('open', ...arguments); return newWindow(); };
    globalThis.close = function close() { record('close'); };
    globalThis.nativeOpen = open; globalThis.nativeClose = close; globalThis.realToString = Function.prototype.toString;
  `, context);
  vm.runInContext(before, context);
  vm.runInContext(`(${pageScripts.main})('fowlbrowser-test')`, context);
  const run = (code) => vm.runInContext(code, context);
  // A trusted click on a link: the capture listener arms the bubble one, which decides.
  const clickLink = (attributes, init = {}) => {
    let prevented = false;
    const link = { localName: 'a', href: new URL(attributes.href, 'https://site.example/dir/').href, referrerPolicy: '',
      getAttribute: (n) => attributes[n] ?? null, hasAttribute: (n) => n in attributes };
    const event = run('(init) => new MouseEvent(init)')({ isTrusted: true, defaultPrevented: false, ...init });
    Object.assign(event, { composedPath: () => [link], preventDefault: () => { prevented = true; } });
    for (const { fn } of listeners.filter((l) => l.type === 'click' && l.capture)) fn(event);
    for (const { fn } of listeners.filter((l) => l.type === 'click' && !l.capture)) fn(event);
    return prevented;
  };
  // A key event as the browser sends it, through the window capture listeners; true when the page would see it.
  const key = (init) => {
    const event = run('(init) => Object.assign(new Event(), init)')({ isTrusted: true, ...init });
    for (const { fn } of listeners.filter((l) => l.type === init.type && l.capture)) if (!event.stopped) fn(event);
    return !event.stopped;
  };
  // A trusted input event of another type (mousedown, pointerup...) through the window capture listeners.
  const input = (type, init = {}) => {
    const event = run('(init) => new MouseEvent(init)')({ type, isTrusted: true, ...init });
    for (const { fn } of listeners.filter((l) => l.type === type && l.capture)) fn(event);
    return event;
  };
  return { context, run, handed, native, order, clickLink, key, input };
}

test('opens that need no opener go to the isolated world and the page gets null, as natively', () => {
  const p = page();
  assert.equal(p.run(`window.open('next.html', '_blank', 'noopener')`), null);
  p.input('mousedown'); // a new activation
  assert.equal(p.run(`window.open('https://other.example/', 'x', 'width=300, noreferrer')`), null);
  assert.deepEqual(p.handed, [
    { type: 'open', url: 'https://site.example/dir/next.html' },
    { type: 'open', url: 'https://other.example/' },
  ]);
  assert.deepEqual(p.native, []);

  // Refused (the debugger is gone, or no isolated world in that frame): the native call runs as asked, and from then
  // on the natives are back.
  const lone = page({ take: false });
  lone.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.deepEqual(lone.native, [['open', 'next.html', '_blank', 'noopener']]);
  assert.equal(lone.run('window.open === nativeOpen && window.close === nativeClose && Function.prototype.toString === realToString'), true);
});

test('a refused opener-keeping open (debugger gone) runs natively with its features and switches the wrappers off', () => {
  const p = page({ take: false });
  p.run(`window.open('https://idp.example/auth', 'idp', 'popup,width=480')`);
  assert.deepEqual(p.handed, [{ type: 'live' }]);
  assert.deepEqual(p.native, [['open', 'https://idp.example/auth', 'idp', 'popup,width=480']]);
  assert.equal(p.run('window.open === nativeOpen'), true);
  assert.equal(p.clickLink({ href: 'target.html', target: '_blank' }), false, 'links are native too');
});

test('the private event goes through the dispatchEvent of document start: a page that wraps it later learns nothing', () => {
  const p = page();
  p.run(`globalThis.leaked = []; const real = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = document.dispatchEvent = function (e) { leaked.push(e.type); return real.call(this, e); };`);
  p.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.equal(p.handed.length, 1);
  assert.equal(p.run('leaked.length'), 0);
});

test('window.open that may need its opener runs for real, as a tab: popup features are dropped', () => {
  const p = page();
  const w = p.run(`window.open('https://idp.example/auth', 'idp', 'popup,width=480,height=640')`);
  assert.deepEqual(w, { closed: false });
  assert.deepEqual(p.native, [['open', 'https://idp.example/auth', 'idp', '']]);
  assert.deepEqual(p.handed, [{ type: 'live' }]); // the isolated world says the debugger is still there
  // noopener=0 is not noopener.
  p.run(`window.open('a.html', '_blank', 'noopener=0,left=10')`);
  assert.deepEqual(p.native.at(-1), ['open', 'a.html', '_blank', '']);
  // The window it named now exists, so a noopener open of that name navigates it natively.
  p.run(`window.open('b.html', 'idp', 'noopener')`);
  assert.deepEqual(p.native.at(-1), ['open', 'b.html', 'idp', 'noopener']);
});

test('a script\'s click on a colour input is refused wherever the input is (a closed shadow root too); other inputs click', () => {
  const p = page({ before: `globalThis.HTMLElement = class extends EventTarget { click() { record('click', this.type); } };
    globalThis.HTMLInputElement = class extends HTMLElement {};` });
  p.run(`const c = new HTMLInputElement(); c.type = 'color'; c.click(); HTMLElement.prototype.click.call(c);`);
  assert.deepEqual(p.native, []);
  assert.deepEqual(p.handed.map((h) => h.what), ['the colour window', 'the colour window']);
  p.run(`const t = new HTMLInputElement(); t.type = 'checkbox'; t.click(); const d = new HTMLInputElement(); d.type = 'color'; d.disabled = true; d.click();`);
  assert.deepEqual(p.native, [['click', 'checkbox'], ['click', 'color']]);
});

test('everything else is left to the browser untouched', () => {
  const cases = [
    `window.open('', '_blank', 'popup')`, // then document.write: needs the real window
    `window.open('about:blank', '_blank', 'popup')`,
    `window.open('javascript:void 0', '_blank', 'noopener')`,
    `window.open('next.html', '_self', 'noopener')`,
    `window.open('next.html', 'side', 'noopener')`, // an iframe of that name exists
  ];
  for (const code of cases) {
    const p = page({ frames: [{ name: 'side' }] });
    p.run(code);
    assert.equal(p.handed.length, 0, code);
    assert.equal(p.native.length, 1, code);
    assert.ok(/popup|noopener/.test(p.native[0][3]), `${code}: features kept`);
  }
  const idle = page({ active: false }); // no user activation: not the agent's click (the browser blocks it anyway)
  idle.run(`window.open('next.html', 'x', 'popup')`);
  assert.deepEqual(idle.native, [['open', 'next.html', 'x', 'popup']]);
  const modified = page(); // a real modified click already picks a background tab or a new window
  modified.run(`window.event = new MouseEvent({ metaKey: true }); window.open('next.html', 'x', 'popup')`);
  assert.deepEqual(modified.native, [['open', 'next.html', 'x', 'popup']]);
});

test('links that open a new context without an opener are replaced; the rest (named targets keep their opener) keep their default action', () => {
  const p = page({ frames: [{ name: 'side' }] });
  assert.equal(p.clickLink({ href: 'target.html', target: '_blank' }), true);
  assert.equal(p.clickLink({ href: 'target.html', target: 'fresh', rel: 'noreferrer' }), true);
  assert.deepEqual(p.handed, [
    { type: 'open', url: 'https://site.example/dir/target.html' },
    { type: 'open', url: 'https://site.example/dir/target.html' },
  ]);
  const kept = [
    [{ href: 'target.html', target: '_blank', rel: 'opener' }],
    [{ href: 'target.html' }],
    [{ href: 'target.html', target: 'side' }],
    [{ href: 'target.html', target: 'fresh' }], // a new named context: it has an opener (HTML: only _blank implies noopener)
    [{ href: 'file.zip', target: '_blank', download: '' }],
    [{ href: 'mailto:a@b.example', target: '_blank' }],
    [{ href: 'target.html', target: '_blank' }, { metaKey: true }],
    [{ href: 'target.html', target: '_blank' }, { button: 1 }],
    [{ href: 'target.html', target: '_blank' }, { isTrusted: false }],
    [{ href: 'target.html', target: '_blank' }, { defaultPrevented: true }],
  ];
  for (const [attributes, init] of kept) assert.equal(p.clickLink(attributes, init), false, JSON.stringify([attributes, init]));
  assert.equal(p.handed.length, 2);
});

test('window.close is reported once it ran; the wrappers look native and the off-switch restores the originals', () => {
  const p = page();
  p.run('window.close()');
  assert.deepEqual(p.order, ['native close', 'handed close']);
  assert.equal(p.run('window.open.name'), 'open');
  assert.equal(p.run('window.open.length'), 0);
  assert.equal(p.run('window.open.toString()'), p.run('realToString.call(nativeOpen)'));
  assert.equal(p.run('Function.prototype.toString.toString()'), p.run('realToString.call(realToString)'));

  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // a second install changes nothing
  p.run(`window.open('x.html', '_blank', 'noopener')`);
  assert.equal(p.handed.length, 2);

  p.run(`window[Symbol.for('fowlbrowser.popups')].off()`);
  assert.equal(p.run('window.open === nativeOpen && window.close === nativeClose && Function.prototype.toString === realToString'), true);
  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // installed again (a resumed tab): on again
  assert.equal(p.run('window.open === nativeOpen'), false);
});

test('one open per activation, as the browser consumes it: later ones in it get null, whatever their features; an opaque origin is left to the browser', () => {
  const p = page();
  const open = () => p.run(`window.open('next.html', '_blank', 'noopener')`);
  open();
  // Same activation: natively the first open used it up, so these are blocked, popup features or not.
  for (const call of [`'next.html', '_blank', 'noopener'`, `'https://other.example/', '_blank', 'popup,width=400'`, `'https://idp.example/', 'idp'`, `''`]) {
    assert.equal(p.run(`window.open(${call})`), null, call);
  }
  assert.deepEqual([p.handed.length, p.native], [1, []]);
  p.run(`window.open('https://site.example/', '_self')`); // not a new context: as is
  assert.deepEqual(p.native, [['open', 'https://site.example/', '_self']]);
  p.native.length = 0;
  p.input('click'); // not activation-triggering
  p.input('pointerup', { pointerType: 'mouse' });
  p.input('mousedown', { isTrusted: false });
  open();
  assert.equal(p.handed.length, 1);
  for (const [type, init] of [['mousedown'], ['pointerdown'], ['keydown'], ['pointerup', { pointerType: 'touch' }], ['touchend']]) {
    p.input(type, init);
    open();
  }
  assert.equal(p.handed.length, 6, 'each activation-triggering input allows one more');
  // Once the activation is over the browser decides (its popup blocker, or the site's popup permission).
  p.run(`navigator.userActivation.isActive = false`);
  p.run(`window.open('https://other.example/', '_blank', 'popup')`);
  assert.deepEqual(p.native, [['open', 'https://other.example/', '_blank', 'popup']]);

  // A sandbox without allow-same-origin may also lack allow-popups: the browser decides, for opens and links.
  const sandboxed = page({ origin: 'null' });
  sandboxed.run(`window.open('next.html', '_blank', 'noopener')`);
  assert.deepEqual([sandboxed.handed, sandboxed.native], [[], [['open', 'next.html', '_blank', 'noopener']]]);
  assert.equal(sandboxed.clickLink({ href: 'target.html', target: '_blank' }), false);
});

test('hidden-modifier window: opened by the agent click\'s own modifier keydown, for a moment; the page reads no Cmd or Ctrl on its trusted mouse events and never gets the key', async () => {
  const p = page();
  p.run(`globalThis.target = { id: 'button' }; globalThis.elsewhere = { id: 'other' };`);
  const control = (call) => p.run(`window[Symbol.for('fowlbrowser.popups')].${call}`);
  // A Cmd-click as the browser dispatches it: the window capture listeners see it first, then the page reads it.
  const dispatch = (on, { isTrusted = true, metaKey = true, type = 'mousedown' } = {}) => {
    const e = p.input(type, { metaKey, ctrlKey: metaKey, isTrusted, path: p.run(on) ? [{ id: 'child' }, p.run(on), p.context] : [] });
    e.path = []; // composedPath() is empty once dispatch is over
    return e;
  };
  const read = (e) => p.run('(e) => [e.metaKey, e.ctrlKey, e.getModifierState("Meta"), e.getModifierState("Control")]')(e);
  const meta = (type, isTrusted = true) => p.key({ type, key: 'Meta', isTrusted });
  const plain = [false, false, false, false];
  const held = [true, true, true, true];
  assert.deepEqual([...read(dispatch('target'))], held, 'closed: everything as is');
  assert.equal(meta('keydown'), true);

  assert.equal(control(`hide(10000, target, 't1')`), true);
  // Armed while Playwright waits for the element: the user's own Cmd-click and keys still read as they are.
  assert.deepEqual([...read(dispatch('target'))], held, 'before the click starts');
  assert.equal(meta('keyup'), true);
  assert.equal(meta('keydown'), false, 'the click\'s modifier opens the window, and is stopped');
  const agents = dispatch('target');
  assert.deepEqual([...read(agents)], plain, 'the agent\'s click on its element');
  assert.deepEqual([...read(dispatch('target', { type: 'click' }))], plain);
  assert.deepEqual([...read(dispatch('elsewhere'))], held, 'the user\'s own Cmd-click elsewhere');
  assert.deepEqual([...read(dispatch('target', { isTrusted: false }))], held, 'synthetic');
  assert.equal(p.run(`(e) => e.getModifierState('Shift')`)(agents), false);
  assert.deepEqual([meta('keydown'), meta('keyup'), p.key({ type: 'keydown', key: 'Control' })], [false, false, false], 'the modifier key is stopped');
  assert.deepEqual([p.key({ type: 'keydown', key: 'a' }), meta('keydown', false)], [true, true], 'other keys and synthetic events pass');
  // Their own window.open still takes the opener-keeping path (the page script reads the masked event too).
  p.run('(e) => { window.event = e; }')(dispatch('target', { type: 'click' }));
  p.run(`window.open('https://idp.example/auth', 'idp', 'popup')`);
  assert.deepEqual(p.native.at(-1), ['open', 'https://idp.example/auth', 'idp', '']);

  control(`show('t1')`);
  assert.deepEqual([...read(agents)], plain, 'an event the page kept reads the same after the window closed');
  assert.deepEqual([...read(dispatch('target'))], held, 'closed again');
  assert.equal(meta('keydown'), true);

  // The window is short: after a second nothing is hidden, and only another modifier keydown (a retried click) opens it.
  control(`hide(10000, target, 't5')`);
  p.run(`clock = Date.now()`);
  meta('keydown');
  p.run(`clock += 1001`);
  assert.deepEqual([...read(dispatch('target'))], held);
  assert.equal(meta('keyup'), true);
  assert.equal(meta('keydown'), false);
  assert.deepEqual([...read(dispatch('target'))], plain);
  p.run(`clock = null`);
  control(`show('t5')`);

  // Never left armed: disarmed by itself after capMs (a detach mid-click), and on the off-switch.
  control(`hide(20, target, 't2')`);
  meta('keydown');
  assert.deepEqual([...read(dispatch('target'))], plain);
  await sleepMs(40);
  assert.deepEqual([...read(dispatch('target'))], held);
  assert.equal(meta('keydown'), true);
  control(`hide(10000, target, 't3')`);
  meta('keydown');
  control('off()');
  assert.deepEqual([...read(dispatch('target'))], held);
  assert.equal(control(`hide(10000, target, 't4')`), false, 'off: no window');
  assert.equal(meta('keydown'), true);
});

test('hidden-modifier window: a probe that lands after its window was closed never opens it again', () => {
  const p = page();
  p.run(`globalThis.target = {};`);
  const control = (call) => p.run(`window[Symbol.for('fowlbrowser.popups')].${call}`);
  control(`show('late')`); // the click gave up on its probe and closed the window first
  assert.equal(control(`hide(10000, target, 'late')`), false);
  assert.equal(p.key({ type: 'keydown', key: 'Meta' }), true, 'nothing masked');
  // A stale close leaves the current click's window open.
  control(`hide(10000, target, 'now')`);
  control(`show('late')`);
  assert.equal(p.key({ type: 'keydown', key: 'Meta' }), false);
  control(`show('now')`);
  assert.equal(p.key({ type: 'keydown', key: 'Meta' }), true);
});

test('hidden-modifier window: the patched getters look native and the off-switch puts the originals back', () => {
  const p = page();
  p.run(`(${pageScripts.main})('fowlbrowser-test')`); // already installed: no second patch
  assert.equal(p.run('mouseNow().every((fn, i) => fn !== mouseNatives[i])'), true, 'patched while on');
  assert.equal(p.run('mouseNow().every((fn, i) => fn.toString() === realToString.call(mouseNatives[i]))'), true);
  assert.equal(p.run('mouseNow().every((fn, i) => fn.name === mouseNatives[i].name && fn.length === mouseNatives[i].length)'), true);
  assert.equal(p.run('mouseNow()[0].name'), 'get metaKey');
  p.run(`window[Symbol.for('fowlbrowser.popups')].off()`);
  assert.equal(p.run('mouseNow().every((fn, i) => fn === mouseNatives[i])'), true, 'originals back');
  p.run(`(${pageScripts.main})('fowlbrowser-test')`);
  assert.equal(p.run('mouseNow().every((fn, i) => fn !== mouseNatives[i])'), true, 'on again');
});

// BACKGROUND_CLICK_FN on stand-in elements: the decision table, and the hidden-modifier window it opens. `tree` runs
// from the outside in; the click's target is tree[target] (default the last), and the element at the click point is
// the last one unless `covered` names another.
function probe(tree, { focused = null, control = { hide: () => true }, target = tree.length - 1, covered, box = { left: 10, top: 10, right: 30, bottom: 20 }, seen = {} } = {}) {
  const context = vm.createContext({ innerWidth: 800, innerHeight: 600 });
  vm.runInContext('globalThis.window = globalThis;', context);
  const make = (spec, parent = null) => {
    const { tag, attrs = {}, type, form = null, editable = false, root = false, shadowHost = null } = spec;
    return {
      localName: tag, type, form, isContentEditable: editable, parentElement: parent,
      getRootNode: () => ({ host: root ? shadowHost : undefined }),
      hasAttribute: (n) => n in attrs, getAttribute: (n) => attrs[n] ?? null,
    };
  };
  const nodes = [];
  for (const spec of tree) nodes.push(make(spec, spec.root ? null : nodes.at(-1)));
  const el = nodes[target];
  Object.assign(el, { scrollIntoViewIfNeeded: () => { seen.scrolled = true; }, getClientRects: () => [box] });
  const hit = covered ?? nodes.at(-1);
  context.document = { activeElement: focused, elementFromPoint: (x, y) => { seen.point = [x, y]; return hit; } };
  if (control) context[Symbol.for('fowlbrowser.popups')] = control;
  return vm.runInContext(`(${BACKGROUND_CLICK_FN})`, context)(el, { capMs: 10000, token: 'tok' });
}

test('background click probe: plain buttons and click-handler elements qualify; links, submits, fields, labels, toggles and rows do not', () => {
  const form = {};
  const yes = [
    [{ tag: 'body' }, { tag: 'button', type: 'button' }],
    [{ tag: 'body' }, { tag: 'form' }, { tag: 'button', type: 'button', form }],
    [{ tag: 'body' }, { tag: 'button', type: 'submit', form: null }], // submit outside any form submits nothing
    [{ tag: 'body' }, { tag: 'div', attrs: { role: 'button' } }, { tag: 'span' }],
    [{ tag: 'body' }, { tag: 'div' }],
    [{ tag: 'body' }, { tag: 'input', type: 'button' }],
  ];
  const no = [
    [{ tag: 'body' }, { tag: 'a', attrs: { href: '/x' } }, { tag: 'span' }],
    [{ tag: 'body' }, { tag: 'a' }, { tag: 'span' }], // no href yet: its mousedown handler may give it one
    [{ tag: 'body' }, { tag: 'a', attrs: { role: 'button' } }],
    [{ tag: 'map' }, { tag: 'area' }],
    [{ tag: 'map' }, { tag: 'area', attrs: { href: '/x' } }],
    [{ tag: 'form' }, { tag: 'button', type: 'submit', form }, { tag: 'span' }],
    [{ tag: 'form' }, { tag: 'input', type: 'submit', form }],
    [{ tag: 'form' }, { tag: 'input', type: 'image', form }],
    [{ tag: 'body' }, { tag: 'input', type: 'text' }],
    [{ tag: 'body' }, { tag: 'input', type: 'checkbox' }],
    [{ tag: 'body' }, { tag: 'textarea' }],
    [{ tag: 'body' }, { tag: 'select' }, { tag: 'option' }],
    [{ tag: 'body' }, { tag: 'label' }, { tag: 'span' }],
    [{ tag: 'body' }, { tag: 'div', editable: true }],
    ...['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'row', 'gridcell', 'treeitem']
      .map((role) => [{ tag: 'body' }, { tag: 'div', attrs: { role: ` ${role.toUpperCase()} button` } }]),
    [{ tag: 'body' }, { tag: 'div', attrs: { role: 'row' } }, { tag: 'button', type: 'button' }],
  ];
  for (const tree of yes) assert.equal(probe(tree), true, JSON.stringify(tree));
  for (const tree of no) assert.equal(probe(tree), false, JSON.stringify(tree));

  // Across a shadow root: a button in a component inside a link is still inside the link.
  const link = { tag: 'a', attrs: { href: '/x' } };
  const host = { localName: 'x-card', parentElement: null, getRootNode: () => ({}), hasAttribute: (n) => n === 'href' && false, getAttribute: () => null };
  const inLink = { localName: 'x-card', parentElement: { localName: 'a', parentElement: null, getRootNode: () => ({}), hasAttribute: (n) => n in link.attrs, getAttribute: (n) => link.attrs[n] ?? null }, getRootNode: () => ({}), hasAttribute: () => false, getAttribute: () => null };
  assert.equal(probe([{ tag: 'button', type: 'button', root: true, shadowHost: inLink }]), false);
  assert.equal(probe([{ tag: 'button', type: 'button', root: true, shadowHost: host }]), true);

  // Focus in a frame (the modifier's key events would go there), or no page script (or switched off): no modifier.
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'iframe' } }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'x-app', shadowRoot: { activeElement: { localName: 'iframe' } } } }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { focused: { localName: 'input' } }), true);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { control: null }), false);
  assert.equal(probe([{ tag: 'button', type: 'button' }], { control: { hide: () => false } }), false);
  let asked;
  probe([{ tag: 'button', type: 'button' }], { control: { hide: (...args) => { asked = args; return true; } } });
  assert.deepEqual([asked[0], asked[1].localName, asked[2]], [10000, 'button', 'tok'], 'the window is opened for this element, with its cap and token');
});

test('background click probe: judged on the element the click really hits, which must be the target or inside it', () => {
  const seen = {};
  // Playwright clicks the middle of the first box, clipped to the viewport, after scrolling it into view.
  assert.equal(probe([{ tag: 'body' }, { tag: 'div', attrs: { role: 'button' } }, { tag: 'span' }], { target: 1, box: { left: -10, top: 0, right: 30, bottom: 20 }, seen }), true);
  assert.deepEqual(seen, { scrolled: true, point: [15, 10] });
  // A link (or a field, a toggle...) inside the target, where the click lands: it would follow the link with the modifier.
  assert.equal(probe([{ tag: 'body' }, { tag: 'div', attrs: { role: 'button' } }, { tag: 'a', attrs: { href: '/next' } }], { target: 1 }), false);
  assert.equal(probe([{ tag: 'body' }, { tag: 'div' }, { tag: 'input', type: 'checkbox' }], { target: 1 }), false);
  // Something else on top, or nothing in the viewport: no modifier.
  assert.equal(probe([{ tag: 'body' }, { tag: 'button', type: 'button' }], { covered: { localName: 'div', parentElement: null, getRootNode: () => ({}) } }), false);
  assert.equal(probe([{ tag: 'body' }, { tag: 'button', type: 'button' }], { box: { left: -40, top: 0, right: -10, bottom: 20 } }), false);
  assert.equal(probe([{ tag: 'body' }, { tag: 'div' }, { tag: 'span', editable: true }], { target: 1 }), false);
});

test('background click: only in tabs with the scripts; the modifier is lifted and the window closed afterwards, whatever happened', async () => {
  const { tab, commands } = fakeTab();
  const keys = [];
  tab.page.keyboard = { up: async (key) => keys.push(key) };
  const asked = [];
  const loc = (answer) => ({ evaluate: async (fn, arg) => { asked.push(arg); return answer(); } });
  const clicks = [];
  const click = async (modifiers) => { clicks.push(modifiers); return 'clicked'; };
  const shown = () => commands.filter(([m]) => m === 'Runtime.evaluate').map(([, p]) => p.expression);

  assert.equal(await backgroundClick(tab, loc(() => true), 15000, click), 'clicked');
  assert.deepEqual([asked, clicks], [[], [undefined]], 'no scripts: no probe, no modifier');
  await installPopups(tab);
  commands.length = 0;

  assert.equal(await backgroundClick(tab, loc(() => true), 15000, click), 'clicked');
  const { token } = asked.at(-1);
  assert.deepEqual([asked.at(-1).capMs, clicks.at(-1), keys], [15000, ['ControlOrMeta'], ['ControlOrMeta']]);
  assert.deepEqual(shown(), [`window[Symbol.for('fowlbrowser.popups')]?.show(${JSON.stringify(token)})`]);

  // A probe that timed out (the page may have armed it): closed for good before the plain click, which has no modifier.
  commands.length = 0;
  keys.length = 0;
  let shownAtClick;
  await backgroundClick(tab, loc(() => { throw new Error('Timeout 300ms exceeded'); }), 15000, async (modifiers) => { shownAtClick = shown(); return click(modifiers); });
  assert.notEqual(asked.at(-1).token, token, 'a token per click');
  assert.deepEqual([clicks.at(-1), keys, shownAtClick], [undefined, [], [`window[Symbol.for('fowlbrowser.popups')]?.show(${JSON.stringify(asked.at(-1).token)})`]]);

  // A click that failed after the modifier went down (Playwright lifts it only on success): lifted here, then closed.
  commands.length = 0;
  const order = [];
  tab.page.keyboard = { up: async (key) => order.push(`up ${key}`) };
  const failing = async () => { throw new Error('Timeout 1000ms exceeded'); };
  await assert.rejects(backgroundClick(tab, loc(() => true), 15000, failing), /Timeout 1000ms/);
  order.push(...shown().map(() => 'show'));
  assert.deepEqual(order, ['up ControlOrMeta', 'show']);

  // The page said no: it opened nothing, so nothing to close.
  commands.length = 0;
  await backgroundClick(tab, loc(() => false), 15000, click);
  assert.deepEqual([clicks.at(-1), shown()], [undefined, []]);

  // A hung keyboard or page never holds the action up.
  tab.page.keyboard = { up: () => new Promise(() => {}) };
  const started = Date.now();
  await backgroundClick(tab, loc(() => true), 15000, click);
  assert.ok(Date.now() - started < 1000);

  await uninstallPopups(tab);
  asked.length = 0;
  await backgroundClick(tab, loc(() => true), 15000, click);
  assert.deepEqual([asked, clicks.at(-1)], [[], undefined], 'given back: never');
});

// The isolated world with a stand-in DOM: `attached` says whether a new context of the world gets the binding (only
// while the debugger is attached). Returns how to send it a request as MAIN would (true when taken), the clicks it
// made on its private link, its reports, and the nodes it left in the document.
function isolatedWorld({ attached = true, active = true, closed = false } = {}) {
  const clicks = [];
  const reports = [];
  const tree = new Set();
  let listener;
  const element = (localName) => ({
    localName,
    contentWindow: localName === 'iframe' ? (attached ? { __fowlbrowserPopup() {} } : {}) : undefined,
    attachShadow: () => ({ append() {} }),
    remove() { tree.delete(this); },
    dispatchEvent(e) { clicks.push({ href: this.href, target: this.target, rel: this.rel, metaKey: e.metaKey, composed: e.composed }); return true; },
  });
  const context = vm.createContext({
    URL, JSON,
    navigator: { platform: 'MacIntel', userActivation: { isActive: active } },
    document: {
      createElement: element,
      documentElement: { append: (node) => tree.add(node) },
      addEventListener: (type, fn) => { listener = fn; },
    },
    __fowlbrowserPopup: (payload) => reports.push(JSON.parse(payload)),
    closed,
  });
  vm.runInContext('globalThis.window = globalThis; globalThis.top = globalThis;', context);
  vm.runInContext(`(${pageScripts.isolated})('fowlbrowser-test', '__fowlbrowserPopup')`, context);
  const send = (detail) => {
    let taken = false;
    listener({ detail: typeof detail === 'string' ? detail : JSON.stringify(detail), preventDefault: () => { taken = true; } });
    return taken;
  };
  return { send, clicks, reports, tree, context };
}

test('isolated world: reports what MAIN hands over (the server has the extension open it), after checking it again', () => {
  const w = isolatedWorld();
  assert.equal(w.send({ type: 'open', url: 'https://site.example/next' }), true);
  assert.equal(w.send({ type: 'open', url: 'https://site.example/other', referrer: 'https://site.example/secret' }), true);
  assert.deepEqual(w.reports, [{ type: 'open', url: 'https://site.example/next' }, { type: 'open', url: 'https://site.example/other' }]);
  assert.deepEqual(w.clicks, [], 'nothing clicked in the page');
  assert.equal(w.tree.size, 0, 'nothing left in the document');
  assert.equal(w.send({ type: 'live' }), true);

  // Forged by a page that learned the event name: anything MAIN would never send is refused, and never reported.
  for (const forged of [{ type: 'open', url: 'javascript:alert(1)' }, { type: 'open', url: 'next.html' }, { type: 'open' }, { type: 'nope' }, 'not json']) {
    assert.equal(w.send(forged), false, JSON.stringify(forged));
  }
  const idle = isolatedWorld({ active: false });
  assert.equal(idle.send({ type: 'open', url: 'https://site.example/next' }), false, 'no user activation, no open');
  assert.equal(w.reports.length + idle.reports.length, 2);
});

test('isolated world: after a detach (no binding in a new context) it refuses everything, so MAIN switches off', () => {
  const w = isolatedWorld({ attached: false });
  assert.equal(w.send({ type: 'open', url: 'https://site.example/next' }), false);
  assert.equal(w.send({ type: 'live' }), false);
  assert.deepEqual([w.clicks, w.reports, w.tree.size], [[], [], 0]);
});

test('isolated world: a close is reported only when the window really is closing', () => {
  const open = isolatedWorld();
  open.send({ type: 'close' }); // forged: the page is not closing
  assert.deepEqual(open.reports, []);
  const closing = isolatedWorld({ closed: true });
  closing.send({ type: 'close' });
  assert.deepEqual(closing.reports, [{ type: 'close' }]);
});

function fakeTab() {
  const commands = [];
  const page = Object.assign(new EventEmitter(), {
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://site.example/',
    frames: () => [{ evaluate: async (code) => commands.push(['evaluate', code]) }, { evaluate: async (code) => commands.push(['evaluate', code]) }],
  });
  let next = 1;
  const host = {
    async request(method, params) {
      if (method === 'chrome.debugger.sendCommand') {
        commands.push([params[1], params[2]]);
        return params[1] === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: String(next++) } : {};
      }
      commands.push([method, params]);
      return method === 'tabs.info' ? null : { ok: true };
    },
  };
  const browser = { key: 'chrome', name: 'Chrome', host, tabs: new Map(), adopting: new Map(), forget(id) { this.tabs.delete(id); } };
  const tab = new Tab(browser, 7, page);
  browser.tabs.set(7, tab);
  return { tab, browser, commands };
}

test('installed over raw CDP: the binding first (isolated world only), then both scripts for every new document', async () => {
  const { tab, commands } = fakeTab();
  await installPopups(tab);
  await installPopups(tab); // once per tab
  assert.deepEqual(commands.map(([m, p]) => [m, p.name ?? p.worldName ?? null, p.runImmediately ?? null, p.executionContextName ?? null]), [
    ['Runtime.addBinding', '__fowlbrowserPopup', null, 'fowlbrowser-popups'],
    ['Page.addScriptToEvaluateOnNewDocument', null, true, null],
    ['Page.addScriptToEvaluateOnNewDocument', 'fowlbrowser-popups', true, null],
  ]);

  await uninstallPopups(tab);
  await installPopups(tab); // again (a resumed tab): its reports are still heard once
  const opens = [];
  tab.on('windowopen', (url) => opens.push(url));
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/next"}');
  tab.emit('binding', '__fowlbrowserUserInput', '{"type":"close"}'); // someone else's binding
  tab.emit('binding', '__fowlbrowserPopup', 'not json');
  assert.deepEqual(opens, ['https://site.example/next']);
  await sleepMs(0);
  assert.deepEqual(commands.filter(([m]) => m === 'tabs.openChild'), [['tabs.openChild', { tabId: 7, url: 'https://site.example/next' }]], 'the extension opens it');
  assert.equal(tab.closedByPageAt, null);
  const before = Date.now();
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"close"}');
  assert.ok(tab.closedByPageAt >= before);

  commands.length = 0;
  await uninstallPopups(tab);
  await uninstallPopups(tab);
  assert.deepEqual(commands.map(([m, p]) => [m, p?.identifier ?? p?.name ?? p]).sort(), [
    ['Page.removeScriptToEvaluateOnNewDocument', '3'],
    ['Page.removeScriptToEvaluateOnNewDocument', '4'],
    ['Runtime.removeBinding', '__fowlbrowserPopup'],
    ['evaluate', `window[Symbol.for('fowlbrowser.popups')]?.off()`],
    ['evaluate', `window[Symbol.for('fowlbrowser.popups')]?.off()`],
  ].sort());
});

test('a popup without an opener: the extension opens a blank child, which goes to the URL with no referrer; a failed navigation fails the opening', async () => {
  const { tab, browser, commands } = fakeTab();
  const child = { tabId: 9, browser };
  browser.waitForTab = async (tabId) => (tabId === 9 ? child : null);
  const request = browser.host.request;
  let navigate = async () => ({ frameId: 'f', loaderId: 'l' });
  browser.host.request = async (method, params) => {
    if (method === 'tabs.openChild') { commands.push([method, params]); return { tabId: 9 }; }
    if (method === 'chrome.debugger.sendCommand' && params[0].tabId === 9) { commands.push(['child', params[1], params[2]]); return navigate(params[2]); }
    return request(method, params);
  };
  await installPopups(tab);
  const opens = [];
  tab.on('windowopen', (url, opening) => opens.push(opening));
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/next"}');
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://other.example/","referrer":"https://site.example/?token=SECRET"}');
  assert.deepEqual(await Promise.all(opens), [{ tabId: 9, url: 'https://site.example/next' }, { tabId: 9, url: 'https://other.example/' }]);
  assert.deepEqual(commands.filter(([m]) => m === 'tabs.openChild' || m === 'child'), [
    ['tabs.openChild', { tabId: 7, url: 'https://site.example/next' }],
    ['tabs.openChild', { tabId: 7, url: 'https://other.example/' }],
    ['child', 'Page.navigate', { url: 'https://site.example/next' }],
    ['child', 'Page.navigate', { url: 'https://other.example/' }],
  ], 'never a referrer: the page\'s policy may forbid one');

  // A navigation that failed, or was refused, fails the opening; a download (net::ERR_ABORTED) does not.
  navigate = async () => ({ frameId: 'f', errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://nowhere.example/"}');
  await assert.rejects(opens.at(-1), /ERR_NAME_NOT_RESOLVED/);
  navigate = async () => { throw new Error('Debugger is not attached to the tab'); };
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/x"}');
  await assert.rejects(opens.at(-1), /not attached/);
  navigate = async () => ({ frameId: 'f', errorText: 'net::ERR_ABORTED' });
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/file.zip"}');
  assert.deepEqual(await opens.at(-1), { tabId: 9, url: 'https://site.example/file.zip' });

  // Refused (the opener changed hands meanwhile): the action that caused it is told, not only the log.
  browser.host.request = async (method, params) => (method === 'tabs.openChild' ? Promise.reject(new Error('Tab 7 is no longer this client\'s to open from')) : request(method, params));
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/lost"}');
  await assert.rejects(opens.at(-1), /no longer this client/);
});

test('a popup is asked for only once the user\'s input in its tab is judged; one the user opened is theirs: never attached or navigated', async () => {
  const { tab, browser, commands } = fakeTab();
  let judge;
  const judged = new Promise((resolve) => { judge = resolve; });
  const request = browser.host.request;
  let user = true;
  browser.host.request = async (method, params) => {
    if (method === 'tabs.isShown') { commands.push([method, params]); await judged; return { shown: true, focused: true }; }
    if (method === 'tabs.openChild') { commands.push([method, params]); return { tabId: user ? 9 : 10, ...(user && { user: true }) }; }
    if (method === 'chrome.debugger.sendCommand' && params[0].tabId !== 7) { commands.push(['child', params[0].tabId, params[1]]); return {}; }
    return request(method, params);
  };
  const attached = [];
  browser.waitForTab = async (tabId) => { attached.push(tabId); return { tabId, browser }; };
  await watchUserInput(tab);
  await installPopups(tab);
  const opens = [];
  tab.on('windowopen', (url, opening) => opens.push(opening));
  tab.emit('binding', USER_BINDING, JSON.stringify({ type: 'pointerdown', at: Date.now() }));
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/terms"}');
  await sleepMs(20);
  assert.ok(!commands.some(([m]) => m === 'tabs.openChild'), 'not while the user\'s input is being judged');
  judge();
  assert.deepEqual(await opens[0], { tabId: 9, user: true, url: 'https://site.example/terms' });
  const asked = commands.map(([m]) => m).filter((m) => /^tabs\./.test(m));
  assert.deepEqual(asked, ['tabs.isShown', 'tabs.userInput', 'tabs.openChild']);
  assert.deepEqual(attached, [], 'never attached');
  assert.ok(!commands.some(([m]) => m === 'child'), 'never navigated');

  // The agent's own (no user: true): attached and navigated as before.
  user = false;
  tab.emit('binding', '__fowlbrowserPopup', '{"type":"open","url":"https://site.example/next"}');
  assert.deepEqual(await opens[1], { tabId: 10, url: 'https://site.example/next' });
  assert.deepEqual(attached, [10]);
  assert.deepEqual(commands.filter(([m]) => m === 'child'), [['child', 10, 'Page.navigate']]);
});

test('an action reports every opening that failed by its deadline, names the ones still under way, and counts the user\'s', async () => {
  const never = new Promise(() => {});
  const started = Date.now();
  const { failed, pending, users } = await openingLines([
    { url: 'https://a.example/', opening: Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')) },
    { url: 'https://b.example/', opening: never },
    { url: 'https://c.example/', opening: Promise.resolve({ tabId: 8, url: 'https://c.example/' }) },
    { url: 'https://d.example/', opening: Promise.resolve({ tabId: 9, user: true, url: 'https://d.example/' }) },
  ], 50);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(failed, ['The page opened https://a.example/ in a new tab, which failed: net::ERR_NAME_NOT_RESOLVED']);
  assert.deepEqual(pending, ['The page opened https://b.example/ in a new tab, which is still loading.']);
  assert.equal(users, 1, 'the user\'s own popup is no tab of the action\'s');
  assert.deepEqual(await openingLines([], 50), { failed: [], pending: [], users: 0 });
});

test('an unanswered uninstall (debugger gone, page hung) never holds up the release', async () => {
  const { tab, browser } = fakeTab();
  await installPopups(tab);
  browser.host.request = (method) => (method === 'chrome.debugger.sendCommand' ? new Promise(() => {}) : Promise.resolve({ ok: true }));
  tab.page.frames = () => [{ evaluate: () => new Promise(() => {}) }];
  const started = Date.now();
  await uninstallPopups(tab);
  assert.ok(Date.now() - started < 1000);
});

test('tab_release and tab_keep take the scripts out before the tab goes back to the user', async () => {
  for (const [tool, method] of [['tab_release', 'tabs.release'], ['tab_keep', 'tabs.keep']]) {
    const { tab, browser, commands } = fakeTab();
    await installPopups(tab);
    commands.length = 0;
    const handlers = {};
    registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, { get: async () => browser });
    const result = await handlers[tool]({ tab: 'chrome:7' });
    assert.ok(!result.isError, result.content?.[0]?.text);
    const order = commands.map(([m]) => m);
    assert.ok(order.includes('Runtime.removeBinding'), `${tool}: ${order}`);
    assert.ok(order.indexOf('Runtime.removeBinding') < order.indexOf(method), `${tool}: ${order}`);
  }
});

test('a tab kept while it is being adopted never keeps popup scripts: adoption sees the keep, or keep waits and takes them out', async () => {
  for (const keepFirst of [true, false]) {
    let kept = false;
    const commands = [];
    let tabIdAsked;
    const tabIdReady = new Promise((resolve) => { tabIdAsked = resolve; });
    const host = {
      hello: { extension: { userAgent: 'Chrome/150.0.0.0' } },
      on() {},
      async request(method, params) {
        commands.push(method === 'chrome.debugger.sendCommand' ? `${params[1]} ${params[2]?.name ?? ''}`.trim() : method);
        if (method === 'tabs.info') return { id: 7, owner: 'you', origin: 'agent', kept, handedOver: kept, parked: null };
        if (method === 'tabs.keep') { await sleepMs(20); kept = true; return { ok: true }; }
        if (method === 'tabs.isShown') return { shown: false };
        return method === 'chrome.debugger.sendCommand' && params[1] === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '1' } : {};
      },
    };
    const browser = new Browser('chrome', host);
    const page = Object.assign(new EventEmitter(), {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, url: () => 'https://site.example/', isClosed: () => false, frames: () => [],
      context: () => ({ newCDPSession: async () => ({ send: async () => { await tabIdReady; return { tabId: 7 }; }, detach: async () => {} }) }),
    });
    const handlers = {};
    registerTools({ registerTool: (name, meta, handler) => { handlers[name] = handler; } }, { get: async () => browser });
    const adopted = browser.tabFor(page);
    if (keepFirst) {
      await handlers.tab_keep({ tab: 'chrome:7' });
      tabIdAsked();
    } else {
      const keeping = handlers.tab_keep({ tab: 'chrome:7' }); // sent before the adoption knows the tab id, lands after its lookup
      await sleepMs(1);
      tabIdAsked();
      await keeping;
    }
    await adopted;
    const installed = commands.indexOf('Runtime.addBinding __fowlbrowserPopup');
    const removed = commands.indexOf('Runtime.removeBinding __fowlbrowserPopup');
    assert.ok(keepFirst ? installed === -1 : removed > installed, `keepFirst ${keepFirst}: ${commands}`);
    browser.stop();
  }
});
