#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NOTE_PULL_CHECK_DIR="$(mktemp -d -t friday-note-pull-check)"
trap 'rm -rf "$FRIDAY_NOTE_PULL_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/NotePullGesture.swift \
  apps/apple/Tests/FridayKitTests/NotePullGestureTests.swift \
  -o "$FRIDAY_NOTE_PULL_CHECK_DIR/check"
"$FRIDAY_NOTE_PULL_CHECK_DIR/check"
