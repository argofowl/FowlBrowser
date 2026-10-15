// What a prompt-injected agent hits first: only web pages open, only web files download, devices never upload, and a
// password's value never shows in a snapshot, find, text mode or the changes after an action (in the page, an iframe of
// either origin, a field Playwright gives no ref, a closed shadow root), while the page itself keeps it.
import { ToolError } from '../lib.mjs';

// FowlBrowser's own extension id (fixed by the key in extension/manifest.json).
const EXTENSION_PAGE = 'chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html';
const MASKED = '"••••••••"';

export default {
  name: 'security',
  async run(t) {
    const refused = async (name, args, pattern) => {
      const error = await t.call(name, args).then(() => null, (e) => e);
      t.ok(error instanceof ToolError && pattern.test(error.message), `${name} ${JSON.stringify(args)} refused: ${error?.message ?? 'it went through'}`);
    };

    t.step('tab_open refuses pages that are not web pages');
    const before = (await t.listMine()).length;
    const notWeb = /can't be opened: agents open web pages only/;
    const cases = [[EXTENSION_PAGE, notWeb], ['chrome://settings', notWeb], ['javascript:alert(1)', notWeb], ['mailto:x@example.com', notWeb],
      ['file:///etc/hosts', /is a local file/]];
    for (const [url, pattern] of cases) await refused('tab_open', { browser: t.browser, url }, pattern);
    t.eq((await t.listMine()).length, before, 'no tab was opened');

    t.step('navigate refuses them too and stays on the page');
    const tab = await t.open(`${t.site}/index.html`);
    for (const [url, pattern] of cases) await refused('navigate', { tab, url }, pattern);
    t.eq(await t.eval(tab, '() => location.href'), `${t.site}/index.html`, 'still on the test page');

    t.step('download refuses a local file');
    await refused('download', { tab, url: 'file:///etc/hosts', wait_ms: 5000 }, /can't be downloaded: download takes http: and https: URLs only/);

    t.step('upload_files refuses a device');
    const upload = await t.open(`${t.site}/upload.html`);
    await refused('upload_files', { tab: upload, ref: t.ref(await t.snapshot(upload), ['button', 'textbox'], /Attachment/), paths: ['/dev/zero'] },
      /can't be uploaded: it is not a regular file or folder/);

    t.step('a filled sign-in form: password values are masked');
    const secret = `fb-secret-${t.tag}`;
    const typed = `fb-typed-${t.tag}`;
    await t.call('evaluate', { tab, function: `() => {
      const form = document.createElement('form');
      form.innerHTML = '<label>Email <input id="fb-email" type="email"></label> <label>Password <input id="fb-pass" type="password" placeholder="Your password"></label> ' +
        '<label>New password <input id="fb-new" type="password"></label> <label style="pointer-events: none">Locked password <input id="fb-locked" type="password"></label> ' +
        '<input id="fb-role" type="password" role="button" aria-label="Reveal">';
      document.body.prepend(form);
      document.getElementById('fb-email').value = 'ada@example.com';
      for (const id of ['fb-pass', 'fb-role']) document.getElementById(id).value = ${JSON.stringify(secret)};
      document.getElementById('fb-locked').value = ${JSON.stringify(`  ${secret}   end `)}; // shown with its spaces collapsed
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = '<label>Closed password <input type="password"></label>';
      root.querySelector('input').value = ${JSON.stringify(secret)};
      form.append(host);
    }` });
    const leaks = (text) => text.includes(secret) || text.includes(typed);
    const whole = await t.snapshot(tab);
    t.ok(!leaks(whole), `snapshot shows no password: ${whole.slice(0, 1500)}`);
    t.ok(/textbox "Email" \[ref=e\d+\]: ada@example\.com/.test(whole), `other fields keep their values: ${whole.slice(0, 1500)}`);
    t.ok(/textbox "Password" \[ref=e\d+\]:\n\s+- \/placeholder: Your password\n\s+- text: "••••••••"/.test(whole), `the password under its placeholder is masked: ${whole.slice(0, 1500)}`);
    t.ok(whole.includes(`textbox "Locked password": ${MASKED}`), `a field without a ref is masked: ${whole.slice(0, 1500)}`);
    t.ok(/button "Reveal" \[ref=e\d+\]: "••••••••"/.test(whole), `a password input with role="button" is masked: ${whole.slice(0, 1500)}`);
    // Listed with an s ref; its value (if Chrome's accessibility tree gives one) only as the mask.
    t.ok(/textbox "Closed password" \[ref=s\d+\](: "••••••••")?$/m.test(whole), `a closed shadow root's field is listed, masked: ${whole.slice(-800)}`);
    const found = (await t.call('snapshot', { tab, find: 'password' })).text;
    t.ok(!leaks(found) && found.includes(MASKED), `find shows no password: ${found}`);
    t.ok(/no line contains/.test((await t.call('snapshot', { tab, find: secret })).text), 'find for the password itself finds nothing');
    const text = (await t.call('snapshot', { tab, mode: 'text' })).text;
    t.ok(!leaks(text), `text mode shows no password: ${text.slice(0, 800)}`);

    t.step('the changes after typing into and clicking a password field show no value');
    const afterType = (await t.call('type', { tab, ref: t.ref(whole, 'textbox', 'New password'), text: typed })).text;
    t.ok(!leaks(afterType) && afterType.includes(MASKED), `type result: ${afterType}`);
    const afterClick = (await t.call('click', { tab, ref: t.ref(whole, 'textbox', 'Password') })).text;
    t.ok(!leaks(afterClick), `click result: ${afterClick}`);
    t.ok(!leaks(await t.snapshot(tab)), 'the next snapshot shows no password either');
    t.eq(await t.eval(tab, `() => ['fb-pass', 'fb-new'].map((id) => document.getElementById(id).value)`), [secret, typed], 'the page keeps the real values');

    t.step('password fields in a same-origin and a cross-origin iframe are masked');
    const frames = await t.open(`${t.site}/frames.html`);
    const s = await t.until(async () => {
      const snap = await t.snapshot(frames);
      return (snap.match(/textbox "Frame text"/g) || []).length === 2 && snap;
    }, 'both frame forms in snapshot');
    for (const nth of [0, 1]) {
      await t.call('evaluate', { tab: frames, ref: t.ref(s, 'textbox', 'Frame text', nth), function: `(el) => { el.type = 'password'; el.value = ${JSON.stringify(secret)}; }` });
    }
    const framed = await t.snapshot(frames);
    t.ok(!leaks(framed), `iframe passwords are masked: ${framed.slice(0, 2000)}`);
    t.eq((framed.match(new RegExp(`textbox "Frame text" \\[ref=f\\d+e\\d+\\]: ${MASKED}`, 'g')) || []).length, 2, `both iframe fields show the mask: ${framed.slice(0, 2000)}`);

    t.step("a fresh agent tab's own navigation to FowlBrowser's page never leaves the tab controllable there");
    // The first blank page of a tab the extension made: its page script sends it to the extension's popup. Chrome blocks
    // that, or the tab is let go (a tool then refuses it, which passes, even the evaluate that starts it); an evaluate
    // never returns from the popup or with its chrome.* powers.
    const fresh = await t.open('about:blank');
    const go = `() => { setTimeout(() => { location.href = ${JSON.stringify(EXTENSION_PAGE)}; }, 0); return true; }`;
    const started = await t.call('evaluate', { tab: fresh, function: go }).then(() => true, (e) => { if (e instanceof ToolError) return false; throw e; });
    for (let i = 0; started && i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const seen = await t.eval(fresh, '() => ({ href: location.href, powers: !!(globalThis.chrome && (chrome.debugger || chrome.runtime?.id)) })').catch((e) => e);
      if (seen instanceof ToolError) break; // refused: the tab shows a page agents can't control
      if (seen instanceof Error) throw seen;
      t.ok(!seen.powers && !seen.href.startsWith('chrome-extension://'), `still controllable on FowlBrowser's page: ${JSON.stringify(seen)}`);
    }
  },
};
