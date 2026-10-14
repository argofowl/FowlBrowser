// frames: screenshots taken while an action's effect plays out, in a background agent tab: a CSS transition after a
// click, a requestAnimationFrame animation, a hover lift, and a running animation through the screenshot tool. Frames
// of something moving differ from each other; the last ones of a settled page match.
export default {
  name: 'motion',
  async run(t) {
    const tab = await t.open(`${t.site}/motion.html`);
    const s = await t.snapshot(tab);
    const distinct = (images) => new Set(images.map((i) => i.data)).size;

    t.step('a click with frames: the CSS transition in motion');
    const slide = await t.call('click', { tab, ref: t.ref(s, 'button', 'Slide'), frames: 5, frame_ms: 120, snapshot: false });
    t.ok(/5 frames from the action's first input to the page, at \+\d+(, \+\d+){4} ms/.test(slide.text), `frames line: ${slide.text}`);
    t.eq(slide.images.length, 5, 'five images');
    t.ok(distinct(slide.images.slice(0, 4)) >= 3, `the first frames differ (it moves): ${distinct(slide.images)} distinct`);

    t.step('a requestAnimationFrame animation moves between frames too (the tab is in the background)');
    const run = await t.call('click', { tab, ref: t.ref(s, 'button', 'Run bar'), frames: 4, frame_ms: 150, snapshot: false });
    t.ok(distinct(run.images) >= 3, `rAF frames differ: ${distinct(run.images)} distinct`);

    t.step('hover with frames: the lift');
    const at = await t.eval(tab, '() => { const r = document.getElementById("lift").getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }');
    const lift = await t.call('hover', { tab, x: at[0], y: at[1], frames: 3, frame_ms: 150, snapshot: false });
    t.eq(lift.images.length, 3, 'three images');

    t.step('screenshot frames of a running animation');
    await t.call('click', { tab, ref: t.ref(s, 'button', 'Show spinner'), snapshot: false });
    const shots = await t.call('screenshot', { tab, frames: 3, frame_ms: 200 });
    t.ok(/3 screenshots of the viewport at \+\d+, \+\d+, \+\d+ ms/.test(shots.text), shots.text);
    t.ok(distinct(shots.images) >= 2, 'the spinner turns between them');
    const full = await t.call('screenshot', { tab, frames: 2, full_page: true }).then((r) => `no error: ${r.text}`, (e) => e.message);
    t.ok(/not of the full page/.test(full), full);
  },
};
