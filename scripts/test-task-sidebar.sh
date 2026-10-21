#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_SIDEBAR_CHECK_DIR="$(mktemp -d -t friday-sidebar-check)"
trap 'rm -rf "$FRIDAY_SIDEBAR_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskWorkspaces.swift \
  apps/apple/Sources/FridayKit/TaskSnooze.swift \
  apps/apple/Sources/FridayKit/TaskSidebarState.swift \
  apps/apple/Sources/FridayKit/TaskSidebarSelection.swift \
  apps/apple/Sources/FridayKit/TaskBulkCoordinator.swift \
  apps/apple/Tests/FridayKitTests/TaskSidebarStateTests.swift \
  -o "$FRIDAY_SIDEBAR_CHECK_DIR/check"
"$FRIDAY_SIDEBAR_CHECK_DIR/check"
