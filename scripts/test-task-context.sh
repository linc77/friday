#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_CONTEXT_CHECK_DIR="$(mktemp -d -t friday-context-check)"
trap 'rm -rf "$FRIDAY_CONTEXT_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskComposerCommands.swift \
  apps/apple/Sources/FridayKit/TaskDraftCache.swift \
  apps/apple/Sources/FridayKit/TaskContextDocument.swift \
  apps/apple/Sources/FridayKit/TaskAssistantCitation.swift \
  apps/apple/Tests/FridayKitTests/TaskContextDocumentTests.swift \
  -o "$FRIDAY_CONTEXT_CHECK_DIR/check"
"$FRIDAY_CONTEXT_CHECK_DIR/check"
