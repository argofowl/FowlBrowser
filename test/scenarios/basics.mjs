// browser_list, tab_list, snapshot, screenshot (CSS pixel scale), console and network on our own tab.
export default {
  name: 'basics',
  async run(t) {
    t.step('browser_list');
    const browsers = await t.call('browser_list');
    t.ok(browsers.text.includes(t.browser), `browser_list names ${t.browser}: ${browsers.text.slice(0, 200)}`);

    const tab = await t.open(`${t.site}/index.html`);
    t.step('tab_list mine');
    const mine = await t.listMine();
    const entry = mine.find(x => x.tab === tab);
    t.ok(entry, `opened tab ${tab} listed as mine`);
    t.eq(entry.active, false, 'agent tab opened in the background');

    t.step('snapshot');
    const s = await t.snapshot(tab);
    t.ok(/heading "FowlBrowser test site"/.test(s), 'heading in snapshot');
    t.ok(/link "Form"/.test(s), 'link in snapshot');

    t.step('screenshot');
    const shot = await t.call('screenshot', { tab });
    t.eq(shot.images.length, 1, 'one image');
    t.eq(shot.images[0].mimeType, 'image/jpeg', 'jpeg');
    const width = jpegWidth(Buffer.from(shot.images[0].data, 'base64'));
    const cssWidth = await t.eval(tab, '() => innerWidth');
    t.eq(width, cssWidth, 'screenshot width equals CSS viewport width');

    t.step('console');
    const con = await t.call('console', { tab });
    t.ok(con.text.includes('fowlbrowser index loaded'), `console has page log: ${con.text.slice(0, 200)}`);

    t.step('network');
    const net = await t.call('network', { tab, filter: 'style.css' });
    t.ok(net.text.includes('style.css'), `network lists style.css: ${net.text.slice(0, 200)}`);

    // A page taller than the browser can capture in one go (16,384 px) is cut, not a capture that never finishes.
    t.step('full-page screenshot of a 34,000 px page');
    await t.call('navigate', { tab, url: `${t.site}/big.html`, snapshot: false });
    const tall = await t.call('screenshot', { tab, full_page: true });
    t.eq(jpegWidth(Buffer.from(tall.images[0].data, 'base64'), 5), 16000, 'image height');
    t.ok(/full page, cut to its first [\d,]+x16,000 px of [\d,]+x3\d,\d{3}/.test(tall.text), `says it is cut: ${tall.text.split('\n')[1]}`);
    t.step('screenshot of an element over 16,000 px tall');
    const main = await t.refOf(tab, 'main');
    const element = await t.call('screenshot', { tab, ref: main });
    t.eq(jpegWidth(Buffer.from(element.images[0].data, 'base64'), 5), 16000, 'element image height');
    t.ok(new RegExp(`element ${main}, cut to its first [\\d,]+x16,000 px of`).test(element.text), `says it is cut: ${element.text.split('\n')[1]}`);
  },
};

// Reads the width (or, at 5, the height) from a JPEG SOF marker.
function jpegWidth(buf, at = 7) {
  for (let i = 2; i < buf.length;) {
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return buf.readUInt16BE(i + at);
    i += 2 + len;
  }
  return -1;
}
