// download by url and by clicking (same tab, download attribute, target=_blank), downloads lists them, and
// another client of the same browser never sees them. Removes the files it made.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { HostClient, SOCKET_DIR } from '../../mcp/src/hostClient.mjs';

const BODY = 'FowlBrowser download test file.\n';
const pathIn = (text) => /^Download #\d+ · complete · (\/.+?) · /m.exec(text)?.[1];

export default {
  name: 'downloads',
  async run(t) {
    const name = `fb-${t.tag}.txt`;
    const files = [];
    try {
      const tab = await t.open(`${t.site}/download.html?name=${name}`);

      t.step('download url');
      const byUrl = await t.call('download', { tab, url: `${t.site}/download.txt?attachment=url-${name}` });
      const urlFile = pathIn(byUrl.text);
      t.ok(urlFile, `url download complete with a path: ${byUrl.text.slice(0, 300)}`);
      files.push(urlFile);
      t.eq(path.basename(urlFile), `url-${name}`, 'url download file name');
      t.eq(await readFile(urlFile, 'utf8'), BODY, 'url download content');
      t.ok(byUrl.text.includes(`${BODY.length} B`), `url download size: ${byUrl.text}`);

      const s = await t.snapshot(tab);
      for (const [link, expected] of [['Download report', name], ['Save with download attribute', `anchor-${name}`],
        ['Download in a new tab', `blank-${name}`]]) {
        t.step(`download ref "${link}"`);
        const res = await t.call('download', { tab, ref: t.ref(s, 'link', link) });
        const file = pathIn(res.text);
        t.ok(file, `click download complete with a path: ${res.text.slice(0, 300)}`);
        files.push(file);
        t.eq(path.basename(file), expected, 'click download file name');
        t.eq(await readFile(file, 'utf8'), BODY, 'click download content');
      }

      t.step('downloads list');
      const list = await t.call('downloads', { browser: t.browser });
      for (const file of files) t.ok(list.text.includes(file), `downloads lists ${file}: ${list.text.slice(0, 600)}`);

      t.step('another client sees none of them');
      const other = new HostClient(path.join(SOCKET_DIR, `${t.browser}.sock`));
      await other.connect(`other-${t.tag}`);
      try {
        const seen = (await other.request('downloads.list', {})).map((d) => d.filename);
        t.eq(seen.filter((f) => files.includes(f)), [], 'downloads of another client');
        const refused = await other.request('downloads.start', { tabId: Number(tab.split(':')[1]), url: `${t.site}/download.txt` })
          .then(() => 'started', (e) => e.message);
        t.ok(/controlled by another agent session/.test(refused), `downloads.start on a tab it does not own: ${refused}`);
      } finally {
        other.close();
      }
    } finally {
      for (const file of files) await rm(file, { force: true });
    }
  },
};
