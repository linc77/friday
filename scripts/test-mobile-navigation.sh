#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NAVIGATION_CHECK_DIR="$(mktemp -d -t friday-navigation-check)"
trap 'rm -rf "$FRIDAY_NAVIGATION_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/MobileTabScrubbing.swift \
  apps/apple/Tests/FridayKitTests/MobileTabScrubbingTests.swift \
  -o "$FRIDAY_NAVIGATION_CHECK_DIR/check"
"$FRIDAY_NAVIGATION_CHECK_DIR/check"
