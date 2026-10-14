// Refs for controls inside CLOSED shadow roots, which Playwright's aria snapshot cannot see.
// Chrome's own DOM and accessibility trees do include them, so for pages that have a closed root we list
// their interactive nodes as `s` refs (s1, s2...) mapped to backendNodeIds, and act on them over raw CDP.
//
// Reading the whole DOM (DOM.getDocument pierce) costs ~300 ms on a large page, so it only runs when a cheap
// signal says a closed root may exist:
// - Agent tabs: an init script wraps Element.prototype.attachShadow (and the setHTMLUnsafe/parseHTMLUnsafe
//   parsers) and counts closed roots per document; each snapshot reads the count in every frame (one
//   evaluate per frame, in parallel). Declarative `<template shadowrootmode="closed">` from the HTML parser
//   calls no JS, so each frame's document response is checked for it (fetched in the background as it loads).
//   A document the hook missed the start of (`late`: one loaded before control, every cross-origin frame) gets a full
//   scan, and one on every snapshot while the page has closed roots.
// - the user's claimed tabs (nothing is patched in their pages): a full scan per document, then again on each
//   snapshot if it found roots, or, if it found none, at most every RESCAN_MS. Nothing cheap seen from outside the
//   page reliably signals a closed root attached later to an element already there (the light DOM is unchanged).
// Refs belong to one main-frame document (Tab.documentGeneration): a navigation voids them, and a scan that
// finishes after a navigation is dropped. s numbers are never reused in a tab: a control keeps its number for the
// life of its document, and a new document's controls get numbers above every one shown before.

import crypto from 'node:crypto';
import { cdp } from './cdp.mjs';
import { sleep, within } from './util.mjs';

const KEY = `__fb${crypto.randomBytes(6).toString('hex')}`; // per server process, so pages cannot guess it
const ROLES = new Set(['textbox', 'searchbox', 'button', 'link', 'checkbox', 'radio', 'combobox', 'menuitem', 'tab', 'switch', 'slider', 'option']);
const DECLARATIVE = /shadowrootmode\s*=\s*["']?closed/i;
const RESCAN_MS = 10_000;
const FRAME_READ_MS = 1000;
const BODY_WAIT_MS = 2000;
const HIT_WAIT_MS = 1500;

// Installs the counter in the current document if missing and returns it. `late` = installed after the
// document had already run scripts, so closed roots made before it are unknown until one full scan.
function hook(key, late) {
  const own = Object.prototype.hasOwnProperty.call(document, key);
  if (own) return { closed: document[key].closed, late: document[key].late };
  const state = { closed: 0, late };
  Object.defineProperty(document, key, { value: state });
  Element.prototype.attachShadow = new Proxy(Element.prototype.attachShadow, {
    apply(target, self, args) {
      const root = Reflect.apply(target, self, args);
      if (root.mode === 'closed') state.closed++;
      return root;
    },
  });
  // Declarative roots parsed from strings at runtime.
  const parser = (fn) => new Proxy(fn, {
    apply(target, self, args) {
      if (/shadowrootmode\s*=\s*["']?closed/i.test(String(args[0]))) state.closed++;
      return Reflect.apply(target, self, args);
    },
  });
  for (const proto of [Element.prototype, ShadowRoot.prototype]) if (proto.setHTMLUnsafe) proto.setHTMLUnsafe = parser(proto.setHTMLUnsafe);
  if (Document.parseHTMLUnsafe) Document.parseHTMLUnsafe = parser(Document.parseHTMLUnsafe);
  return { closed: 0, late };
}

// Tab -> { count: highest s number given, generation, base: count before this document's first number,
//   byNode: Map(backendNodeId -> "sN") of this document, refs: Map("sN" -> backendNodeId) of the last scan }
const refsByTab = new WeakMap();
const hooked = new WeakSet(); // Tabs with the attachShadow hook
const declarativeByTab = new WeakMap(); // agent Tab -> WeakMap(frame -> Promise<boolean>) for its current document
const claimedState = new WeakMap(); // claimed Tab -> { generation, hosts, at } of the last full scan

// Call once per adopted tab, before it navigates. Agent tabs (inject) get the hook in every new document,
// and every document response is checked for declarative closed roots.
export async function watchClosedShadow(tab, inject) {
  if (!inject) return;
  hooked.add(tab);
  const declarative = new WeakMap();
  declarativeByTab.set(tab, declarative);
  tab.page.on('response', (response) => {
    const request = response.request();
    if (!request.isNavigationRequest() || request.resourceType() !== 'document') return;
    const check = response.text().then((body) => DECLARATIVE.test(body), () => false);
    declarative.set(response.frame(), check);
  });
  await cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', { source: `(${hook})(${JSON.stringify(KEY)}, false)` });
}

export const isShadowRef = (ref) => /^s\d+$/.test(cleanRef(ref));
export const cleanRef = (ref) => String(ref).trim().replace(/^\[?(?:ref=|aria-ref=)?/, '').replace(/\]$/, '');

// Should this snapshot run the full scan? Agent tabs: counters per frame plus the declarative check.
async function agentNeedsScan(tab) {
  const frames = tab.page.frames();
  const states = await Promise.all(frames.map((frame) => within(frame.evaluate(`(${hook})(${JSON.stringify(KEY)}, true)`), FRAME_READ_MS, null)));
  const declarative = declarativeByTab.get(tab);
  const parsed = await Promise.all(frames.map((frame) => within(declarative?.get(frame) ?? Promise.resolve(false), BODY_WAIT_MS, false)));
  const late = frames.filter((_, i) => states[i]?.late);
  const closed = states.reduce((sum, s) => sum + (s?.closed ?? 0), 0) + parsed.filter(Boolean).length;
  // A frame that didn't answer in time (a busy page or machine) may have roots: look rather than miss them.
  const unknown = states.some((state) => state === null);
  return { scan: closed > 0 || late.length > 0 || unknown, late, expected: closed };
}

// Claimed tabs: first snapshot of a document, every snapshot while it has roots, else once RESCAN_MS has passed.
function claimedNeedsScan(tab) {
  const last = claimedState.get(tab);
  return { scan: !last || last.generation !== tab.documentGeneration || last.hosts > 0 || Date.now() - last.at >= RESCAN_MS };
}

// YAML lines for interactive controls inside closed shadow roots ('' when there are none). Regenerates the tab's s refs.
export async function closedShadowSection(tab) {
  const generation = tab.documentGeneration;
  const state = refStateOf(tab);
  state.refs = new Map();
  const agent = hooked.has(tab);
  const need = agent ? await agentNeedsScan(tab) : claimedNeedsScan(tab);
  if (!need.scan) return '';

  const { root } = await cdp(tab, 'DOM.getDocument', { depth: -1, pierce: true });
  await cdp(tab, 'DOM.disable'); // getDocument turns on DOM mutation events; nobody here wants them
  const hosts = []; // outermost hosts of closed roots
  const inside = new Set(); // backendNodeIds inside closed roots
  let roots = 0; // closed roots, nested ones included
  const walk = (node, closed) => {
    if (node.localName === 'fowlbrowser-cursor') return; // the agent cursor overlay (cursor/overlay.js), not the page
    if (closed) inside.add(node.backendNodeId);
    for (const shadow of node.shadowRoots ?? []) {
      const isClosed = shadow.shadowRootType === 'closed';
      if (isClosed) roots++;
      if (isClosed && !closed) hosts.push(node.backendNodeId);
      walk(shadow, closed || isClosed);
    }
    for (const child of node.children ?? []) walk(child, closed);
    if (node.contentDocument) walk(node.contentDocument, closed);
  };
  walk(root, false);
  if (tab.documentGeneration !== generation) return ''; // navigated meanwhile: these nodes belong to the old document
  if (!agent) claimedState.set(tab, { generation, hosts: hosts.length, at: Date.now() });
  else {
    // Documents the hook joined late stay late (scanned on every snapshot) only while the page has roots. Not counted as
    // roots of their own: those are what the hook saw, which a late cross-origin frame's are not.
    await Promise.all(need.late.map((frame) => frame.evaluate(([key, found]) => {
      const state = document[key];
      if (state) state.late = found;
    }, [KEY, hosts.length > 0]).catch(() => {})));
  }
  const unreachable = agent && need.expected > roots
    ? '\n  - note: the page made closed shadow roots this list cannot reach (cross-origin frame, or not on the page); for a control you see but cannot find here, use screenshot and click x,y'
    : '';
  if (!hosts.length) return unreachable ? `\n- group "Inside closed shadow roots":${unreachable}` : '';

  if (state.generation !== generation) Object.assign(state, { generation, base: state.count, byNode: new Map() });
  const refs = new Map();
  const lines = [];
  for (const backendNodeId of hosts) {
    const { nodes } = await cdp(tab, 'Accessibility.queryAXTree', { backendNodeId });
    for (const node of nodes) {
      if (node.ignored || !ROLES.has(node.role?.value) || !inside.has(node.backendDOMNodeId)) continue;
      let ref = state.byNode.get(node.backendDOMNodeId);
      if (!ref) state.byNode.set(node.backendDOMNodeId, ref = `s${++state.count}`);
      if (refs.has(ref)) continue;
      refs.set(ref, node.backendDOMNodeId);
      const props = Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value]));
      const flags = ['checked', 'disabled', 'expanded', 'selected'].filter((f) => props[f] === true || props[f] === 'true').map((f) => ` [${f}]`).join('');
      const name = node.name?.value ? ` ${JSON.stringify(node.name.value)}` : '';
      const value = node.value?.value ? `: ${JSON.stringify(String(node.value.value))}` : '';
      lines.push(`  - ${node.role.value}${name}${flags} [ref=${ref}]${value}`);
    }
  }
  await cdp(tab, 'Accessibility.disable');
  if (tab.documentGeneration !== generation) return '';
  state.refs = refs;
  if (!lines.length) return unreachable ? `\n- group "Inside closed shadow roots":${unreachable}` : '';
  return `\n- group "Inside closed shadow roots (use these s refs with click, type, hover, press_key)":\n${lines.join('\n')}${unreachable}`;
}

function refStateOf(tab) {
  let state = refsByTab.get(tab);
  if (!state) refsByTab.set(tab, state = { count: 0, generation: null, base: 0, byNode: new Map(), refs: new Map() });
  return state;
}

const staleMessage = (clean) => `Ref ${clean} is unknown, stale or not visible. Take a new snapshot and use its s refs.`;

function backendNodeFor(tab, ref) {
  const clean = cleanRef(ref);
  const state = refsByTab.get(tab);
  const backendNodeId = state?.generation === tab.documentGeneration ? state.refs.get(clean) : undefined;
  if (backendNodeId) return backendNodeId;
  // A number given on an earlier document of the tab: never resolved on this one.
  const n = Number(clean.slice(1));
  if (state && n <= state.count && (state.generation !== tab.documentGeneration || n <= state.base)) {
    throw new Error(`Ref ${clean} is from an earlier page of this tab: it has loaded a new page since (${tab.page.url()}). Call snapshot again and use its refs.`);
  }
  throw new Error(staleMessage(clean));
}

// Runs a CDP call on the node behind an s ref, turning "node gone" errors into a clear hint.
async function onNode(tab, ref, method, params = {}) {
  const backendNodeId = backendNodeFor(tab, ref);
  try {
    return await cdp(tab, method, { ...params, backendNodeId });
  } catch (error) {
    if (/no node|backend id|box model|layout object|not attached|detached/i.test(error.message)) throw new Error(staleMessage(cleanRef(ref)));
    throw error;
  }
}

// The node's flat-tree subtree: backendNodeIds of its children, shadow roots, pseudo-elements (a switch's ::after
// knob) and what its slots show, plus the slotted text nodes (a hit on text reports the text's DOM parent, the host, instead).
async function flatSubtree(tab, backendNodeId, tree = { ids: new Set(), texts: [] }) {
  const { node } = await cdp(tab, 'DOM.describeNode', { backendNodeId, depth: -1, pierce: true });
  const slotted = [];
  const walk = (n) => {
    tree.ids.add(n.backendNodeId);
    for (const d of n.distributedNodes ?? []) (d.nodeType === 3 ? tree.texts : slotted).push(d.backendNodeId);
    for (const child of [...(n.shadowRoots ?? []), ...(n.pseudoElements ?? []), ...(n.children ?? [])]) walk(child);
  };
  walk(node);
  for (const id of slotted) if (!tree.ids.has(id)) await flatSubtree(tab, id, tree);
  return tree;
}

async function parentId(tab, backendNodeId) {
  const objects = [];
  try {
    const { object } = await cdp(tab, 'DOM.resolveNode', { backendNodeId });
    objects.push(object.objectId);
    const { result } = await cdp(tab, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return this.parentNode; }' });
    if (!result?.objectId) return null;
    objects.push(result.objectId);
    return (await cdp(tab, 'DOM.describeNode', { objectId: result.objectId })).node.backendNodeId;
  } finally {
    for (const objectId of objects) cdp(tab, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

// true if what a click at the point hits is the ref's node or shown inside it, else a short description of it.
async function hitTest(tab, ref, { x, y }) {
  const backendNodeId = backendNodeFor(tab, ref);
  // getNodeForLocation takes document coordinates; the box model (and the click) are in viewport coordinates.
  const { cssLayoutViewport: scrolled } = await cdp(tab, 'Page.getLayoutMetrics');
  const hit = await cdp(tab, 'DOM.getNodeForLocation', { x: Math.round(x + scrolled.pageX), y: Math.round(y + scrolled.pageY), includeUserAgentShadowDOM: false, ignorePointerEventsNone: false })
    .catch(() => null);
  if (!hit?.backendNodeId) return 'nothing (off screen)';
  if (hit.backendNodeId === backendNodeId) return true;
  const { ids, texts } = await flatSubtree(tab, backendNodeId).catch(() => ({ ids: new Set(), texts: [] }));
  if (ids.has(hit.backendNodeId)) return true;
  for (const text of texts.slice(0, 5)) if (await parentId(tab, text).catch(() => null) === hit.backendNodeId) return true;
  const { node } = await cdp(tab, 'DOM.describeNode', { backendNodeId: hit.backendNodeId }).catch(() => ({}));
  if (!node) return 'another element';
  const attrs = Object.fromEntries((node.attributes ?? []).flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]])));
  return `<${node.localName || node.nodeName.toLowerCase()}${attrs.id ? `#${attrs.id}` : ''}${attrs.class ? `.${attrs.class.trim().split(/\s+/).join('.')}` : ''}>`;
}

// Viewport point (CSS px) at the centre of the node, scrolled into view first. Waits briefly while something
// else covers that point (an overlay that is closing), then fails instead of clicking what covers it.
export async function shadowRefPoint(tab, ref) {
  const deadline = Date.now() + HIT_WAIT_MS;
  for (;;) {
    await onNode(tab, ref, 'DOM.scrollIntoViewIfNeeded');
    const { model } = await onNode(tab, ref, 'DOM.getBoxModel');
    const q = model.border;
    const point = { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
    const hit = await hitTest(tab, ref, point);
    if (hit === true) return point;
    if (Date.now() > deadline) {
      throw new Error(`Ref ${cleanRef(ref)} is covered at its centre (${Math.round(point.x)}, ${Math.round(point.y)}) by ${hit}. ` +
        'Close or dismiss what covers it, then take a new snapshot.');
    }
    await sleep(150);
  }
}

// Centre of the node behind an s ref (scrolled into view), without the hit test: where the agent cursor points.
export async function shadowRefCenter(tab, ref) {
  await onNode(tab, ref, 'DOM.scrollIntoViewIfNeeded');
  const q = (await onNode(tab, ref, 'DOM.getBoxModel')).model.border;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

export const focusShadowRef = (tab, ref) => onNode(tab, ref, 'DOM.focus');

// Calls fn(el) on the node behind an s ref (fn must be self-contained, it runs in the page); returns its JSON value.
export async function callOnShadowRef(tab, ref, fn) {
  const { object } = await onNode(tab, ref, 'DOM.resolveNode');
  try {
    return (await cdp(tab, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: String(fn), returnByValue: true }))?.result?.value;
  } finally {
    cdp(tab, 'Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}
