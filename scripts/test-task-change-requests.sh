#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
FRIDAY_REVIEW_CHECK_DIR="$(mktemp -d -t friday-review-check)"
trap 'rm -rf "$FRIDAY_REVIEW_CHECK_DIR"' EXIT
swiftc -parse-as-library \
  apps/apple/Sources/FridayKit/Models.swift \
  apps/apple/Sources/FridayKit/CodexTranscript.swift \
  apps/apple/Sources/FridayKit/TaskChangeRequestStackModels.swift \
  apps/apple/Sources/FridayKit/TaskChangeRequestModels.swift \
  apps/apple/Sources/FridayKit/TaskPullRequestPresentation.swift \
  apps/apple/Sources/FridayKit/TaskChangeRequestTimelineModels.swift \
  apps/apple/Sources/FridayKit/TaskChangeRequestCodeScope.swift \
  apps/apple/Sources/FridayKit/TaskReviewStateModels.swift \
  apps/apple/Sources/FridayKit/TaskReviewGuideModels.swift \
  apps/apple/Sources/FridayKit/TaskDiffDocument.swift \
  apps/apple/Sources/FridayKit/TaskSourceLines.swift \
  apps/apple/Sources/FridayKit/TaskDiffReview.swift \
  apps/apple/Tests/FridayKitTests/TaskChangeRequestTests.swift \
  -o "$FRIDAY_REVIEW_CHECK_DIR/check"
"$FRIDAY_REVIEW_CHECK_DIR/check"
