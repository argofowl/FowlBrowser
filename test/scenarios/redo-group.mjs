// A redo: tab_open for_user with a named group puts even a lone tab in that group; in a later turn, the same URLs with the
// same group reload the earlier tabs in place (same ids, never activated) and a new URL joins the same group, so the user
// sees one group with the latest set. Runs on a server of its own, so it can end that server's turn without touching
// other jobs' tabs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connect, parseJSON, rawHost } from '../lib.mjs';

export default {
  name: 'redo-group',
  async run(t) {
    const own = await connect(`e2e-redo-${t.tag}`, { ownTurns: true });
    const host = await rawHost(t.browser, `raw-${t.tag}`);
    const group = `Prototypes ${t.tag}`;
    const urls = ['a', 'b', 'c'].map((v) => `${t.site}/index.html?redo=${v}-${t.tag}`);
    const open = async (url) => {
      const res = await own.call('tab_open', { browser: t.browser, url, for_user: true, group, snapshot: false });
      const tab = res.text.match(new RegExp(`\\b${t.browser}:\\d+\\b`))[0];
      t.userTabs.add(tab); // the user's after the turn; cleanup closes it with the flag
      return { tab, text: res.text };
    };
    // When the page's document started: a reload makes a new one. Read as t.eval does.
    const loadedAt = async (tab) => {
      const res = await own.call('evaluate', { tab, function: '() => JSON.stringify(performance.timeOrigin)' });
      const value = res.structured?.result ?? parseJSON(res.text);
      return Number(typeof value === 'string' ? JSON.parse(value) : value);
    };
    const inGroup = async () => (await host.request('tabs.listAll', {})).filter((x) => x.groupTitle === group);
    try {
      t.step('a named lone tab is grouped at once');
      const a = await open(urls[0]);
      t.eq((await inGroup()).map((x) => `${t.browser}:${x.id}`), [a.tab], 'the lone tab is in the named group');
      const b = await open(urls[1]);
      t.eq((await inGroup()).map((x) => `${t.browser}:${x.id}`).sort(), [a.tab, b.tab].sort(), 'the second joins it');
      const before = [await loadedAt(a.tab), await loadedAt(b.tab)];

      t.step('turn end');
      const turn = await own.endTurn();
      t.ok([a.tab, b.tab].every((tab) => turn.released.includes(tab)), `both released, not closed: ${JSON.stringify(turn)}`);

      t.step('redo: the same URLs reload in place, a new one joins');
      const a2 = await open(urls[0]);
      t.eq(a2.tab, a.tab, 'the first keeps its id');
      t.ok(a2.text.includes(`Reloaded your earlier tab ${a.tab} in group "${group}" (same URL) instead of opening another.`), `reuse line: ${a2.text.slice(0, 400)}`);
      t.ok(a2.text.includes(`Also in group "${group}": ${b.tab} · `), `lists the other earlier tab: ${a2.text.slice(0, 600)}`);
      const b2 = await open(urls[1]);
      t.eq(b2.tab, b.tab, 'the second keeps its id');
      const c = await open(urls[2]);
      t.ok(![a.tab, b.tab].includes(c.tab), 'a new URL opens a new tab');
      const after = [await loadedAt(a.tab), await loadedAt(b.tab)];
      t.ok(after[0] > before[0] && after[1] > before[1], `both reloaded: ${JSON.stringify({ before, after })}`);

      const grouped = await inGroup();
      t.eq(grouped.map((x) => `${t.browser}:${x.id}`).sort(), [a.tab, b.tab, c.tab].sort(), 'one group with the three');
      t.eq(new Set(grouped.map((x) => x.windowId)).size, 1, 'in one window');
      const indexes = grouped.map((x) => x.index).sort((x, y) => x - y);
      t.eq(indexes[2] - indexes[0], 2, 'side by side, one group');
      t.ok(grouped.every((x) => !x.active), 'none brought to the front');

      t.step('local prototype files: a redo reloads them in place and they read; a claimed one reads after navigating');
      // Needs "Allow access to file URLs" on for FowlBrowser in this browser.
      const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), 'fb-e2e-redo-')));
      try {
        fs.writeFileSync(path.join(dir, 'proto.html'), '<title>Proto</title><h1 id="v"></h1><script>v.textContent = "Variant " + new URLSearchParams(location.search).get("variant")</script>');
        const local = ['A', 'B'].map((v) => `${pathToFileURL(path.join(dir, 'proto.html')).href}?variant=${v}`);
        const fileGroup = `${group} files`;
        const openFile = async (url) => {
          const res = await own.call('tab_open', { browser: t.browser, url, for_user: true, group: fileGroup });
          const tab = res.text.match(new RegExp(`\\b${t.browser}:\\d+\\b`))[0];
          t.userTabs.add(tab);
          return { tab, text: res.text };
        };
        const fa = await openFile(local[0]);
        t.ok(/heading "Variant A"/.test(fa.text), `the local page's snapshot: ${fa.text.slice(0, 600)}`);
        const fb = await openFile(local[1]);
        await own.endTurn();
        fs.writeFileSync(path.join(dir, 'proto.html'), '<title>Proto v2</title><h1 id="v"></h1><script>v.textContent = "V2 " + new URLSearchParams(location.search).get("variant")</script>');
        const fa2 = await openFile(local[0]);
        t.eq(fa2.tab, fa.tab, 'the local tab keeps its id');
        t.ok(/heading "V2 A"/.test(fa2.text), `reloaded with the new file and readable: ${fa2.text.slice(0, 600)}`);
        await own.endTurn();
        const claimed = await own.call('tab_claim', { tab: fb.tab }).then((r) => r.text, (e) => e.message);
        const unwatched = await own.call('snapshot', { tab: fb.tab }).then((r) => r.text, (e) => e.message);
        t.ok(/loaded before FowlBrowser watched it/.test(unwatched), `a claimed local page isn't read until navigated: ${claimed.slice(0, 200)} | ${unwatched.slice(0, 400)}`);
        const again = await own.call('navigate', { tab: fb.tab, url: local[1] });
        t.ok(/heading "V2 B"/.test(again.text), `after navigating it reads: ${again.text.slice(0, 600)}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      host.close();
      await own.close();
    }
  },
};
