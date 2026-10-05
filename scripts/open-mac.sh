#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -x dist/Friday.app/Contents/MacOS/Friday ]; then bash scripts/build-mac.sh; fi
open dist/Friday.app
