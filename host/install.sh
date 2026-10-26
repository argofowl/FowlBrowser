#!/bin/sh
# Registers the FowlBrowser native messaging host (com.fowl.browser) for every supported Chromium browser that is
# installed (its app or its Application Support folder exists). With --remove, deletes those registrations instead.
set -eu

HOST_DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node) || { echo "node not found on PATH" >&2; exit 1; }

# The browser launches hosts with a minimal environment, so bake the node path in. Node writes both files:
# paths are single-quoted for sh in the wrapper and JSON-encoded in the manifests, whatever they contain.
SCRIPT=$(cat <<'JS'
const fs = require('fs');
const path = require('path');
const [node, hostDir, home, mode] = process.argv.slice(1);
const support = path.join(home, 'Library', 'Application Support');
// [name, its folder in Application Support, its app]: installed when either exists (an app never opened has no folder yet).
const installed = (dir, app) => fs.existsSync(path.join(support, dir)) ||
  ['/Applications', path.join(home, 'Applications')].some((apps) => fs.existsSync(path.join(apps, app + '.app')));
const browsers = [
  ['Google Chrome', 'Google/Chrome', 'Google Chrome'], ['Google Chrome Beta', 'Google/Chrome Beta', 'Google Chrome Beta'],
  ['Google Chrome Canary', 'Google/Chrome Canary', 'Google Chrome Canary'], ['Chromium', 'Chromium', 'Chromium'],
  ['Helium', 'net.imput.helium', 'Helium'], ['Brave', 'BraveSoftware/Brave-Browser', 'Brave Browser'],
  ['Microsoft Edge', 'Microsoft Edge', 'Microsoft Edge'], ['Arc', 'Arc/User Data', 'Arc'], ['Vivaldi', 'Vivaldi', 'Vivaldi'],
  ['Dia', 'Dia/User Data', 'Dia'],
].filter(([, dir, app]) => installed(dir, app));
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
console.log('host: ' + wrapper + ' (node: ' + node + ')');
JS
)
"$NODE" -e "$SCRIPT" "$NODE" "$HOST_DIR" "$HOME" "${1:-}"
