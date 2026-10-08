#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_WORKSPACE_CHECK_DIR="$(mktemp -d -t friday-workspace-check)"
trap 'rm -rf "$FRIDAY_WORKSPACE_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskRowPresentation.swift \
  apps/apple/Sources/FridayKit/TaskWorkspaces.swift \
  apps/apple/Sources/FridayKit/TaskExecutionWorkspace.swift \
  apps/apple/Sources/FridayKit/WorkspaceStyle.swift \
  apps/apple/Tests/FridayKitTests/TaskWorkspaceTests.swift \
  -o "$FRIDAY_WORKSPACE_CHECK_DIR/check"
"$FRIDAY_WORKSPACE_CHECK_DIR/check"
