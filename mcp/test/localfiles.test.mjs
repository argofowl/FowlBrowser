// What an agent may open and upload from this Mac: no local file pages, and no uploads of hidden files, ~/Library or
// system configuration, also not through a symlink.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { refuseLocalFile, uploadPaths } from '../src/tools.mjs';

test('local file and view-source: URLs are refused however they are written; web URLs pass', () => {
  for (const url of ['file:///Users/me/.ssh/id_ed25519', 'fi\tle:///etc/passwd', 'fi\nle:///etc/passwd', '\u0001file:///etc/passwd',
    ' FILE:///etc/passwd', 'view-source:file:///etc/passwd', 'view-source:https://example.com/']) {
    assert.throws(() => refuseLocalFile(url), /local file|view-source/, JSON.stringify(url));
  }
  for (const url of [undefined, 'about:blank', 'https://example.com/file:///x', 'http://localhost:3000/']) assert.equal(refuseLocalFile(url), url);
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
