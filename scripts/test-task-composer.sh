#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import os, pathlib, subprocess, tempfile
sources = ["Models.swift", "CodexTranscript.swift", "TaskComposerCommands.swift", "TaskContextDocument.swift", "TaskAssistantCitation.swift", "TaskContextText.swift"]
files = ["apps/apple/Sources/FridayKit/" + name for name in sources]
test = "apps/apple/Tests/FridayKitTests/TaskComposerCommandTests.swift"
fixture = "apps/apple/Tests/FridayKitTests/Fixtures/task-composer-command-search.json"
environment = {"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "LANG": "en_US.UTF-8"}
with tempfile.TemporaryDirectory(prefix="friday-composer-check-") as directory:
    output = str(pathlib.Path(directory) / "check")
    subprocess.run(["swiftc", "-parse-as-library", *files, test, "-o", output], env=environment, check=True)
    subprocess.run([output, fixture], env=environment, check=True)
PY
