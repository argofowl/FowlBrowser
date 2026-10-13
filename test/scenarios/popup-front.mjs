// What a popup from an agent's click does while the user works in another app (a test Mac only, under its GUI lock: run.mjs
// --gui). With a Finder window frontmost and the agent tab's browser behind it, the agent clicks a link and buttons
// that window.open with and without popup features (a size guide, a sign-in window). The front app is polled with
// lsappinfo for the whole action, and the extension's activity stream records activations, windows and focus.
// Checked: each popup is a background tab from the start (no activation, no window); a click that opens nothing, a
// tab_open and a popup without an opener (tier 1, opened by the extension) leave the front app alone. Reported, not
// failed: the browser coming to the front for opener-dependent popups (known limit, accepted).
// The Finder window is closed and the frontmost app given back at the end.
import { execFileSync, spawn } from 'node:child_process';
import { rawHost, sleep, tabIdsIn } from '../lib.mjs';

// The GUI driver, from PATH unless named (the test Mac's runner puts ~/.local/bin on PATH).
const CUA = process.env.FOWLBROWSER_GUI_DRIVER || 'cua-driver-local';
const APPS = { chrome: 'Google Chrome', helium: 'Helium' };
const SETTLE_MS = 1000;

const front = () => {
  const asn = execFileSync('lsappinfo', ['front'], { encoding: 'utf8' }).trim();
  const info = (key) => execFileSync('lsappinfo', ['info', '-only', key, asn], { encoding: 'utf8' });
  return { name: /"([^"]*)"/.exec(info('name'))?.[1] ?? null, pid: Number(/pid = (\d+)/.exec(info('pid'))?.[1]) };
};
const cua = (tool, args) => JSON.parse(execFileSync(CUA, ['call', tool, JSON.stringify(args)], { encoding: 'utf8' }));
const toFront = (pid, windowId) => cua('bring_to_front', { pid, ...(windowId && { window_id: windowId }) });
// The other app: a Finder window of a folder of the scenario's own, closed at the end.
const FOLDER = '/tmp/fowlbrowser-popup-front';
// Left open, it would cover the browser windows that later scenarios click with real input. Waits until it is gone,
// so the next job never finds the closing one.
const finderWindows = () => cua('list_windows', { on_screen_only: true }).windows.filter((w) => w.app_name === 'Finder' && w.title === FOLDER.split('/').pop());
async function closeFinderWindow() {
  try {
    execFileSync('osascript', ['-e', 'tell application "Finder"', '-e', 'repeat with i from (count Finder windows) to 1 by -1',
      '-e', `if name of Finder window i is "${FOLDER.split('/').pop()}" then close Finder window i`, '-e', 'end repeat', '-e', 'end tell']);
  } catch {}
  for (let i = 0; i < 20 && finderWindows().length; i++) await sleep(250);
}
async function finderWindow() {
  execFileSync('mkdir', ['-p', FOLDER]);
  execFileSync('open', [FOLDER]);
  for (let i = 0; i < 40; i++) {
    const [found] = finderWindows();
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`no Finder window for ${FOLDER}`);
}

// The front app's name, as often as lsappinfo answers, until stopped: [[name, at]].
function watchFront() {
  const seen = [];
  const proc = spawn('sh', ['-c', 'while :; do lsappinfo info -only name "$(lsappinfo front)"; done']);
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (/^"/.test(line)) seen.push([/^"([^"]*)"/.exec(line)[1], Date.now()]);
  });
  return { seen, stop: () => proc.kill() };
}

export default {
  name: 'popup-front',
  gui: true,
  exclusive: true,
  async run(t) {
    const before = front();
    const finder = await finderWindow();
    const host = await rawHost(t.browser, `raw-${t.tag}`);
    const activity = [];
    host.on('tabs.activity', (e) => activity.push(e));
    await host.request('tabs.watchActivity');
    try {
      const agent = await t.open(`${t.site}/popups.html?tag=${t.tag}`);
      const opener = await t.open(`${t.site}/oauth.html?tag=${t.tag}`);
      const plain = await t.open(`${t.site}/modifier.html?tag=${t.tag}`);
      for (const [tab, name, via] of [[plain, 'Record modifiers', 'none'], [plain, 'Record modifiers', 'tab_open'], [agent, 'Open link in new tab', 'blank'], [agent, 'Open popup window', 'features'], [agent, 'Open window', 'window-open'], [opener, 'Sign in with IdP', 'oauth']]) {
        t.step(`${via}: the browser stays behind`);
        const ref = await t.refOf(tab, via === 'blank' ? 'link' : 'button', name);
        toFront(finder.pid, finder.window_id);
        await t.until(() => front().name === 'Finder', 'Finder is frontmost');
        await sleep(300);
        const fronts = watchFront();
        await t.until(() => fronts.seen.length, 'lsappinfo answers');
        const mark = Date.now();
        const res = via === 'tab_open' ? await t.call('tab_open', { browser: t.browser, url: `${t.site}/popup-target.html?via=tab_open&tag=${t.tag}` })
          : await t.call('click', { tab, ref, snapshot: false });
        await sleep(SETTLE_MS);
        fronts.stop();
        const popup = tabIdsIn(res.text.split('New tab opened by this action')[1] ?? '', t.browser)[0];
        const apps = [...new Set(fronts.seen.filter(([, at]) => at >= mark).map(([app]) => app))];
        const events = activity.filter((e) => e.at >= mark).map(({ kind, tabId, active, windowType }) => ({ kind, tab: tabId === null ? null : `${t.browser}:${tabId}`, active, windowType }));
        const times = activity.filter((e) => e.at >= mark).map((e) => `${e.kind}@${e.at - mark}`);
        const changes = fronts.seen.filter(([app], i) => i === 0 || app !== fronts.seen[i - 1][0]).map(([app, at]) => `${app}@${at - mark}`);
        console.log(`[popup-front] ${t.browser} ${via}: front apps during the click: ${apps.join(', ')} (${fronts.seen.length} samples; ${changes.join(' ')}); activity ${JSON.stringify(events)} ${times.join(' ')}`);
        if (via === 'none') {
          t.eq([apps, events], [['Finder'], []], 'a click that opens nothing leaves the front app alone');
          continue;
        }
        if (via === 'tab_open') {
          const opened = res.structured?.tab ?? tabIdsIn(res.text, t.browser)[0];
          t.track(opened);
          t.eq([apps, events], [['Finder'], [{ kind: 'created', tab: opened, active: false, windowType: 'normal' }]], 'a tab the extension opens leaves the front app alone');
          await t.close(opened);
          continue;
        }
        t.ok(popup, `${via}: the click opened a tab (${res.text.slice(0, 200)})`);
        t.track(popup);
        // Never a tab activation or a window: the popup was a background tab from the start.
        t.eq(events.filter((e) => e.kind !== 'windowFocus'), [{ kind: 'created', tab: popup, active: false, windowType: 'normal' }], `${via}: one background tab, nothing activated`);
        // Known limit (SPEC "Popups (session 5)"): Chrome shows the source window for any tab a page opens with a user
        // gesture (OpenURLFromTab and AddNewContents pass kShowWindow, whatever the disposition), and showing a visible
        // window on macOS activates the browser. Reported, not failed, until a fix exists.
        const jumped = apps.some((app) => app !== 'Finder');
        if (via === 'blank') {
          t.eq(apps, ['Finder'], `${via}: a popup without an opener leaves the browser behind`);
          await t.close(popup);
          continue;
        }
        console.log(`[popup-front] ${t.browser} ${via}: ${jumped ? `KNOWN LIMIT: ${APPS[t.browser]} came to the front` : 'stayed behind'}`);
        await t.close(popup);
      }
    } finally {
      await closeFinderWindow();
      if (before.pid) try { toFront(before.pid); } catch {}
      host.close();
    }
  },
};
