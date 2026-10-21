#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_QUESTION_CHECK_DIR="$(mktemp -d -t friday-question-check)"
trap 'rm -rf "$FRIDAY_QUESTION_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskQuestionDraft.swift \
  apps/apple/Tests/FridayKitTests/TaskQuestionDraftTests.swift \
  -o "$FRIDAY_QUESTION_CHECK_DIR/check"
"$FRIDAY_QUESTION_CHECK_DIR/check"
