#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_GIT_CHECK_DIR="$(mktemp -d -t friday-git-check)"
trap 'rm -rf "$FRIDAY_GIT_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskGitPresentation.swift \
  apps/apple/Tests/FridayKitTests/TaskGitPresentationTests.swift \
  -o "$FRIDAY_GIT_CHECK_DIR/check"
"$FRIDAY_GIT_CHECK_DIR/check"
