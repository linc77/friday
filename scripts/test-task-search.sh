#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_SEARCH_CHECK_DIR="$(mktemp -d -t friday-search-check)"
trap 'rm -rf "$FRIDAY_SEARCH_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskWorkspaces.swift \
  apps/apple/Sources/FridayKit/TaskSnooze.swift \
  apps/apple/Sources/FridayKit/TaskSearchState.swift \
  apps/apple/Tests/FridayKitTests/TaskSearchStateTests.swift \
  -o "$FRIDAY_SEARCH_CHECK_DIR/check"
"$FRIDAY_SEARCH_CHECK_DIR/check"
