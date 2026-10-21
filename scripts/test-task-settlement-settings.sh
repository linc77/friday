#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_SETTLEMENT_CHECK_DIR="$(mktemp -d -t friday-settlement-check)"
trap 'rm -rf "$FRIDAY_SETTLEMENT_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TextGenerationSettingsState.swift \
  apps/apple/Tests/FridayKitTests/TaskSettlementSettingsStateTests.swift \
  -o "$FRIDAY_SETTLEMENT_CHECK_DIR/check"
"$FRIDAY_SETTLEMENT_CHECK_DIR/check"
