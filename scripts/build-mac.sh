#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --package-path apps/apple -c release
FRIDAY_BIN_DIR="$(swift build --package-path apps/apple -c release --show-bin-path)"
mkdir -p dist/Friday.app/Contents/MacOS
cp "$FRIDAY_BIN_DIR/Friday" dist/Friday.app/Contents/MacOS/Friday
cp apps/apple/Info-mac.plist dist/Friday.app/Contents/Info.plist
codesign --force --sign - dist/Friday.app
printf 'Built %s/dist/Friday.app\n' "$PWD"
