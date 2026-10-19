// window.open and target=_blank: the action reports the new tab (even one whose page loads slowly), it is ours,
// in the background, and closable. One the extension opens (target=_blank) has no referrer (the page's referrer policy
// isn't known to the server), and a page that opens one and closes itself at once still gets it.
import { tabIdsIn } from '../lib.mjs';

export default {
  name: 'popups',
  async run(t) {
    const tab = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
    const s = await t.snapshot(tab);

    // slow: the popup's page commits 3 s after the click, long after the click has returned.
    for (const [name, role, via] of [['Open window', 'button', 'window-open'], ['Open link in new tab', 'link', 'blank'], ['Open slow window', 'button', 'slow']]) {
      t.step(`${via}: click`);
      const res = await t.call('click', { tab, ref: t.ref(s, role, name), snapshot: false });
      const reported = tabIdsIn(res.text, t.browser).find(id => id !== tab);
      if (reported) t.track(reported);
      if (via === 'slow') t.ok(/New tab opened by this action \(loading\)/.test(res.text), `slow popup reported while loading: ${res.text.slice(0, 300)}`);

      t.step(`${via}: find popup in tab_list mine`);
      const entry = await t.until(async () => (await t.listMine()).find(x => x.url.includes(`via=${via}&tag=${t.tag}`)),
        `popup via=${via} listed as mine`);
      t.track(entry.tab);
      t.eq(reported, entry.tab, 'click result names the new tab');
      t.eq(entry.active, false, 'popup stays in the background');
      t.eq(entry.muted, true, 'popup muted like its opener');
      t.eq(await t.resultOf(entry.tab), `popup:${via}`, 'popup page drivable');
      if (via === 'blank') t.eq(await t.eval(entry.tab, '() => document.referrer'), '', 'no referrer');

      t.step(`${via}: close popup`);
      await t.close(entry.tab);
    }

    // Only a tab a script opened may close itself: the opener is a window.open popup of the first tab.
    t.step('self-close: the opener closes itself right after window.open');
    const res = await t.call('click', { tab, ref: t.ref(s, 'button', 'Open window'), snapshot: false });
    const closer = tabIdsIn(res.text, t.browser).find(id => id !== tab);
    t.track(closer); // closed by cleanup unless it closes itself (below)
    await t.call('navigate', { tab: closer, url: `${t.site}/popups.html?tag=${t.tag}` });
    await t.call('click', { tab: closer, ref: await t.refOf(closer, 'button', 'Open and close this tab'), snapshot: false }).catch(() => {});
    const entry = await t.until(async () => (await t.listMine()).find(x => x.url.includes(`via=self-close&tag=${t.tag}`)), 'popup via=self-close listed as mine');
    t.track(entry.tab);
    t.eq(entry.active, false, 'popup stays in the background');
    t.eq(await t.resultOf(entry.tab), 'popup:self-close', 'popup page drivable');
    t.ok(!(await t.listMine()).some((x) => x.tab === closer), 'the opener closed itself');
    t.closed.add(closer);
    await t.close(entry.tab);
  },
};
