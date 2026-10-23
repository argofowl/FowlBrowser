// The thread pages that read-all reads (test/site/threads): with ?all=1 each renders exactly data.js's truth, and in a
// real background tab their mechanics hold: the DM log is virtualized, shifts data-index on load, loads older messages
// on a wheel with its spinner showing, throws a script scroll back to the bottom and, with recycle=1, reuses its rows;
// mail's expanders and danger controls work; the feed loads on the wheel to its end; the reverse chat loads upward;
// comments grow through their buttons.
import { rowLines, truth } from '../site/threads/data.js';

const SEED = 11;

// The first row that differs from the truth, or null.
export function firstDiff(got, want) {
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) return `row ${i} of ${got.length} (truth ${want.length}): expected ${JSON.stringify(want[i])}, got ${JSON.stringify(got[i])}`;
  }
  return null;
}

export default {
  name: 'thread-pages',
  async run(t) {
    const site = `${t.site}/threads`;
    const state = tab => t.eval(tab, '() => window.__state()');
    // In slices of their JSON: a mail thread that quotes itself is longer than one evaluate result.
    const rows = async (tab) => {
      let json = '';
      for (let at = 0, part; at === 0 || part.length; at += 5000) json += part = await t.eval(tab, `() => JSON.stringify(window.__rows()).slice(${at}, ${at + 5000})`);
      return JSON.parse(json).map(rowLines);
    };
    const wheel = (tab, direction, pages = 1) => t.call('scroll', { tab, direction, pages, snapshot: false });
    let tab;
    // A ref by its text on a page whose snapshot is longer than the default cap.
    const find = async (role, name) => t.ref((await t.call('snapshot', { tab, find: name })).text, role, name);
    const go = async (url) => {
      if (tab) await t.call('navigate', { tab, url: `${site}/${url}`, snapshot: false });
      else tab = await t.open(`${site}/${url}`);
      await t.until(() => t.eval(tab, '() => !!window.__rows?.().length'), `${url} rendered rows`);
    };

    for (const page of ['dm', 'chat-reverse', 'mail', 'feed', 'comments']) {
      t.step(`${page} ?all=1 renders the truth`);
      const search = `?seed=${SEED}&all=1`;
      await go(`${page}.html${search}`);
      const diff = firstDiff(await rows(tab), truth(page, search).map(x => x.lines));
      t.ok(!diff, `${page}: ${diff}`);
    }

    t.step('dm: a virtualized log at the bottom');
    await go(`dm.html?seed=${SEED}&delay=1500-1800`);
    let s = await state(tab);
    t.ok(s.mounted.length > 3 && s.mounted.length <= 20, `mounted rows: ${s.mounted.length}`);
    t.ok(s.loaded === 20 && s.scrollTop >= s.max - 1, `opens on the last 20 at the bottom: ${JSON.stringify({ ...s, mounted: s.mounted.length })}`);

    // What scroll with ref did before it turned the wheel (an instant el.scrollBy), done here by evaluate.
    t.step('dm: a script scroll goes back to the bottom');
    await t.call('evaluate', { tab, function: '() => { document.getElementById("pane").shadowRoot.querySelector("[role=log]").scrollBy({ top: -2000, behavior: "instant" }); }' });
    s = await t.until(async () => { const v = await state(tab); return v.snapbacks === 1 && v.scrollTop >= v.max - 1 && v; }, 'scrolled back to the bottom', 3000);
    t.ok(s.loaded === 20 && !s.loading, 'no load from a thrown-back scroll');

    t.step('dm: the wheel loads older messages with the spinner showing');
    let during;
    for (let i = 0; i < 6 && !during; i++) {
      await wheel(tab, 'up');
      const v = await state(tab);
      if (v.loading) during = v;
    }
    t.ok(during?.spinner, `spinner in the status slot while loading: ${JSON.stringify(during)}`);
    const mid = during.mounted.sort((a, b) => a.index - b.index)[Math.floor(during.mounted.length / 2)];
    s = await t.until(async () => { const v = await state(tab); return !v.loading && v.loaded > 20 && v; }, 'older batch loaded', 10000);
    t.ok(s.snapbacks === 1, `wheel scrolls are not thrown back: ${s.snapbacks} snapbacks`);
    const now = s.mounted.find(x => x.key === mid.key);
    t.ok(now?.index === mid.index + (s.loaded - 20), `data-index shifts by the batch: ${mid.key} was ${mid.index}, now ${now?.index} (loaded ${s.loaded})`);

    t.step('dm recycle=1: the same row elements take other messages');
    await go(`dm.html?seed=${SEED}&recycle=1&delay=200-300`);
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      (await state(tab)).mounted.forEach(x => seen.add(x.key));
      await wheel(tab, 'up');
    }
    s = await state(tab);
    t.ok(seen.size > s.created + 5, `${seen.size} messages shown in ${s.created} row elements`);

    t.step('reverse chat: the wheel loads older messages at the top');
    await go(`chat-reverse.html?seed=${SEED}&delay=200-300`);
    const c0 = await state(tab);
    s = await t.until(async () => { await wheel(tab, 'up', 2); const v = await state(tab); return v.loaded > c0.loaded && v.scrollTop < 0 && v; }, 'older messages loaded', 15000);
    const chatDiff = firstDiff(await rows(tab), truth('chat-reverse', `?seed=${SEED}`).slice(s.start).map(x => x.lines));
    t.ok(!chatDiff, `chat rows after a load: ${chatDiff}`);

    t.step('mail: older messages, a click to expand');
    const mailSearch = `?seed=${SEED}&delay=300-500`;
    const msgs = truth('mail', mailSearch);
    await go(`mail.html${mailSearch}`);
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', `${msgs.length - 3} older messages`), snapshot: false });
    s = await t.until(async () => { const v = await state(tab); return !v.older && !v.views.includes('hidden') && v; }, 'older messages revealed');
    t.ok(s.views.filter(v => v === 'collapsed').length === msgs.length - 1, `revealed collapsed: ${s.views}`);
    await t.call('click', { tab, ref: await t.refOf(tab, 'listitem', null, 1), snapshot: false });
    await t.until(async () => (await state(tab)).views[1] === 'open', 'message 2 opened');

    t.step('mail: Expand all, then every trimmed quote');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Expand all'), snapshot: false });
    await t.until(async () => (await state(tab)).views.every(v => v === 'open'), 'every message open');
    const trims = msgs.filter(m => m.quote.length).length;
    for (let i = 0; i < trims; i++) await t.call('click', { tab, ref: await find('button', 'Show trimmed content'), snapshot: false });
    t.eq((await state(tab)).trimmed, trims, 'quotes shown');
    await t.until(async () => (await state(tab)).late === msgs.filter(m => m.late).length, 'late lines shown');
    const mailDiff = firstDiff(await rows(tab), msgs.map(x => x.lines));
    t.ok(!mailDiff, `mail fully expanded: ${mailDiff}`);

    t.step('mail: danger controls record');
    await t.call('click', { tab, ref: await find('button', 'Archive'), snapshot: false });
    t.eq(await t.eval(tab, '() => window.__danger'), ['Archive'], 'Archive recorded');
    await t.call('click', { tab, ref: await find('link', 'Show more') });
    await t.until(async () => (await t.eval(tab, '() => window.__danger'))?.[0] === 'Show more (landed here)', 'Show more landed on the danger page');

    t.step('feed: the wheel loads to the end');
    await go(`feed.html?seed=${SEED}&n=30&batch=10&delay=200-300`);
    s = await t.until(async () => {
      await wheel(tab, 'down', 3);
      const v = await state(tab);
      return v.ended && !v.loading && v.scrollY >= v.max - 1 && v;
    }, 'feed ended', 30000);
    t.ok(s.mounted < s.loaded, `virtualized: ${s.mounted} of ${s.loaded} cells mounted`);
    t.eq((await rows(tab)).at(-1), ["You're all caught up"], 'end marker last');

    t.step('comments: load more, older, replies, danger');
    await go(`comments.html?seed=${SEED}&n=20&batch=5&delay=200-300`);
    const k0 = await state(tab);
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Load more comments'), snapshot: false });
    await t.until(async () => (await state(tab)).end > k0.end, 'more comments loaded');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Show older comments'), snapshot: false });
    await t.until(async () => (await state(tab)).start < k0.start, 'older comments loaded');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', /^View \d+ repl/), snapshot: false });
    await t.until(async () => (await state(tab)).replies > 0, 'replies shown');
    await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Like'), snapshot: false });
    t.eq(await t.eval(tab, '() => window.__danger'), ['Like'], 'Like recorded');
  },
};
