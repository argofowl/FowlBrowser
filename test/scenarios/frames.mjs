// Forms inside a same-origin iframe and an out-of-process cross-origin iframe, targeted through snapshot refs.
export default {
  name: 'frames',
  async run(t) {
    const tab = await t.open(`${t.site}/frames.html`);
    t.step('wait for both frames');
    const s = await t.until(async () => {
      const snap = await t.snapshot(tab);
      return (snap.match(/textbox "Frame text"/g) || []).length === 2 && snap;
    }, 'both frame forms in snapshot');

    t.step('wait_for text only the iframes show');
    await t.call('wait_for', { tab, text: 'Frame agree', timeout_ms: 3000, snapshot: false });

    t.step('text mode takes in the iframes');
    const text = (await t.call('snapshot', { tab, mode: 'text' })).text;
    t.ok((text.match(/^\[iframe: [\w.:]+\]\nFrame text\nFrame agree\nFrame save$/gm) ?? []).length === 2, `both iframes' text: ${text}`);

    t.step('same-origin frame');
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Frame text', 0), text: `same ${t.tag}`, snapshot: false });
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Frame save', 0), snapshot: false });

    t.step('cross-origin frame');
    await t.call('type', { tab, ref: t.ref(s, 'textbox', 'Frame text', 1), text: `cross ${t.tag}`, snapshot: false });
    await t.call('click', { tab, ref: t.ref(s, 'checkbox', 'Frame agree', 1), snapshot: false });
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Frame save', 1), snapshot: false });

    t.step('assert');
    const r = await t.until(async () => { const v = await t.resultOf(tab); return v.same && v.cross && v; }, 'both frames posted results');
    t.eq(r.same.text, `same ${t.tag}`, 'same-origin text');
    t.eq(r.same.agree, false, 'same-origin checkbox');
    t.eq(r.cross.text, `cross ${t.tag}`, 'cross-origin text');
    t.eq(r.cross.agree, true, 'cross-origin checkbox');
    t.ok(r.cross.origin.endsWith(`:${new URL(t.cross).port}`), `cross frame origin ${r.cross.origin}`);

    t.step('iframe loads a new page: its old refs are refused, the new ones work');
    const oldText = t.ref(await t.snapshot(tab), 'textbox', 'Frame text', 0);
    await t.call('evaluate', { tab, function: `() => { document.getElementById('same').src = 'frame-form.html?frame=again'; }` });
    await t.until(() => t.eval(tab, `() => { const f = document.getElementById('same'); return f.contentWindow.location.search === '?frame=again' && f.contentDocument.readyState === 'complete'; }`), 'same-origin frame loaded its new page');
    const s2 = await t.snapshot(tab);
    const newText = t.ref(s2, 'textbox', 'Frame text', 0);
    t.ok(newText !== oldText, `new iframe page should get a new ref, got ${newText} again`);
    const refused = await t.call('type', { tab, ref: oldText, text: 'old ref', snapshot: false }).then(() => null, e => e.message);
    t.ok(/earlier page of an iframe/.test(refused ?? ''), `old iframe ref should be refused: ${refused}`);
    await t.call('type', { tab, ref: newText, text: `again ${t.tag}`, snapshot: false });
    await t.call('click', { tab, ref: t.ref(s2, 'button', 'Frame save', 0), snapshot: false });
    const r2 = await t.until(async () => { const v = await t.resultOf(tab); return v.again && v; }, 'new iframe page posted its result');
    t.eq(r2.again.text, `again ${t.tag}`, 'text typed through the new ref');
  },
};
