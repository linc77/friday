#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
# This protocol regression also runs with Command Line Tools, which omit XCTest.
FRIDAY_CHECK_DIR="$(mktemp -d -t friday-swift-check)"
trap 'rm -rf "$FRIDAY_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/MarkdownBlocks.swift \
  apps/apple/Sources/FridayKit/SnapshotStream.swift \
  apps/apple/Tests/FridayKitTests/SnapshotStreamTests.swift \
  -o "$FRIDAY_CHECK_DIR/check"
"$FRIDAY_CHECK_DIR/check"
