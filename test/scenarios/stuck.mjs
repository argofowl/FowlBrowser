// A page stuck in an endless script (a broken dev build): a call on it fails within about 20 s saying so, the call
// queued behind it and the next ones fail at once, and navigate gets the tab out, also with a reload or another page of
// the same site (which Chrome holds while the script runs). A reload sent before the page was found stuck waits on it
// for good: the next navigate says only closing gets out, and tab_close does.
import { AssertionError, sleep } from '../lib.mjs';

const STUCK = /has not answered for \d+ s: a script on it seems stuck in a loop/;
const WEDGED = /is stuck in a script, and a navigation sent before that was found still waits on it, so it can't be navigated any more\. Close it with tab_close/;

export default {
  name: 'stuck',
  async run(t) {
    const stick = async (tab) => {
      // The other tab of this page may share its renderer and be stuck already: then the click goes through, but the
      // page doesn't finish it in time.
      await t.call('click', { tab, ref: await t.refOf(tab, 'button', 'Start endless loop'), snapshot: false }).catch((e) => {
        if (!/started but did not finish/.test(e.message)) throw e;
      });
      await sleep(1000); // the loop starts 300 ms after the click
    };
    const fails = async (name, args) => {
      const started = Date.now();
      try {
        await t.call(name, args);
      } catch (e) {
        return { message: e.message, ms: Date.now() - started, at: Date.now() };
      }
      throw new AssertionError(`${name} should fail on the stuck page`);
    };

    // Found stuck by a read: the read fails, so do the calls after it, and navigate gets the tab out.
    const foundByRead = async (tab) => {
      t.step('a text snapshot fails within about 20 s saying the page is stuck, and the call queued behind it right after');
      await stick(tab);
      const first = fails('snapshot', { tab, mode: 'text' });
      await sleep(1000);
      const queued = fails('screenshot', { tab });
      const [text, shot] = await Promise.all([first, queued]);
      t.ok(STUCK.test(text.message), `text snapshot: ${text.message.slice(0, 300)}`);
      t.ok(text.ms >= 14_000 && text.ms < 30_000, `the text snapshot failed after ${text.ms} ms`);
      t.ok(STUCK.test(shot.message), `queued screenshot: ${shot.message.slice(0, 300)}`);
      t.ok(shot.at - text.at < 4000, `the queued screenshot failed ${shot.at - text.at} ms after the text snapshot`);

      t.step('the next call fails at once');
      const next = await fails('evaluate', { tab, function: '() => 1' });
      t.ok(STUCK.test(next.message) && next.ms < 4000, `evaluate on the stuck page failed after ${next.ms} ms: ${next.message.slice(0, 300)}`);

      t.step('navigate reload gets the tab out');
      const reloaded = await t.call('navigate', { tab, action: 'reload' });
      t.ok(/Stuck page/.test(reloaded.text), `reload result: ${reloaded.text.slice(0, 300)}`);
      t.eq(await t.eval(tab, '() => document.title'), 'Stuck page', 'the page answers after the reload');

      t.step('stuck again: reading its links fails, navigate to another page of the same site works');
      await stick(tab);
      const links = await fails('snapshot', { tab, mode: 'links' });
      t.ok(STUCK.test(links.message), `links: ${links.message.slice(0, 300)}`);
      await t.call('navigate', { tab, url: `${t.site}/index.html` });
      t.eq(await t.eval(tab, '() => document.title'), 'FowlBrowser test site', 'navigated to index');
    };

    // Stuck before any call noticed, and the first call is a reload: Chrome holds it, and every command to the page after it.
    const foundByReload = async (tab) => {
      await stick(tab);
      const reload = await fails('navigate', { tab, action: 'reload' });
      t.ok(STUCK.test(reload.message) && reload.ms < 30_000, `reload sent to the stuck page, after ${reload.ms} ms: ${reload.message.slice(0, 300)}`);
      const again = await fails('navigate', { tab, action: 'reload' });
      t.ok(WEDGED.test(again.message) && again.ms < 4000, `the next reload, after ${again.ms} ms: ${again.message.slice(0, 300)}`);
      await t.close(tab);
    };

    const [read, reload] = await Promise.all([t.open(`${t.site}/stuck.html`), t.open(`${t.site}/stuck.html`)]);
    await Promise.all([foundByRead(read), foundByReload(reload)]);
  },
};
