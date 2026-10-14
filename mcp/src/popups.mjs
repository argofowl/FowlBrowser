// Popups from agent tabs open without taking the user's eyes or focus (SPEC "Popups (session 5)"), and the page can't put
// the browser's or the Mac's own UI (colour picker, file panels, full screen, share and passkey sheets...) in front of them.
// Two page scripts, in every same-process frame of an agent tab and every new document, before page scripts:
// - MAIN world: decides. Opens that need no opener (target=_blank links without rel=opener, links with rel=noopener
//   or noreferrer to a name no frame or window has, window.open with noopener/noreferrer) are handed to the isolated
//   world, which reports them; the server has the extension open them (tabs.openChild: a background tab, and unlike
//   any tab the page opens itself, it never brings the browser to the front). Every other window.open still runs for
//   real (the opener and the returned window stay real) but without popup features, so it opens as a tab, never as a
//   window; the agent's click on a button carries the new-tab modifier the page never sees (backgroundClick), so it
//   is a background tab, and otherwise the extension switches the window back at once. window.close() is reported
//   once the page is closing.
// - isolated world `fowlbrowser-popups`: checks every request again (the page can't reach this world, but a page
//   that learned the event name can send it anything) and holds the binding that reports to the server. It also tells
//   whether the debugger is still attached: after a detach nothing can switch the MAIN script off over CDP, so it
//   switches itself off at its next decision.
// Only for tabs the user hasn't been given; removed (scripts, binding, and a live off-switch in the current
// documents) before a tab goes back to the user.
import crypto from 'node:crypto';
import { cdp } from './cdp.mjs';
import { debug } from './debug.mjs';
import { userSettled } from './takeover.mjs';
import { within } from './util.mjs';

export const POPUP_WORLD = 'fowlbrowser-popups';
const WORLD = POPUP_WORLD;
export const POPUP_BINDING = '__fowlbrowserPopup';
const BINDING = POPUP_BINDING;
const EVENT = `fowlbrowser-${crypto.randomBytes(6).toString('hex')}`; // MAIN -> isolated world; per process, unguessable
const OFF_CAP_MS = 400;

// MAIN world. Gate: transient user activation, no modifier on the event being handled (a real modified click already
// means a background tab or a new window), http(s) only, a new browsing context only (never _self/_parent/_top or a
// frame or window that exists), never about:blank or empty (window.open('') then document.write needs the window).
// An opaque origin (a sandbox without allow-same-origin, which may also lack allow-popups) is left to the browser. Once
// an activation went to the extension, every later window.open for a new context in it gets null, whatever its
// features: the browser's own open would have used the activation up and blocked them.
function main(event) {
  const CONTROL = Symbol.for('fowlbrowser.popups');
  if (window[CONTROL]) return window[CONTROL].on();
  // Taken before the page's scripts run: a page that replaced dispatchEvent would learn the event name.
  const { apply } = Reflect;
  const { dispatchEvent, addEventListener: listen, removeEventListener: unlisten } = EventTarget.prototype;
  const Custom = CustomEvent;
  const { stringify } = JSON;
  const nativeOpen = window.open;
  const nativeClose = window.close;
  const nativeToString = Function.prototype.toString;
  const names = new Map(); // window names this document opened -> their windows
  let on = false;
  const opaque = window.origin === 'null';
  // Set once a window.open went to the extension; the next activation-triggering input (as the HTML spec lists them)
  // clears it.
  let spent = false;
  const rearm = (e) => { if (e.isTrusted && (e.type !== 'pointerup' || e.pointerType !== 'mouse')) spent = false; };
  for (const type of ['keydown', 'mousedown', 'pointerdown', 'pointerup', 'touchend']) apply(listen, window, [type, rearm, true]);
  // The new-tab modifier the server adds to an agent click that may open a popup (backgroundClick below), so Blink
  // opens it as a background tab with its opener; the page must not see it. The probe arms this (for one element, under
  // one token); nothing is hidden while Playwright waits for the element. The click's own trusted modifier keydown, the
  // first event of its input, opens a short window (CLICK_MS): during it the modifier's key events stop at this first
  // window listener, and trusted mouse events that carry the modifier and target that element or its descendants read
  // metaKey and ctrlKey false, decided when the event is first read (a window capture listener reads each one first)
  // and kept for that event; everything else reads as is. Disarmed after the click, or after capMs if that never comes
  // (a detach mid-click).
  const CLICK_MS = 1000;
  const { now } = Date;
  let hidden = null; // { element, token, until }: until is the end of the window the click's keydown opened
  let hiddenTimer;
  const clicking = () => hidden?.until !== undefined && now() <= hidden.until;
  const closedTokens = []; // a late hide() of a window already closed never opens it again
  const decided = new WeakMap(); // mouse event -> masked
  const { setTimeout: later, clearTimeout: cancel } = window;
  const { stopImmediatePropagation, composedPath } = Event.prototype;
  const mouse = MouseEvent.prototype;
  const nativeKeys = ['metaKey', 'ctrlKey'].map((key) => Object.getOwnPropertyDescriptor(mouse, key));
  const masked = (e) => {
    if (decided.has(e)) return decided.get(e);
    if (!clicking() || !e.isTrusted) return false;
    let value = false;
    if (apply(nativeKeys[0].get, e, []) || apply(nativeKeys[1].get, e, [])) {
      const path = apply(composedPath, e, []);
      for (let i = 0; i < path.length && !value; i++) value = path[i] === hidden.element;
    }
    decided.set(e, value);
    return value;
  };
  for (const type of ['pointerover', 'pointerenter', 'pointerdown', 'pointermove', 'pointerup', 'pointerout', 'pointerleave', 'mouseover',
    'mouseenter', 'mousedown', 'mousemove', 'mouseup', 'mouseout', 'mouseleave', 'click', 'dblclick', 'auxclick', 'contextmenu']) {
    apply(listen, window, [type, masked, true]);
  }
  const keyGetters = ['metaKey', 'ctrlKey'].map((key, i) => {
    const native = nativeKeys[i];
    return [key, native, { ...native, get: new Proxy(native.get, { apply: (target, self, args) => apply(target, self, args) && !masked(self) }) }];
  });
  const nativeModifierState = mouse.getModifierState;
  const modifierState = new Proxy(nativeModifierState, {
    apply: (target, self, args) => apply(target, self, args) && !((args[0] === 'Meta' || args[0] === 'Control') && masked(self)),
  });
  const stopModifierKey = (e) => {
    if (!hidden || !e.isTrusted || (e.key !== 'Meta' && e.key !== 'Control')) return;
    if (e.type === 'keydown' && !clicking()) hidden.until = now() + CLICK_MS;
    if (clicking()) apply(stopImmediatePropagation, e, []);
  };
  apply(listen, window, ['keydown', stopModifierKey, true]);
  apply(listen, window, ['keyup', stopModifierKey, true]);

  // Synchronous: the isolated world's listener runs inside dispatchEvent. True when it took the request. Refused
  // (the debugger is gone, or no isolated world in this frame): off for good, the page's own call goes ahead natively.
  const dispatch = (data) => !apply(dispatchEvent, document, [new Custom(event, { detail: stringify(data), cancelable: true })]);
  const send = (data) => dispatch(data) || (control.off(), false);
  const httpUrl = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  const modified = (e) => (e instanceof MouseEvent && e.button !== 0) || (!!e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey));
  const exists = (name) => {
    if (names.get(name)?.closed === false) return true;
    for (let w = window; ; w = w.parent) {
      try { if (w.name === name) return true; } catch {}
      if (w === w.parent) break;
    }
    return [...document.querySelectorAll('iframe, frame')].some((frame) => frame.name === name);
  };
  const newContext = (target) => !/^(_self|_parent|_top|_unfencedtop)?$/i.test(target) && (/^_blank$/i.test(target) || !exists(target));
  // The HTML spec's boolean window feature: present with no value, "yes", "true" or a non-zero number.
  const feature = (features, name) => features.toLowerCase().replace(/\s*=\s*/g, '=').split(/[\s,]+/).some((token) => {
    const [key, value = ''] = token.split('=');
    return key === name && (value === '' || value === 'yes' || value === 'true' || (Number.parseInt(value, 10) || 0) !== 0);
  });

  const open = new Proxy(nativeOpen, {
    apply(target, self, args) {
      const url = args[0] === undefined ? '' : String(args[0]);
      const name = args[1] === undefined || String(args[1]) === '' ? '_blank' : String(args[1]);
      const features = args[2] === undefined ? '' : String(args[2]);
      if (on && spent && navigator.userActivation?.isActive && newContext(name)) return null;
      if (!on || opaque || !navigator.userActivation?.isActive || modified(window.event) || !url || !httpUrl(url) || !newContext(name)) {
        return apply(target, self, args);
      }
      if (feature(features, 'noreferrer') || feature(features, 'noopener')) {
        if (!send({ type: 'open', url: httpUrl(url) })) return apply(target, self, args);
        spent = true;
        return null;
      }
      // Needs its opener: a real window.open, as a tab (no popup, width, height, left, top...).
      if (!send({ type: 'live' })) return apply(target, self, args);
      const opened = apply(target, self, [args[0], args[1], '']);
      if (opened && !/^_blank$/i.test(name)) names.set(name, opened);
      return opened;
    },
  });
  const close = new Proxy(nativeClose, {
    apply(target, self, args) {
      apply(target, self, args);
      // Reported once it really closes (the isolated world checks window.closed), so it can't be faked.
      if (on && (self === undefined || self === window) && window === window.top) dispatch({ type: 'close' });
    },
  });
  // Page calls that would put the browser's or the Mac's own UI in front of the user from an agent's tab: the screen
  // colour picker (it takes over the mouse), file and folder panels, full screen, pointer lock, printing, the share
  // sheet, passkey and payment sheets, the camera, microphone and screen pickers, and picture-in-picture windows (they
  // float over every app). Refused as a person declining would be (the page sees the error a cancel gives) and
  // reported, so the agent hears what the page wanted. [owner, method, what it shows, error, when (default: always)]
  const Abort = 'AbortError';
  const Denied = 'NotAllowedError';
  const InputElement = window.HTMLInputElement;
  // [owner, method, what it shows, error (none: returns nothing), when (default: always), sync: throws instead of
  // returning a rejected promise (showPicker)]. A file input's showPicker is left alone: an agent's own action holds
  // the chooser it opens (the server intercepts choosers then).
  const declined = [
    [window.EyeDropper?.prototype, 'open', 'the screen colour picker (eyedropper)', Abort],
    [window, 'showOpenFilePicker', 'a file panel', Abort], [window, 'showSaveFilePicker', 'a save panel', Abort],
    [window, 'showDirectoryPicker', 'a folder panel', Abort],
    [window.Element?.prototype, 'requestFullscreen', 'full screen', 'TypeError'], [window.Element?.prototype, 'webkitRequestFullscreen', 'full screen'],
    [window.Element?.prototype, 'webkitRequestFullScreen', 'full screen'], [window.HTMLVideoElement?.prototype, 'webkitEnterFullscreen', 'full screen'],
    [window.Element?.prototype, 'requestPointerLock', 'pointer lock (it hides the mouse pointer)', Denied],
    [window, 'print', 'the print dialog'], [window.Navigator?.prototype, 'share', 'the share sheet', Abort],
    [window.CredentialsContainer?.prototype, 'get', 'a passkey or security key prompt', Denied, (options) => !!options?.publicKey],
    [window.CredentialsContainer?.prototype, 'create', 'a passkey or security key prompt', Denied, (options) => !!options?.publicKey],
    [window.PaymentRequest?.prototype, 'show', 'a payment sheet', Abort],
    [window.MediaDevices?.prototype, 'getUserMedia', 'the camera or microphone', Denied],
    [window.MediaDevices?.prototype, 'getDisplayMedia', 'the screen sharing picker', Denied],
    [window.HTMLVideoElement?.prototype, 'requestPictureInPicture', 'a picture-in-picture window', Denied],
    [window.DocumentPictureInPicture?.prototype, 'requestWindow', 'a picture-in-picture window', Denied],
    [window.HTMLInputElement?.prototype, 'showPicker', 'the colour window', Denied, function () { return this.type === 'color'; }, true],
    // A script's click on a colour input inside a closed shadow root, which the click listener below can't see (on
    // HTMLElement, where click() lives, so calling it from there is refused too).
    [window.HTMLElement?.prototype, 'click', 'the colour window', null, function () { return this instanceof InputElement && this.type === 'color' && !this.disabled; }, true],
    [window.HTMLSelectElement?.prototype, 'showPicker', 'a dropdown menu', Denied, null, true],
  ].filter(([owner, method]) => typeof owner?.[method] === 'function').map(([owner, method, what, error, when, sync]) => {
    const native = owner[method];
    const fake = new Proxy(native, {
      apply(target, self, args) {
        // Refused only while the debugger is attached (send: after a detach, a takeover, the wrappers switch off and the
        // page gets what it asked for).
        if (!on || (when && !apply(when, self, args)) || !send({ type: 'blocked', what })) return apply(target, self, args);
        if (!error) return undefined;
        const refusal = error === 'TypeError' ? new TypeError(`${what} was refused`) : new DOMException(`${what} was refused`, error);
        if (sync) throw refusal;
        return Promise.reject(refusal);
      },
    });
    return { owner, method, native, fake };
  });
  // A page script's click on a colour input (input.click(), label.click(), a dispatched click) opens the colour window
  // too when the page has the agent's user activation: its default action is prevented. Trusted clicks are the user's
  // (an agent's own click on one is refused by the server before it is sent).
  apply(listen, window, ['click', (e) => {
    const target = apply(composedPath, e, [])[0];
    if (!on || e.isTrusted || !InputElement || !(target instanceof InputElement) || target.type !== 'color' || target.disabled) return;
    if (send({ type: 'blocked', what: 'the colour window' })) e.preventDefault();
  }, true]);
  const fakes = new Map([[open, nativeOpen], [close, nativeClose], [modifierState, nativeModifierState], ...keyGetters.map(([, native, fake]) => [fake.get, native.get]),
    ...declined.map(({ native, fake }) => [fake, native])]);
  const toString = new Proxy(nativeToString, { apply: (target, self, args) => apply(target, fakes.get(self) ?? self, args) });
  fakes.set(toString, nativeToString);

  // Links: decided after the page's own click handlers (a bubble listener added again while the click is on its way
  // down, so it is the last one on window), which run once as usual; only the default action is replaced.
  function onLink(e) {
    if (!on || opaque || !e.isTrusted || e.defaultPrevented || modified(e) || !navigator.userActivation?.isActive) return;
    const link = e.composedPath().find((node) => (node.localName === 'a' || node.localName === 'area') && typeof node.href === 'string');
    if (!link || link.hasAttribute('download')) return;
    const rel = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/);
    const url = httpUrl(link.href);
    const target = (link.getAttribute('target') ?? document.querySelector('base[target]')?.getAttribute('target') ?? '').trim();
    // Only links without an opener: _blank, or rel=noopener|noreferrer (a link to any other name keeps its opener).
    const noopener = rel.includes('noopener') || rel.includes('noreferrer') || /^_blank$/i.test(target);
    if (!url || rel.includes('opener') || !noopener || !newContext(target)) return;
    if (send({ type: 'open', url })) e.preventDefault();
  }
  apply(listen, window, ['click', (e) => {
    if (!on || !e.isTrusted) return;
    apply(unlisten, window, ['click', onLink]);
    apply(listen, window, ['click', onLink]);
  }, true]);

  const control = {
    on() {
      on = true;
      window.open = open;
      window.close = close;
      Function.prototype.toString = toString;
      for (const [key, , fake] of keyGetters) Object.defineProperty(mouse, key, fake);
      mouse.getModifierState = modifierState;
      for (const { owner, method, fake } of declined) owner[method] = fake;
    },
    off() {
      on = false;
      control.show();
      if (window.open === open) window.open = nativeOpen;
      if (window.close === close) window.close = nativeClose;
      if (Function.prototype.toString === toString) Function.prototype.toString = nativeToString;
      for (const [key, native, fake] of keyGetters) if (Object.getOwnPropertyDescriptor(mouse, key)?.get === fake.get) Object.defineProperty(mouse, key, native);
      if (mouse.getModifierState === modifierState) mouse.getModifierState = nativeModifierState;
      for (const { owner, method, native, fake } of declined) if (owner[method] === fake) owner[method] = native;
    },
    hide(capMs, element, token) {
      if (!on || closedTokens.includes(token)) return false;
      control.show();
      hidden = { element, token };
      hiddenTimer = later(() => { hidden = null; }, capMs);
      return true;
    },
    // With a token: closes that window only, and for good.
    show(token) {
      if (token !== undefined) {
        closedTokens.push(token);
        if (closedTokens.length > 20) closedTokens.shift();
        if (hidden && hidden.token !== token) return;
      }
      hidden = null;
      cancel(hiddenTimer);
    },
  };
  Object.defineProperty(window, CONTROL, { value: control });
  control.on();
}

// Isolated world: checks what MAIN hands over and reports it to the server, which opens it.
function isolated(event, binding) {
  const CONTROL = Symbol.for('fowlbrowser.popups');
  if (globalThis[CONTROL]) return;
  globalThis[CONTROL] = true;
  const report = (data) => { try { globalThis[binding](JSON.stringify(data)); } catch {} };
  const httpUrl = (value) => {
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };
  // Nodes the page can't see (a closed shadow root), connected for the time of fn.
  const privately = (node, fn) => {
    const host = document.createElement('span');
    host.attachShadow({ mode: 'closed' }).append(node);
    document.documentElement.append(host);
    try {
      return fn();
    } finally {
      host.remove();
    }
  };
  // The binding goes into every new context of this world only while the debugger is attached (after a detach it stays
  // in the old ones, silently doing nothing): a new frame's context has it, or the tab is no longer the agent's.
  const attached = () => {
    const frame = document.createElement('iframe');
    return privately(frame, () => typeof frame.contentWindow?.[binding] === 'function');
  };
  document.addEventListener(event, (e) => {
    let data;
    try { data = JSON.parse(e.detail); } catch { return; }
    if (data?.type === 'live') {
      if (attached()) e.preventDefault();
    } else if (data?.type === 'open') {
      const url = httpUrl(data.url);
      if (!url || !navigator.userActivation?.isActive || !attached()) return;
      e.preventDefault();
      report({ type: 'open', url });
    } else if (data?.type === 'close' && window.closed && window === window.top) {
      report({ type: 'close' });
    } else if (data?.type === 'blocked' && typeof data.what === 'string' && attached()) {
      e.preventDefault(); // taken: the page's call is refused
      report({ type: 'blocked', what: data.what.slice(0, 80) });
    }
  });
}

// In the page, on the target of a plain left click: whether it may carry the new-tab modifier, and if so the MAIN
// script's hidden-modifier window is now open (for this element, under this token). Judged on the element the click
// will really hit (Playwright clicks the middle of its first box in the viewport, after scrolling it into view), which
// must be the target or inside it, and everything around that: never links (tier 1, or their own meaning of a
// modified click), form submits, editable or selectable things, labels and toggles, nor with focus inside a frame (the
// modifier's key events would go there). Everything else (buttons, role=button, elements with click handlers) qualifies.
export const BACKGROUND_CLICK_FN = (el, { capMs, token }) => {
  const skipRoles = ['checkbox', 'radio', 'switch', 'option', 'menuitemcheckbox', 'menuitemradio', 'row', 'gridcell', 'treeitem'];
  const up = (node) => node.parentElement ?? node.getRootNode().host;
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  if (/^(iframe|frame|fencedframe|object|embed)$/.test(focused?.localName ?? '')) return false;
  el.scrollIntoViewIfNeeded?.();
  const box = [...el.getClientRects()]
    .map((r) => ({ left: Math.max(r.left, 0), top: Math.max(r.top, 0), right: Math.min(r.right, innerWidth), bottom: Math.min(r.bottom, innerHeight) }))
    .find((r) => (r.right - r.left) * (r.bottom - r.top) > 0.99);
  if (!box) return false;
  const [x, y] = [(box.left + box.right) / 2, (box.top + box.bottom) / 2];
  let hit = document.elementFromPoint(x, y);
  for (let inner = hit?.shadowRoot?.elementFromPoint(x, y); inner && inner !== hit; inner = hit.shadowRoot?.elementFromPoint(x, y)) hit = inner;
  let inside = false;
  for (let node = hit; node && !inside; node = up(node)) inside = node === el;
  if (!inside || hit.isContentEditable) return false;
  for (let node = hit; node; node = up(node)) {
    const tag = node.localName;
    if (tag === 'a' || tag === 'area') return false; // also without href: a handler may give it one
    if (tag === 'button' && node.type === 'submit' && node.form) return false;
    if (tag === 'input' && node.type !== 'button') return false;
    if (/^(textarea|select|option|label)$/.test(tag)) return false;
    if (skipRoles.includes((node.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0])) return false;
  }
  return window[Symbol.for('fowlbrowser.popups')]?.hide?.(capMs, el, token) === true;
};

export const pageScripts = { main, isolated }; // for tests

const installed = new Map(); // Tab -> identifiers of its two scripts
const heard = new WeakSet(); // Tabs whose reports are listened to (once, however often they are installed)

// Call when an agent tab comes under control, before it navigates. Reports: 'close' sets tab.closedByPageAt; 'open' (a
// popup without an opener) is opened by the extension and announced like a Page.windowOpen (with the opening, and the
// creation that gives its tab id first), so the action that caused it names the tab. The extension is asked once the
// user's input in the tab is judged (takeover.mjs userSettled): a popup the user's own click opened is theirs, opened
// in front and never driven ({tabId, user: true}; the opening resolves with it as is).
export const popupsInstalled = (tab) => installed.has(tab);

export async function installPopups(tab) {
  if (installed.has(tab)) return;
  installed.set(tab, []);
  if (!heard.has(tab)) {
    heard.add(tab);
    tab.on('binding', (name, payload) => {
      if (name !== BINDING) return;
      let data;
      try { data = JSON.parse(payload); } catch { return; }
      if (data?.type === 'close') tab.closedByPageAt = Date.now();
      else if (data?.type === 'blocked' && typeof data.what === 'string') tab.emit('blocked', data.what);
      else if (data?.type === 'open' && typeof data.url === 'string') {
        const created = userSettled(tab).then(() => tab.browser.host.request('tabs.openChild', { tabId: tab.tabId, url: data.url }));
        const opening = created.then((child) => (child.user ? { ...child, url: data.url } : navigateChild(tab, child.tabId, data.url)));
        opening.catch((e) => debug('popups: openChild failed', e.message));
        tab.emit('windowopen', data.url, opening, created);
      }
    });
    tab.page.once('close', () => installed.delete(tab));
  }
  await cdp(tab, 'Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
  const scripts = await Promise.all([
    cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: `(${main})(${JSON.stringify(EVENT)})`, runImmediately: true }),
    cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: `(${isolated})(${JSON.stringify(EVENT)}, ${JSON.stringify(BINDING)})`, worldName: WORLD, runImmediately: true }),
  ]);
  if (installed.has(tab)) installed.set(tab, scripts.map((s) => s.identifier));
}

// The extension opens a blank background child (tabs.openChild); once it is attached it goes to the URL, so a download
// it turns into shows on the child's session. With no referrer: the page's referrer policy isn't known here, and none
// never tells more than the page would. Resolves with { tabId, url } once the navigation went through; one that failed
// fails the opening (net::ERR_ABORTED is a download or an empty response, which the page's own open would not show
// either).
async function navigateChild(tab, tabId, url) {
  const child = await tab.browser.waitForTab(tabId);
  const { errorText } = (await cdp(child, 'Page.navigate', { url })) ?? {};
  if (errorText && errorText !== 'net::ERR_ABORTED') throw new Error(errorText);
  return { tabId, url };
}

// What became of the opens an action had the extension make ([{ url, opening }]), at most `ms` after it: an error line
// for each that failed, one for each still under way, and how many went to the user (the rest went through).
export async function openingLines(openings, ms) {
  const states = openings.map(({ url, opening }) => {
    const state = { url };
    state.done = opening.then((opened) => { state.line = null; state.user = !!opened?.user; },
      (error) => { state.line = `The page opened ${url} in a new tab, which failed: ${error.message}`; });
    return state;
  });
  let timer;
  await Promise.race([Promise.allSettled(states.map((s) => s.done)), new Promise((resolve) => { timer = setTimeout(resolve, ms); })])
    .finally(() => clearTimeout(timer));
  return {
    failed: states.filter((s) => s.line).map((s) => s.line),
    pending: states.filter((s) => s.line === undefined).map((s) => `The page opened ${s.url} in a new tab, which is still loading.`),
    users: states.filter((s) => s.user).length,
  };
}

// Before a tab goes back to the user (release, keep, turn end, handoff; at session end every
// tab that still has them closes): new documents get nothing, and window.open is native again in the current ones.
// Best effort and capped, so it never holds up the release (after a detach every command fails).
export async function uninstallPopups(tab) {
  const identifiers = installed.get(tab);
  if (!identifiers) return;
  installed.delete(tab);
  const off = `window[Symbol.for('fowlbrowser.popups')]?.off()`;
  let timer;
  await Promise.race([
    Promise.allSettled([
      ...identifiers.map((identifier) => cdp(tab, 'Page.removeScriptToEvaluateOnNewDocument', { identifier })),
      cdp(tab, 'Runtime.removeBinding', { name: BINDING }),
      ...tab.page.frames().map((frame) => frame.evaluate(off)),
    ]),
    new Promise((resolve) => { timer = setTimeout(resolve, OFF_CAP_MS); }),
  ]).finally(() => clearTimeout(timer));
  debug('popups: uninstalled', tab.id);
}

// A plain left click on a main-frame ref: click(modifiers) runs it, with the new-tab modifier when the page says so
// (BACKGROUND_CLICK_FN, in tabs with the scripts). Afterwards, whatever the outcome, the modifier is lifted (Playwright
// lifts it only after a click that went through; the page never sees this key either) and the window is closed. A
// probe whose answer never came back (the page may have armed it) is closed before the plain click, for good: a late
// probe can't arm it again.
const PROBE_MS = 300;
export async function backgroundClick(tab, loc, capMs, click) {
  if (!installed.has(tab)) return click();
  const token = crypto.randomUUID();
  // In the main frame's current document (after a navigation the new one never had it).
  const close = () => capped(cdp(tab, 'Runtime.evaluate', { expression: `window[Symbol.for('fowlbrowser.popups')]?.show(${JSON.stringify(token)})` }).catch(() => {}));
  // Bounded here too: the locator's timeout covers finding the element, not a page that stalls after.
  const background = await within(loc.evaluate(BACKGROUND_CLICK_FN, { capMs, token }, { timeout: PROBE_MS }).then((yes) => yes === true), PROBE_MS, null);
  if (background === null) await close();
  if (!background) return click();
  try {
    return await click(['ControlOrMeta']);
  } finally {
    await capped(tab.page.keyboard.up('ControlOrMeta').catch(() => {}));
    await close();
  }
}

async function capped(promise) {
  let timer;
  await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, PROBE_MS); })]).finally(() => clearTimeout(timer));
}
