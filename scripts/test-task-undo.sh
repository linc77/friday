#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import pathlib, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="friday-undo-check-") as directory:
    output = str(pathlib.Path(directory)/"check")
    files = ["Models.swift", "CodexTranscript.swift", "TaskUndoLedger.swift"]
    subprocess.run(["swiftc", "-parse-as-library", *["apps/apple/Sources/FridayKit/"+name for name in files], "apps/apple/Tests/FridayKitTests/TaskUndoLedgerTests.swift", "-o", output], check=True)
    subprocess.run([output, "apps/apple/Tests/FridayKitTests/Fixtures/task-undo-traces.json"], check=True)
PY
