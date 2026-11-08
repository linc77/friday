#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NAV_CHECK_DIR="$(mktemp -d -t friday-nav-check)"
trap 'rm -rf "$FRIDAY_NAV_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/MobileNavigationMotion.swift \
  apps/apple/Tests/FridayKitTests/MobileNavigationMotionTests.swift \
  -o "$FRIDAY_NAV_CHECK_DIR/check"
"$FRIDAY_NAV_CHECK_DIR/check"
