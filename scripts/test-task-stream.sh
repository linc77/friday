#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_STREAM_CHECK_DIR="$(mktemp -d -t friday-stream-check)"
trap 'rm -rf "$FRIDAY_STREAM_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/TaskStreamState.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskHistoryWindow.swift \
  apps/apple/Sources/FridayKit/TaskConversationWindow.swift \
  apps/apple/Sources/FridayKit/TaskViewHistoryCache.swift \
  apps/apple/Sources/FridayKit/TaskOutputProtocol.swift \
  apps/apple/Sources/FridayKit/TaskTerminalProtocol.swift \
  apps/apple/Tests/FridayKitTests/TaskStreamStateTests.swift \
  -o "$FRIDAY_STREAM_CHECK_DIR/check"
node server/test/fixtures/task-stream.mjs "$FRIDAY_STREAM_CHECK_DIR/check"
