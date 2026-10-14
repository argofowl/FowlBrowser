// The export tool: a YouTube video's transcript, or a Google Docs/Sheets/Slides/Drawings file through its export URL.
// Everything is fetched inside the page, so it runs with the user's session and their page origin, in the background tab.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { debug } from './debug.mjs';
import { privateDir } from './perf.mjs';

export const EXPORT_DIR = path.join(os.tmpdir(), 'fowlbrowser-exports');
const DEFAULT_MAX_CHARS = 20_000;
const PAGE_TIMEOUT_MS = 60_000;

const GOOGLE = {
  document: { label: 'Google Doc', formats: ['md', 'txt', 'pdf', 'docx', 'html'] },
  spreadsheets: { label: 'Google Sheet', formats: ['csv', 'xlsx', 'pdf'] },
  presentation: { label: 'Google Slides deck', formats: ['txt', 'pdf', 'pptx'] },
  drawings: { label: 'Google Drawing', formats: ['png', 'svg', 'pdf', 'jpg'] },
};
const TEXT_FORMATS = new Set(['md', 'txt', 'html', 'csv']); // returned inline as well as saved

export const SUPPORTED = 'YouTube videos (watch, Shorts or live pages: transcript), Google Docs (md, txt, pdf, docx, html), ' +
  'Google Sheets (csv of the visible sheet, xlsx, pdf), Google Slides (txt, pdf, pptx) and Google Drawings (png, svg, pdf, jpg)';

export const EXPORT_DESCRIPTION =
  'Export the content of a special page in a tab: a YouTube video\'s transcript (timestamped "[mm:ss] text" lines plus title, channel, ' +
  'duration and caption language; never starts or unmutes playback), or a Google Docs, Sheets, Slides or Drawings file through Google\'s ' +
  'export with the user\'s login. Text formats come back inline (cut at max_chars) and every export is saved to a file whose path is returned. ' +
  `Supported: ${SUPPORTED}. For any other page use snapshot.`;

export const exportShape = (tabArg) => ({
  tab: tabArg,
  format: z.string().optional().describe('Docs: md (default), txt, pdf, docx, html. Sheets: csv (default, the visible sheet), xlsx, pdf. ' +
    'Slides: txt (default), pdf, pptx. Drawings: png (default), svg, pdf, jpg. YouTube: txt only.'),
  language: z.string().optional().describe('YouTube: caption language code or name, e.g. "de" or "German" (default: page language, then English, then the video\'s own).'),
  // At most 40,000: with its header that stays under the 50,000 characters Claude Code takes without counting.
  max_chars: z.number().int().positive().max(40_000).optional().describe(`Most characters returned inline (default ${DEFAULT_MAX_CHARS}, at most 40000); the file always has everything.`),
});

// --- Page kinds ---

export function classify(href) {
  let url;
  try { url = new URL(href); } catch { return null; }
  if (/^(www\.|m\.)?youtube\.com$/.test(url.hostname)) {
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|live)\/([\w-]{11})/.exec(url.pathname)?.[1];
    return id && /^[\w-]{11}$/.test(id) ? { kind: 'youtube', videoId: id } : null;
  }
  if (url.hostname === 'docs.google.com') {
    // /document/d/<id>/edit, also with an account prefix: /document/u/1/d/<id>/edit
    const m = /^\/(document|spreadsheets|presentation|drawings)(\/u\/\d+)?\/d\/([\w-]{20,})/.exec(url.pathname);
    if (!m) return null;
    const gid = /(?:^|[#&?])gid=(\d+)/.exec(url.hash)?.[1] ?? url.searchParams.get('gid');
    return { kind: 'google', app: m[1], account: m[2] ?? '', id: m[3], gid, resourceKey: url.searchParams.get('resourcekey') };
  }
  return null;
}

export function googleExportUrl({ app, account, id, gid, resourceKey }, format) {
  const base = `https://docs.google.com/${app}${account}/d/${id}`;
  const url = new URL(app === 'drawings' ? `${base}/export/${format}` : `${base}/export`);
  if (app !== 'drawings') url.searchParams.set('format', format);
  if (app === 'spreadsheets' && gid != null) url.searchParams.set('gid', gid);
  if (resourceKey) url.searchParams.set('resourcekey', resourceKey);
  return url.href;
}

// --- YouTube transcript ---

// json3 caption events: {tStartMs, segs:[{utf8}]}; auto-generated tracks add events that only hold a line break.
export function parseJson3(json) {
  const lines = [];
  for (const event of json?.events ?? []) {
    if (!Array.isArray(event.segs) || !Number.isFinite(event.tStartMs)) continue;
    const text = event.segs.map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
    if (text) lines.push({ startMs: event.tStartMs, text });
  }
  return lines;
}

export function timestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${String(m).padStart(2, '0')}:${s}`;
}

const baseLanguage = (code) => String(code ?? '').toLowerCase().split(/[-_]/)[0];
const trackLabel = (t) => `${t.languageCode} (${t.kind === 'asr' ? `${t.name.replace(/\s*\(auto-generated\)\s*$/i, '')}, auto-generated` : t.name})`;

// The track to export: the asked language, else the page language, then English, then the language the video is spoken
// in (its auto-generated track), then the player's default. Within a language a manual track beats an auto-generated one.
export function pickTrack(tracks, { language, pageLanguage, defaultIndex } = {}) {
  if (!tracks.length) return null;
  const inLanguage = (wanted) => {
    const want = String(wanted).toLowerCase();
    const matches = tracks.filter((t) => t.languageCode.toLowerCase() === want || t.name.toLowerCase().replace(/\s*\(auto-generated\)\s*$/, '') === want)
      .concat(tracks.filter((t) => baseLanguage(t.languageCode) === baseLanguage(want)));
    return matches.find((t) => t.kind !== 'asr') ?? matches[0] ?? null;
  };
  if (language) {
    const asked = inLanguage(language);
    if (!asked) throw new Error(`No "${language}" captions. Available: ${tracks.map(trackLabel).join(', ')}.`);
    return asked;
  }
  const spoken = tracks.find((t) => t.kind === 'asr')?.languageCode;
  for (const wanted of [pageLanguage, 'en', spoken]) {
    const found = wanted && inLanguage(wanted);
    if (found) return found;
  }
  return tracks[defaultIndex] ?? tracks.find((t) => t.kind !== 'asr') ?? tracks[0];
}

export function transcriptText(info, track, lines) {
  const others = info.tracks.filter((t) => t !== track).map(trackLabel);
  return [
    `Title: ${info.title}`,
    `Channel: ${info.channel}`,
    `Duration: ${timestamp(info.seconds * 1000)}`,
    `Language: ${trackLabel(track)}`,
    `Other languages: ${others.length ? `${others.join(', ')} (pass language to export one)` : 'none'}`,
    `URL: https://www.youtube.com/watch?v=${info.videoId}`,
    '',
    ...lines.map((l) => `[${timestamp(l.startMs)}] ${l.text}`),
  ].join('\n');
}

// Runs in the page: the video's metadata and caption tracks, from the player that shows this video (Shorts and
// in-page navigations included), waiting for it to appear.
const YT_INFO_FN = async (videoId) => {
  for (let tries = 0; tries < 50; tries++) {
    const player = [...document.querySelectorAll('#movie_player, #shorts-player')].find((p) => p.getVideoData?.()?.video_id === videoId);
    let response = player?.getPlayerResponse?.();
    if (response?.videoDetails?.videoId !== videoId) response = window.ytInitialPlayerResponse;
    if (response?.videoDetails?.videoId === videoId) {
      const list = response.captions?.playerCaptionsTracklistRenderer;
      const details = response.videoDetails;
      return {
        videoId, title: details.title, channel: details.author, seconds: Number(details.lengthSeconds) || 0,
        pageLanguage: document.documentElement.lang || null,
        defaultIndex: list?.audioTracks?.[list.defaultAudioTrackIndex ?? 0]?.defaultCaptionTrackIndex ?? null,
        tracks: (list?.captionTracks ?? []).map((t) => ({
          baseUrl: t.baseUrl, languageCode: t.languageCode, kind: t.kind ?? null,
          name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? t.languageCode,
        })),
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};

// Runs in the page. YouTube answers a caption URL from the player response with an empty body unless it carries the
// proof-of-origin token (pot) the player adds, and that token is bound to the video. So we turn the player's captions
// on (never play, never unmute), read the URL of the request it makes, put the captions back as they were, and fetch
// the wanted track with the player's extra parameters. While an ad holds the player its requests are for the ad.
const YT_CAPTIONS_FN = async ({ videoId, baseUrl }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const player = [...document.querySelectorAll('#movie_player, #shorts-player')].find((p) => p.getVideoData?.()?.video_id === videoId);
  if (typeof player?.toggleSubtitlesOn !== 'function') return { error: 'This page has no YouTube player for the video. Reload the page and try again.' };
  if (player.classList.contains('ad-showing')) {
    return { error: 'An ad is in this video\'s player, and YouTube serves the video\'s captions only to its player. Call export again once the ad is over (media status shows the player state).' };
  }
  const ours = (name) => {
    try {
      const u = new URL(name);
      return u.pathname === '/api/timedtext' && u.searchParams.get('v') === videoId && u.searchParams.has('pot');
    } catch { return false; }
  };
  let found = null;
  const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (ours(e.name)) found = e.name; });
  observer.observe({ type: 'resource', buffered: true });
  await sleep(50);
  const was = player.isSubtitlesOn();
  try {
    // Right after load the player asks without a token (its attestation isn't ready yet; the reply is empty),
    // so captions go off and on again until a request carries one. Each switch-on makes a new request.
    for (const deadline = Date.now() + 20000; !found && Date.now() < deadline;) {
      if (player.isSubtitlesOn()) player.toggleSubtitles();
      player.toggleSubtitlesOn();
      for (const end = Math.min(deadline, Date.now() + 2500); !found && Date.now() < end;) await sleep(150);
    }
  } finally {
    observer.disconnect();
    if (player.isSubtitlesOn() !== was) player.toggleSubtitles();
  }
  if (!found) return { error: 'YouTube\'s player made no caption request with its token within 20 s. Reload the page and try again.' };
  const target = new URL(baseUrl, location.href);
  for (const [key, value] of new URL(found).searchParams) {
    if (!['lang', 'kind', 'name', 'tlang', 'fmt'].includes(key) && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  target.searchParams.set('fmt', 'json3');
  const response = await fetch(target, { credentials: 'include' });
  return { status: response.status, body: await response.text() };
};

async function inPage(tab, fn, arg) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`The page did not answer within ${PAGE_TIMEOUT_MS / 1000} s.`)), PAGE_TIMEOUT_MS); });
  const run = tab.page.evaluate(fn, arg);
  run.catch(() => {});
  return Promise.race([run, expired]).finally(() => clearTimeout(timer));
}

async function exportYouTube(tab, { videoId }, { format = 'txt', language }) {
  if (format !== 'txt') throw new Error(`YouTube transcripts export as txt only, not "${format}".`);
  const info = await inPage(tab, YT_INFO_FN, videoId);
  if (!info) throw new Error('YouTube\'s player data for this video is not on the page yet. Wait for the page to load (or reload it) and try again.');
  const track = pickTrack(info.tracks, { language, pageLanguage: info.pageLanguage, defaultIndex: info.defaultIndex });
  if (!track) throw new Error(`"${info.title}" has no captions or transcript.`);
  const result = await inPage(tab, YT_CAPTIONS_FN, { videoId, baseUrl: track.baseUrl });
  if (result.error) throw new Error(result.error);
  debug('export youtube', videoId, track.languageCode, track.kind, 'HTTP', result.status, result.body.length, 'bytes');
  let lines = [];
  try { lines = parseJson3(JSON.parse(result.body)); } catch {}
  if (!lines.length) throw new Error(`YouTube returned no caption text for ${trackLabel(track)} (HTTP ${result.status}, ${result.body.length} bytes).`);
  const body = transcriptText(info, track, lines);
  return { what: `YouTube transcript of "${info.title}"`, name: `${info.title}-${videoId}`, ext: 'txt', text: body };
}

// Loads a URL the way the tab's own frame would (its cookies, so the user's Google session), through Chrome's
// Network.loadNetworkResource. A fetch() in the page can't do it: Google redirects most exports to
// googleusercontent.com, which CORS hides from docs.google.com scripts.
async function loadInFrame(tab, url) {
  const send = (method, params) => tab.browser.host.request('chrome.debugger.sendCommand', [{ tabId: tab.tabId }, method, params]);
  const { frameTree } = await send('Page.getFrameTree');
  const { resource } = await send('Network.loadNetworkResource', { frameId: frameTree.frame.id, url, options: { disableCache: true, includeCredentials: true } });
  const type = Object.entries(resource.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '';
  if (!resource.success || !resource.stream) return { status: resource.httpStatusCode ?? 0, type, error: resource.netErrorName };
  const parts = [];
  try {
    for (;;) {
      const chunk = await send('IO.read', { handle: resource.stream, size: 1 << 20 });
      parts.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      if (chunk.eof) break;
    }
  } finally {
    await send('IO.close', { handle: resource.stream }).catch(() => {});
  }
  return { status: resource.httpStatusCode, type, data: Buffer.concat(parts) };
}

async function exportGoogle(tab, doc, { format }) {
  const kind = GOOGLE[doc.app];
  format = (format ?? kind.formats[0]).toLowerCase();
  if (!kind.formats.includes(format)) throw new Error(`A ${kind.label} exports as ${kind.formats.join(', ')}, not "${format}".`);
  const url = googleExportUrl(doc, format);
  const result = await loadInFrame(tab, url);
  // Without access Google answers with its sign-in or error page instead of the file.
  if (result.status !== 200 || (format !== 'html' && /text\/html/i.test(result.type))) {
    throw new Error(`Google did not return the ${format} export (HTTP ${result.status}${result.error ? ` ${result.error}` : ''}, ${result.type || 'no content type'}). ` +
      'the user may lack access in this browser\'s Google account, or the owner disabled downloads.');
  }
  const title = (await tab.currentTitle()).replace(/\s+-\s+Google (Docs|Sheets|Slides|Drawings)$/i, '') || doc.id;
  const sheet = doc.app === 'spreadsheets' && format === 'csv' ? `, sheet gid ${doc.gid ?? '0 (first)'}` : '';
  const what = `${kind.label} "${title}" as ${format}${sheet}`;
  const name = `${title}-${doc.id.slice(0, 8)}${sheet ? `-gid${doc.gid ?? 0}` : ''}`;
  return TEXT_FORMATS.has(format) ? { what, name, ext: format, text: result.data.toString('utf8').replace(/^\uFEFF/, '') } : { what, name, ext: format, data: result.data };
}

export const fileName = (name, ext) => `${name.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80) || 'export'}.${ext}`;

export function inline(text, max) {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n... [cut at ${max.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters; the file has all of it]`;
}

// Returns the lines of the tool result (after the Browser/Tab header).
export async function exportTab(tab, args) {
  if (tab.dialog) throw new Error('A dialog is open on this tab; resolve it with the dialog tool first.');
  const page = classify(tab.page.url());
  if (!page) throw new Error(`Nothing to export here: read normal pages with snapshot. export supports ${SUPPORTED}.`);
  const result = page.kind === 'youtube' ? await exportYouTube(tab, page, args) : await exportGoogle(tab, page, args);
  // A folder per export, so no other export (another language, another session) ever overwrites a returned file.
  privateDir(EXPORT_DIR);
  const file = path.join(await fs.mkdtemp(path.join(EXPORT_DIR, 'export-')), fileName(result.name, result.ext));
  await fs.writeFile(file, result.text ?? result.data);
  if (result.data) return `Exported ${result.what} (${Math.ceil(result.data.length / 1024).toLocaleString('en-US')} KB).\nSaved: ${file}`;
  return `Exported ${result.what} (${result.text.length.toLocaleString('en-US')} characters).\nSaved: ${file}\n\n${inline(result.text, args.max_chars ?? DEFAULT_MAX_CHARS)}`;
}
