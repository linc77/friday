import Foundation

@main
struct TaskOutputProtocolTests {
    static func main() throws {
        let scope = TaskOutputScope(connection: "account-one", taskID: "task", eventID: "codex:turn/item", epoch: "epoch")
        precondition(scope.path == "/api/tasks/task/history/items/codex%3Aturn%2Fitem?epoch=epoch")
        precondition(scope.streamPath.hasSuffix("codex%3Aturn%2Fitem/output?epoch=epoch"))
        precondition(scope.key != TaskOutputScope(connection: "account-two", taskID: scope.taskID, eventID: scope.eventID, epoch: scope.epoch).key)
        var decoder = TaskOutputStream()
        _ = try decoder.read("event: ping"); _ = try decoder.read("data: {}")
        let ping = try decoder.read(""); precondition(ping == nil)
        _ = try decoder.read("event: output")
        let frame = try decoder.read(#"data: {"taskId":"task","eventId":"codex:turn/item","epoch":"epoch","text":"你好 🚀\n","truncated":false,"running":true}"#)!
        precondition(frame.text == "你好 🚀\n" && frame.running && scope.accepts(frame))
        precondition(!TaskOutputScope(connection: "account-one", taskID: "other", eventID: scope.eventID, epoch: scope.epoch).accepts(frame))
        precondition(!TaskOutputScope(connection: "account-one", taskID: scope.taskID, eventID: scope.eventID, epoch: "rewound").accepts(frame))
        let native = TaskOutputScope(connection: scope.connection, taskID: "task", eventID: "claude-bg:owned", epoch: "native-process", native: true)
        precondition(native.streamPath == "/api/tasks/task/background/claude-bg%3Aowned/output?sessionId=native-process")
        precondition(native.accepts(TaskCommandOutputFrame(taskId: "task", eventId: "claude-bg:owned", epoch: "native-process", text: "late", truncated: false, running: true)))
        precondition(!native.accepts(TaskCommandOutputFrame(taskId: "task", eventId: "claude-bg:owned", epoch: "old-process", text: "stale", truncated: false, running: true)))
        let work = try JSONDecoder().decode(TaskNativeBackgroundWork.self, from: Data(#"{"id":"owned","provider":"claude","sessionId":"thread","transportId":"process","taskId":"native","generation":0,"kind":"monitor","status":"running","member":true,"backgrounded":true,"ambient":false,"description":"Watch","startedAt":"","updatedAt":""}"#.utf8))
        precondition(work.visible && work.label == "监视器")
        let activity = try JSONDecoder().decode(TaskBackgroundActivity.self, from: Data(#"{"commands":1,"unknownCommands":0,"monitors":1,"subagents":2}"#.utf8))
        precondition(activity.total == 4)
        let interrupted = try JSONDecoder().decode(TaskNativeBackgroundWork.self, from: Data(#"{"id":"owned","provider":"claude","sessionId":"thread","transportId":"process","taskId":"native","generation":0,"kind":"monitor","status":"interrupted","member":false,"backgrounded":true,"ambient":false,"description":"Watch","startedAt":"","updatedAt":""}"#.utf8))
        precondition(interrupted.terminal && !interrupted.visible, "A host interrupt must not remain a running monitor")
        var payload: [String: Any] = ["id": "task", "title": "Task", "agent": "claude", "prompt": "", "cwd": "/project", "mode": "code", "status": "completed", "createdAt": "", "updatedAt": "", "events": [], "approvals": [], "result": "Answer", "executionSessionId": "process", "currentRunId": "run"]
        let operation: [String: Any] = ["requestId": "stop", "durableId": 1, "sessionId": "process", "runId": "run", "startedAt": "", "status": "uncertain"]
        payload["backgroundStop"] = operation
        func task() throws -> WorkItem { try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload)) }
        var projected = try task()
        precondition(projected.backgroundStopAvailable, "An uncertain owned Stop remains available for explicit reconciliation")
        payload["currentRunId"] = "newer-run"
        projected = try task()
        precondition(!projected.backgroundStopAvailable, "An old Stop cannot authorize stopping a newer turn")
        payload["backgroundActivity"] = ["commands": 0, "unknownCommands": 0, "canStop": true]
        projected = try task()
        precondition(projected.backgroundStopAvailable, "The overview's authoritative availability is sufficient without command bodies")
        payload["backgroundActivity"] = ["commands": 0, "unknownCommands": 0, "canStop": false]
        projected = try task()
        precondition(!projected.backgroundStopAvailable)
        payload["backgroundStop"] = operation.merging(["status": "pending"]) { _, new in new }
        projected = try task()
        precondition(projected.sessionBusy, "A pending whole Stop protects other session operations")
        _ = try decoder.read("event: error")
        do { _ = try decoder.read(#"data: {"error":"history removed"}"#); preconditionFailure("Server errors must end the old stream") } catch { precondition(error.localizedDescription == "history removed") }
        var oversized = TaskOutputStream()
        do { _ = try oversized.read("data: " + String(repeating: "x", count: 1024 * 1024 + 1)); preconditionFailure("An oversized frame must be rejected") } catch TaskOutputError.oversizedFrame {}
        let json = #"{"taskId":"task","epoch":"epoch","sequence":3,"event":{"id":"codex:turn/item","kind":"tool","text":"Read","at":"","status":"completed","detail":"full output","historyDigest":"fresh"}}"#
        let detail = try JSONDecoder().decode(TaskEventDetail.self, from: Data(json.utf8))
        var event = detail.event; event.detailOmitted = true
        precondition(scope.detail(detail, event: event)?.detail == "full output")
        event.historyDigest = "newer"
        precondition(scope.detail(detail, event: event) == nil, "A stale detail cannot overwrite a newer completed result")
        let changed = TaskOutputScope(connection: scope.connection, taskID: scope.taskID, eventID: scope.eventID, epoch: "new projection")
        precondition(changed.detail(detail, event: detail.event) == nil)
        var removed = detail.event; removed.revertedAt = "rewound"
        let removedDetail = TaskEventDetail(taskId: "task", epoch: "epoch", sequence: 4, event: removed)
        precondition(scope.detail(removedDetail, event: detail.event) == nil, "Audited output is not visible output")
        let text = "plain \u{1b}[0;1;31m红色 🚀\u{1b}[0m\n\u{1b}[0;38;2;12;34;56mRGB\u{1b}[0m"
        let spans = TaskOutputText.spans(text)
        precondition(TaskOutputText.plain(text) == "plain 红色 🚀\nRGB")
        precondition(spans.first(where: { $0.text == "红色 🚀" })?.style.bold == true)
        precondition(spans.first(where: { $0.text == "红色 🚀" })?.style.foreground == .indexed(1))
        precondition(spans.last?.style.foreground == .rgb(12, 34, 56))
        let legacy = try JSONDecoder().decode(TaskEvent.self, from: Data(#"{"id":"old","kind":"command","text":"pwd","at":"","detail":"saved output"}"#.utf8))
        precondition(legacy.detailOmitted == nil && legacy.detail == "saved output")
        print("Task output protocol, detail scope and ANSI presentation checks passed")
    }
}
