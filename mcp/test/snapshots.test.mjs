// Text helpers for what agents read: caps, ref numbering, changes-only snapshots, page text, evaluate source, wait_for url patterns.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cap, collapseText, functionSource, MASK, maskFields, newRefState, numberRefs, playwrightRef, REF_PATTERN, shownRef, shownValue, snapshotChanges, textFields,
  urlMatcher, yamlValue } from '../src/snapshots.mjs';
import { cleanError } from '../src/tools.mjs';

test('cap: short text is unchanged', () => {
  assert.equal(cap('a\nb', 100, 'note'), 'a\nb');
});

test('cap: cuts at a line boundary, stays within max and counts the left-out lines', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `- listitem "row ${i}" [ref=e${i}]`).join('\n');
  const out = cap(text, 2000, 'Call snapshot with ref=<eN>');
  assert.ok(out.length <= 2000, `length ${out.length}`);
  const lines = out.split('\n');
  const last = lines.pop();
  assert.match(last, /^\.\.\. \[(\d+) more lines not shown\. Call snapshot with ref=<eN>\]$/);
  assert.equal(Number(/(\d+)/.exec(last)[1]) + lines.length, 1000);
  assert.ok(lines.every((line, i) => line === `- listitem "row ${i}" [ref=e${i}]`), 'kept lines are whole');
});

test('cap: one huge line still fits', () => {
  const out = cap('x'.repeat(50_000), 1000, 'n');
  assert.ok(out.length <= 1000);
  assert.match(out, /1 more line not shown/);
});

const page = `- banner [ref=e1]:
  - link "Home" [ref=e2]
- main [ref=e3]:
  - heading "Shop" [level=1] [ref=e4]
  - list [ref=e5]:
    - listitem [ref=e6]: Apples
    - listitem [ref=e7]: Pears
  - button "Add" [ref=e8]
  - status [ref=e9]: 0 items`;

const big = (body) => `${body}\n${Array.from({ length: 40 }, (_, i) => `- paragraph [ref=p${i}]: filler text number ${i}`).join('\n')}`;

test('snapshotChanges: added lines with their ancestors, changed lines as removed + added', () => {
  const next = page
    .replace('    - listitem [ref=e7]: Pears', '    - listitem [ref=e7]: Pears\n    - listitem [ref=e10]: Plums')
    .replace('0 items', '1 item');
  const out = snapshotChanges(big(page), big(next), { since: 6, number: 7 });
  assert.equal(out, [
    'Changes since snapshot 6 of this tab; this is snapshot 7 (call snapshot for the whole page).',
    'Lines starting with + are new or changed (use their refs); the other lines are their parent elements, for context.',
    '  - main [ref=e3]:',
    '    - list [ref=e5]:',
    '+     - listitem [ref=e10]: Plums',
    '+   - status [ref=e9]: 1 item',
    'Removed (1 line, no longer on the page):',
    '- - status [ref=e9]: 0 items',
  ].join('\n'));
});

test('snapshotChanges: nothing changed', () => {
  assert.equal(snapshotChanges(page, page, { since: 3, number: 4 }), 'No changes since snapshot 3 of this tab; this is snapshot 4.');
});

test('snapshotChanges: only removals', () => {
  const out = snapshotChanges(big(page), big(page.replace('  - button "Add" [ref=e8]\n', '')));
  assert.match(out, /No new or changed lines\.\nRemoved \(1 line, no longer on the page\):\n- - button "Add" \[ref=e8\]$/);
});

test('snapshotChanges: removed list is capped', () => {
  const rows = Array.from({ length: 200 }, (_, i) => `- row [ref=r${i}]: ${i}`).join('\n');
  const out = snapshotChanges(`${big(big(big('- x')))}\n${rows}`, big(big(big('- x'))));
  assert.match(out, /Removed \(200 lines/);
  assert.match(out, /\.\.\. and 160 more removed lines\.$/);
});

test('snapshotChanges: a diff about as big as the page returns null (send the full snapshot)', () => {
  assert.equal(snapshotChanges(page, page.replace(/ref=e/g, 'ref=f')), null);
});

test('snapshotChanges: duplicate lines are counted, not just matched', () => {
  const before = big('- main:\n  - listitem: same');
  const after = big('- main:\n  - listitem: same\n  - listitem: same');
  assert.match(snapshotChanges(before, after), /  - main:\n\+   - listitem: same/);
});

test('snapshotChanges: an element moved to another parent is removed + added', () => {
  const regions = (active, archive) => big(`- region "Active" [ref=e1]:\n${active}- region "Archive" [ref=e2]:\n${archive}- paragraph [ref=e9]: end`);
  const task = '  - button "Task" [ref=e3]\n';
  const before = regions(`${task}  - button "Other" [ref=e4]\n`, '  - button "Old" [ref=e5]\n');
  const after = regions('  - button "Other" [ref=e4]\n', `  - button "Old" [ref=e5]\n${task}`);
  const out = snapshotChanges(before, after, { since: 1, number: 2 });
  assert.match(out, /\n  - region "Archive" \[ref=e2\]:\n\+   - button "Task" \[ref=e3\]\n/);
  assert.match(out, /Removed \(1 line, no longer on the page\):\n- - button "Task" \[ref=e3\]$/);
});

test('snapshotChanges: a parent with a ref that changes state keeps its children unchanged', () => {
  const before = big(`- generic [active] [ref=e1]:\n${page.replace(/^/gm, '  ')}`);
  const after = big(`- generic [ref=e1]:\n${page.replace(/^/gm, '  ').replace('- button "Add" [ref=e8]', '- button "Add" [active] [ref=e8]')}`);
  assert.equal(snapshotChanges(before, after, { since: 1, number: 2 }), [
    'Changes since snapshot 1 of this tab; this is snapshot 2 (call snapshot for the whole page).',
    'Lines starting with + are new or changed (use their refs); the other lines are their parent elements, for context.',
    '+ - generic [ref=e1]:',
    '    - main [ref=e3]:',
    '+     - button "Add" [active] [ref=e8]',
    'Removed (2 lines, no longer on the page):',
    '- - generic [active] [ref=e1]:',
    '- - button "Add" [ref=e8]',
  ].join('\n'));
});

test('snapshotChanges: reordered siblings return null (send the full snapshot)', () => {
  const swapped = page.replace('    - listitem [ref=e6]: Apples\n    - listitem [ref=e7]: Pears', '    - listitem [ref=e7]: Pears\n    - listitem [ref=e6]: Apples');
  assert.equal(snapshotChanges(big(page), big(swapped), { since: 1, number: 2 }), null);
  // A moved subtree with children reorders too.
  const tree = big('- list:\n  - listitem [ref=e1]:\n    - link "A" [ref=e2]\n  - listitem [ref=e3]:\n    - link "B" [ref=e4]');
  const moved = big('- list:\n  - listitem [ref=e3]:\n    - link "B" [ref=e4]\n  - listitem [ref=e1]:\n    - link "A" [ref=e2]');
  assert.equal(snapshotChanges(tree, moved, { since: 1, number: 2 }), null);
});

test('numberRefs: the first page keeps Playwright refs; later pages number above every ref shown before', () => {
  const state = newRefState();
  const a = '- main [ref=e1]:\n  - button "Add" [ref=e2]\n  - iframe [ref=e3]:\n    - button "In frame" [ref=f1e1]';
  assert.equal(numberRefs(state, a, 1), a, 'first page unchanged');
  assert.equal(playwrightRef(state, 'e2', 1), 'e2');
  assert.equal(playwrightRef(state, 'f1e1', 1), 'f1e1', 'iframe refs pass through');
  // Same document again: same numbers.
  assert.equal(numberRefs(state, a.replace('Add', 'Added'), 1), a.replace('Add', 'Added'));
  // Page B: Playwright restarts at e1 and (after a real page) prefixes the main frame with its new seq.
  const b = '- main [ref=f4e1]:\n  - button "Add" [ref=f4e2]\n  - iframe [ref=f4e3]:\n    - button "In frame" [ref=f5e1]';
  assert.equal(numberRefs(state, b, 2), '- main [ref=e4]:\n  - button "Add" [ref=e5]\n  - iframe [ref=e6]:\n    - button "In frame" [ref=f5e1]');
  assert.equal(playwrightRef(state, 'e5', 2), 'f4e2', 'shown ref translates to the Playwright ref');
  assert.equal(shownRef(state, 'f4e2'), 'e5', 'and back, for errors');
  assert.equal(shownRef(state, 'f5e1'), 'f5e1');
  assert.equal(playwrightRef(state, 'e2', 2), null, 'page A ref (N <= base) is refused');
  assert.equal(playwrightRef(state, 'e3', 2), null, 'the highest page A ref too');
  assert.equal(playwrightRef(state, 'f1e1', 2), null, 'page A iframe ref is refused');
  assert.equal(playwrightRef(state, 'f5e1', 2), 'f5e1');
  assert.equal(playwrightRef(state, 'e99', 2), 'f4e96', 'a ref never shown goes to Playwright, which reports it stale');
  assert.equal(playwrightRef(state, 's3', 2), 's3', 'not a ref of this numbering');
  // A ref section of page B numbers the same way (main prefix already known).
  assert.equal(numberRefs(state, '- button "Add" [ref=f4e2]', 2, { whole: false }), '- button "Add" [ref=e5]');
  // Page C loaded but not snapshotted yet: every ref is refused.
  assert.equal(playwrightRef(state, 'e5', 3), null);
  assert.equal(numberRefs(state, '- main [ref=f6e1]', 3), '- main [ref=e7]');
  assert.equal(playwrightRef(state, 'e6', 3), null);
  assert.equal(playwrightRef(state, 'e7', 3), 'f6e1');
});

test('numberRefs: an iframe that loads a new page gets numbers above its earlier ones; its old refs are refused', () => {
  const state = newRefState();
  const a = '- main [ref=e1]:\n  - iframe [ref=e2]:\n    - button "A" [ref=f1e1]\n    - button "A2" [ref=f1e2]\n  - iframe [ref=e3]:\n    - button "C" [ref=f2e1]';
  assert.equal(numberRefs(state, a, 1, { frameGeneration: 0 }), a, 'first documents unchanged');
  assert.equal(playwrightRef(state, 'f1e1', 1, 0), 'f1e1');
  // Iframe f1 loads page B (the tab's frameGeneration moves on); Playwright keeps f1 and restarts at e1.
  assert.equal(playwrightRef(state, 'f1e1', 1, 1), null, 'refused before a new snapshot');
  assert.equal(playwrightRef(state, 'f2e1', 1, 1), null, 'every iframe ref is (the generation is tab-wide)');
  assert.equal(playwrightRef(state, 'e1', 1, 1), 'e1', 'main-frame refs still work');
  const b = '- main [ref=e1]:\n  - iframe [ref=e2]:\n    - button "B" [ref=f1e1]\n  - iframe [ref=e3]:\n    - button "C" [ref=f2e1]';
  assert.equal(numberRefs(state, b, 1, { frameGeneration: 1 }), '- main [ref=e1]:\n  - iframe [ref=e2]:\n    - button "B" [ref=f1e3]\n  - iframe [ref=e3]:\n    - button "C" [ref=f2e2]');
  assert.equal(playwrightRef(state, 'f1e1', 1, 1), null, 'A\'s f1e1 (M <= base) is refused, not resolved to B');
  assert.equal(playwrightRef(state, 'f1e2', 1, 1), null, 'the highest A ref too');
  assert.equal(playwrightRef(state, 'f1e3', 1, 1), 'f1e1', 'B\'s ref maps to the Playwright ref');
  assert.equal(playwrightRef(state, 'f2e2', 1, 1), 'f2e1');
  assert.equal(shownRef(state, 'f1e1'), 'f1e3', 'and back, for errors');
  assert.equal(playwrightRef(state, 'f9e1', 1, 1), null, 'a prefix never shown is refused');
  // A section of B, and a later snapshot of the same documents, keep the same numbers.
  assert.equal(numberRefs(state, '- button "B" [ref=f1e1]', 1, { whole: false, frameGeneration: 1 }), '- button "B" [ref=f1e3]');
  assert.equal(numberRefs(state, b, 1, { frameGeneration: 1 }), numberRefs(state, b, 1, { frameGeneration: 1 }));
  assert.equal(playwrightRef(state, 'f1e3', 1, 1), 'f1e1');
  // The main page loads: iframe refs of the old page are refused even if a prefix were seen again.
  assert.equal(numberRefs(state, '- main [ref=f3e1]:\n  - iframe [ref=f3e2]:\n    - button "D" [ref=f1e1]', 2, { frameGeneration: 2 }),
    '- main [ref=e4]:\n  - iframe [ref=e5]:\n    - button "D" [ref=f1e4]');
  assert.equal(playwrightRef(state, 'f1e3', 2, 2), null);
  assert.equal(playwrightRef(state, 'f2e2', 2, 2), null, 'a frame of the old page is refused');
  assert.equal(playwrightRef(state, 'f1e4', 2, 2), 'f1e1');
});

test('numberRefs: the main prefix comes from the first ref outside an iframe, even when iframe content comes first', () => {
  // An iframe line without a ref (not visible) and its content come before any main-frame ref.
  const state = newRefState();
  const a = '- generic:\n  - iframe:\n    - button "In frame" [ref=f6e1]\n- main [ref=f3e1]:\n  - button "Main" [ref=f3e2]';
  assert.equal(numberRefs(state, a, 1), '- generic:\n  - iframe:\n    - button "In frame" [ref=f6e1]\n- main [ref=e1]:\n  - button "Main" [ref=e2]');
  assert.equal(state.main, 'f3');
  assert.equal(playwrightRef(state, 'e2', 1), 'f3e2');
  assert.equal(playwrightRef(state, 'f6e1', 1), 'f6e1');
  assert.deepEqual([...state.mainPrefixes], ['f3']);
});

test('numberRefs: nested iframes stay out of the main frame; an iframe\'s own line is a main-frame ref', () => {
  const state = newRefState();
  const a = '- iframe [ref=f3e1]:\n  - iframe [ref=f4e1]:\n    - button "Deep" [ref=f5e1]\n  - button "Mid" [ref=f4e2]\n- button "Main" [ref=f3e2]';
  assert.equal(numberRefs(state, a, 1), '- iframe [ref=e1]:\n  - iframe [ref=f4e1]:\n    - button "Deep" [ref=f5e1]\n  - button "Mid" [ref=f4e2]\n- button "Main" [ref=e2]');
  assert.equal(state.main, 'f3');
  assert.deepEqual([...state.mainPrefixes], ['f3']);
});

test('numberRefs: without iframes every prefix is a main-frame one (back/forward cache keeps old refs)', () => {
  // A page restored from the back/forward cache: unchanged elements keep refs from the earlier visit (f3), new ones get f6.
  const state = newRefState();
  const a = '- main [ref=f3e1]:\n  - button "Old" [ref=f3e2]\n  - button "New" [ref=f6e1]';
  assert.equal(numberRefs(state, a, 1), '- main [ref=e1]:\n  - button "Old" [ref=e2]\n  - button "New" [ref=f6e1]');
  assert.deepEqual([...state.mainPrefixes].sort(), ['f3', 'f6']);
  assert.equal(playwrightRef(state, 'f6e1', 1), 'f6e1');
  numberRefs(state, '- main [ref=f6e2]', 2);
  assert.deepEqual([...state.mainPrefixes], ['f6'], 'a new document starts over');
});

test('REF_PATTERN: snapshot refs only', () => {
  for (const ref of ['e1', 'e12', 'f3e12']) assert.ok(REF_PATTERN.test(ref), ref);
  for (const ref of ['Fowl', 's4', 'f3', 'e', 'e12x', 'ref=e1', '']) assert.ok(!REF_PATTERN.test(ref), ref);
});

test('numberRefs: no snapshot yet refuses refs; a page without refs leaves the base where it was', () => {
  const state = newRefState();
  assert.equal(playwrightRef(state, 'e1', 0), null);
  assert.equal(playwrightRef(undefined, 'e1', 0), null);
  assert.equal(numberRefs(state, '- document', 0), '- document');
  assert.equal(numberRefs(state, '- button [ref=e1]', 1), '- button [ref=e1]');
  assert.equal(playwrightRef(state, 'e1', 1), 'e1');
});

test('collapseText: whitespace collapsed per line, empty lines dropped', () => {
  assert.equal(collapseText('  Title \n\n\n a \t  b  \n \nend'), 'Title\na b\nend');
});

// Runs functionSource's output the way evaluate does: the page form called with no argument, the ref form with el.
const run = (source, el) => {
  const document = { title: 'Doc' };
  // eslint-disable-next-line no-new-func
  return new Function('document', 'el', `return (${functionSource(source, { withElement: el !== undefined })})(el);`)(document, el);
};

test('functionSource: function expressions are called, other expressions return their value', async () => {
  assert.equal(run('(() => 42)'), 42);
  assert.equal(run('(function () { return 42; })'), 42);
  assert.equal(run('function () { return 43 }'), 43);
  assert.equal(run('(v = Math.max(1, 2)) => v'), 2);
  assert.equal(run('({ a } = { a: 5 }) => a'), 5);
  assert.equal(await run('async () => 1'), 1);
  assert.equal(run(' () => document.title '), 'Doc');
  assert.equal(run('document.title'), 'Doc');
  assert.equal(run('document.title;'), 'Doc', 'one trailing semicolon is dropped');
  assert.equal(run('document.title // the title'), 'Doc', 'a trailing comment keeps the wrapper intact');
  assert.deepEqual(run('[1, 2].map((n) => n * 2)'), [2, 4]);
  assert.equal(run('el => el.id', { id: 'x' }), 'x');
  assert.equal(run('(el) => el.id', { id: 'y' }), 'y');
  assert.equal(run('el.id', { id: 'z' }), 'z', 'a ref expression sees el');
  assert.throws(() => run('() => {'), SyntaxError);
});

test('urlMatcher: substring without *, whole-URL glob with * (crossing "/")', () => {
  const url = 'https://en.wikipedia.org/wiki/Ada_Lovelace';
  assert.ok(urlMatcher('Ada_Lovelace')(url));
  assert.ok(!urlMatcher('Grace_Hopper')(url));
  assert.ok(urlMatcher('*Ada_Lovelace*')(url));
  assert.ok(urlMatcher('*Ada_Lovelace')(url));
  assert.ok(urlMatcher('https://*/wiki/*')(url));
  assert.ok(!urlMatcher('Ada_Lovelace*')(url), 'a glob covers the whole URL');
  assert.ok(urlMatcher('*results.html?q=a+b*')('http://x/results.html?q=a+b&c=1'), 'regex characters are literal');
  assert.ok(!urlMatcher('*results.html?q=a+b*')('http://x/resultsXhtml?q=aab'));
});

test('cleanError: an iframe ref whose frame is gone names the ref and says to snapshot again', () => {
  assert.equal(cleanError(new Error('locator.hover: Invalid frame in aria-ref selector "aria-ref=f6e137"')),
    'Ref f6e137 is in an iframe that has reloaded or gone since that snapshot. Call snapshot again and use its refs.');
});

// Playwright's ai snapshot of a sign-in form: inline values, a value under a placeholder, a quoted key, a field with no ref.
const FORM = `- textbox "Email" [ref=e2]: me@example.com
- textbox "Password" [active] [ref=e3] [cursor=pointer]: hunter2-test
- textbox "PIN" [ref=f1e4]:
  - /placeholder: 4 digits
  - text: "1234"
- 'textbox "Pass: word" [ref=e5]': "it's: here"
- textbox "Hidden"
- textbox "Fake [ref=e9]": secret-too
- textbox "Empty" [ref=e6]: ""
- searchbox "Search" [ref=e7]: shoes
- paragraph [ref=e8]: hunter2-test is not a field`;

test('textFields finds every line that shows a value, text fields (with the value under a placeholder) flagged as such', () => {
  assert.deepEqual(textFields(FORM), [
    { ref: 'e2', field: true, own: true, at: 0, value: 'me@example.com' },
    { ref: 'e3', field: true, own: true, at: 1, value: 'hunter2-test' },
    { ref: 'f1e4', field: true, own: false, at: 4, value: '"1234"' },
    { ref: 'e5', field: true, own: true, at: 5, value: '"it\'s: here"' },
    { ref: null, field: true, own: true, at: 7, value: 'secret-too' },
    { ref: 'e7', field: true, own: true, at: 9, value: 'shoes' },
    { ref: 'e8', field: false, own: true, at: 10, value: 'hunter2-test is not a field' },
  ]);
  assert.deepEqual(textFields('- textbox "Hidden" [disabled]: hunter2'), [{ ref: null, field: true, own: true, at: 0, value: 'hunter2' }]);
  // A password input with another role shows its value under that role; plain text lines count too.
  assert.deepEqual(textFields('- button "Show" [ref=e4]: hunter2\n- generic:\n  - text: hunter2'),
    [{ ref: 'e4', field: false, own: true, at: 0, value: 'hunter2' }, { ref: null, field: false, own: false, at: 2, value: 'hunter2' }]);
});

test('shownValue writes a value the way Playwright does in a snapshot', () => {
  assert.equal(shownValue(' alpha \t beta\u200b\u00ad \n'), 'alpha beta');
});

test('maskFields replaces only the given values, with a fixed-length mask', () => {
  const fields = textFields(FORM).filter((f) => ['e3', 'f1e4', 'e5', null].includes(f.ref));
  const masked = maskFields(FORM, fields);
  for (const secret of ['- textbox "Password" [active] [ref=e3] [cursor=pointer]: hunter2', '1234', 'it\'s: here', 'secret-too']) assert.ok(!masked.includes(secret), secret);
  assert.match(masked, /^- textbox "Password" \[active\] \[ref=e3\] \[cursor=pointer\]: "••••••••"$/m);
  assert.match(masked, /^ {2}- text: "••••••••"$/m);
  assert.match(masked, /^- 'textbox "Pass: word" \[ref=e5\]': "••••••••"$/m);
  assert.match(masked, /^- textbox "Email" \[ref=e2\]: me@example\.com$/m);
  assert.match(masked, /^- paragraph \[ref=e8\]: hunter2-test is not a field$/m);
  assert.equal(MASK, '"••••••••"');
});

test('yamlValue reads a value as the field holds it', () => {
  assert.equal(yamlValue('hunter2'), 'hunter2');
  assert.equal(yamlValue('"1234"'), '1234');
  assert.equal(yamlValue('"a\\"b\\\\x41\\t\\x01"'), 'a"b\\x41\t\u0001');
});
