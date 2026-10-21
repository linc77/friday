import Foundation

@main
struct TaskExecutionPresentationTests {
    static func main() throws {
        let patch = "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -3,3 +3,4 @@\n context\n-old\n+replacement\n+second\n tail\n@@ -20 +21 @@\n---header text\n+++new header text\n\\ No newline at end of file\n"
        let lines = TaskDiffDocument.lines(patch)
        let added = lines.filter { $0.kind == .addition }
        precondition(added.map(\.newNumber) == [4, 5, 21])
        precondition(added.last?.text == "++new header text", "Source lines beginning with ++ retain their content within a hunk")
        precondition(lines.filter { $0.kind == .deletion }.map(\.oldNumber) == [4, 20])
        let pairs = TaskDiffDocument.pairs(lines)
        let replacement = pairs.first { $0.left?.text == "old" }
        precondition(replacement?.right?.text == "replacement")
        precondition(pairs.contains { $0.left == nil && $0.right?.text == "second" }, "Unequal replacement blocks preserve blank alignment cells")
        precondition(pairs.filter { $0.full?.kind == .hunk }.count == 2)
        precondition(lines.last?.kind == .note)
        let rawPatch = TaskDiffDocument.lines("@@\n-old\n+new\n")
        precondition(rawPatch[1].oldNumber == nil && rawPatch[2].newNumber == nil, "Codex hunks without offsets do not invent line numbers")

        let paths = ["/project/src/a.swift", "/project/src/nested/b.swift", "/project/README.md"]
        let tree = TaskFileTree.rows(paths: paths, cwd: "/project")
        precondition(tree.map(\.path) == ["src", "src/nested", "src/nested/b.swift", "src/a.swift", "README.md"])
        precondition(tree[2].originalPath == "/project/src/nested/b.swift")
        precondition(TaskFileTree.rows(paths: paths, cwd: "/project", collapsed: ["src"]).map(\.path) == ["src", "README.md"])
        precondition(TaskFileTree.directories(paths: paths, cwd: "/project") == ["src", "src/nested"])
        precondition(TaskExecutionPresentation.relativePath("/project-other/file", cwd: "/project") == "/project-other/file")

        let markdown = "<proposed_plan>\n# Durable Tasks\n\n## Summary\n\nMake it persistent.\n\n1. Inspect\n\n2. Change\n\n3. Verify\n</proposed_plan>"
        precondition(TaskExecutionPresentation.planTitle(markdown) == "Durable Tasks")
        precondition(TaskExecutionPresentation.planFilename(markdown) == "durable-tasks.md")
        precondition(TaskExecutionPresentation.displayedPlan(markdown).hasPrefix("Make it persistent."))
        precondition(TaskExecutionPresentation.planPreview(markdown, maxLines: 2) == "Make it persistent.\n\n1. Inspect\n\n...")
        precondition(TaskExecutionPresentation.planMarkdown("# Title\n\nUse `<proposed_plan>` as a literal.").contains("`<proposed_plan>`"))
        let prefs = TaskPanelPreferences(diff: TaskDiffSelection(eventID: "historical-event", path: "src/a.swift"), width: 540)
        let restored = try JSONDecoder().decode(TaskPanelPreferences.self, from: JSONEncoder().encode(prefs))
        precondition(restored.diff == prefs.diff && restored.width == 540)

        let legacyEvent = try JSONDecoder().decode(TaskEvent.self, from: Data(##"{"id":"old","kind":"plan","text":"# Legacy plan","at":"2026-10-17T12:00:00Z","itemId":"proposal-item"}"##.utf8))
        precondition(CodexTranscript.isProposal(legacyEvent) && legacyEvent.changes == nil)
        var event = legacyEvent
        event.plan = [TaskPlanStep(step: "Inspect", status: "pending")]
        precondition(!CodexTranscript.isProposal(event), "Execution steps never become a proposed plan")
        let legacyTask = ##"{"id":"task","title":"Title","prompt":"Question","projectId":null,"cwd":"/project","agent":"codex","mode":"research","status":"completed","createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T12:00:00Z","durableId":1,"threadId":"thread","turnId":"turn","result":"# Legacy plan","error":null,"events":[],"approvals":[],"artifact":null}"##
        var payload = try JSONSerialization.jsonObject(with: Data(legacyTask.utf8)) as! [String: Any]
        payload["events"] = [try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacyEvent))]
        let task = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        let rows = CodexTranscript.rows(task)
        precondition(rows.count == 2, "The saved result does not duplicate a proposed-plan event")
        guard case .proposal = rows.last?.content else { preconditionFailure("Render a dedicated proposed-plan card") }
        var planEvent = try JSONSerialization.jsonObject(with: JSONEncoder().encode(legacyEvent)) as! [String: Any]
        planEvent["kind"] = "proposal"; planEvent["turnId"] = "turn"; planEvent["status"] = "completed"
        payload["events"] = [planEvent]; payload["interactionMode"] = "plan"
        payload["messages"] = [["id": "initial", "role": "user", "text": "Question", "at": "2026-10-17T10:00:00Z"],
                               ["id": "saved-plan-answer", "role": "assistant", "text": "# Legacy plan", "turnId": "turn", "at": "2026-10-17T12:05:00Z"]]
        let planning = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(TaskExecutionPresentation.currentPlan(planning, mode: "plan", editing: false)?.id == "old")
        precondition(TaskExecutionPresentation.currentPlan(planning, mode: "default", editing: false) == nil)
        precondition(TaskExecutionPresentation.currentPlan(planning, mode: "plan", editing: true) == nil)
        precondition(CodexTranscript.rows(planning).count == 2, "A plan generated for more than five seconds still deduplicates by its native turn")

        let runPrefs = TaskPanelPreferences(diff: TaskDiffSelection(runID: "1", path: "file"), width: 500)
        let restoredRunPrefs = try JSONDecoder().decode(TaskPanelPreferences.self, from: JSONEncoder().encode(runPrefs))
        precondition(restoredRunPrefs.diff == runPrefs.diff)
        var run: [String: Any] = ["id": "1", "durableId": 1, "messageId": "user-1", "requestId": "request-1", "cwd": "/project", "at": "2026-10-17T12:00:00Z", "status": "completed", "completedAt": "2026-10-17T12:00:04Z", "mode": "code", "interactionMode": "default",
            "changes": [["path": "file", "kind": "update", "additions": 1, "deletions": 1, "binary": false]]]
        payload = try JSONSerialization.jsonObject(with: Data(legacyTask.utf8)) as! [String: Any]
        payload["result"] = "Second answer"
        payload["messages"] = [
            ["id": "user-1", "role": "user", "text": "First", "at": "2026-10-17T12:00:00Z", "runId": "1"],
            ["id": "answer-1", "role": "assistant", "text": "First answer", "at": "2026-10-17T12:00:05Z", "runId": "1"],
            ["id": "user-2", "role": "user", "text": "Second", "at": "2026-10-17T12:00:06Z", "runId": "2"],
            ["id": "answer-2", "role": "assistant", "text": "Second answer", "at": "2026-10-17T12:00:07Z", "runId": "2"]
        ]
        payload["events"] = [["id": "patch-1", "kind": "files", "text": "Applied patch", "at": "2026-10-17T12:00:02Z", "runId": "1", "status": "completed",
            "changes": [["path": "file", "kind": "update", "diff": "@@\n-old\n+new\n", "additions": 1, "deletions": 1]]]]
        payload["runs"] = [run]
        func transcript() throws -> [CodexTranscriptRow] { CodexTranscript.rows(try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))) }
        let netRows = try transcript()
        let netIndex = netRows.firstIndex { if case .runChanges = $0.content { return true }; return false }!
        precondition(netRows[netIndex - 1].id == "answer-1" && netRows[netIndex + 1].id == "user-2", "The whole-turn card follows its answer, before the next request")
        precondition(!netRows.contains { if case .changes = $0.content { return true }; return false }, "Per-tool patches remain in the work log after a complete net diff is known")
        run["changes"] = []; payload["runs"] = [run]
        let emptyNetRows = try transcript()
        precondition(!emptyNetRows.contains { if case .runChanges = $0.content { return true }; return false }, "Changes undone within a turn have no misleading card")
        payload.removeValue(forKey: "runs")
        let fallbackRows = try transcript()
        precondition(fallbackRows.contains { if case .changes = $0.content { return true }; return false }, "Legacy and interrupted turns retain saved per-tool patches")
        var history = payload["messages"] as! [[String: Any]]
        history[2]["revertedAt"] = "2026-10-17T12:01:00Z"; history[3]["revertedAt"] = "2026-10-17T12:01:00Z"
        payload["messages"] = history; payload["result"] = "First answer"
        payload["rewindOperation"] = ["id": "rewind", "durableId": 3, "requestId": "request", "messageId": "user-2", "runId": "2", "status": "needs_review", "phase": "files", "restoreFiles": true, "updatedAt": "2026-10-17T12:01:00Z", "attempt": 0,
            "editor": ["text": "Second", "images": [], "interactionMode": "default"]]
        let rewound = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(rewound.rewindBusy && !rewound.active, "A pending rewind holds input without masquerading as an Agent turn")
        precondition(rewound.conversation.map(\.text) == ["First", "First answer"], "Reverted messages remain in audit data without reappearing in visible history")
        precondition(rewound.rewindOperation?.editor.text == "Second")
        precondition(netRows.first { $0.id == "answer-1" }?.runID == "1", "The response keeps its exact run identity for forking")
        payload.removeValue(forKey: "rewindOperation")
        run["durableId"] = NSNull(); payload["runs"] = [run]; payload["durableId"] = NSNull()
        payload["forkOrigin"] = ["taskId": "source", "runId": "source-run", "title": "Source task", "rootTaskId": "root"]
        payload["forkOperation"] = ["id": "fork", "status": "interrupted", "updatedAt": "2026-10-18T12:01:00Z", "sourceTaskId": "source", "sourceRunId": "source-run", "startedAt": "2026-10-18T12:00:00Z", "candidateId": "candidate"]
        var forked = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(forked.forkBusy && forked.sessionBusy && !forked.rewindBusy && !forked.active, "A pending native fork holds input without becoming an Agent Working turn")
        precondition(forked.runs?.first?.durableId == nil && forked.forkOrigin?.rootTaskId == "root", "Inherited runs never take ownership of the source Durable task")
        payload["forkOperation"] = ["id": "fork", "status": "completed", "updatedAt": "2026-10-18T12:01:00Z", "sourceTaskId": "source", "sourceRunId": "source-run", "strategy": "native"]
        forked = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(!forked.sessionBusy, "Confirmed fork results release the composer")
        var nativePayload = try JSONSerialization.jsonObject(with: Data(legacyTask.utf8)) as! [String: Any]
        nativePayload["result"] = ""; nativePayload["messages"] = []; nativePayload["events"] = [
            ["id": "before-child", "kind": "tool", "text": "Read", "at": "2026-10-18T12:00:00Z"],
            ["id": "native-child", "kind": "subagent", "subagentId": "native", "text": "Inspect", "at": "2026-10-18T12:00:01Z", "status": "running"],
            ["id": "after-child", "kind": "tool", "text": "Search", "at": "2026-10-18T12:00:02Z"]
        ]
        let nativeTask = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        let nativeRows = CodexTranscript.rows(nativeTask)
        guard let nativeRow = nativeRows.first(where: { $0.id == "native-child" }), case .subagent(let nativeEvent) = nativeRow.content else { preconditionFailure("Native subagent navigation must remain visible outside folded tool logs") }
        precondition(nativeEvent.subagentId == "native")
        nativePayload["subagentOrigin"] = ["rootTaskId": "parent", "parentTaskId": "parent", "subagentId": "native", "sessionId": "process", "threadId": "provider", "nativeId": "agent", "status": "running"]
        nativePayload["result"] = "Older preview"
        nativePayload["messages"] = []
        nativePayload["events"] = [["id": "live-native-message", "kind": "message", "text": "Current child answer", "at": "2026-10-18T12:00:01Z", "phase": "final_answer", "status": "running"]]
        let streamingChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        let childRows = CodexTranscript.rows(streamingChild)
        precondition(childRows.count == 1, "A lagging child result preview must never create a second reply")
        guard case .reply("Current child answer") = childRows[0].content else { preconditionFailure("The native child's own conversation text must not be hidden in a tool fold") }
        nativePayload["threadId"] = "agent"
        nativePayload["events"] = [
            ["id": "codex:native-turn-1:turn", "kind": "turn", "itemId": "turn", "turnId": "observed-turn", "nativeTurnId": "native-turn-1", "text": "", "at": "2026-10-18T12:00:00Z", "status": "completed"],
            ["id": "native-answer", "kind": "message", "text": "Native answer", "turnId": "observed-turn", "at": "2026-10-18T12:00:01Z", "phase": "final_answer", "status": "completed"]
        ]
        var forkableChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        precondition(forkableChild.runs == nil && TaskNativeForkBoundary.supported(forkableChild, id: "observed-turn"), "A completed native reply forks without a fabricated Friday execution")
        precondition(CodexTranscript.rows(forkableChild).last?.nativeTurnID == "observed-turn")
        nativePayload["status"] = "running"
        forkableChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        precondition(TaskNativeForkBoundary.supported(forkableChild, id: "observed-turn"), "Earlier native replies remain forkable while a later Codex turn runs")
        var nativeEvents = nativePayload["events"] as! [[String: Any]]
        nativeEvents[0]["status"] = "running"; nativePayload["events"] = nativeEvents
        forkableChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        precondition(!TaskNativeForkBoundary.supported(forkableChild, id: "observed-turn"))
        precondition(CodexTranscript.rows(forkableChild).last?.nativeTurnID == nil)
        nativeEvents[0]["status"] = "completed"; nativeEvents[0].removeValue(forKey: "nativeTurnId"); nativePayload["events"] = nativeEvents
        forkableChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        precondition(TaskNativeForkBoundary.supported(forkableChild, id: "observed-turn"), "Previously saved native markers retain their fork boundary")
        nativePayload["agent"] = "claude"
        forkableChild = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: nativePayload))
        precondition(!TaskNativeForkBoundary.supported(forkableChild, id: "observed-turn"))
        print("Diff alignment, native and Friday fork boundaries, historical identity, plan preview, fork lineage and transcript deduplication passed")
    }
}
