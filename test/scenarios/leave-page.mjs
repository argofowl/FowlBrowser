// A page that asks "leave page?" (a chat or mail draft) closes at once when the agent closes it. On 2026-10-26 such a
// close hung: the question went to the debugger, nobody answered, the page froze in front of argo, and the tab stayed
// held by a session that had long ended.
export default {
  name: 'leave-page',
  async run(t) {
    const tab = await t.open(`${t.site}/leave-page.html`);
    await t.call('type', { tab, ref: await t.refOf(tab, 'textbox', 'Draft'), text: `draft ${t.tag}`, snapshot: false });
    t.eq(await t.resultOf(tab), 'draft', 'the page asks before it is left');

    t.step('tab_close closes it within a few seconds');
    const started = Date.now();
    await t.close(tab);
    const ms = Date.now() - started;
    t.ok(ms < 5000, `tab_close took ${ms} ms`);
    t.ok(!(await t.listAll()).some((listed) => listed.tab === tab), 'the tab is gone');
  },
};
