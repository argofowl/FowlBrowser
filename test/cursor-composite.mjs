#!/usr/bin/env node
// Whether Chrome runs every animation of the agent cursor (mcp/src/cursor/overlay.js of this checkout) on the
// compositor, where a busy page main thread can't stall it. Headless, no window, its own temporary profile:
//   node test/cursor-composite.mjs [--chrome <path to a Chrome or Chromium binary>]
// Drives a fixed script through __fbCursor (appear and travel, retarget, click, every cue, a long label, the corner
// pose, hide), once with full motion and once with prefers-reduced-motion: reduce, while tracing blink.animations.
// Prints one line per distinct animation (target element, animated properties, how many, during which steps) and
// exits 1 when any is not composited. Travel and turns are rAF frames, not animations: not checked here.
import fs from 'node:fs';
import { chromium } from '../mcp/node_modules/playwright-core/index.mjs';

const at = process.argv.indexOf('--chrome');
const executablePath = at > 0 ? process.argv[at + 1] : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SOURCE = fs.readFileSync(new URL('../mcp/src/cursor/overlay.js', import.meta.url), 'utf8');
const W = 800;
const H = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Chromium's CompositorAnimations::FailureReason bits (third_party/blink/renderer/core/animation/compositor_animations.h).
// NO_CHANGE alone is no failure: the animation changes nothing visible (constant values, or off screen).
const REASONS = ['accelerated animations disabled', 'suppressed by devtools', 'invalid animation or effect', 'unsupported timing',
  'non-replace composite mode', 'target has invalid compositing state', 'target has incompatible animations', 'target has CSS offset',
  '(obsolete)', '(obsolete)', 'transform cannot be accelerated on target', '(unused)', 'filter may move pixels', 'unsupported CSS property',
  '(obsolete)', 'mixed keyframe value types', 'timeline source not composited', 'no visible change', 'affects !important property',
  'SVG target has independent transform', 'non-replace iteration composite', 'unsupported inheritance'];
const NO_CHANGE = 1 << 17;
const reasons = (bits) => REASONS.filter((_, i) => bits & (1 << i)).join(', ') || 'unknown';

// The trace names only an animation's target element. What it animates comes from its keyframes: every animate() call
// in the overlay's world is noted (step, target class, properties), in the order the trace begins them. Evaluated in
// that world before the overlay; it changes nothing else.
const NOTE = `(() => {
  const animate = Element.prototype.animate;
  globalThis.__animations = [];
  Element.prototype.animate = function (keyframes, options) {
    const props = [...new Set((Array.isArray(keyframes) ? keyframes : [keyframes]).flatMap((k) => Object.keys(k ?? {}))
      .filter((p) => !['offset', 'easing', 'composite'].includes(p)))].sort();
    globalThis.__animations.push({ step: globalThis.__step, target: this.getAttribute('class') ?? '', props: props.join(' ') });
    return animate.call(this, keyframes, options);
  };
})()`;

async function run(reduced) {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2, reducedMotion: reduced ? 'reduce' : 'no-preference' });
    await page.setContent('<body style="margin:0;background:#fff;font:16px system-ui"><p style="margin:40px">A page.</p></body>');
    const cdp = await page.context().newCDPSession(page);
    const events = [];
    cdp.on('Tracing.dataCollected', (d) => events.push(...d.value));
    const traced = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['blink.animations'] }, transferMode: 'ReportEvents' });
    // The overlay in an isolated world of the top frame, as the server injects it (mcp/src/cursor/index.mjs world()).
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId: contextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'fowlbrowser-cursor' });
    const evaluate = async (expression) => {
      const reply = await cdp.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`);
      return reply.result.value;
    };
    await evaluate(NOTE);
    await evaluate(SOURCE);
    const step = (name) => evaluate(`globalThis.__step = ${JSON.stringify(name)}`);
    const c = (call, opts) => evaluate(`globalThis.__fbCursor.${call}${opts ? `, ${JSON.stringify(opts)})` : ''}`);
    const label = { label: 'Claude' };

    await step('appear + long move');
    const arrived = c('move(60, 60', label);
    await sleep(200);
    await step('retarget');
    await c('move(620, 120', label);
    await arrived;
    await sleep(200);
    await step('click');
    await c('click(620, 120)');
    await sleep(450);
    // A word stays at least 0.6 s; Pressing keys and Loading go by themselves after 1.2 s. Then 0.25 s for the change back.
    for (const kind of ['observe', 'scroll', 'text', 'key', 'navigate', 'drag', 'transfer']) {
      await step(`cue ${kind}`);
      await c(`cue(${JSON.stringify(kind)}`, label);
      await sleep(kind === 'key' || kind === 'navigate' ? 1250 : 650);
      await c('cueEnd()');
      await sleep(250);
    }
    await step('hide');
    await c('hide()');
    await step('cue while appearing');
    await c('cue("observe"', label);
    await sleep(650);
    await c('cueEnd()');
    await sleep(250);
    await step('long label');
    // Travels, so the pill's glide to the new width runs (a land would cut it short).
    await c('move(300, 200', { label: 'Research agent reading the quarterly report' });
    await sleep(200);
    await step('label back');
    await c('move(360, 240', label);
    await sleep(200);
    await step('corner');
    await c(`move(${W - 3}, ${H - 3}`, label);
    await sleep(300);
    await step('hide');
    await c('hide()');
    await sleep(250);
    const noted = await evaluate('globalThis.__animations');

    await cdp.send('Tracing.end');
    await traced;
    // Trace begin events in order, each matched to the animate() call noted for it (same target class). A trace id is
    // reused once its animation is gone: a begin starts a new one under that id.
    const all = [];
    const live = new Map();
    for (const e of events.filter((e) => e.name === 'Animation').sort((a, b) => a.ts - b.ts)) {
      const id = e.id2?.local ?? e.id;
      const data = e.args?.data ?? {};
      if (e.ph === 'b') {
        const target = /class='([^']*)'/.exec(data.nodeName ?? '')?.[1] ?? '';
        const note = noted[all.length];
        const known = note && note.target === target;
        const a = { target: target ? target.split(' ').map((k) => `.${k}`).join('') : (data.nodeName ?? '?').toLowerCase(),
          props: known ? note.props : '?', step: known ? note.step : '?', failed: 0, unsupported: [], begin: e.ts };
        live.set(id, a);
        all.push(a);
      } else if (e.ph === 'e' && live.has(id)) {
        live.get(id).end ??= e.ts;
      } else if (data.compositeFailed !== undefined && live.has(id)) {
        const a = live.get(id);
        a.failed |= data.compositeFailed;
        a.unsupported = [...new Set([...a.unsupported, ...(data.unsupportedProperties ?? [])])];
      }
    }
    if (all.length !== noted.length) console.warn(`${reduced ? 'reduced' : 'full'}: ${all.length} animations traced, ${noted.length} started`);
    return { version: browser.version(), all };
  } finally {
    await browser.close();
  }
}

const runs = await Promise.all([run(false), run(true)]);
console.log(`Chrome ${runs[0].version}, overlay ${new URL('../mcp/src/cursor/overlay.js', import.meta.url).pathname}, isolated world`);
let failing = 0;
for (const [i, { all }] of runs.entries()) {
  console.log(`\n${i ? 'prefers-reduced-motion: reduce' : 'full motion'}`);
  const groups = new Map();
  for (const a of all) {
    // Cancelled in the task that started it (a jump cuts a label glide short): Chrome never tried to composite it.
    a.never = !a.failed && a.end - a.begin < 3000;
    const key = `${a.target} ${a.props} ${a.failed} ${a.never}`;
    const g = groups.get(key) ?? { ...a, count: 0, steps: new Set() };
    g.count++;
    g.steps.add(a.step);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const bad = g.failed & ~NO_CHANGE;
    if (bad) failing++;
    const verdict = bad ? `NOT composited (0x${g.failed.toString(16)}: ${reasons(g.failed)}${g.unsupported.length ? `; unsupported: ${g.unsupported.join(', ')}` : ''})`
      : g.failed ? 'composited (no visible change, nothing to run)' : g.never ? 'not checked (cancelled before its first frame)' : 'composited';
    console.log(`  ${g.target.padEnd(15)} ${g.props.padEnd(26)} x${String(g.count).padEnd(3)} ${verdict}  [${[...g.steps].join(', ')}]`);
  }
}
console.log(failing ? `\n${failing} not composited` : '\nall composited');
process.exit(failing ? 1 : 0);
