#!/bin/bash
set -euo pipefail

echo "=================================================="
echo "  Duytai Downloader v7.4 - macOS Setup"
echo "=================================================="

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_SRC="/Applications/Duytai.app"
SUPPORT_DIR="$HOME/Library/Application Support/Duytai"
CORE_DIR="$SUPPORT_DIR/core"
HOST_SH="$SUPPORT_DIR/duytai-native-host.sh"
EXT_ID="knpgakkbngbpcijjehpjflnflccdlaon"

mkdir -p "$CORE_DIR"

if [ -d "$APP_SRC/Contents/Resources/core" ]; then
  cp -R "$APP_SRC/Contents/Resources/core/"* "$CORE_DIR/"
  cp "$APP_SRC/Contents/Resources/duytai-native-host.sh" "$HOST_SH"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  cp "$ROOT_DIR/server.js" "$ROOT_DIR/engine.js" "$ROOT_DIR/idm-features.js" \
     "$ROOT_DIR/duytai-native-host.js" "$CORE_DIR/"
  if [ -f "$ROOT_DIR/package.json" ]; then cp "$ROOT_DIR/package.json" "$CORE_DIR/"; fi
  cp -R "$ROOT_DIR/public" "$ROOT_DIR/extension" "$CORE_DIR/"
  cp "$SCRIPT_DIR/duytai-native-host.sh" "$HOST_SH"
fi
chmod +x "$HOST_SH"

CHROMIUM_NMH_DIRS=(
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/CocCoc/Browser/NativeMessagingHosts"
  "$HOME/Library/Application Support/Vivaldi/NativeMessagingHosts"
  "$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
)

for dir in "${CHROMIUM_NMH_DIRS[@]}"; do
  mkdir -p "$dir"
  cat > "$dir/com.duytai.idm.json" << EOF
{
  "name": "com.duytai.idm",
  "description": "Duytai Download Engine Native Host (macOS)",
  "path": "$HOST_SH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
done

FF_NMH_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$FF_NMH_DIR"
cat > "$FF_NMH_DIR/com.duytai.idm.json" << EOF
{
  "name": "com.duytai.idm",
  "description": "Duytai Download Engine Native Host (macOS)",
  "path": "$HOST_SH",
  "type": "stdio",
  "allowed_extensions": [
    "duytai-idm@doanduy.dev"
  ]
}
EOF

if [ -d "$APP_SRC" ]; then
  xattr -cr "$APP_SRC" 2>/dev/null || true
  codesign --verify --deep --strict "$APP_SRC" 2>/dev/null || codesign --force --deep --sign - "$APP_SRC" 2>/dev/null || true
fi
xattr -cr "$SUPPORT_DIR" 2>/dev/null || true

LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.doanduy.duytai.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.doanduy.duytai</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Duytai.app/Contents/MacOS/Duytai</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
</dict>
</plist>
EOF

echo "-> Registered Native Messaging for Chrome, Edge, Brave, CocCoc, Vivaldi, Arc, Firefox"
echo "-> Registered LaunchAgent auto-start: $LAUNCH_AGENT"
echo "-> Ready! Extension ID: $EXT_ID"
