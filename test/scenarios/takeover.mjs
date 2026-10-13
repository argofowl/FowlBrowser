// The user in the tab an agent works in, with a real mouse and keyboard (a test Mac only, under its GUI lock: run.mjs
// --gui). Like Codex, the agent keeps going: the user's real click, typing, scrolling and an address typed into the
// address bar no longer take the tab over (nothing is parked, no call fails, no notice), and neither does a burst of
// the agent's own input. Cmd-W still does, and the next call says so in words. A tab the user opens from an agent tab
// with their own click is theirs (in front, not owned, grouped or muted); the agent's own click still opens one of its
// own in the background. Also records what opening DevTools on an agent tab does.
// Real input comes from the test Mac's GUI driver (cua-driver): pixel clicks posted to the browser, keys through the HID
// queue for the browser's own shortcuts. The scenario brings its tabs to the front and gives the window its previous
// active tab back at the end, like cursor.mjs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rawHost, sleep, tabIdsIn, ToolError } from '../lib.mjs';

// The GUI driver, from PATH unless named (the test Mac's runner puts ~/.local/bin on PATH).
const CUA = process.env.FOWLBROWSER_GUI_DRIVER || 'cua-driver-local';
const APPS = { chrome: 'Google Chrome', helium: 'Helium' };
// One driver session per job, so a pixel click finds the capture it was measured on; ended when the job is done.
// Exclusive scenarios run one at a time, so one variable does.
let session = null;
const QUIET_MS = 800; // real input comes this long after the agent's last call (its windows end 250 ms after a call)
const LATE_MS = 1500; // a late input report, a takeover or a popup switched back would show within this

function cua(tool, args) {
  let out;
  try {
    out = execFileSync(CUA, ['call', tool, JSON.stringify({ session, ...args })], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const output = `${error.stdout ?? ''} ${error.stderr ?? ''}`.trim();
    console.error(`GUI driver call ${tool} failed: ${output}`);
    throw new Error(`GUI driver call ${tool} ${JSON.stringify(args)} failed: ${output.slice(0, 600)}`);
  }
  try { return JSON.parse(out); } catch { return out; }
}

// The element's centre in screen points (CSS px at zoom 100%), from the page.
const SCREEN_POINT_FN = (selector) => `() => {
  const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
  return { x: screenX + (outerWidth - innerWidth) / 2 + r.left + r.width / 2, y: screenY + (outerHeight - innerHeight) + r.top + r.height / 2 };
}`;

const numeric = (tab) => Number(tab.split(':')[1]);

export default {
  name: 'takeover',
  gui: true,
  exclusive: true,
  async run(t) {
    session = `fowlbrowser-${t.tag}`;
    const host = await rawHost(t.browser, `raw-${t.tag}`);
    const activeBefore = (await t.listAll()).filter((x) => x.active).map((x) => x.tab);
    const restoreFocus = async () => {
      const now = (await t.listAll()).filter((x) => x.active).map((x) => x.tab);
      for (const previous of activeBefore.filter((x) => !now.includes(x))) await t.call('tab_focus', { tab: previous }).catch(() => {});
    };
    // The browser window holding the page titled `title` (the active tab's title is the window's).
    const windowOf = (title) => {
      const found = cua('list_windows', { on_screen_only: true }).windows
        .filter((w) => w.app_name === APPS[t.browser] && w.title.includes(title)).sort((a, b) => b.z_index - a.z_index)[0];
      if (!found) throw new Error(`no ${APPS[t.browser]} window titled "${title}"`);
      return found;
    };
    // Measures where `point` lands in the window titled `title`; the returned function waits QUIET_MS, clicks there and
    // returns when it clicked. The point is read first: an agent call running on the tab would queue the read behind it.
    const aim = (point, title) => {
      const win = windowOf(title);
      const state = cua('get_window_state', { pid: win.pid, window_id: win.window_id, include_accessibility_tree: false });
      const bounds = state.window_bounds ?? win.bounds;
      const scale = state.screenshot_width / bounds.width;
      return async () => {
        await sleep(QUIET_MS);
        const at = Date.now();
        cua('click', { pid: win.pid, window_id: win.window_id, ...(state.capture_id && { capture_id: state.capture_id }),
          x: Math.round((point.x - bounds.x) * scale), y: Math.round((point.y - bounds.y) * scale) });
        return at;
      };
    };
    const realClick = async (tab, selector, title) => aim(await t.eval(tab, SCREEN_POINT_FN(selector)), title)();
    const keys = (title, combo) => {
      const win = windowOf(title);
      cua('hotkey', { pid: win.pid, window_id: win.window_id, keys: combo, delivery_mode: 'foreground' });
    };
    // Every agent result until Cmd-W, so each case can show no notice ever came.
    const texts = [];
    const call = async (name, args) => {
      const res = await t.call(name, args);
      texts.push(res.text);
      return res;
    };
    const noNotice = (what) => {
      const notice = texts.find((x) => /took over/.test(x));
      t.ok(!notice, `${what}: no takeover notice: ${notice?.slice(0, 300)}`);
    };
    const refusal = async (tab) => {
      const error = await t.call('snapshot', { tab }).then(() => null, (e) => e);
      t.ok(error instanceof ToolError, `calls on ${tab} are refused now`);
      return error.message;
    };
    const parkedOf = async (tab) => (await host.request('tabs.listAll', {})).find((x) => `${t.browser}:${x.id}` === tab)?.parked ?? null;
    const listed = async (tab) => (await t.listAll()).find((x) => x.tab === tab);
    const userPopups = new Set(); // the user's popups still open, closed at the end if a step failed

    const tab = await t.open(`${t.site}/takeover.html?tag=${t.tag}`);
    const other = await t.open(`${t.site}/index.html?other=${t.tag}`);
    try {
      await t.call('tab_focus', { tab });
      const { group } = await listed(tab);
      t.ok(group, 'the agent tab is in its group');

      t.step('1: a burst of agent actions in the focused tab is no takeover');
      const s = await t.snapshot(tab);
      const ref = (role, name) => t.ref(s, role, name);
      const [add, search, notes, size, gift, drag, drop, hover, box] = [ref('button', 'Add to cart'), ref('textbox', 'Search'), ref('textbox', 'Notes'),
        ref('combobox', 'Size'), ref('checkbox', 'Gift wrap'), ref('generic', 'Drag me'), ref('generic', 'Drop here'), ref('generic', 'Hover me'), ref('generic', 'Scroll inside me')];
      const burst = [
        ['click', { ref: add }], ['type', { ref: search, text: 'agent' }], ['type', { ref: search, text: 'slow', slowly: true }],
        ['press_key', { ref: search, key: 'ArrowLeft' }], ['press_key', { key: 'Tab' }], ['type', { ref: notes, text: ' more', append: true }],
        ['scroll', { direction: 'down' }], ['scroll', { direction: 'up' }], ['scroll', { ref: box, direction: 'down' }], ['drag', { from_ref: drag, to_ref: drop }],
        ['fill_form', { fields: [{ ref: search, value: 'filled' }, { ref: gift, value: true }, { ref: size, value: 'Large' }] }],
        ['select_option', { ref: size, values: ['Medium'] }], ['hover', { ref: hover }], ['click', { x: 600, y: 30 }], ['click', { ref: gift }], ['click', { ref: add }],
      ];
      let count = 0;
      for (let round = 0; round < 2; round++) {
        for (const [name, args] of burst) { await call(name, { tab, snapshot: false, ...args }); count++; }
      }
      // The agent's own navigations in the focused tab: a link, back, forward, reload, a URL (a fresh page: "ready").
      for (const [name, args] of [['click', { ref: t.ref(s, 'link', 'Next page') }], ['navigate', { action: 'back' }], ['navigate', { action: 'forward' }],
        ['navigate', { action: 'reload' }], ['navigate', { url: `${t.site}/takeover.html?tag=${t.tag}` }]]) {
        await call(name, { tab, snapshot: false, ...args });
        count++;
      }
      await sleep(LATE_MS); // late reports and commits
      await call('snapshot', { tab });
      t.ok(count >= 30, `${count} agent actions`);
      noNotice('after the burst');
      t.eq(await parkedOf(tab), null, 'not parked after the burst');

      t.step('2: one real click is no takeover');
      await realClick(tab, '#add', 'Takeover test');
      await sleep(LATE_MS);
      t.eq(await parkedOf(tab), null, 'not parked after the click');
      await call('snapshot', { tab });
      noNotice('after the click');
      t.eq(await t.resultOf(tab), 'added 1', 'the user\'s click landed');

      t.step('3: a real click while the agent\'s wait_for runs on the tab');
      const fire = aim(await t.eval(tab, SCREEN_POINT_FN('#add')), 'Takeover test');
      const waitStarted = Date.now();
      const waiting = call('wait_for', { tab, seconds: 3, snapshot: false }).then((r) => r, (e) => e);
      const clickedAt = await fire();
      const waited = await waiting;
      const tookMs = Date.now() - waitStarted;
      console.log(`WAIT_FOR ${t.browser}: the click came ${clickedAt - waitStarted} ms in, wait_for ended after ${tookMs} ms (3 s asked)`);
      t.ok(!(waited instanceof Error), `wait_for resolves: ${waited?.message}`);
      t.ok(clickedAt - waitStarted < 2500, `the click came while wait_for ran (${clickedAt - waitStarted} ms in)`);
      t.ok(tookMs >= 2900, `wait_for ran its full 3 s (${tookMs} ms)`);
      noNotice('wait_for');
      t.eq(await parkedOf(tab), null, 'not parked after the click during wait_for');
      t.eq(await t.resultOf(tab), 'added 2', 'the user\'s click landed');

      t.step('4: real typing in a field is no takeover');
      await call('click', { tab, ref: await t.refOf(tab, 'textbox', 'Search'), snapshot: false });
      await sleep(QUIET_MS);
      const win = windowOf('Takeover test');
      cua('type_text', { pid: win.pid, window_id: win.window_id, text: 'hello', delivery_mode: 'foreground' });
      await sleep(LATE_MS);
      t.eq(await parkedOf(tab), null, 'not parked after typing');
      await call('snapshot', { tab });
      noNotice('after typing');
      t.eq(await t.eval(tab, '() => document.getElementById("search").value'), 'hello', 'the field holds the user\'s text');

      t.step('5: an address typed into the address bar is no takeover');
      await sleep(QUIET_MS);
      keys('Takeover test', ['cmd', 'l']);
      await sleep(300);
      const win5 = windowOf('Takeover test');
      cua('type_text', { pid: win5.pid, window_id: win5.window_id, text: `${t.site}/takeover.html?typed&tag=${t.tag}`, delivery_mode: 'foreground' });
      cua('press_key', { pid: win5.pid, window_id: win5.window_id, key: 'return', delivery_mode: 'foreground' });
      await t.until(async () => (await listed(tab))?.url.includes('takeover.html?typed'), 'the tab commits the typed address', 8000);
      await sleep(LATE_MS);
      const typed = await listed(tab);
      t.eq([typed.owner, typed.parked, typed.group], ['you', null, group], 'still the agent\'s tab, in its group');
      const page = await call('snapshot', { tab });
      t.ok(page.text.includes('takeover.html?typed'), `the next snapshot shows the typed page: ${page.text.slice(0, 300)}`);
      noNotice('after the address bar');

      // The user's popups: a target=_blank link (the extension opens it, tabs.openChild) and a button's window.open (the
      // browser opens it with its opener). Chrome would put a tab the user opens like this in front, and so must we.
      for (const [selector, via] of [['#user-link', 'takeover-link'], ['#user-open', 'takeover-open']]) {
        t.step(`6: the user's own popup (${via}) is theirs`);
        const before = new Set((await t.listAll()).map((x) => x.tab));
        await realClick(tab, selector, 'Takeover test');
        const popup = await t.until(async () => (await t.listAll()).find((x) => !before.has(x.tab) && x.url.includes(`via=${via}&tag=${t.tag}`)),
          `a new tab for the user's ${via} click`, 5000);
        userPopups.add(popup.tab);
        t.ok(popup.active, `${via}: opened in front: ${JSON.stringify(popup)}`);
        await sleep(LATE_MS);
        const later = await listed(popup.tab);
        t.ok(later, `${via}: still open ${LATE_MS} ms later`);
        t.eq([later.owner, later.active, later.muted], [null, true, false], `${via}: the user's (not owned, not muted), still in front`);
        t.ok(later.group !== group, `${via}: not in the agent's group "${group}": ${JSON.stringify(later)}`);
        await host.request('tabs.closeUnowned', { tabId: numeric(popup.tab) });
        userPopups.delete(popup.tab);
        // The agent tab in front again for the next real click (closing a tab in front mostly shows its opener anyway).
        await t.call('tab_focus', { tab });
        await t.until(() => windowOf('Takeover test'), 'the agent tab is in front again', 3000);
      }

      // The user's target=_blank link to a download (the extension opens it for them, tabs.openChild): the new tab turns
      // into a download and Chrome closes it, as for a tab it opens itself, so no empty tab is left in front.
      t.step('6: the user\'s own download link in a new tab leaves no tab behind');
      const file = path.join(os.homedir(), 'Downloads', `fowlbrowser-user-download-${t.tag}.txt`);
      const beforeDownload = new Set((await t.listAll()).map((x) => x.tab));
      await realClick(tab, '#user-download', 'Takeover test');
      try {
        await t.until(() => fs.existsSync(file), 'the file downloaded', 8000);
        await sleep(LATE_MS);
        const left = (await t.listAll()).filter((x) => !beforeDownload.has(x.tab));
        for (const x of left) userPopups.add(x.tab);
        t.eq(left.map((x) => x.url), [], 'no new tab left behind');
      } finally {
        fs.rmSync(file, { force: true });
      }
      await t.call('tab_focus', { tab });
      await t.until(() => windowOf('Takeover test'), 'the agent tab is in front again', 3000);

      t.step('6: the agent\'s own click on the same link opens a tab of its own');
      const clicked = await call('click', { tab, ref: await t.refOf(tab, 'link', 'Open link in new tab'), snapshot: false });
      const child = await t.until(async () => (await t.listMine()).find((x) => x.url.includes(`via=takeover-link&tag=${t.tag}`)), 'the agent\'s popup listed as mine');
      t.track(child.tab);
      t.eq(tabIdsIn(clicked.text, t.browser).find((id) => id !== tab), child.tab, 'the click result names it');
      t.eq([child.owner, child.active, child.muted, child.group], ['you', false, true, group], 'the agent\'s: in the background, muted, in its group');
      await t.close(child.tab);
      noNotice('after the popups');

      t.step('7: Cmd-W is still a takeover');
      await t.call('tab_focus', { tab });
      await sleep(QUIET_MS);
      keys('Takeover test', ['cmd', 'w']);
      await t.until(async () => !(await host.request('tabs.listAll', {})).some((x) => `${t.browser}:${x.id}` === tab), 'tab closed', 5000);
      t.closed.add(tab);
      const message = await refusal(tab);
      t.ok(/The user took over .* \(closed the tab\)\. Stop working in that tab, tell the user where you got to, and ask before going on\.$/.test(message), `notice: ${message}`);

      t.step('8: DevTools on an agent tab (recorded)');
      await t.call('tab_focus', { tab: other });
      await sleep(QUIET_MS);
      const title = 'FowlBrowser test site';
      keys(title, ['cmd', 'option', 'i']);
      await sleep(2500);
      const devtools = await t.call('snapshot', { tab: other }).then((r) => `call ok${r.text.includes('took over') ? `, notice: ${r.text.split('\n')[0]}` : ''}`, (e) => `call refused: ${e.message.split('\n').slice(0, 2).join(' ')}`);
      const parked = await parkedOf(other);
      // DevTools docks into the window by default: its panel tabs show in the window's accessibility tree.
      const devWindow = windowOf(title);
      const opened = cua('get_window_state', { pid: devWindow.pid, window_id: devWindow.window_id, include_screenshot: false, query: 'Elements' });
      const shown = (opened.filtered_element_count ?? opened.elements?.length ?? 0) > 0
        || cua('list_windows', { on_screen_only: true }).windows.some((w) => w.app_name === APPS[t.browser] && /DevTools/.test(w.title));
      console.log(`DEVTOOLS ${t.browser}: open: ${shown}; ${devtools}; parked: ${parked}`);
      t.ok(shown, 'DevTools opened');
      keys(title, ['cmd', 'option', 'i']); // closes it again (the shortcut works from the DevTools window too)
      await sleep(1500);
      if (parked) {
        const again = await t.call('tab_claim', { tab: other, resume: true });
        t.ok(/Resumed/.test(again.text), 'resumed once DevTools closed');
      }
      await t.snapshot(other);
    } finally {
      // A user's popup a failed step left open: unowned, closed without a claim; adopted by mistake, closed as ours.
      for (const left of userPopups) {
        await host.request('tabs.closeUnowned', { tabId: numeric(left) })
          .catch(() => t.call('tab_close', { tab: left, confirm_close_users_tab: true })).catch(() => {});
      }
      host.close();
      await restoreFocus();
      try { cua('end_session', {}); } catch {}
    }
  },
};
