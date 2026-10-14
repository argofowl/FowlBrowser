// Infinite scroll in a background tab: scrolling must load more items (IntersectionObserver keeps working). The result
// says where the page landed, and on a page whose content scrolls in a box (an app shell, a phone mock-up) that box moved.
export default {
  name: 'scroll',
  async run(t) {
    const tab = await t.open(`${t.site}/scroll.html`);
    // A tall window already shows the end of the first 20, so it preloads more on its own.
    const initial = (await t.resultOf(tab)).count;
    t.ok(initial >= 20, `initial items: expected at least 20, got ${initial}`);
    t.step('scroll down');
    const r = await t.until(async () => {
      await t.call('scroll', { tab, direction: 'down', pages: 3, snapshot: false });
      const v = await t.resultOf(tab);
      return v.count >= initial + 40 && v;
    }, `at least ${initial + 40} items after scrolling`, 15000);
    t.ok(r.scrollY > 0, 'page scrolled');

    t.step('scroll a ref into view');
    const s = await t.snapshot(tab);
    await t.call('scroll', { tab, ref: t.ref(s, 'listitem', 'Item 5'), snapshot: false });
    t.ok((await t.resultOf(tab)).scrollY < r.scrollY, 'scrolled back up to item 5');

    // On a long page that doesn't grow (an infinite list at its end moves on as it loads more).
    t.step('the result says where the page landed');
    await t.call('navigate', { tab, url: `${t.site}/big.html`, snapshot: false });
    for (let i = 0; i < 3; i++) {
      const said = (await t.call('scroll', { tab, direction: 'down', snapshot: false })).text;
      const y = await t.eval(tab, '() => Math.round(scrollY)');
      t.ok(y > 0 && said.includes(`Window scroll position: x=0 y=${y} `), `scroll result names y=${y}: ${said.split('\n').at(-1)}`);
    }

    t.step('an embed from another site under the viewport centre');
    await t.call('navigate', { tab, url: `${t.site}/embed.html`, snapshot: false });
    const over = (await t.call('scroll', { tab, direction: 'down', snapshot: false })).text;
    const below = await t.eval(tab, '() => Math.round(scrollY)');
    t.ok(below > 0 ? over.includes(`Scrolled down 1 page. Window scroll position: x=0 y=${below} `) : /over an iframe \(<iframe#embed>\): the window did not move/.test(over),
      `scroll over the embed names what moved (window at y=${below}): ${over.split('\n').at(-1)}`);

    for (const query of ['', '?phone']) {
      t.step(`content that scrolls in a box${query}`);
      await t.call('navigate', { tab, url: `${t.site}/inner-scroll.html${query}`, snapshot: false });
      for (let i = 0; i < 2; i++) {
        const said = (await t.call('scroll', { tab, direction: 'down', snapshot: false })).text;
        const top = await t.eval(tab, '() => Math.round(document.getElementById("content").scrollTop)');
        t.ok(top > 0 && said.includes(`Scrolled the box under the viewport centre (<main#content>) down 1 page: scrollTop ${top} of `),
          `scroll result names the box at scrollTop ${top}: ${said.split('\n').at(-1)}`);
      }
    }
  },
};
