// What agents read stays small: capped snapshots, changes-only results after actions, text mode, and the clearer
// errors (stale ref, refs from a previous page, evaluate that navigates, wait_for url glob, local files).
export default {
  name: 'snapshot-size',
  async run(t) {
    const callError = (name, args) => t.call(name, args).then((r) => { throw new Error(`${name} should have failed: ${r.text.slice(0, 300)}`); }, (e) => e.message);
    const tab = await t.open(`${t.site}/big.html`, { snapshot: false });

    t.step('snapshot is capped');
    const s = await t.snapshot(tab);
    t.ok(s.length < 12_400, `snapshot of a 1500-row page is capped: ${s.length} chars`);
    t.ok(/\.\.\. \[\d+ more lines not shown\. To read them, call snapshot with ref=<eN> of a section, or with a larger max_chars\]/.test(s),
      `cut snapshot names what was left out: ${s.slice(-300)}`);
    const larger = await t.call('snapshot', { tab, max_chars: 40_000 });
    t.ok(larger.text.length > 30_000 && larger.text.length < 40_400, `max_chars 40000 gives a larger snapshot: ${larger.text.length}`);

    t.step('action returns changes only');
    const add = t.ref(s, 'button', 'Add item');
    const baseline = Number(/Snapshot (\d+) of this tab:/.exec(await t.snapshot(tab))?.[1]);
    const first = await t.call('click', { tab, ref: add });
    t.ok(first.text.includes(`Changes since snapshot ${baseline} of this tab; this is snapshot ${baseline + 1}`), `changes-only result names its snapshots: ${first.text.slice(0, 600)}`);
    t.ok(/^\+ .*listitem.*Added item 1/m.test(first.text), 'new list item marked +');
    t.ok(/^\+ .*status.*1 added/m.test(first.text), 'changed status marked +');
    t.ok(/^- - status.*0 added/m.test(first.text), 'old status listed as removed');
    t.ok(first.text.length < 2000, `changes-only result is small: ${first.text.length} chars`);
    const second = await t.call('click', { tab, ref: add });
    t.ok(/Added item 2/.test(second.text) && !/^\+ .*Added item 1/m.test(second.text), `second click diffs against the first result: ${second.text.slice(0, 600)}`);
    const none = await t.call('evaluate', { tab, function: '() => 1', snapshot: true });
    t.ok(none.text.includes(`No changes since snapshot ${baseline + 2} of this tab; this is snapshot ${baseline + 3}.`), `no-op reports no changes: ${none.text.slice(0, 400)}`);

    t.step('text mode');
    const read = await t.call('snapshot', { tab, mode: 'text' });
    t.ok(read.text.includes('Text of <main>') && read.text.includes('no refs'), `text header names the source: ${read.text.slice(0, 300)}`);
    t.ok(read.text.includes('Long article\nThe quick brown fox.\nRow number 0 with some filler text'), 'whitespace collapsed per line');
    t.ok(!/\[ref=/.test(read.text) && read.text.length < 12_400 && /more lines not shown/.test(read.text), `text is capped and has no refs: ${read.text.length}`);

    t.step('evaluate expression');
    const title = await t.call('evaluate', { tab, expression: 'document.title' });
    t.ok(title.text.includes('"Big page"'), `expression is wrapped: ${title.text}`);

    t.step('wait_for url glob');
    await t.call('wait_for', { tab, url: '*big.html*', timeout_ms: 3000 });
    const missed = await callError('wait_for', { tab, url: '*nowhere*', timeout_ms: 1000 });
    t.ok(missed.includes(`Current URL: ${t.site}/big.html`), `timeout names the current URL: ${missed}`);

    t.step('evaluate that navigates');
    const nav = await callError('evaluate', { tab, function: `() => { location.href = '${t.site}/index.html'; return new Promise(() => {}); }` });
    t.ok(nav.includes('The page navigated while evaluate ran') && nav.includes('/index.html'), `navigation is named: ${nav}`);

    t.step('new document: full snapshot, stale ref');
    const back = await t.call('navigate', { tab, url: `${t.site}/big.html` });
    t.ok(/Snapshot \d+ of this tab:/.test(back.text) && !back.text.includes('Changes since'), 'a new document gets the full snapshot');
    // A ref this page never showed (refs of earlier pages are refused before Playwright sees them, see below).
    const stale = await callError('click', { tab, ref: 'e99999', timeout_ms: 2000, snapshot: false });
    t.ok(stale.includes('Ref e99999 is from an older snapshot'), `stale ref error (action): ${stale}`);
    const staleSection = await callError('snapshot', { tab, ref: 'e99999' });
    t.ok(staleSection.includes('Ref e99999 is from an older snapshot'), `stale ref error (snapshot section): ${staleSection}`);

    t.step('a ref from an earlier page is refused, even after a snapshot of the new page');
    const pageA = await t.snapshot(tab);
    const addA = t.ref(pageA, 'button', 'Add item');
    await t.call('navigate', { tab, url: `${t.site}/big.html?again`, snapshot: false });
    const early = await callError('click', { tab, ref: addA, snapshot: false });
    t.ok(early.includes(`Ref ${addA} is from an earlier page of this tab`), `old-page ref refused before a new snapshot: ${early}`);
    const pageB = await t.snapshot(tab);
    const addB = t.ref(pageB, 'button', 'Add item');
    t.ok(addB !== addA, `the same button on page B has a new ref: ${addA} -> ${addB}`);
    const crossed = await callError('click', { tab, ref: addA, snapshot: false });
    t.ok(crossed.includes(`Ref ${addA} is from an earlier page of this tab: it has loaded a new page since (${t.site}/big.html?again)`),
      `old-page ref refused after page B's snapshot: ${crossed}`);
    t.eq(await t.eval(tab, '() => document.querySelectorAll("#added li").length'), 0, 'nothing was clicked on page B');

    t.step("page B's refs work");
    const clicked = await t.call('click', { tab, ref: addB });
    t.ok(/^\+ .*listitem.*Added item 1/m.test(clicked.text), `page B ref clicked: ${clicked.text.slice(0, 400)}`);
    t.eq(await t.eval(tab, '() => document.querySelectorAll("#added li").length'), 1, 'one item added on page B');
    const unknown = await callError('click', { tab, ref: 'e99999', timeout_ms: 2000, snapshot: false });
    t.ok(unknown.includes('Ref e99999 is from an older snapshot'), `errors name the ref the agent passed: ${unknown}`);

    t.step('local files in system folders');
    const local = await callError('navigate', { tab, url: 'file:///etc/hosts' });
    t.ok(/is a local file that can't be opened: it is inside \/private\/etc/.test(local), `file:// in /etc refused: ${local}`);
  },
};
