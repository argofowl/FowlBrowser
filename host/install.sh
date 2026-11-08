#!/bin/sh
# Registers the FowlBrowser native messaging host (com.fowl.browser) for every supported Chromium browser that is
# installed (its app, or its folder in Application Support on macOS or ~/.config on Linux, exists). With --remove,
# deletes those registrations instead.
set -eu

HOST_DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }

# The browser launches hosts with a minimal environment, so bake the node path in. Node writes both files:
# paths are single-quoted for sh in the wrapper and JSON-encoded in the manifests, whatever they contain.
SCRIPT=$(cat <<'JS'
const fs = require('fs');
const path = require('path');
const [node, hostDir, home, mode] = process.argv.slice(1);
const linux = process.platform === 'linux';
// macOS: the folder of each browser in Application Support. Linux: its folder in $XDG_CONFIG_HOME (~/.config), where it
// looks for NativeMessagingHosts.
const support = linux ? (process.env.XDG_CONFIG_HOME || path.join(home, '.config')) : path.join(home, 'Library', 'Application Support');
// [name, its folder in support, its app]: installed when either exists (an app never opened has no folder yet). On
// Linux the app is its command on PATH.
// Snap and Flatpak put launchers on PATH too; their sandboxed browsers cannot start the host, so those do not count.
const SANDBOX_BIN = /^(\/snap\/bin|\/var\/lib\/flatpak\/exports\/bin|.*\/flatpak\/exports\/bin)\/?$/;
const onPath = (cmd) => (process.env.PATH || '').split(':')
  .some((dir) => dir && !SANDBOX_BIN.test(dir) && fs.existsSync(path.join(dir, cmd)));
const installed = (dir, app) => fs.existsSync(path.join(support, dir)) || (linux ? onPath(app) :
  ['/Applications', path.join(home, 'Applications')].some((apps) => fs.existsSync(path.join(apps, app + '.app'))));
const browsers = (linux ? [
  ['Google Chrome', 'google-chrome', 'google-chrome-stable'], ['Google Chrome Beta', 'google-chrome-beta', 'google-chrome-beta'],
  ['Google Chrome Dev', 'google-chrome-unstable', 'google-chrome-unstable'], ['Chromium', 'chromium', 'chromium'],
  ['Helium', 'net.imput.helium', 'helium'], ['Brave', 'BraveSoftware/Brave-Browser', 'brave-browser'],
  ['Microsoft Edge', 'microsoft-edge', 'microsoft-edge'], ['Vivaldi', 'vivaldi', 'vivaldi'],
] : [
  ['Google Chrome', 'Google/Chrome', 'Google Chrome'], ['Google Chrome Beta', 'Google/Chrome Beta', 'Google Chrome Beta'],
  ['Google Chrome Canary', 'Google/Chrome Canary', 'Google Chrome Canary'], ['Chromium', 'Chromium', 'Chromium'],
  ['Helium', 'net.imput.helium', 'Helium'], ['Brave', 'BraveSoftware/Brave-Browser', 'Brave Browser'],
  ['Microsoft Edge', 'Microsoft Edge', 'Microsoft Edge'], ['Arc', 'Arc/User Data', 'Arc'], ['Vivaldi', 'Vivaldi', 'Vivaldi'],
]).filter(([, dir, app]) => installed(dir, app));
if (mode === '--remove') {
  for (const [name, dir] of browsers) {
    const file = path.join(support, dir, 'NativeMessagingHosts', 'com.fowl.browser.json');
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file);
    console.log('removed ' + name + ': ' + file);
    // Folders the install created for this file go too, once empty (a browser never opened had none).
    for (let d = path.dirname(file); d !== support; d = path.dirname(d)) {
      try { fs.rmdirSync(d); } catch { break; }
    }
  }
  process.exit(0);
}
const sh = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const wrapper = path.join(hostDir, 'fowlbrowser-host');
fs.writeFileSync(wrapper, '#!/bin/sh\nexec ' + sh(node) + ' ' + sh(path.join(hostDir, 'host.mjs')) + ' "$@"\n', { mode: 0o755 });
fs.chmodSync(wrapper, 0o755);
const manifest = JSON.stringify({
  name: 'com.fowl.browser',
  description: 'FowlBrowser native messaging host',
  path: wrapper,
  type: 'stdio',
  allowed_origins: ['chrome-extension://lpfcnmmimgcillacmnibffooadlofjhj/'],
}, null, 2) + '\n';
for (const [name, dir] of browsers) {
  const hosts = path.join(support, dir, 'NativeMessagingHosts');
  fs.mkdirSync(hosts, { recursive: true });
  fs.writeFileSync(path.join(hosts, 'com.fowl.browser.json'), manifest);
  console.log('registered ' + name + ': ' + path.join(hosts, 'com.fowl.browser.json'));
}
if (!browsers.length) console.log('no supported browser found in ' + support);
// Linux: browsers installed as a Snap or a Flatpak run sandboxed, and a sandbox cannot start a native messaging host
// (KeePassXC and 1Password hit the same wall). Name them, so nobody waits for them to connect.
if (linux && mode !== '--remove') {
  const flatpakRoots = ['/var/lib/flatpak/app', path.join(home, '.local', 'share', 'flatpak', 'app'), path.join(home, '.var', 'app')];
  const sandboxed = [
    ['Chromium', 'snap', 'chromium'], ['Brave', 'snap', 'brave'], ['Vivaldi', 'snap', 'vivaldi'],
    ['Google Chrome', 'flatpak', 'com.google.Chrome'], ['Chromium', 'flatpak', 'org.chromium.Chromium'],
    ['Brave', 'flatpak', 'com.brave.Browser'], ['Microsoft Edge', 'flatpak', 'com.microsoft.Edge'],
    ['Vivaldi', 'flatpak', 'com.vivaldi.Vivaldi'], ['Helium', 'flatpak', 'net.imput.helium'],
  ];
  for (const [name, kind, id] of sandboxed) {
    const there = kind === 'snap' ? fs.existsSync(path.join('/snap', id)) : flatpakRoots.some((root) => fs.existsSync(path.join(root, id)));
    if (there) console.log('skipped ' + name + ' (' + (kind === 'snap' ? 'Snap' : 'Flatpak') + '): a sandboxed browser can not start ' +
      'FowlBrowser, so install it from its .deb or .rpm, or your distribution package, instead');
  }
}
console.log('host: ' + wrapper + ' (node: ' + node + ')');
JS
)
"$NODE" -e "$SCRIPT" "$NODE" "$HOST_DIR" "$HOME" "${1:-}"
