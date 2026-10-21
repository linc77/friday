import Foundation

@main struct TaskHistoryWindowTests {
    static func event(_ n: Int, digest: String? = nil, detail: String? = nil) -> TaskEvent {
        var value = TaskEvent(id: "event-\(n)", kind: "command", text: "command \(n)", at: "2026-10-18T00:00:00.000Z", turnId: "turn", status: "completed", detail: detail)
        value.runId = "run"; value.historyOrder = n; value.historyDigest = digest ?? "digest-\(n)"; return value
    }
    static func task(count: Int, epoch: String = "epoch", version: Int? = nil, live: [TaskEvent], recent: [TaskHistoryRecent] = []) throws -> WorkItem {
        let data = Data(##"{"id":"task","title":"Title","prompt":"Question","projectId":null,"cwd":"/project","agent":"codex","mode":"research","status":"completed","createdAt":"2026-10-18T00:00:00Z","updatedAt":"2026-10-18T00:01:00Z","durableId":null,"threadId":"thread","turnId":"turn","result":"","error":null,"events":[],"approvals":[],"artifact":null,"messages":[{"id":"user","role":"user","text":"Question","at":"2026-10-18T00:00:00Z"}]}"##.utf8)
        var value = try JSONDecoder().decode(WorkItem.self, from: data)
        value.events = live; value.history = TaskHistoryInfo(count: count, version: version ?? count, epoch: epoch, nextCursor: count == 0 ? nil : "cursor", coverage: "complete", recent: recent); return value
    }
    static func main() throws {
        var window = TaskHistoryWindow()
        var live = try task(count: 250, live: [event(250), event(251)])
        window.accept(live, scope: "server-one:task")
        precondition(window.nextEarlier == TaskHistoryRange(lower: 0, upper: 250) && window.nextAutomatic == nil)
        let page = TaskHistoryPage(taskId: "task", epoch: "epoch", version: 250, count: 250, from: 122, to: 250, events: (122..<250).map { event($0) }, nextCursor: "older", coverage: "complete")
        precondition(window.apply(page, live: live, scope: "server-one:task"))
        precondition(window.presenting(live, scope: "server-one:task").events.count == 130)
        precondition(window.nextEarlier == TaskHistoryRange(lower: 0, upper: 122))
        let anchor = CodexTranscript.rows(window.presenting(live, scope: "server-one:task")).last?.id
        let older = TaskHistoryPage(taskId: "task", epoch: "epoch", version: 250, count: 250, from: 0, to: 122, events: (0..<122).map { event($0) }, nextCursor: nil, coverage: "complete")
        precondition(window.apply(older, live: live, scope: "server-one:task"))
        precondition(CodexTranscript.rows(window.presenting(live, scope: "server-one:task")).last?.id == anchor, "Prepending work items preserves the existing work-group scroll anchor")
        precondition(!window.hasEarlier)

        live = try task(count: 252, live: [event(252), event(253)], recent: [TaskHistoryRecent(id: "event-250", position: 250, digest: "digest-250"), TaskHistoryRecent(id: "event-251", position: 251, digest: "digest-251")])
        window.accept(live, scope: "server-one:task")
        precondition(!window.hasEarlier && window.nextAutomatic == nil, "Archiving items already received live does not create a fake earlier-page gap")
        precondition(window.presenting(live, scope: "server-one:task").events.count == 254)

        let latest = event(0, digest: "changed", detail: "new authoritative output")
        live = try task(count: 252, version: 253, live: [latest, event(252), event(253)], recent: [TaskHistoryRecent(id: "event-0", position: 0, digest: "changed")])
        let stalePage = TaskHistoryPage(taskId: "task", epoch: "epoch", version: 250, count: 252, from: 0, to: 1, events: [event(0, detail: "old output")], nextCursor: nil, coverage: "complete")
        precondition(window.apply(stalePage, live: live, scope: "server-one:task"))
        precondition(window.presenting(live, scope: "server-one:task").events.first { $0.id == "event-0" }?.detail == "new authoritative output", "A late page never replaces a newer live item")

        live = try task(count: 400, version: 401, live: [event(400), event(401)])
        window.accept(live, scope: "server-one:task")
        precondition(window.nextAutomatic == TaskHistoryRange(lower: 252, upper: 400), "Reconnect fills a missing range above the already-loaded historical prefix")
        let gap = TaskHistoryPage(taskId: "task", epoch: "epoch", version: 401, count: 400, from: 272, to: 400, events: (272..<400).map { event($0) }, nextCursor: "gap", coverage: "complete")
        precondition(window.apply(gap, live: live, scope: "server-one:task"))
        precondition(window.nextAutomatic == TaskHistoryRange(lower: 252, upper: 272))

        let rewound = try task(count: 400, epoch: "rewound", version: 401, live: [])
        precondition(!window.apply(gap, live: rewound, scope: "server-one:task"), "A stale projection response is rejected before its body enters the new view")
        window.accept(rewound, scope: "server-one:task")
        precondition(window.presenting(rewound, scope: "server-one:task").events.isEmpty)
        precondition(!window.apply(page, live: rewound, scope: "server-two:task"))
        window.accept(rewound, scope: "server-two:task")
        precondition(window.scope == "server-two:task" && window.presenting(rewound, scope: "server-one:task").events.isEmpty)
        let wrongAccountPage = TaskHistoryPage(taskId: "task", epoch: "rewound", version: 401, count: 400, from: 0, to: 1, events: [event(0)], nextCursor: nil, coverage: "complete")
        precondition(!window.apply(wrongAccountPage, live: rewound, scope: "server-one:task"), "Even identical copied task IDs and projection epochs cannot rebind an in-flight page to another account")
        var payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try task(count: 0, live: []))) as! [String: Any]
        payload["messages"] = [["id": "user", "role": "user", "text": "Question", "at": "2026-10-18T00:00:00Z"], ["id": "saved-answer", "role": "assistant", "text": "Saved response", "at": "2026-10-18T00:00:02Z", "turnId": "turn"]]
        var hydrated = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(CodexTranscript.rows(hydrated).last?.id == "saved-answer")
        var nativeAnswer = TaskEvent(id: "native-answer", kind: "message", text: "Saved response", at: "2026-10-18T00:00:01Z", turnId: "turn", phase: "final_answer", status: "completed")
        nativeAnswer.runId = "run"; hydrated.events = [nativeAnswer]
        precondition(CodexTranscript.rows(hydrated).last?.id == "saved-answer", "Hydrating the native final answer preserves the existing message scroll identity")
        nativeAnswer = TaskEvent(id: "native-plan", kind: "proposal", text: "Saved response", at: "2026-10-18T00:00:01Z", turnId: "turn", status: "completed")
        hydrated.events = [nativeAnswer]
        precondition(CodexTranscript.rows(hydrated).last?.id == "saved-answer", "Hydrating a plan also preserves the original assistant-row identity")
        payload["messages"] = [["id": "user", "role": "user", "text": "Question", "at": "2026-10-18T00:00:00Z"], ["id": "saved-answer", "role": "assistant", "text": "Saved response", "at": "2026-10-18T00:01:02Z", "turnId": "turn"]]
        hydrated = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        hydrated.events = [TaskEvent(id: "legacy-native-answer", kind: "message", text: "Saved response", at: "2026-10-18T00:00:01Z", turnId: "turn", status: "completed")]
        let legacyRows = CodexTranscript.rows(hydrated)
        precondition(legacyRows.count == 2 && legacyRows.last?.id == "saved-answer", "An older provider without phase metadata cannot duplicate a long-running saved reply or its ID")
        print("History ranges, reconnect gaps, stable scroll identity, live/page ordering and projection/account isolation passed")
    }
}
