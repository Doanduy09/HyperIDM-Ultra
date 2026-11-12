#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/Duytai.app"
DMG_OUT="$ROOT_DIR/Duytai-macOS-Universal.dmg"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources/core"

echo "[1/4] Compiling arm64 & x86_64 Swift Universal binary..."
swiftc -parse-as-library -O -target arm64-apple-macos11.0 \
  "$SCRIPT_DIR/DuytaiMac.swift" -o "$DIST_DIR/DuytaiMac-arm64" \
  -framework Cocoa -framework WebKit

swiftc -parse-as-library -O -target x86_64-apple-macos11.0 \
  "$SCRIPT_DIR/DuytaiMac.swift" -o "$DIST_DIR/DuytaiMac-x86_64" \
  -framework Cocoa -framework WebKit

lipo -create "$DIST_DIR/DuytaiMac-arm64" "$DIST_DIR/DuytaiMac-x86_64" \
  -output "$APP_BUNDLE/Contents/MacOS/Duytai"
rm -f "$DIST_DIR/DuytaiMac-arm64" "$DIST_DIR/DuytaiMac-x86_64"
chmod +x "$APP_BUNDLE/Contents/MacOS/Duytai"

echo "[2/4] Bundling Duytai Cross-Platform Core + Extension..."
cp "$ROOT_DIR/server.js" "$ROOT_DIR/engine.js" "$ROOT_DIR/idm-features.js" \
   "$ROOT_DIR/duytai-native-host.js" "$ROOT_DIR/package.json" \
   "$APP_BUNDLE/Contents/Resources/core/"
cp -R "$ROOT_DIR/public" "$ROOT_DIR/extension" "$APP_BUNDLE/Contents/Resources/core/"
cp "$SCRIPT_DIR/duytai-native-host.sh" "$SCRIPT_DIR/Install-Duytai-macOS.sh" "$APP_BUNDLE/Contents/Resources/"
chmod +x "$APP_BUNDLE/Contents/Resources/duytai-native-host.sh" "$APP_BUNDLE/Contents/Resources/Install-Duytai-macOS.sh"

echo "[3/4] Writing Info.plist & ad-hoc codesign..."
cat > "$APP_BUNDLE/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>vi</string>
  <key>CFBundleExecutable</key><string>Duytai</string>
  <key>CFBundleIdentifier</key><string>com.doanduy.duytai</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Duytai</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>7.4.0</string>
  <key>CFBundleVersion</key><string>740</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.doanduy.duytai.url</string>
      <key>CFBundleURLSchemes</key>
      <array><string>duytai</string></array>
    </dict>
  </array>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP_BUNDLE" || true

echo "[4/4] Packaging Universal DMG..."
rm -f "$DMG_OUT"
hdiutil create -volname "Duytai Downloader" -srcfolder "$APP_BUNDLE" -ov -format UDZO "$DMG_OUT"
echo "DONE: $DMG_OUT"
