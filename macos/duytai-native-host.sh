#!/bin/bash
set -euo pipefail

# Native Messaging Bridge for Duytai on macOS (Chromium/Firefox 4-byte LE framing)
NODE_BIN=""
for candidate in \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "$HOME/.volta/bin/node" \
  "$HOME/.fnm/current/bin/node" \
  "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM="$(ls -1d "$HOME/.nvm/versions/node/"* 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -n "$LATEST_NVM" ] && [ -x "$LATEST_NVM/bin/node" ]; then
    NODE_BIN="$LATEST_NVM/bin/node"
  fi
fi

if [ -z "$NODE_BIN" ]; then
  echo "Duytai Native Host: Node.js not found" >&2
  exit 1
fi

CORE_DIR="$HOME/Library/Application Support/Duytai/core"
if [ ! -f "$CORE_DIR/duytai-native-host.js" ] && [ -f "/Applications/Duytai.app/Contents/Resources/core/duytai-native-host.js" ]; then
  CORE_DIR="/Applications/Duytai.app/Contents/Resources/core"
fi

exec "$NODE_BIN" "$CORE_DIR/duytai-native-host.js"
