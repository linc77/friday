#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_EXECUTION_CHECK_DIR="$(mktemp -d -t friday-execution-check)"
trap 'rm -rf "$FRIDAY_EXECUTION_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskComposerDispatch.swift \
  apps/apple/Sources/FridayKit/TaskBrowserState.swift \
  apps/apple/Sources/FridayKit/TaskBrowserPreferenceModels.swift \
  apps/apple/Sources/FridayKit/TaskExecutionPresentation.swift \
  apps/apple/Sources/FridayKit/TaskDiffDocument.swift \
  apps/apple/Tests/FridayKitTests/TaskExecutionPresentationTests.swift \
  -o "$FRIDAY_EXECUTION_CHECK_DIR/check"
"$FRIDAY_EXECUTION_CHECK_DIR/check"
