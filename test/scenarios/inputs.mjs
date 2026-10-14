// What real jobs needed (2026-10 logs): hover and drag by point, repeated keys, the browser's reload shortcut, dark
// mode and reduced motion, the current page's console, a settled wait, page links, an app that renders after load,
// and full-page screenshots of reveal-on-scroll pages.
export default {
  name: 'inputs',
  async run(t) {
    const tab = await t.open(`${t.site}/inputs.html?first`);
    const log = () => t.eval(tab, '() => window.__log');
    const box = (selector) => t.eval(tab, `() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }`);

    t.step('hover by point opens the card');
    const anchor = await box('#card-anchor');
    await t.call('hover', { tab, x: anchor.x + 10, y: anchor.y + anchor.h / 2, snapshot: false });
    t.ok((await log()).includes('hover'), 'hover card opened');

    t.step('drag along points: slider and a drawn stroke');
    const slider = await box('#volume');
    await t.call('drag', { tab, from_x: slider.x + 4, from_y: slider.y + slider.h / 2, to_x: slider.x + slider.w * 0.75, to_y: slider.y + slider.h / 2, snapshot: false });
    const volume = Number(await t.eval(tab, '() => document.getElementById("volume").value'));
    t.ok(volume >= 60 && volume <= 90, `slider dragged to about 75: ${volume}`);
    const pad = await box('#pad');
    await t.call('drag', { tab, from_x: pad.x + 20, from_y: pad.y + 20, to_x: pad.x + 260, to_y: pad.y + 100, snapshot: false });
    const stroke = (await log()).find((l) => l.startsWith('stroke'));
    t.ok(stroke && Number(stroke.split(' ')[1]) >= 5, `a stroke with several moves: ${stroke}`);

    t.step('press_key times');
    const list = await t.refOf(tab, 'list', 'Fruit list');
    await t.call('press_key', { tab, ref: list, key: 'ArrowDown', times: 3, snapshot: false });
    t.ok((await log()).includes('list 3'), `three ArrowDowns: ${JSON.stringify(await log())}`);

    t.step('browser shortcuts: Cmd+R reloads, Cmd+W is refused');
    const reloaded = await t.call('press_key', { tab, key: 'ControlOrMeta+r', snapshot: false });
    t.ok(/reload shortcut.*did the reload instead/.test(reloaded.text), `reload: ${reloaded.text}`);
    t.eq(await log(), [], 'the page was reloaded (fresh log)');
    const refused = await t.call('press_key', { tab, key: 'Meta+w', snapshot: false }).then((r) => `no error: ${r.text}`, (e) => e.message);
    t.ok(/shortcut to close the tab.*tab_close/.test(refused), `Cmd+W: ${refused}`);

    t.step('console shows the current page; earlier pages on request');
    const console = await t.call('console', { tab, level: 'error' });
    t.ok((console.text.match(/inputs page loaded/g) ?? []).length === 1 && /1 from earlier pages of this tab left out/.test(console.text), `console: ${console.text}`);
    const all = await t.call('console', { tab, level: 'error', all_pages: true });
    t.eq((all.text.match(/inputs page loaded/g) ?? []).length, 2, 'both pages with all_pages');

    t.step('dark mode and reduced motion');
    const dark = await t.call('viewport', { tab, color_scheme: 'dark', reduced_motion: true, snapshot: false });
    t.ok(/prefers-color-scheme dark, prefers-reduced-motion reduce/.test(dark.text), `emulated: ${dark.text}`);
    t.eq(await t.eval(tab, '() => [getComputedStyle(document.getElementById("scheme"), "::after").content, getComputedStyle(document.getElementById("motion"), "::after").content]'),
      ['"dark"', '"reduced"'], 'the page sees dark and reduced');
    await t.call('viewport', { tab, reset: true, snapshot: false });
    t.eq(await t.eval(tab, '() => matchMedia("(prefers-reduced-motion: reduce)").matches'), false, 'reset');

    t.step('links mode');
    const links = await t.call('snapshot', { tab, mode: 'links' });
    t.ok(/First result → http:\/\/[^/]+\/results\.html\?q=one/.test(links.text) && /Second result →/.test(links.text), `links: ${links.text}`);
    t.ok(!/First again/.test(links.text) && !/Top →/.test(links.text), `each URL once, no in-page anchors: ${links.text}`);

    t.step('find: only the matching lines, with refs that work');
    const found = await t.call('snapshot', { tab, find: 'second result' });
    t.ok(/only the 1 line with "second result"/.test(found.text) && /link "Second result" \[ref=(\w+)\]/.test(found.text) && !/First result/.test(found.text), `find: ${found.text}`);
    await t.call('click', { tab, ref: /link "Second result" \[ref=(\w+)\]/.exec(found.text)[1], snapshot: false });
    await t.until(async () => (await t.eval(tab, '() => location.search')) === '?q=two', 'the found ref clicked through');
    await t.call('navigate', { tab, action: 'back', snapshot: false });

    t.step('an app that renders after load: navigate waits for its content');
    const spa = await t.call('navigate', { tab, url: `${t.site}/spa.html` });
    t.ok(/Revenue this month/.test(spa.text), `content in the navigate result: ${spa.text.slice(0, 600)}`);
    await t.call('navigate', { tab, url: `${t.site}/spa.html?again`, snapshot: false });
    const settled = await t.call('wait_for', { tab, snapshot: false });
    t.ok(/The page settled after/.test(settled.text), `settled: ${settled.text}`);
    t.ok(await t.eval(tab, '() => !!document.querySelector("h1")'), 'rendered once settled');

    t.step('full-page screenshot reveals content that appears on scroll');
    await t.call('navigate', { tab, url: `${t.site}/native.html?reveal`, snapshot: false });
    t.eq(await t.eval(tab, '() => document.getElementById("lazy").classList.contains("seen")'), false, 'not revealed before');
    await t.call('screenshot', { tab, full_page: true });
    t.eq(await t.eval(tab, '() => [document.getElementById("lazy").classList.contains("seen"), Math.round(scrollY)]'), [true, 0], 'revealed, scrolled back');

    t.step('evaluate takes script too');
    const title = await t.call('evaluate', { tab, script: '() => document.title' });
    t.ok(/Native pickers/.test(title.text), `script: ${title.text}`);
  },
};
