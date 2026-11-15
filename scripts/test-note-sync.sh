#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NOTE_SYNC_CHECK_DIR="$(mktemp -d -t friday-note-sync-check)"
trap 'rm -rf "$FRIDAY_NOTE_SYNC_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskOutputProtocol.swift \
  apps/apple/Sources/FridayKit/ClientNoteDatabase.swift \
  apps/apple/Sources/FridayKit/NoteSyncState.swift \
  apps/apple/Tests/FridayKitTests/NoteSyncStateTests.swift \
  -o "$FRIDAY_NOTE_SYNC_CHECK_DIR/check"
"$FRIDAY_NOTE_SYNC_CHECK_DIR/check"
