// The browser's and the Mac's own UI never opens from an agent's actions (it would float over the user's screen or
// take over their mouse): clicks and opening keys on colour, dropdown and file controls and on links to other apps are
// refused with what to use instead; a file chooser a button opens is held for upload_files; page calls for the
// eyedropper, file panels, full screen, print, share sheet, camera and pointer lock are refused and reported.
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default {
  name: 'native',
  async run(t) {
    const tab = await t.open(`${t.site}/native.html`);
    const s = await t.snapshot(tab);
    const log = () => t.eval(tab, '() => window.__log.map((e) => `${e.what}:${e.detail}`)');
    const refused = async (args, pattern, msg) => {
      const result = await t.call('click', { tab, snapshot: false, ...args }).then((r) => `no error: ${r.text}`, (e) => e.message);
      t.ok(pattern.test(result), `${msg}: ${result}`);
    };

    t.step('colour input: click, label click and x,y click refused; type sets it');
    const colour = t.ref(s, 'textbox', 'Accent colour');
    await refused({ ref: colour }, /colour picker \(now #3366ff\).*type \(text "#rrggbb"\)/s, 'colour click');
    const box = await t.eval(tab, '() => { const r = document.getElementById("color").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }');
    await refused({ x: box[0], y: box[1] }, /The element at \d+,\d+ is a colour picker/, 'colour x,y click');
    await t.call('type', { tab, ref: colour, text: '#AA3300', snapshot: false });
    t.eq(await t.eval(tab, '() => document.getElementById("color").value'), '#aa3300', 'colour set by type');

    t.step('dropdown: click and Space refused, select_option works');
    const plan = t.ref(s, 'combobox', 'Plan');
    await refused({ ref: plan }, /dropdown.*select_option.*options: Free, Pro, Team/s, 'select click');
    const space = await t.call('press_key', { tab, ref: plan, key: 'Space', snapshot: false }).then((r) => `no error: ${r.text}`, (e) => e.message);
    t.ok(/Pressing Space on it opens its menu/.test(space), `select Space: ${space}`);
    await t.call('select_option', { tab, ref: plan, values: ['Team'], snapshot: false });
    t.eq(await t.eval(tab, '() => document.getElementById("select").value'), 'Team', 'select_option');

    t.step('file input and app links refused');
    await refused({ ref: t.ref(s, 'button', 'Attachment') }, /file input.*upload_files/s, 'file click');
    await refused({ ref: t.ref(s, 'link', 'Email us') }, /link to another app \(mailto:someone@example.com\)/, 'mailto');
    await refused({ ref: t.ref(s, 'link', 'Join meeting') }, /link to another app \(zoommtg:/, 'custom scheme');
    t.ok(!(await log()).some((line) => /^(color|select|file):click/.test(line)), `no refused control was clicked: ${JSON.stringify(await log())}`);

    t.step('a dropdown in an iframe (and in one drawn at half size) and a colour input in a web link card: refused too');
    for (const id of ['frame-plain', 'frame-scaled']) {
      const at = await t.eval(tab, `() => { const f = document.getElementById(${JSON.stringify(id)}); f.scrollIntoView({ block: 'center' }); const r = f.getBoundingClientRect();
        const s = r.width / f.offsetWidth; const b = f.contentDocument.getElementById('s').getBoundingClientRect();
        return [r.left + (f.clientLeft + b.left + b.width / 2) * s, r.top + (f.clientTop + b.top + b.height / 2) * s]; }`);
      await refused({ x: at[0], y: at[1] }, /is a dropdown \(<select>\)/, `${id} x,y click`);
    }
    const card = await t.snapshot(tab);
    await refused({ ref: t.ref(card, 'textbox', 'Card colour') }, /colour picker \(now #00aa00\)/, 'colour input inside a link');

    t.step('a dropdown in a closed shadow root (an s ref): click refused');
    await refused({ ref: t.ref(card, 'combobox', 'Shadow size') }, /Ref s\d+ is a dropdown/, 'closed shadow select');

    t.step('a page script clicking a colour input in a closed shadow root: refused and reported');
    const swatch = await t.call('click', { tab, ref: t.ref(card, 'button', 'Pick swatch'), snapshot: false });
    t.ok(/The page tried to open the colour window/.test(swatch.text), `swatch reported: ${swatch.text}`);

    t.step('a button that opens a file chooser: held, then filled by upload_files');
    const path = join(tmpdir(), `fowlbrowser-native-${t.tag}.txt`);
    await writeFile(path, 'avatar');
    try {
      const opened = await t.call('click', { tab, ref: t.ref(s, 'button', 'Choose avatar'), snapshot: false });
      t.ok(/opened a file chooser; FowlBrowser kept it off the user's screen/.test(opened.text), `chooser held: ${opened.text}`);
      await t.call('upload_files', { tab, paths: [path], snapshot: false });
      await t.until(async () => (await log()).includes(`avatar-input:fowlbrowser-native-${t.tag}.txt`), 'file chosen through the held chooser');
    } finally {
      await rm(path, { force: true });
    }

    t.step('page calls for the browser\'s or the Mac\'s UI: refused and reported');
    for (const [name, what, error] of [['Pick from screen', 'screen colour picker', 'AbortError'], ['Full screen', 'full screen', 'TypeError'],
      ['Print', 'print dialog', null], ['Open file (File System Access)', 'file panel', 'AbortError'], ['Share', 'share sheet', 'AbortError'],
      ['Camera', 'camera or microphone', 'NotAllowedError'], ['Lock pointer', 'pointer lock', 'NotAllowedError']]) {
      const result = await t.call('click', { tab, ref: t.ref(s, 'button', name), snapshot: false });
      t.ok(new RegExp(`The page tried to open [^.]*${what}`).test(result.text), `${name} reported: ${result.text}`);
      if (error) await t.until(async () => (await log()).some((line) => line.includes(error)), `${name}: the page saw ${error}`);
    }
    t.eq(await t.eval(tab, '() => !!document.fullscreenElement'), false, 'not full screen');
  },
};
