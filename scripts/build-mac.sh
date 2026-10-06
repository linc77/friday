#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --package-path apps/apple -c release
FRIDAY_BIN_DIR="$(swift build --package-path apps/apple -c release --show-bin-path)"
mkdir -p dist/Friday.app/Contents/MacOS dist/Friday.app/Contents/Resources
cp "$FRIDAY_BIN_DIR/Friday" dist/Friday.app/Contents/MacOS/Friday
cp apps/apple/Info-mac.plist dist/Friday.app/Contents/Info.plist
cp apps/apple/Assets/Friday.icns dist/Friday.app/Contents/Resources/Friday.icns
rm -rf dist/Friday.app/Contents/Resources/Friday_FridayKit.bundle
cp -R "$FRIDAY_BIN_DIR/Friday_FridayKit.bundle" dist/Friday.app/Contents/Resources/
codesign --force --sign - dist/Friday.app
touch dist/Friday.app
printf 'Built %s/dist/Friday.app\n' "$PWD"
