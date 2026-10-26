#!/bin/sh
# FowlBrowser installer (macOS). Copies the app into ~/Library/Application Support/FowlBrowser, registers the
# native host for every installed Chromium browser, and registers the MCP server and hooks with Claude Code.
# Re-run to update. --lite skips Lighthouse. FOWLBROWSER_SKIP_CLAUDE=1 leaves Claude Code alone; uninstall.sh undoes it all.
# Nothing keeps running on its own: the browser starts the host, Claude starts the MCP server.
set -eu
# --lite leaves Lighthouse out (about 160 MB on disk): every other tool works, and `lighthouse` says how to add it.
OMIT=""
for arg in "$@"; do [ "$arg" = --lite ] && OMIT="--omit=optional"; done
SRC=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/Library/Application Support/FowlBrowser"
# The user's own node comes first; Homebrew's folders are only a fallback for a minimal PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
[ "$(uname)" = Darwin ] || { echo "FowlBrowser runs on macOS only." >&2; exit 1; }
# 22.19 is what the locked Lighthouse needs (mcp/package.json engines says the same).
command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 19) ? 0 : 1)' ||
  { echo "FowlBrowser needs Node.js 22.19 or newer (https://nodejs.org)." >&2; exit 1; }
NODE=$(command -v node)

mkdir -p "$APP"
rsync -a --delete --exclude test --exclude NOTES.md "$SRC/extension/" "$APP/extension/"
rsync -a --delete --exclude fowlbrowser-host --exclude NOTES.md "$SRC/host/" "$APP/host/"
rsync -a --delete --exclude node_modules --exclude test --exclude NOTES.md "$SRC/mcp/" "$APP/mcp/"
rsync -a "$SRC/tools/fb.mjs" "$APP/fb.mjs"
(cd "$APP/mcp" && npm ci --omit=dev $OMIT --no-audit --no-fund --silent)
# Desktop apps and IDEs start MCP servers with a minimal PATH, so the installed launcher runs this node by its full
# path (the repo's own launcher, for development, uses the node on PATH). Quoted for sh whatever the paths contain.
LAUNCHER=$(cat <<'JS'
const [file, node, server] = process.argv.slice(1);
const sh = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
require('fs').writeFileSync(file, '#!/bin/sh\n# FowlBrowser MCP server launcher, written by install.sh.\nexec ' + sh(node) + ' ' + sh(server) + ' "$@"\n');
JS
)
"$NODE" -e "$LAUNCHER" "$APP/mcp/bin/fowlbrowser-mcp" "$NODE" "$APP/mcp/src/server.mjs"
HOST_OUT=$(sh "$APP/host/install.sh") # a failed registration stops the install here
REGISTERED=$(printf '%s\n' "$HOST_OUT" | grep '^registered ' || true)
echo "${REGISTERED:-No supported browser found (Chrome, Chromium, Helium, Brave, Edge, Arc, Vivaldi or Dia).}"

# Claude Code: the MCP server in user scope (~/.claude.json) and four hooks in ~/.claude/settings.json.
if [ "${FOWLBROWSER_SKIP_CLAUDE:-}" = 1 ]; then
  echo "Claude Code: skipped (FOWLBROWSER_SKIP_CLAUDE=1)."
elif ! command -v claude >/dev/null; then
  echo "Claude Code: not found, skipped. Install it, then run this script again."
else
  env -u CLAUDE_CONFIG_DIR claude mcp remove --scope user fowlbrowser >/dev/null 2>&1 || true
  env -u CLAUDE_CONFIG_DIR claude mcp add --scope user fowlbrowser -- "$APP/mcp/bin/fowlbrowser-mcp" >/dev/null
  echo "Claude Code: added MCP server fowlbrowser (user scope): $APP/mcp/bin/fowlbrowser-mcp"
  # Hooks: at each turn end the session's agent tabs close and claimed and kept tabs go back to the user; while a
  # subagent runs (SubagentStart until SubagentStop) turn ends leave everything alone. Before each Bash command, a
  # guard refuses opening pages in a browser from the shell (`open -a "Google Chrome" x.html`): those go through tab_open.
  node "$SRC/tools/claude-hooks.mjs" add "${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}" "$NODE" "$APP/mcp/bin/turn-ended.mjs" "$APP/mcp/bin/shell-guard.mjs"
  echo "Claude Code: agents can't open pages in a browser from the shell (open, osascript, a browser's binary); they use tab_open."
  echo "To opt out: sh uninstall.sh removes these, and FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh skips them."
fi

# Browsers already running FowlBrowser pick up the new extension code without the extensions page, unless
# agents are working there right now (a reload closes their tabs): then it says "reload later".
for s in "$HOME"/.fowlbrowser/*.sock; do
  [ -S "$s" ] || continue
  b=$(basename "$s" .sock)
  echo "$b: $(node "$APP/fb.mjs" -b "$b" reload-if-idle 2>&1 || true)"
done

echo "Installed to $APP"
[ -n "$REGISTERED" ] || exit 0
# Run by a person in a terminal: the folder to pick goes on the clipboard (scripted re-installs leave it alone).
CLIP=""
if [ -t 1 ] && command -v pbcopy >/dev/null; then printf %s "$APP/extension" | pbcopy && CLIP=" (the path is on your clipboard)"; fi
echo
echo "First time only, in each browser:"
echo "  1. Open its extensions page:"
echo "$REGISTERED" | while IFS= read -r line; do
  name=${line#registered }; name=${name%%: *}
  case $name in
    Brave) page=brave://extensions ;; "Microsoft Edge") page=edge://extensions ;;
    Arc) page=arc://extensions ;; Vivaldi) page=vivaldi://extensions ;; Dia) page=dia://extensions ;;
    *) page=chrome://extensions ;;
  esac
  echo "     $name: $page"
done
echo "  2. Turn on Developer mode."
echo "  3. Click Load unpacked and pick $APP/extension$CLIP."
echo "  4. Open FowlBrowser's Details and turn on Allow access to file URLs (needed for uploads)."
echo "Optional: to hide the \"started debugging\" bar, quit the browser and start it with --silent-debugger-extension-api,"
echo "  for example: open -a \"Google Chrome\" --args --silent-debugger-extension-api"
