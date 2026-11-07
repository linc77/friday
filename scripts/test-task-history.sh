#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_HISTORY_CHECK_DIR="$(mktemp -d -t friday-history-check)"
trap 'rm -rf "$FRIDAY_HISTORY_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskHistoryWindow.swift \
  apps/apple/Tests/FridayKitTests/TaskHistoryWindowTests.swift \
  -o "$FRIDAY_HISTORY_CHECK_DIR/check"
"$FRIDAY_HISTORY_CHECK_DIR/check"
