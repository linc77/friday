#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_NAMED_PROJECT_CHECK_DIR="$(mktemp -d -t friday-named-project-check)"
trap 'rm -rf "$FRIDAY_NAMED_PROJECT_CHECK_DIR"' EXIT
swiftc -parse-as-library apps/apple/Sources/FridayKit/ManagedProjectNaming.swift apps/apple/Tests/FridayKitTests/ManagedProjectNamingTests.swift -o "$FRIDAY_NAMED_PROJECT_CHECK_DIR/check"
"$FRIDAY_NAMED_PROJECT_CHECK_DIR/check" server/test/fixtures/t3-named-projects.json server/test/fixtures/t3-project-clone.json
