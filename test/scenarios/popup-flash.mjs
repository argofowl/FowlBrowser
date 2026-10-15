// Popups from an agent tab never take the user's eyes (SPEC "Popups (session 5)"). A witness tab, the active tab of
// the agent tab's window, logs every time it is hidden or loses focus. Opens that need no opener (tier 1) must leave
// it untouched, and so must opener-dependent window.open calls from a button (tier 3); opener-dependent links and
// forms (tier 2) open as a tab, never a window, and the flash they leave is measured in frames and printed. Every
// popup is the session's: named in the click result, muted, grouped, in the background. The OAuth pair checks the
// opener still gets its code and sees the popup close.
// Exclusive: it makes the witness the active tab of its window and gives the window its previous active tab back.
import { tabIdsIn } from '../lib.mjs';

const TIER1 = [
  ['link', 'Open link in new tab', 'blank'],
  ['link', 'Open noopener link', 'rel-noopener'],
  ['button', 'Open noopener window', 'noopener'],
];
// Opener-dependent opens from a button: the agent's click carries the new-tab modifier the page never sees, so they
// open in the background with their opener (tier 3) and the witness must see nothing. Links and forms keep tier 2.
const TIER3 = new Set(['window-open', 'features', 'oauth']);
const TIER2 = [
  ['button', 'Open window', 'window-open'],
  ['button', 'Open popup window', 'features'],
  ['link', 'Open opener link', 'rel-opener'],
  ['link', 'Open named link', 'named'], // a named target keeps its opener (HTML: only _blank implies noopener)
  ['button', 'Submit form to new tab', 'form'],
];
const SETTLE_MS = 700; // a late flash (the switch back, a re-collapsed group) lands well within this

export default {
  name: 'popup-flash',
  exclusive: true,
  async run(t) {
    const host = await t.host();
    const numeric = (tab) => Number(tab.split(':')[1]);
    const info = async (tab) => (await host.request('tabs.listAll', {})).find(x => x.id === numeric(tab));
    const windows = async () => new Set((await host.request('tabs.listAll', {})).map(x => x.windowId));

    t.step('witness: the active tab of its window');
    const windowsBefore = await windows();
    const witness = await t.userTab(`${t.site}/watch.html?tag=${t.tag}`);
    const windowId = (await info(witness)).windowId;
    const previous = (await host.request('tabs.listAll', {})).find(x => x.windowId === windowId && x.active)?.id;
    await host.request('tabs.focus', { tabId: numeric(witness) });
    try {
      const agent = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
      t.eq((await info(agent)).windowId, windowId, 'the agent tab opened in the witness window');
      const log = async () => t.eval(agent, `() => JSON.parse(localStorage['fbwatch:${t.tag}'] || 'null')`);
      await t.until(async () => (await log())?.interval, 'the witness is drawing frames');
      const start = (await log()).events.at(-1);
      t.ok(start[1] === 'visible' && start[2] === true, `the witness is shown and focused before the clicks: ${JSON.stringify(start)}`);
      const since = async (mark) => (await log()).events.filter(([type, , , at]) => at >= mark && type !== 'focus' && type !== 'start');
      const flashes = [];

      // One click: the result names the new tab, which is ours, muted, grouped, in the background, in a tab of the
      // same window (never a new window). Returns the popup and the witness events the click caused.
      const clickOpens = async (tab, role, name, via, url = `via=${via}&tag=${t.tag}`) => {
        const mark = Date.now();
        const res = await t.call('click', { tab, ref: await t.refOf(tab, role, name), snapshot: false });
        const reported = tabIdsIn(res.text.split('New tab opened by this action')[1] ?? '', t.browser)[0];
        if (reported) t.track(reported);
        const entry = await t.until(async () => (await t.listMine()).find(x => x.url.includes(url)), `${via}: popup listed as mine`);
        t.track(entry.tab);
        t.eq(reported, entry.tab, `${via}: click result names the new tab (${res.text.slice(0, 200)})`);
        t.eq([entry.active, entry.muted, entry.group], [false, true, t.server.label], `${via}: background, muted, grouped`);
        const raw = await info(entry.tab);
        t.eq([raw.windowId, raw.windowType], [windowId, 'normal'], `${via}: a tab in the agent's window, not a popup window`);
        t.eq(await windows(), windowsBefore, `${via}: no new window`);
        await new Promise(r => setTimeout(r, SETTLE_MS));
        t.eq((await info(witness)).active, true, `${via}: the witness is the active tab again`);
        return { popup: entry.tab, events: await since(mark), mark };
      };
      const measure = async (via, events, mark) => {
        const { interval, gaps } = await log();
        const hidden = events.find(([type, state]) => type === 'visibilitychange' && state === 'hidden');
        const shown = events.find(([type, state, , at]) => type === 'visibilitychange' && state === 'visible' && at >= (hidden?.[3] ?? Infinity));
        const ms = hidden && shown ? shown[3] - hidden[3] : 0;
        // Frames the witness did not draw: its longest rAF gap since the click, in frame intervals, less the one it always has.
        const gap = Math.max(0, ...gaps.filter(([, at]) => at >= mark).map(([g]) => g));
        const flash = { via, hiddenMs: ms, frameGapMs: gap, frames: gap ? Math.round(gap / interval) - 1 : 0, intervalMs: Math.round(interval * 10) / 10, events: events.map(([type, state]) => `${type}:${state}`) };
        flashes.push(flash);
        return flash;
      };

      for (const [role, name, via] of TIER1) {
        t.step(`tier 1 ${via}`);
        const { popup, events, mark } = await clickOpens(agent, role, name, via);
        t.eq(events, [], `${via}: the witness saw nothing`);
        t.eq(await t.eval(popup, `() => document.getElementById('opener').textContent`), 'no opener', `${via}: opened without an opener`);
        await measure(via, events, mark);
        await t.close(popup);
      }
      for (const [role, name, via] of TIER2) {
        t.step(`tier 2 ${via}`);
        const { popup, events, mark } = await clickOpens(agent, role, name, via);
        if (via !== 'form') t.eq(await t.eval(popup, `() => document.getElementById('opener').textContent`), 'has opener', `${via}: the opener is kept`);
        if (TIER3.has(via)) t.eq(events, [], `${via}: the witness saw nothing`);
        await measure(via, events, mark);
        await t.close(popup);
      }

      t.step('tier 2 oauth: the code comes back and the popup closes itself');
      const opener = await t.open(`${t.site}/oauth.html?tag=${t.tag}`);
      const signin = await clickOpens(opener, 'button', 'Sign in with IdP', 'oauth', `oauth-popup.html?tag=${t.tag}`);
      const { popup } = signin;
      t.eq(signin.events, [], 'oauth: the witness saw nothing');
      await measure('oauth', signin.events, signin.mark);
      t.eq(await t.resultOf(popup), 'opener', 'the popup has its opener');
      const mark = Date.now();
      await t.call('click', { tab: popup, ref: await t.refOf(popup, 'button', 'Continue'), snapshot: false }).catch(() => {}); // it closes under the click
      t.closed.add(popup);
      const done = await t.until(async () => { const r = await t.resultOf(opener); return r?.closed && r; }, 'the opener sees the popup closed');
      t.eq(done, { opened: true, code: 'code-1234', closed: true }, 'the opener got the code');
      t.eq(await since(mark), [], 'the popup closing itself left the witness alone');
      await new Promise(r => setTimeout(r, 500));
      const gone = await t.call('snapshot', { tab: popup }).then(() => 'still there', (e) => e.message);
      t.ok(!/took over|still there/.test(gone), `a popup that closed itself is no takeover (its close report counted): ${gone}`);

      t.step('tab_keep: window.open is native again in the live document');
      await t.eval(agent, `() => { window.__fbWrapped = window.open; return Object.getOwnPropertySymbols(window).some(s => s.description?.startsWith('fowlbrowser.popups')); }`)
        .then(installed => t.ok(installed, 'the agent tab has the popup script'));
      await t.call('tab_keep', { tab: agent });
      t.eq(await t.eval(agent, '() => window.open !== window.__fbWrapped'), true, 'window.open restored without a reload');

      for (const f of flashes) console.log(`[popup-flash] ${t.browser} ${f.via}: hidden ${f.hiddenMs} ms, longest frame gap ${f.frameGapMs} ms, ${f.frames} frame(s) not drawn at ${f.intervalMs} ms/frame ${f.events.length ? `(${f.events.join(' ')})` : ''}`);
    } finally {
      if (previous !== undefined && previous !== numeric(witness)) await host.request('tabs.focus', { tabId: previous }).catch(() => {});
    }
  },
};
