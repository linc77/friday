#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NOTE_STORAGE_CHECK_DIR="$(mktemp -d -t friday-note-storage-check)"
trap 'rm -rf "$FRIDAY_NOTE_STORAGE_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/ClientNoteDatabase.swift \
  apps/apple/Tests/FridayKitTests/ClientNoteDatabaseTests.swift \
  -o "$FRIDAY_NOTE_STORAGE_CHECK_DIR/check"
"$FRIDAY_NOTE_STORAGE_CHECK_DIR/check"
