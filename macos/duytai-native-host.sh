#!/bin/bash
set -euo pipefail

# Native Messaging Bridge for Duytai on macOS (Chromium/Firefox 4-byte LE framing)
for candidate in "/opt/homebrew/bin/node" "/usr/local/bin/node" "$(command -v node || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

CORE_DIR="$HOME/Library/Application Support/Duytai/core"
if [ ! -f "$CORE_DIR/duytai-native-host.js" ] && [ -f "/Applications/Duytai.app/Contents/Resources/core/duytai-native-host.js" ]; then
  CORE_DIR="/Applications/Duytai.app/Contents/Resources/core"
fi

exec "$NODE_BIN" "$CORE_DIR/duytai-native-host.js"
