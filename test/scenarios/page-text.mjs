// snapshot mode "text" on a page that loads itself again (a "Just a moment..." challenge): read while the new document
// is still in its <head>, before it has a body, it waits for the body instead of failing.
export default {
  name: 'page-text',
  async run(t) {
    const tab = await t.open(`${t.site}/challenge.html`, { snapshot: false });
    t.step('text while the reloaded document has no body yet');
    const texts = [];
    const end = Date.now() + 4000;
    while (Date.now() < end && !texts.at(-1)?.includes('Welcome back')) {
      texts.push((await t.call('snapshot', { tab, mode: 'text' })).text); // a failure throws: the bug
    }
    t.ok(texts.at(-1).includes('Text of <body>') && texts.at(-1).includes('Welcome back'), `text of the new document: ${texts.at(-1)}`);
  },
};
