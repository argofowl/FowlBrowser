#!/bin/sh
# FowlBrowser uninstaller: removes what install.sh added (native host registrations, the Claude Code MCP server and
# hooks, the app folder). The extension itself is removed by hand in each browser.
set -eu
SRC=$(cd "$(dirname "$0")" && pwd)
APP="$HOME/Library/Application Support/FowlBrowser"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
command -v node >/dev/null || { echo "FowlBrowser's uninstaller needs Node.js." >&2; exit 1; }

sh "$SRC/host/install.sh" --remove

# FOWLBROWSER_SKIP_CLAUDE=1 leaves Claude Code's settings alone, hooks included.
if [ "${FOWLBROWSER_SKIP_CLAUDE:-}" != 1 ]; then
  if command -v claude >/dev/null; then
    env -u CLAUDE_CONFIG_DIR claude mcp remove --scope user fowlbrowser >/dev/null 2>&1 &&
      echo "Claude Code: removed MCP server fowlbrowser (user scope)" || true
  fi
  # Only hook entries running FowlBrowser's turn-ended.mjs or shell-guard.mjs go; everything else in the settings stays.
  node "$SRC/tools/claude-hooks.mjs" remove "${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}" "$APP/mcp/bin/turn-ended.mjs" "$APP/mcp/bin/shell-guard.mjs"
fi

rm -rf "$APP"
echo "Removed $APP"
echo "Last step, by hand: remove FowlBrowser on each browser's extensions page."
