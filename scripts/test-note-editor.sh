#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Native editor regressions require the macOS AppKit SDK.
swift build --package-path apps/apple
FRIDAY_NOTE_BIN_DIR="$(swift build --package-path apps/apple --show-bin-path)"
FRIDAY_NOTE_CHECK_DIR="$(mktemp -d -t friday-note-editor-check)"
trap 'rm -rf "$FRIDAY_NOTE_CHECK_DIR"' EXIT
swiftc -parse-as-library -I "$FRIDAY_NOTE_BIN_DIR" \
  apps/apple/Tests/FridayKitTests/IdeaBodyEditorTests.swift \
  "$FRIDAY_NOTE_BIN_DIR/FridayKit.o" -o "$FRIDAY_NOTE_CHECK_DIR/check"
"$FRIDAY_NOTE_CHECK_DIR/check"
