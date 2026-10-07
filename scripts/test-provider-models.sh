#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_PROVIDER_CHECK_DIR="$(mktemp -d -t friday-provider-check)"
trap 'rm -rf "$FRIDAY_PROVIDER_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/ProviderModelPreferences.swift \
  apps/apple/Tests/FridayKitTests/ProviderModelPreferencesTests.swift \
  -o "$FRIDAY_PROVIDER_CHECK_DIR/check"
"$FRIDAY_PROVIDER_CHECK_DIR/check"
