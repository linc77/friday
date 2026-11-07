#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_SCRIPT_CHECK_DIR="$(mktemp -d -t friday-script-check)"
trap 'rm -rf "$FRIDAY_SCRIPT_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/ProjectScriptModels.swift \
  apps/apple/Sources/FridayKit/TaskWorktreeSetupModels.swift \
  apps/apple/Sources/FridayKit/ProjectScriptShortcut.swift \
  apps/apple/Tests/FridayKitTests/ProjectScriptTests.swift \
  -o "$FRIDAY_SCRIPT_CHECK_DIR/check"
"$FRIDAY_SCRIPT_CHECK_DIR/check"
