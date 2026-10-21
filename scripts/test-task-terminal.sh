#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_TERMINAL_CHECK_DIR="$(mktemp -d -t friday-terminal-check)"
trap 'rm -rf "$FRIDAY_TERMINAL_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskTerminalProtocol.swift \
  apps/apple/Tests/FridayKitTests/TaskTerminalProtocolTests.swift \
  -o "$FRIDAY_TERMINAL_CHECK_DIR/check"
"$FRIDAY_TERMINAL_CHECK_DIR/check"
