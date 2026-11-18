// jev_run: the snapshot → element table parser, the risky-click guard, and the loop against a fake TypeSafe API and
// fake click/type handlers (no browser, no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSnapshot, registerJev, RISKY, targetCriteria } from '../src/jev.mjs';

const SNAP = `Browser: Chrome · Tab: chrome:1 · Search · https://example.test/
Snapshot 1 of this tab:
\`\`\`yaml
- banner [ref=e1]:
  - link [ref=e2] [cursor=pointer]:
    - /url: /
    - img "Example home" [ref=e3]
  - button "Menu" [ref=e4]
- main [ref=e5]:
  - heading "Find a flight" [level=1] [ref=e6]
  - searchbox "Where to?" [ref=e7]
  - textbox "From" [ref=e8]: Zurich
  - checkbox "Direct only" [checked] [ref=e9]
  - button "Post review" [disabled] [ref=e10]
  - text: Prices include taxes
  - button "Search" [ref=e11]
  - link "Help" [ref=e12] [cursor=pointer]:
    - /url: /help
\`\`\``;

test('parser: fields first, then toggles, buttons, links; nameless links borrow a child name; disabled controls are left out', () => {
  const { elements } = parseSnapshot(SNAP);
  assert.deepEqual(elements.map((e) => e.ref), ['e7', 'e8', 'e9', 'e4', 'e11', 'e2', 'e12']);
  const byRef = Object.fromEntries(elements.map((e) => [e.ref, e]));
  assert.equal(byRef.e2.name, 'Example home');
  assert.equal(byRef.e8.value, 'Zurich');
  assert.equal(byRef.e7.value, '');
  assert.deepEqual(byRef.e9.flags, ['checked']);
  assert.ok(!byRef.e10);
});

test('parser: page text starts at the main landmark and drops /url lines', () => {
  const { pageText } = parseSnapshot(SNAP);
  assert.match(pageText, /^main\n/);
  assert.match(pageText, /Prices include taxes/);
  assert.doesNotMatch(pageText, /Menu|\/url|\/help/);
});

test('target criteria: one option per element plus none, or null when nothing fits', () => {
  const { elements } = parseSnapshot(SNAP);
  const typing = targetCriteria(elements, (e) => e.role === 'searchbox' || e.role === 'textbox');
  assert.deepEqual(Object.keys(typing), ['e7', 'e8', 'none']);
  assert.match(typing.e8, /textbox "From" · value: Zurich/);
  assert.equal(targetCriteria(elements, (e) => e.role === 'slider'), null);
});

test('risky guard: irreversible controls in English and Portuguese, not ordinary ones', () => {
  for (const name of ['Send', 'Pagar agora', 'Place order', 'Submit order', 'Publicar', 'Delete account', 'Finalizar pedido']) assert.ok(RISKY.test(name), name);
  for (const name of ['Search', 'Next', 'Apply filters', 'Open', 'Buscar']) assert.ok(!RISKY.test(name), name);
});

// The loop: a fake `tool` registry, handlers that record calls, and a fetch that answers from a script.
function harness(answers, page = SNAP) {
  const calls = [];
  const requests = [];
  let jev;
  registerJev((name, _d, _s, handler) => { if (name === 'jev_run') jev = handler; }, null, {
    parseTabId: (v) => ({ key: v.split(':')[0], tabId: Number(v.split(':')[1]) }),
    handlers: {
      snapshot: async () => ({ content: [{ type: 'text', text: page }] }),
      click: async (a) => { calls.push(['click', a.ref]); return { content: [{ type: 'text', text: a.ref === 'e12' ? 'New tab opened by this action (you control it): chrome:2 · https://example.test/help' : 'ok' }] }; },
      type: async (a) => { calls.push(['type', a.ref, a.text, !!a.submit]); return { content: [{ type: 'text', text: 'ok' }] }; },
      scroll: async () => { calls.push(['scroll']); return { content: [] }; },
      wait_for: async () => ({ content: [] }),
      select_option: async () => ({ content: [] }),
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const answer = answers.shift();
    return new Response(JSON.stringify({ model: 'jev-test', answers: answer(body), usage: { input_tokens: 10, output_tokens: 1 } }));
  };
  return { calls, requests, run: (args) => jev({ tab: 'chrome:1', ...args }).finally(() => { globalThis.fetch = realFetch; }) };
}
const choice = (c, p = 0.9) => ({ type: 'choice', choice: c, probabilities: { [c]: p } });

test('loop: types a provided input, clicks, then stops on DONE; one request per step with every target question', async () => {
  process.env.TYPESAFE_API_KEY = 'test';
  const h = harness([
    () => ({ operation: choice('TYPE_TEXT'), click_target: choice('e11'), type_target: choice('e7'), type_value: choice('destination'), type_submit: { type: 'noul', noul: 0.2 } }),
    () => ({ operation: choice('CLICK'), click_target: choice('e11'), type_target: choice('none'), type_value: choice('destination'), type_submit: { type: 'noul', noul: 0.1 } }),
    () => ({ operation: choice('DONE', 0.95) }),
  ]);
  const result = await h.run({ goal: 'Search flights to London', inputs: { destination: 'London' } });
  assert.deepEqual(h.calls, [['type', 'e7', 'London', false], ['click', 'e11']]);
  assert.equal(h.requests.length, 3);
  assert.deepEqual(Object.keys(h.requests[0].questions).sort(), ['click_target', 'operation', 'type_submit', 'type_target', 'type_value']);
  assert.ok(h.requests[0].state.controls_on_page.some((c) => c.startsWith('searchbox "Where to?"')));
  assert.match(result.content[0].text, /^jev_run status: done · 3 steps/);
});

test('loop: no inputs means no typing questions; a risky click stops before acting', async () => {
  process.env.TYPESAFE_API_KEY = 'test';
  const risky = SNAP.replace('button "Search" [ref=e11]', 'button "Place order" [ref=e11]');
  const h = harness([() => ({ operation: choice('CLICK'), click_target: choice('e11') })], risky);
  const result = await h.run({ goal: 'Order it' });
  assert.deepEqual(h.calls, []);
  assert.equal(h.requests.length, 1);
  assert.ok(!('type_target' in h.requests[0].questions));
  assert.match(result.content[0].text, /status: needs_confirmation \(next click would be button "Place order" \[ref=e11\]\)/);
});

test('loop: a click that opens a new tab stops and names it instead of clicking again', async () => {
  process.env.TYPESAFE_API_KEY = 'test';
  const h = harness([() => ({ operation: choice('CLICK'), click_target: choice('e12') })]);
  const result = await h.run({ goal: 'Open the help page' });
  assert.deepEqual(h.calls, [['click', 'e12']]);
  assert.match(result.content[0].text, /status: new_tab \(the click opened chrome:2 \(https:\/\/example\.test\/help\); continue there\)/);
});

test('loop: a low-probability operation stops as uncertain without acting', async () => {
  process.env.TYPESAFE_API_KEY = 'test';
  const h = harness([() => ({ operation: { type: 'choice', choice: 'CLICK', probabilities: { CLICK: 0.3, SCROLL_DOWN: 0.3 } }, click_target: choice('e11') })]);
  const result = await h.run({ goal: 'Search' });
  assert.deepEqual(h.calls, []);
  assert.match(result.content[0].text, /status: uncertain/);
});
