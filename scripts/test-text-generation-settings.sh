#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_TEXT_SETTINGS_CHECK_DIR="$(mktemp -d -t friday-text-settings-check)"
trap 'rm -rf "$FRIDAY_TEXT_SETTINGS_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TextGenerationSettingsState.swift \
  apps/apple/Tests/FridayKitTests/TextGenerationSettingsStateTests.swift \
  -o "$FRIDAY_TEXT_SETTINGS_CHECK_DIR/check"
"$FRIDAY_TEXT_SETTINGS_CHECK_DIR/check"
