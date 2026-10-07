#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build --package-path apps/apple
FRIDAY_COMPOSER_BIN_DIR="$(swift build --package-path apps/apple --show-bin-path)"
FRIDAY_COMPOSER_CHECK_DIR="$(mktemp -d -t friday-note-composer-check)"
trap 'rm -rf "$FRIDAY_COMPOSER_CHECK_DIR"' EXIT
cp -R "$FRIDAY_COMPOSER_BIN_DIR/Friday_FridayKit.bundle" "$FRIDAY_COMPOSER_CHECK_DIR/"
swiftc -parse-as-library -I "$FRIDAY_COMPOSER_BIN_DIR" \
  apps/apple/Tests/FridayKitTests/NoteComposerWindowTests.swift \
  "$FRIDAY_COMPOSER_BIN_DIR/FridayKit.o" -o "$FRIDAY_COMPOSER_CHECK_DIR/check"
"$FRIDAY_COMPOSER_CHECK_DIR/check"
