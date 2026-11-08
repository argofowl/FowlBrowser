// Small helpers shared by the server's modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hidden files and folders (~/.ssh, ~/.aws, .env, ~/.config), ~/Library and system configuration (on Linux also /proc,
// /sys and system state): where keys, passwords and app data live. Never uploaded, opened or read in a tab (uploads
// already send a file's bytes to a page, so viewing the same files opens no new way out). iCloud Drive and the cloud
// drives (Dropbox, Google Drive, OneDrive) live in ~/Library too and stay allowed. `real`: a path already resolved
// (natively, so "~/library" is ~/Library too).
// Why it is refused, or null.
const DATA_VOLUME = '/System/Volumes/Data/';
// The Data volume's firmlinks name the same folders: /System/Volumes/Data/Users/me/Downloads is /Users/me/Downloads.
const unalias = (real) => (real.startsWith(DATA_VOLUME) ? real.slice(DATA_VOLUME.length - 1) : real);
export function localFileRefusal(real, home = os.homedir()) {
  const library = path.join(unalias(fs.realpathSync.native(home)), 'Library');
  const refusedDirs = [library, '/etc', '/private/etc', '/System', '/private/var/db', '/Library/Keychains', '/private/var/log',
    // Linux: the kernel's views of processes and devices (/proc/self/environ holds this session's environment), runtime
    // state, boot files, root's home and system state and logs.
    '/proc', '/sys', '/run', '/boot', '/root', '/var/lib', '/var/log'];
  // Allowed inside those: cloud drives in ~/Library, and removable drives some Linux systems mount in /run/media.
  const cloudDirs = [path.join(library, 'Mobile Documents'), path.join(library, 'CloudStorage'), '/run/media'];
  const inside = (r, d) => r === d || r.startsWith(d + path.sep);
  real = unalias(real);
  const dir = cloudDirs.some((d) => inside(real, d)) ? null : refusedDirs.find((d) => inside(real, d));
  return real.split(path.sep).some((part) => part.startsWith('.')) ? 'it is hidden (a file or folder name starts with ".")'
    : dir ? `it is inside ${dir}` : null;
}

// Linux systems that give each user a group of their own (Debian, Ubuntu, Fedora...) create the user's folders
// group-writable (umask 002). That write bit lets no other account in when the group really is private: it is the user's
// primary group, no other account is a member (getent, so directory services count too) and none has it as its own
// primary group. Its gid, else null (macOS, a shared group, or anything that can't be read). Read once per process.
let privateGid;
export function userPrivateGid() {
  if (privateGid !== undefined) return privateGid;
  privateGid = null;
  if (process.platform !== 'linux') return privateGid;
  try {
    const getent = (...args) => execFileSync('getent', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    const gid = process.getgid();
    const user = os.userInfo().username;
    const group = getent('group', String(gid)).trim().split(':');
    if (Number(group[2]) !== gid || (group[3] ?? '').split(',').some((member) => member && member !== user)) return privateGid;
    const shared = getent('passwd').split('\n').map((line) => line.split(':'))
      .some((fields) => fields.length > 3 && fields[0] !== user && Number(fields[3]) === gid);
    if (!shared) privateGid = gid;
  } catch {}
  return privateGid;
}

// Does the folder carry an access control list (ls marks it with "+")? Its entries can let other accounts write whatever
// the mode bits say. Unreadable counts as yes, and so does an ls that never shows the mark (BusyBox, which also has no
// --version; GNU and uutils coreutils have both).
let lsShowsAcls;
export function hasAcl(dir) {
  const run = (args) => execFileSync('ls', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
  try {
    lsShowsAcls ??= /coreutils/i.test(run(['--version']));
    return !lsShowsAcls || /^\S+\+/.test(run(['-ld', '--', dir]));
  } catch { return true; }
}

// Does the file carry macOS's quarantine mark (com.apple.quarantine: set by browsers, Archive Utility and AirDrop on what
// came from the web or another machine)? fs has no xattr API, so /usr/bin/xattr answers (exit 0: it has it), ~1.4 ms a
// call; the answer is kept per file until its ctime changes (adding or removing the mark changes it).
const quarantine = new Map(); // real path -> { ctimeMs, marked }
function quarantined(real, stat) {
  const known = quarantine.get(real);
  if (known?.ctimeMs === stat.ctimeMs) return known.marked;
  let marked = true;
  try {
    execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', real], { stdio: 'ignore' });
  } catch {
    marked = false;
  }
  quarantine.set(real, { ctimeMs: stat.ctimeMs, marked });
  return marked;
}

// A file: URL agents may not open or read, and why (null for one they may, undefined for any other URL): it must name,
// with no host, an existing regular file (no folder listings) that localFileRefusal allows, resolved now, so a symlink
// in ~/Downloads to ~/.ssh is refused too, and that wasn't downloaded (a page from the web has its site; opened as a
// file it could read other local files). Query and hash don't matter. Parsed as the browser parses it ("fi\tle:" is file: too).
// document: false for an image, script, font or other subresource, which only a document makes anything of: then a
// downloaded file is fine (its page could not read other files with it).
export function localFileBlock(url, home = os.homedir(), { document = true } = {}) {
  const parsed = URL.parse(url ?? '');
  if (parsed?.protocol !== 'file:') return undefined;
  if (parsed.host) return `it is on another computer (${parsed.host})`;
  let real;
  try {
    real = fs.realpathSync.native(decodeURIComponent(parsed.pathname));
  } catch {
    return 'there is no such file';
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) return 'it is a folder, not a file (folder listings aren\'t opened)';
  return localFileRefusal(real, home) ?? (document && quarantined(real, stat) ? 'it was downloaded from the web (macOS quarantine); open it from its site instead' : null);
}

// A page nothing of which is kept or read: view-source:, or a local file agents may not open (localFileBlock).
export const isBlockedUrl = (url) => URL.parse(url ?? '')?.protocol === 'view-source:' || !!localFileBlock(url);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The promise's value, or `fallback` when it fails or takes longer than ms (the timer is cleared either way).
export function within(promise, ms, fallback) {
  let timer;
  return Promise.race([promise.catch(() => fallback), new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })])
    .finally(() => clearTimeout(timer));
}

// One tab as tabs.listAll describes it (owner, origin, kept, handedOver, parked, windowId, active...), null when it is
// gone; asked for alone (extension tabs.info), from the whole list only on an older extension.
export async function tabInfo(browser, tabId) {
  return browser.host.request('tabs.info', { tabId }).catch(async (error) => {
    if (!/unknown method/i.test(error.message)) throw error;
    return (await browser.host.request('tabs.listAll', {})).find((t) => t.id === tabId) ?? null;
  });
}
