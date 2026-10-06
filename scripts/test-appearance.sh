#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_APPEARANCE_CHECK_DIR="$(mktemp -d -t friday-appearance-check)"
trap 'rm -rf "$FRIDAY_APPEARANCE_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/PresentationPreferences.swift \
  apps/apple/Tests/FridayKitTests/PresentationPreferencesTests.swift \
  -o "$FRIDAY_APPEARANCE_CHECK_DIR/check"
"$FRIDAY_APPEARANCE_CHECK_DIR/check" "$PWD/apps/apple/Sources/FridayKit/Resources"
