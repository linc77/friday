#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_CONVERSATION_CHECK_DIR="$(mktemp -d -t friday-conversation-check)"
trap 'rm -rf "$FRIDAY_CONVERSATION_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskConversationWindow.swift \
  apps/apple/Tests/FridayKitTests/TaskConversationWindowTests.swift \
  -o "$FRIDAY_CONVERSATION_CHECK_DIR/check"
"$FRIDAY_CONVERSATION_CHECK_DIR/check"
