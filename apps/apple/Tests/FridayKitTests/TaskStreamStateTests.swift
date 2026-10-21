import Foundation

@main struct TaskStreamStateTests {
    static func decode<T: Decodable>(_ type: T.Type, _ value: [String: Any]) throws -> T { try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value)) }
    static func body(_ id: String, _ version: String, omitted: Bool = true, sequence: Int = 10, text: String = "") -> [String: Any] {
        ["id": id, "title": id, "prompt": text, "projectId": NSNull(), "cwd": "/project", "agent": "codex", "mode": "code", "status": "completed", "createdAt": "", "updatedAt": "",
         "durableId": NSNull(), "threadId": NSNull(), "turnId": NSNull(), "result": text, "events": [], "approvals": [], "artifact": NSNull(), "contentOmitted": omitted, "contentVersion": version, "contentSequence": sequence]
    }
    static func snapshot(_ sequence: Int, _ serial: Int, _ session: String?, _ tasks: [[String: Any]]) throws -> Snapshot {
        var value: [String: Any] = ["revision": sequence, "ideas": [], "projects": [], "memories": [], "tasks": tasks, "taskStreamSerial": serial]
        if let session { value["taskStreamSession"] = session }
        return try decode(Snapshot.self, value)
    }
    static func frame(_ sequence: Int, _ serial: Int, _ session: String = "service", _ id: String = "a", _ version: String = "v1", _ text: String = "full body") throws -> TaskDetailSnapshot {
        try decode(TaskDetailSnapshot.self, ["taskId": id, "sessionId": session, "sequence": sequence, "serial": serial, "version": version, "task": body(id, version, omitted: false, sequence: sequence, text: text)])
    }
    static func main() async throws {
        var state = TaskStreamState(); let scope = "account one"
        let initial = try snapshot(10, 1, "service", [body("a", "v1"), body("b", "b1")])
        precondition(state.accept(initial, scope: scope)); var tasks = initial.tasks
        precondition(state.task("a", summaries: tasks, scope: scope) == nil)
        let first = try frame(10, 1)
        precondition(state.accept(first, for: "a", summaries: tasks, scope: scope))
        precondition(state.task("a", summaries: tasks, scope: scope)?.result == "full body")
        var projectionCache = TaskStreamState(); _ = projectionCache.accept(initial, scope: scope)
        _ = projectionCache.accept(first, for: "a", summaries: initial.tasks, scope: scope)
        var rewoundSummary = initial.tasks[0]
        rewoundSummary.history = try decode(TaskHistoryInfo.self, ["count": 0, "version": 0, "epoch": "new projection", "coverage": "complete", "recent": []])
        precondition(projectionCache.task("a", summaries: [rewoundSummary], scope: scope) == nil, "A new sidebar projection cannot render a cached body from an unknown/older epoch")
        precondition(!state.accept(first, for: "b", summaries: tasks, scope: scope))
        var bounded = TaskStreamState(); _ = bounded.accept(initial, scope: scope)
        _ = bounded.accept(first, for: "a", summaries: tasks, scope: scope)
        let second = try frame(10, 2, "service", "b", "b1", "second")
        _ = bounded.accept(second, for: "b", summaries: tasks, scope: scope)
        bounded.limitDetails(keeping: ["a"], count: 1)
        precondition(bounded.task("a", summaries: tasks, scope: scope) != nil && bounded.task("b", summaries: tasks, scope: scope) == nil)
        let later = try snapshot(100, 2, "service", [body("a", "v1", sequence: 100), body("b", "b2", sequence: 100)])
        precondition(state.accept(later, scope: scope)); tasks = later.tasks
        let own = try frame(11, 2)
        precondition(state.accept(own, for: "a", summaries: tasks, scope: scope), "Another task's newer overview cursor does not invalidate unchanged content")
        let patch = try decode(TaskSummaryPatch.self, ["sessionId": "service", "sequence": 101, "serial": 3, "tasks": [body("a", "v2", sequence: 101)], "removed": []])
        tasks = state.apply(patch, to: tasks, scope: scope)!
        let stale = try frame(100, 10)
        precondition(!state.accept(stale, for: "a", summaries: tasks, scope: scope))
        let current = try frame(101, 10, "service", "a", "v2", "new body")
        precondition(state.accept(current, for: "a", summaries: tasks, scope: scope))
        let slowHTTP = try frame(101, 9, "service", "a", "v2", "late HTTP")
        precondition(!state.accept(slowHTTP, for: "a", summaries: tasks, scope: scope))
        precondition(state.task("a", summaries: tasks, scope: scope)?.result == "new body")
        precondition(!state.accept(current, for: "a", summaries: tasks, scope: "another account"))
        let removal = TaskDetailRemoval(taskId: "a", sessionId: "service", sequence: 102, serial: 11)
        precondition(state.accept(removal, for: "a", scope: scope)); precondition(state.isRemoved("a"))
        precondition(!state.accept(current, for: "a", summaries: tasks, scope: scope))
        let invalidOrder = try decode(TaskSummaryPatch.self, ["sessionId": "service", "sequence": 103, "serial": 4, "tasks": [], "removed": [], "order": ["a", "a"]])
        precondition(state.apply(invalidOrder, to: tasks, scope: scope) == nil && state.sequence == 101)
        let deletion = try decode(TaskSummaryPatch.self, ["sessionId": "service", "sequence": 103, "serial": 4, "tasks": [], "removed": ["a"], "order": ["b"]])
        tasks = state.apply(deletion, to: tasks, scope: scope)!; precondition(tasks.map(\.id) == ["b"])
        let deletedLate = try frame(104, 20)
        precondition(!state.accept(deletedLate, for: "a", summaries: tasks, scope: scope))
        let b = try frame(103, 20, "service", "b", "b2", "expanded history")
        precondition(state.accept(b, for: "b", summaries: tasks, scope: scope))
        let restart = try snapshot(104, 1, "new service", [body("b", "b2", sequence: 104)])
        precondition(state.accept(restart, scope: scope)); tasks = restart.tasks
        precondition(state.task("b", summaries: tasks, scope: scope)?.result == "expanded history", "A normal service restart retains already loaded content")
        precondition(!state.accept(b, for: "b", summaries: tasks, scope: scope)); precondition(state.version("b") == nil)
        let restored = try snapshot(2, 1, "restored database", [body("b", "old", sequence: 2)])
        precondition(state.accept(restored, scope: scope)); precondition(state.historyGeneration == 1)
        precondition(state.task("b", summaries: restored.tasks, scope: scope) == nil)
        let legacy = try snapshot(200, 1, nil, [body("legacy", "", omitted: false, text: "legacy reply")])
        precondition(state.accept(legacy, scope: scope)); precondition(state.task("legacy", summaries: legacy.tasks, scope: scope)?.result == "legacy reply")
        var historyTask = try decode(WorkItem.self, body("history", "v1", omitted: false))
        historyTask.history = try decode(TaskHistoryInfo.self, ["count": 0, "version": 0, "epoch": "projection-one", "coverage": "complete", "recent": []])
        var window = TaskHistoryWindow(); window.accept(historyTask, scope: "account:history")
        var histories = TaskViewHistoryCache(); histories.save(task: historyTask, scope: "account:history", history: window, conversation: TaskConversationWindow())
        precondition(histories.load(task: historyTask, scope: "account:history") != nil)
        precondition(histories.load(task: historyTask, scope: "another account:history") == nil)
        historyTask.history = try decode(TaskHistoryInfo.self, ["count": 0, "version": 0, "epoch": "rewound", "coverage": "complete", "recent": []])
        precondition(histories.load(task: historyTask, scope: "account:history") == nil)
        histories.retain([]); precondition(histories.load(task: historyTask, scope: "account:history") == nil)
        if CommandLine.arguments.count > 1 { try await network(CommandLine.arguments[1]) }
        print("Task overview/detail isolation, independent cursors, restart/deletion guards and actual URLSession SSE checks passed")
    }
    static func network(_ base: String) async throws {
        for route in ["overview", "task", "output", "terminal", "live"] {
            var request = URLRequest(url: URL(string: base + "/" + route)!); request.timeoutInterval = 10
            let (bytes, response) = try await URLSession.shared.bytes(for: request)
            precondition((response as? HTTPURLResponse)?.statusCode == 200)
            var workspace = TaskWorkspaceStream(); var detail = TaskDetailStream(); var output = TaskOutputStream(); var terminal = TaskTerminalStream(); var count = 0
            for try await line in bytes.lines {
                switch route {
                case "overview": if try workspace.read(line) != nil { count += 1 }
                case "task": if try detail.read(line) != nil { count += 1 }
                case "output": if let value = try output.read(line) { count += 1; precondition(value.text.contains("你好 🚀")) }
                case "live":
                    if case .snapshot(let frame) = try detail.read(line) {
                        count += 1
                        let text = CodexTranscript.rows(frame.task).flatMap { row -> [String] in
                            if case .work(let events) = row.content { return events.map(\.text) }; return []
                        }
                        precondition(text.contains("正在分析项目 🚀") && text.contains("先检查执行链路。"))
                        if frame.task.status == "running" {
                            precondition(count == 1)
                            var release = URLRequest(url: URL(string: base + "/live/release")!); release.httpMethod = "POST"; release.timeoutInterval = 5
                            let (_, reply) = try await URLSession.shared.data(for: release)
                            precondition((reply as? HTTPURLResponse)?.statusCode == 204, "Native timeline must receive the running text before completion is released")
                        } else { precondition(count == 2 && frame.task.status == "completed") }
                    }
                default: if try terminal.read(line) != nil { count += 1 }
                }
            }
            precondition(count == 2, "Actual AsyncBytes.lines must deliver both \(route) frames without empty SSE lines")
        }
    }
}
