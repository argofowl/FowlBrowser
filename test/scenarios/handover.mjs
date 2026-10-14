// Tabs for the user: tab_open for_user is out of the work group from the start and stays after the session ends; tab_keep
// hands a work tab over right away (out of the work group) while the session still drives it. Both stay muted while
// driven (nothing plays aloud before the user looks) and are unmuted when control ends. A lone one is ungrouped; two or
// more given in one turn share a group of their own.
import { connect } from '../lib.mjs';

export default {
  name: 'handover',
  async run(t) {
    t.step('for_user');
    const forUser = await t.open(`${t.site}/index.html?foruser=${t.tag}`, { for_user: true });
    let mine = (await t.listMine()).find((x) => x.tab === forUser);
    t.eq([mine.muted, mine.group, mine.active], [true, null, false], 'for_user tab: muted while driven, ungrouped, background');

    t.step('several for_user tabs share a group');
    const title = `Given ${t.tag}`;
    const first = await t.open(`${t.site}/index.html?given=1-${t.tag}`, { for_user: true, group: title, snapshot: false });
    t.eq((await t.listMine()).find((x) => x.tab === first).group, null, 'a lone one is ungrouped');
    const second = await t.open(`${t.site}/index.html?given=2-${t.tag}`, { for_user: true, group: title, snapshot: false });
    mine = await t.listMine();
    t.eq([first, second].map((tab) => mine.find((x) => x.tab === tab).group), [title, title], 'both in one group, titled as asked');
    t.eq(mine.find((x) => x.tab === forUser).group, null, 'one with another title is not part of it');

    t.step('tab_keep hands over now');
    const workTitle = `Work ${t.tag}`;
    const work = await t.open(`${t.site}/index.html?keep=${t.tag}`, { group: workTitle });
    mine = (await t.listMine()).find((x) => x.tab === work);
    t.ok(mine.muted && mine.group === workTitle, `work tab starts muted and grouped: ${JSON.stringify(mine)}`);
    await t.call('tab_keep', { tab: work });
    mine = (await t.listMine()).find((x) => x.tab === work);
    t.eq([mine.muted, mine.group], [true, null], 'a lone kept tab is ungrouped right away, muted while driven');
    await t.call('snapshot', { tab: work }); // still controlled
    const work2 = await t.open(`${t.site}/index.html?keep=2-${t.tag}`, { group: workTitle, snapshot: false });
    await t.call('tab_keep', { tab: work2 });
    mine = await t.listMine();
    t.eq([work, work2].map((tab) => mine.find((x) => x.tab === tab).group), [workTitle, workTitle],
      'two kept tabs share a group of their own (the first had left the work group)');

    t.step('for_user tab outlives its session');
    const other = await connect(`e2e-handover-${t.tag}`);
    let left;
    try {
      const res = await other.call('tab_open', { browser: t.browser, url: `${t.site}/index.html?outlive=${t.tag}`, for_user: true, snapshot: false });
      left = res.text.match(new RegExp(`\\b${t.browser}:\\d+\\b`))[0];
    } finally {
      await other.close();
    }
    t.userTabs.add(left); // closed by cleanup
    const after = await t.until(async () => (await t.listAll()).find((x) => x.tab === left && x.owner === null), 'tab stays, owned by nobody');
    t.eq([after.muted, after.group], [false, null], 'unmuted once control ended, still ungrouped');
  },
};
