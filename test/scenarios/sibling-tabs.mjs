// Parallel actions in one server (sibling subagents): only the action whose page opened a popup reports it.
// While tab A's click opens a popup and a sibling opens its own tab, B's wait_for must report no new tab,
// and A's click must name only its popup.
import { tabIdsIn } from '../lib.mjs';

export default {
  name: 'sibling-tabs',
  async run(t) {
    const a = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
    const b = await t.open(`${t.site}/index.html?sibling=${t.tag}`);
    const button = t.ref(await t.snapshot(a), 'button', 'Open window');

    t.step('click popup on A, wait on B, tab_open C, all at once');
    const [clicked, waited, c] = await Promise.all([
      t.call('click', { tab: a, ref: button, snapshot: false }),
      t.call('wait_for', { tab: b, seconds: 2, snapshot: false }),
      t.open(`${t.site}/index.html?third=${t.tag}`),
    ]);
    const popup = await t.until(async () => (await t.listMine()).find(x => x.url.includes(`via=window-open&tag=${t.tag}`)), 'popup listed as mine');
    t.track(popup.tab);

    t.step('reports');
    t.eq(tabIdsIn(waited.text, t.browser).filter(id => id !== b), [], `B's wait_for reports no new tab: ${waited.text.slice(0, 300)}`);
    t.ok(!/New tab opened/.test(waited.text), 'no "New tab opened" line in B');
    t.eq(tabIdsIn(clicked.text, t.browser).filter(id => id !== a), [popup.tab], `A's click names only its popup (C is ${c})`);
  },
};
