// Real sites (network): the export tool. YouTube transcripts from a background tab (manual captions, another
// language, auto-generated only) must leave the player paused and the tab muted; Google exports of public sample
// files (Sheets csv, Docs pdf); any other page gets an error naming what is supported.
import fs from 'node:fs';

const TED = 'https://www.youtube.com/watch?v=iG9CE55wbtY'; // manual English captions, many languages
const PSY = 'https://www.youtube.com/watch?v=9bZkp7q19f0'; // auto-generated Korean only
const SHEET = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'; // Google's API sample
const DOC = 'https://docs.google.com/document/d/195j9eDD3ccgjQRttHhJPymLJUCOUjs-jmwTrekvdjFE/edit'; // Google's API sample

const savedPath = (text) => /^Saved: (.+)$/m.exec(text)?.[1];

export default {
  name: 'export',
  real: true,
  async run(t) {
    const player = (tab) => t.eval(tab, `() => { const v = document.querySelector('video'); const p = document.querySelector('#movie_player');
      return v && p?.getPlayerState ? { paused: v.paused, time: v.currentTime, muted: p.isMuted(), subs: p.isSubtitlesOn(), ad: p.classList.contains('ad-showing') } : null; }`);
    // Agent tabs autoplay YouTube (muted): let a pre-roll ad finish (or report one that stays), then pause, so the export has to keep it paused.
    const pausedVideo = async (url) => {
      const tab = await t.open(url);
      // YouTube may resume its own autoplay or start an ad shortly after load, so pause until it stays paused.
      let last = null;
      const before = await t.until(async () => {
        const p = last = await player(tab);
        if (!p || p.ad) return null;
        if (!p.paused) { await t.call('media', { tab, action: 'pause' }); return null; }
        await new Promise((r) => setTimeout(r, 1500));
        const again = await player(tab);
        return again.paused && !again.ad && again;
      }, 'player paused without an ad', 45000).catch((e) => {
        if (!last?.ad) throw new Error(`${e.message}; player: ${JSON.stringify(last)}`);
      });
      return { tab, before };
    };
    // Without an ad blocker an ad sometimes stays: then export must say so (its request is the ad's).
    const stuckAd = async (tab) => {
      const error = await t.call('export', { tab }).then(() => null, (e) => e.message);
      t.ok(/An ad is in this video's player/.test(error ?? ''), `ad still showing after 45 s, export: ${error}`);
      await t.close(tab);
    };
    const unchanged = async (tab, before) => {
      const after = await player(tab);
      t.ok(after.paused && Math.abs(after.time - before.time) < 0.5, `player stayed paused: ${JSON.stringify({ before, after })}`);
      t.eq([after.muted, after.subs], [before.muted, before.subs], 'player mute and captions setting unchanged');
      const row = (await t.listMine()).find((x) => x.tab === tab);
      t.ok(row?.muted, `tab still muted: ${JSON.stringify(row)}`);
    };

    t.step('YouTube manual captions');
    const ted = await pausedVideo(TED);
    if (!ted.before) await stuckAd(ted.tab);
    else {
      const res = await t.call('export', { tab: ted.tab, max_chars: 2000 });
      t.ok(/^Title: Do schools kill creativity/m.test(res.text) && /^Channel: TED$/m.test(res.text) && /^Duration: 20:0\d$/m.test(res.text), `metadata: ${res.text.slice(0, 500)}`);
      t.ok(/^Language: en \(English\)$/m.test(res.text), `manual English picked: ${res.text.slice(0, 600)}`);
      const others = /^Other languages: (.*)$/m.exec(res.text)?.[1] ?? '';
      t.ok(others.includes('fr (French)') && others.includes('en (English, auto-generated)'), `other languages listed: ${others.slice(0, 300)}`);
      t.ok(/^\[\d\d:\d\d\] \S/m.test(res.text) && /\[cut at 2,000 of [\d,]+ characters/.test(res.text), 'timestamped lines, cut inline');
      const file = fs.readFileSync(savedPath(res.text), 'utf8');
      t.ok(file.length > 15000 && /^\[1\d:\d\d\] /m.test(file), `the file has the whole transcript (${file.length} chars)`);
      await unchanged(ted.tab, ted.before);

      t.step('YouTube other language');
      const fr = await t.call('export', { tab: ted.tab, language: 'fr', max_chars: 3000 });
      t.ok(/^Language: fr \(French\)$/m.test(fr.text) && /^\[\d\d:\d\d\] /m.test(fr.text), `French: ${fr.text.slice(0, 500)}`);
      await unchanged(ted.tab, ted.before);
      await t.close(ted.tab);
    }

    t.step('YouTube auto-generated only');
    const psy = await pausedVideo(PSY);
    if (!psy.before) await stuckAd(psy.tab);
    else {
      const ko = await t.call('export', { tab: psy.tab, max_chars: 1000 });
      t.ok(/^Language: ko \(Korean, auto-generated\)$/m.test(ko.text) && /^\[\d\d:\d\d\] .*강남/m.test(ko.text), `Korean auto captions: ${ko.text.slice(0, 600)}`);
      await unchanged(psy.tab, psy.before);
      await t.close(psy.tab);
    }

    t.step('Google Sheets csv and Docs pdf');
    const sheet = await t.open(SHEET);
    const csv = await t.call('export', { tab: sheet });
    t.ok(/as csv, sheet gid 0/.test(csv.text) && /^Student Name,Gender,Class Level/m.test(csv.text), `csv: ${csv.text.slice(0, 400)}`);
    t.ok(fs.readFileSync(savedPath(csv.text), 'utf8').startsWith('Student Name,'), 'csv file');
    await t.close(sheet);
    const doc = await t.open(DOC);
    const pdf = await t.call('export', { tab: doc, format: 'pdf' });
    t.ok(/as pdf \([\d,]+ KB\)/.test(pdf.text) && fs.readFileSync(savedPath(pdf.text)).subarray(0, 5).toString() === '%PDF-', `pdf: ${pdf.text}`);
    const wrong = await t.call('export', { tab: doc, format: 'xlsx' }).then(() => null, (e) => e.message);
    t.ok(/exports as md, txt, pdf, docx, html, not "xlsx"/.test(wrong ?? ''), `wrong format refused: ${wrong}`);

    t.step('other pages are refused');
    const plain = await t.open(`${t.site}/form.html`);
    const refused = await t.call('export', { tab: plain }).then(() => null, (e) => e.message);
    t.ok(/read normal pages with snapshot\. export supports YouTube videos .*Google Docs/.test(refused ?? ''), `refused: ${refused}`);
  },
};
