#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_OUTPUT_CHECK_DIR="$(mktemp -d -t friday-output-check)"
trap 'rm -rf "$FRIDAY_OUTPUT_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskOutputProtocol.swift \
  apps/apple/Tests/FridayKitTests/TaskOutputProtocolTests.swift \
  -o "$FRIDAY_OUTPUT_CHECK_DIR/check"
"$FRIDAY_OUTPUT_CHECK_DIR/check"
