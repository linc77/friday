#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_SNOOZE_CHECK_DIR="$(mktemp -d -t friday-snooze-check)"
trap 'rm -rf "$FRIDAY_SNOOZE_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskSnooze.swift \
  apps/apple/Sources/FridayKit/TaskWorkspaces.swift \
  apps/apple/Tests/FridayKitTests/TaskSnoozeTests.swift \
  -o "$FRIDAY_SNOOZE_CHECK_DIR/check"
"$FRIDAY_SNOOZE_CHECK_DIR/check"
