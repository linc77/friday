#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_QUEUE_CHECK_DIR="$(mktemp -d -t friday-queue-check)"
trap 'rm -rf "$FRIDAY_QUEUE_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskRowPresentation.swift \
  apps/apple/Sources/FridayKit/TaskComposerDispatch.swift \
  apps/apple/Sources/FridayKit/TaskDraftCache.swift \
  apps/apple/Tests/FridayKitTests/TaskQueueTests.swift \
  -o "$FRIDAY_QUEUE_CHECK_DIR/check"
"$FRIDAY_QUEUE_CHECK_DIR/check"
