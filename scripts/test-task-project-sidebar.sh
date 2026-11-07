#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_PROJECT_SIDEBAR_CHECK_DIR="$(mktemp -d -t friday-project-sidebar)"
trap 'rm -rf "$FRIDAY_PROJECT_SIDEBAR_CHECK_DIR"' EXIT
swiftc -parse-as-library apps/apple/Sources/FridayKit/Models.swift apps/apple/Sources/FridayKit/CodexTranscript.swift apps/apple/Sources/FridayKit/TaskWorkspaces.swift apps/apple/Sources/FridayKit/TaskSnooze.swift apps/apple/Sources/FridayKit/TaskProjectSidebar.swift apps/apple/Tests/FridayKitTests/TaskProjectSidebarTests.swift -o "$FRIDAY_PROJECT_SIDEBAR_CHECK_DIR/check"
"$FRIDAY_PROJECT_SIDEBAR_CHECK_DIR/check" apps/apple/Tests/FridayKitTests/Fixtures/task-project-sidebar.json
