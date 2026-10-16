// What an agent may open and upload from this Mac: web pages and local files, but never hidden files, ~/Library or
// system configuration (also not through a symlink); no uploads of devices, pipes or sockets either.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { dropPayload, refuseNonWeb, uploadPaths } from '../src/tools.mjs';
import { isBlockedUrl, localFileBlock } from '../src/util.mjs';

test('refused local files and view-source: URLs are refused however they are written; web URLs pass', () => {
  for (const url of ['file:///Users/me/.ssh/id_ed25519', 'fi\tle:///etc/passwd', 'fi\nle:///etc/passwd', '\u0001file:///etc/passwd',
    ' FILE:///etc/passwd', 'file:///private/etc/hosts', 'view-source:file:///etc/passwd', 'view-source:https://example.com/']) {
    assert.throws(() => refuseNonWeb(url), /local file that can't be opened|view-source/, JSON.stringify(url));
  }
  for (const url of [undefined, 'about:blank', 'https://example.com/file:///x', 'http://localhost:3000/']) assert.equal(refuseNonWeb(url), url);
});

test('only web pages open: extension, browser and app URLs are refused however they are written', () => {
  for (const url of ['chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/popup.html', ' CHROME-EXTENSION://abc/x.html', 'chrome://settings',
    'chr\tome://settings/passwords', 'devtools://devtools/bundled/inspector.html', 'javascript:alert(1)', 'java\nscript:alert(1)', '\u0001JavaScript:alert(1)',
    'blob:https://example.com/0f3c', 'filesystem:https://example.com/temporary/x', 'mailto:x@example.com', 'slack://open', 'about:settings',
    'about:blankx', 'localhost:3000', 'example.com']) {
    assert.throws(() => refuseNonWeb(url), /can't be opened: agents open web pages \(http:, https:, about:blank and data: URLs\) and local files \(file: URLs\) only/, JSON.stringify(url));
  }
  assert.throws(() => refuseNonWeb('javascript:alert(1)'), /use evaluate/);
  assert.throws(() => refuseNonWeb('example.com'), /Pass a full address/);
  for (const url of ['https://example.com/', ' HTTP://example.com', 'about:blank#top', 'data:text/html,<p>hi</p>', 'http://192.168.1.10:8080/']) {
    assert.equal(refuseNonWeb(url), url);
  }
});

// One rule, resolved now: a symlink in an allowed folder to a hidden file is refused, query and hash don't matter, and
// iCloud Drive and the cloud drives in ~/Library open (a stand-in home here).
test('local files open under the upload rule: hidden, ~/Library, folders and missing files are refused, also through a symlink', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-open-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const proto = path.join(home, 'Downloads', 'proto x');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  for (const folder of [proto, icloud, path.join(home, '.ssh'), path.join(home, 'Library', 'Application Support')]) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(proto, 'proto.html'), '<p>A</p>');
  fs.writeFileSync(path.join(icloud, 'notes.html'), 'x');
  fs.writeFileSync(path.join(home, '.ssh', 'id.html'), 'key');
  fs.writeFileSync(path.join(home, 'Library', 'Application Support', 'state.html'), 'x');
  fs.symlinkSync(path.join(home, '.ssh', 'id.html'), path.join(proto, 'link.html'));
  const url = (p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`;

  for (const ok of [url(path.join(proto, 'proto.html')) + '?variant=A#top', url(path.join(icloud, 'notes.html'))]) {
    assert.equal(localFileBlock(ok, home), null, ok);
    assert.equal(refuseNonWeb(ok, home), ok);
  }
  for (const [p, why] of [[path.join(home, '.ssh', 'id.html'), /it is hidden/], [path.join(proto, 'link.html'), /it is hidden/],
    [path.join(home, 'Library', 'Application Support', 'state.html'), /it is inside .*\/Library/], [proto, /it is a folder/],
    [path.join(proto, 'gone.html'), /there is no such file/]]) {
    assert.match(localFileBlock(url(p), home), why, p);
    assert.throws(() => refuseNonWeb(url(p), home), new RegExp(`is a local file that can't be opened: ${why.source}.*hidden folders, ~/Library`), p);
  }
  assert.match(localFileBlock('file://server/share/a.html', home), /another computer/);
  assert.equal(localFileBlock('https://example.com/a.html', home), undefined);
  // What nothing is kept of: refused local files and view-source:, not web pages or allowed files.
  assert.equal(isBlockedUrl(url(path.join(home, '.ssh', 'id.html'))), true);
  assert.equal(isBlockedUrl('view-source:https://example.com/'), true);
  assert.equal(isBlockedUrl(url(path.join(proto, 'proto.html'))), false);
  assert.equal(isBlockedUrl('https://example.com/'), false);
});

test('a downloaded file (macOS quarantine mark) is not opened, also through a symlink; once the mark is gone it is', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-quarantine-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'proto.html');
  fs.writeFileSync(file, '<p>A</p>');
  fs.symlinkSync(file, path.join(dir, 'link.html'));
  const url = `file://${file}`;
  assert.equal(localFileBlock(url), null); // read once, so the answer is cached before the mark comes
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Chrome;', file]);
  for (const u of [url, `file://${path.join(dir, 'link.html')}`]) {
    assert.match(localFileBlock(u), /it was downloaded from the web \(macOS quarantine\); open it from its site instead/, u);
    assert.throws(() => refuseNonWeb(u), /is a local file that can't be opened: it was downloaded from the web/, u);
  }
  // Uploads send a file's bytes to a page anyway: a downloaded file still uploads.
  assert.deepEqual(uploadPaths([file]), [file]);
  execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', file]);
  assert.equal(localFileBlock(url), null);
});

test('uploads refuse hidden files and folders, ~/Library and system folders, also through a symlink', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-upload-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ok = path.join(dir, 'report.pdf');
  fs.writeFileSync(ok, 'x');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'id_ed25519'), 'key');
  fs.symlinkSync(path.join(dir, '.ssh', 'id_ed25519'), path.join(dir, 'photo.jpg'));
  fs.symlinkSync('/etc/hosts', path.join(dir, 'hosts.txt'));

  assert.deepEqual(uploadPaths([ok, path.join(dir, '..', path.basename(dir), 'report.pdf')]), [ok, ok]);
  for (const p of ['.env', '.ssh/id_ed25519', 'photo.jpg']) {
    assert.throws(() => uploadPaths([ok, path.join(dir, p)]), /can't be uploaded: it is hidden.*~\/Downloads/, p);
  }
  assert.throws(() => uploadPaths([path.join(dir, 'hosts.txt')]), /\(\/private\/etc\/hosts\) can't be uploaded: it is inside \/private\/etc/);
  assert.throws(() => uploadPaths(['/etc/hosts']), /inside \/private\/etc/);
  const library = path.join(os.homedir(), 'Library');
  if (fs.existsSync(library)) assert.throws(() => uploadPaths([path.join(os.homedir(), 'library')]), /inside .*\/Library/);
  // iCloud Drive and the cloud drives live in ~/Library, and uploading from them is ordinary (a stand-in home here).
  const home = path.join(dir, 'home');
  const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  const dropbox = path.join(home, 'Library', 'CloudStorage', 'Dropbox');
  for (const folder of [icloud, dropbox, path.join(home, 'Library', 'Keychains')]) fs.mkdirSync(folder, { recursive: true });
  for (const folder of [icloud, dropbox]) {
    fs.writeFileSync(path.join(folder, 'invoice.pdf'), 'x');
    assert.deepEqual(uploadPaths([path.join(folder, 'invoice.pdf')], home), [path.join(folder, 'invoice.pdf')]);
  }
  fs.writeFileSync(path.join(home, 'Library', 'Keychains', 'login.keychain-db'), 'x');
  assert.throws(() => uploadPaths([path.join(home, 'Library', 'Keychains', 'login.keychain-db')], home), /inside .*\/Library/);
  // The same home named through the Data volume keeps ~/Library refused.
  assert.throws(() => uploadPaths([path.join(home, 'Library', 'Keychains', 'login.keychain-db')], `/System/Volumes/Data${home}`), /inside .*\/Library/);
});

test('a folder upload checks everything in it: hidden entries, links out to refused places, more than 10,000 entries', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-upload-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'src', 'img'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'x');
  fs.writeFileSync(path.join(project, 'src', 'img', 'logo.png'), 'x');
  fs.symlinkSync(path.join(project, 'src'), path.join(project, 'src', 'loop')); // a link back up is walked once
  fs.symlinkSync(path.join(dir, 'gone'), path.join(project, 'broken'));
  for (const name of ['.DS_Store', path.join('src', '.DS_Store'), '.localized']) fs.writeFileSync(path.join(project, name), 'x'); // Finder's
  assert.deepEqual(uploadPaths([project]), [project]);
  const disguised = path.join(dir, 'disguised');
  fs.mkdirSync(path.join(disguised, '.DS_Store'), { recursive: true }); // a folder only named like Finder's file
  fs.writeFileSync(path.join(disguised, '.DS_Store', 'id_ed25519'), 'key');
  assert.throws(() => uploadPaths([disguised]), /holds \.DS_Store, which is hidden/);

  fs.writeFileSync(path.join(project, 'src', '.env'), 'SECRET=1');
  assert.throws(() => uploadPaths([project]), /project can't be uploaded: it holds src\/\.env, which is hidden/);
  fs.rmSync(path.join(project, 'src', '.env'));

  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'id_ed25519'), 'key');
  fs.symlinkSync(path.join(dir, '.ssh', 'id_ed25519'), path.join(project, 'src', 'img', 'photo.jpg'));
  assert.throws(() => uploadPaths([project]), /it holds src\/img\/photo\.jpg, a link to .*\.ssh\/id_ed25519: it is hidden/);
  fs.rmSync(path.join(project, 'src', 'img', 'photo.jpg'));
  fs.symlinkSync('/etc', path.join(project, 'config'));
  assert.throws(() => uploadPaths([project]), /it holds config, a link to \/private\/etc: it is inside \/private\/etc/);
  fs.rmSync(path.join(project, 'config'));
  assert.deepEqual(uploadPaths([project]), [project]);

  const big = path.join(dir, 'big');
  fs.mkdirSync(big);
  for (let i = 0; i <= 10_000; i++) fs.writeFileSync(path.join(big, `${i}.txt`), '');
  assert.throws(() => uploadPaths([big]), /holds more than 10,000 files and folders/);
  fs.rmSync(path.join(big, '0.txt'));
  assert.deepEqual(uploadPaths([big]), [big]);
});

test('a path on the Data volume counts as the same path without /System/Volumes/Data; real /System paths stay refused', (t) => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-upload-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'x');
  const onData = `/System/Volumes/Data${dir}/report.pdf`;
  if (!fs.existsSync(onData)) return t.skip('no Data volume here');
  assert.equal(uploadPaths([onData]).length, 1);
  assert.throws(() => uploadPaths(['/System/Volumes/Data/private/etc/hosts']), /inside \/private\/etc/);
  assert.throws(() => uploadPaths(['/System/Library/CoreServices/SystemVersion.plist']), /inside \/System/);
  const library = path.join(os.homedir(), 'Library');
  if (fs.existsSync(library)) assert.throws(() => uploadPaths([`/System/Volumes/Data${library}`]), /inside .*\/Library/);
});

test('uploads refuse devices, pipes and sockets, also inside a folder, and system keychains and logs', (t) => {
  fs.mkdirSync('/tmp/fb-fix/B', { recursive: true });
  const dir = fs.realpathSync.native(fs.mkdtempSync('/tmp/fb-fix/B/upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fifo = path.join(dir, 'pipe');
  execFileSync('mkfifo', [fifo]);
  for (const p of ['/dev/zero', '/dev/stdin', fifo]) assert.throws(() => uploadPaths([p]), /can't be uploaded: it is not a regular file or folder/, p);
  const folder = path.join(dir, 'folder');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
  assert.deepEqual(uploadPaths([folder]), [folder]);
  fs.symlinkSync('/dev/zero', path.join(folder, 'zero'));
  assert.throws(() => uploadPaths([folder]), /it holds zero, which is not a regular file or folder/);
  fs.rmSync(path.join(folder, 'zero'));
  fs.renameSync(fifo, path.join(folder, 'pipe'));
  assert.throws(() => uploadPaths([folder]), /it holds pipe, which is not a regular file or folder/);
  for (const p of ['/Library/Keychains/System.keychain', '/var/log/system.log']) {
    if (fs.existsSync(p)) assert.throws(() => uploadPaths([p]), /inside \/(Library\/Keychains|private\/var\/log)/, p);
  }
});

test('uploads refuse what another account could swap before it is read: a folder others can write to without the sticky bit', (t) => {
  fs.mkdirSync('/tmp/fb-fix/B', { recursive: true });
  const dir = fs.realpathSync.native(fs.mkdtempSync('/tmp/fb-fix/B/swap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const open = path.join(dir, 'open');
  const sticky = path.join(dir, 'sticky');
  for (const [folder, mode] of [[open, 0o777], [sticky, 0o1777]]) {
    fs.mkdirSync(folder);
    fs.chmodSync(folder, mode);
    fs.writeFileSync(path.join(folder, 'report.pdf'), 'x');
  }
  // /tmp is sticky, and the user's own files in a sticky folder can't be swapped by others.
  assert.deepEqual(uploadPaths([path.join(sticky, 'report.pdf')]), [path.join(sticky, 'report.pdf')]);
  assert.throws(() => uploadPaths([path.join(open, 'report.pdf')]),
    new RegExp(`can't be uploaded: it sits in ${open}, where another account on this Mac could swap it .*copy it into ~/Downloads first`));
  // Also below a folder given whole, and through a link that leads there.
  const project = path.join(dir, 'project');
  fs.mkdirSync(path.join(project, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(project, 'shared', 'a.txt'), 'x');
  assert.deepEqual(uploadPaths([project]), [project]);
  fs.chmodSync(path.join(project, 'shared'), 0o777);
  assert.throws(() => uploadPaths([project]), /it sits in .*project\/shared, where another account/);
  fs.chmodSync(path.join(project, 'shared'), 0o755);
  fs.symlinkSync(path.join(open, 'report.pdf'), path.join(project, 'linked.pdf'));
  assert.throws(() => uploadPaths([project]), /it sits in .*\/open, where another account/);
  // Someone else's file in a shared sticky folder (like /Users/Shared) is theirs to swap.
  if (fs.existsSync('/Users/Shared')) {
    const theirs = fs.readdirSync('/Users/Shared').map((n) => path.join('/Users/Shared', n))
      .find((f) => { try { const st = fs.lstatSync(f); return st.isFile() && st.uid !== process.getuid() && st.uid !== 0 && !path.basename(f).startsWith('.'); } catch { return false; } });
    if (theirs) assert.throws(() => uploadPaths([theirs]), /it sits in \/Users\/Shared, where another account/);
  }
});

test('a dropped file is read only if it is still the file that was checked', (t) => {
  fs.mkdirSync('/tmp/fb-fix/B', { recursive: true });
  const dir = fs.realpathSync.native(fs.mkdtempSync('/tmp/fb-fix/B/drop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'photo.png');
  fs.writeFileSync(file, 'picture');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'SECRET');
  const ids = new Map();
  const files = uploadPaths([file], undefined, ids);
  assert.equal(Buffer.from(dropPayload(files, ids)[0].data, 'base64').toString(), 'picture');
  // Swapped for a link to another file, for another file, and for a pipe after the check: nothing is read.
  for (const swap of [() => fs.symlinkSync(path.join(dir, 'secret.txt'), file), () => fs.writeFileSync(file, 'SECRET'), () => execFileSync('mkfifo', [file])]) {
    fs.rmSync(file);
    swap();
    assert.throws(() => dropPayload(files, ids), /photo\.png was not uploaded: it was replaced or changed into something else since it was checked/);
  }
  assert.throws(() => dropPayload(files, new Map()), /was not uploaded/); // never checked
});
