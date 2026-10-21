import Foundation

@main struct TaskUndoLedgerTests {
    struct Fixture: Decodable {
        let sourceRevision: String
        let cases: [[Step]]
        let archiveCases: [Availability]
        let draftCases: [DraftContent]
        struct DraftContent: Decodable { let text: String; let images: Int; let contexts: Int; let expected: Bool }
        struct Availability: Decodable { let providerStatus: String; let fridayStatus: String; let active: Bool; let expected: Bool }
        struct Step: Decodable {
            let op: [Value]; let notice: Notice?; let current: [String: Bool]; let undone: [String]
            struct Notice: Decodable { let kind: String; let count: Int }
        }
        enum Value: Decodable {
            case text(String), number(Double)
            init(from decoder: Decoder) throws { let c = try decoder.singleValueContainer(); if let s = try? c.decode(String.self) { self = .text(s) } else { self = .number(try c.decode(Double.self)) } }
            var text: String { if case .text(let value) = self { return value }; return "" }
            var number: Double { if case .number(let value) = self { return value }; return 0 }
        }
    }
    static func main() throws {
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        precondition(fixture.sourceRevision == "8cd9641f76874f2ce17d6c80acd71fab1f0b99d3")
        var total = 0
        for (caseID, steps) in fixture.cases.enumerated() {
            var ledger = TaskUndoLedger(); ledger.synchronize(context: "fixture")
            var now = Date(timeIntervalSince1970: 0), refs: [String: TaskUndoLedger.Claim] = [:], captured: [String: TaskUndoLedger.Notice] = [:], undone: [String] = []
            for (index, step) in steps.enumerated() {
                let op = step.op
                switch op[0].text {
                case "begin": refs[op[1].text] = ledger.begin(TaskUndoKind(rawValue: op[2].text)!, taskID: op[3].text)
                case "record": let claim = refs[op[1].text]!; _ = ledger.record(claim, restore: .init(taskID: claim.key.taskID, kind: claim.key.kind), now: now)
                case "capture": captured[op[1].text] = ledger.notice
                case "invalidate": ledger.invalidate(TaskUndoKind(rawValue: op[1].text)!, taskID: op[2].text)
                case "advance": now = now.addingTimeInterval(op[1].number / 1000); ledger.expire(now: now)
                case "undo":
                    if let notice = op.count > 1 ? captured[op[1].text] : ledger.notice { undone += ledger.consume(notice, now: now).map { $0.restore.taskID } }
                default: preconditionFailure("Unknown reference operation")
                }
                precondition(ledger.notice?.kind.rawValue == step.notice?.kind && ledger.notice?.count == step.notice?.count, "Notice trace \(caseID):\(index)")
                precondition(refs.mapValues(ledger.isCurrent) == step.current, "Claim trace \(caseID):\(index)")
                precondition(undone == step.undone, "Undo trace \(caseID):\(index)")
                total += 1
            }
        }
        var scoped = TaskUndoLedger(); scoped.synchronize(context: "old")
        let claim = scoped.begin(.archive, taskID: "A"); _ = scoped.record(claim, restore: .init(taskID: "A", kind: .archive), now: .now)
        scoped.synchronize(context: "new"); precondition(!scoped.isCurrent(claim) && scoped.notice == nil)
        let current = scoped.begin(.pin, taskID: "B"); _ = scoped.record(current, restore: .init(taskID: "B", kind: .pin), now: .now); scoped.removeMissing([]); precondition(scoped.notice == nil)
        let restore = TaskUndoRestore(taskID: "A", kind: .settle, wasPinned: true, pinOrderKey: "m", snoozedUntil: "2099-01-01T00:00:00Z").body
        precondition(restore["settled"] as? Bool == false && restore["pinned"] as? Bool == true && restore["pinOrderKey"] as? String == "m" && restore["snoozedUntil"] as? String == "2099-01-01T00:00:00Z")
        try archives(fixture.archiveCases)
        for value in fixture.draftCases { precondition(TaskDraftContent.hasUserContent(value.text, images: value.images, contexts: value.contexts) == value.expected) }
        let discarded = scoped.begin(.discard, taskID: "new-draft"); _ = scoped.record(discarded, restore: .init(taskID: "new-draft", kind: .discard), now: .now)
        scoped.removeMissing([]); precondition(scoped.isCurrent(discarded), "Local drafts are not task IDs and survive task-list pruning")
        scoped.synchronize(context: "other-account"); precondition(!scoped.isCurrent(discarded) && scoped.notice == nil)
        print("\(total) independent pinned T3 Undo states, \(fixture.archiveCases.count) archive availability and \(fixture.draftCases.count) draft-content cases, five-second expiry, grouped restore, stale claims, scope isolation and archive ordering passed")
    }
    static func archives(_ availability: [Fixture.Availability]) throws {
        let base: [String: Any] = ["id": "a", "title": "Old title", "prompt": "kept", "result": "kept", "agent": "codex", "mode": "research", "status": "completed", "cwd": "/workspace", "projectId": "p", "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-19T00:00:00Z", "archivedAt": "2026-10-18T00:00:00Z", "events": [], "approvals": []]
        func task(_ id: String, archived: String? = nil, project: String = "p", status: String = "completed", currentRun: Bool = false) throws -> WorkItem {
            var value = base; value["id"] = id; value["projectId"] = project; value["status"] = status
            if currentRun { value["currentRunId"] = "r" }; if let archived { value["archivedAt"] = archived }
            return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let projects = [Project(id: "p", name: "Project", path: "/workspace", context: ""), Project(id: "empty", name: "Empty", path: "/empty", context: "")]
        let tasks = try [task("a"), task("b"), task("new", archived: "2026-10-20T00:00:00Z"), task("orphan", project: "removed")]
        let groups = TaskArchiveIndex.groups(tasks: tasks, projects: projects, scope: nil)
        precondition(groups.map(\.id) == ["p", "removed"] && groups[0].tasks.map(\.id) == ["new", "b", "a"])
        precondition(TaskArchiveIndex.groups(tasks: tasks, projects: projects, scope: "p").count == 1)
        precondition(TaskArchiveIndex.groups(tasks: tasks, projects: projects, scope: "empty").isEmpty)
        var active = tasks[0]; active.archivedAt = nil
        precondition(TaskArchiveIndex.groups(tasks: [active], projects: projects, scope: nil).isEmpty)
        for value in availability {
            var candidate = try task("availability", status: value.fridayStatus, currentRun: value.active); candidate.archivedAt = nil
            precondition(TaskArchiveIndex.canArchive(candidate, lifecycleSupported: true) == value.expected, value.providerStatus)
        }
        active.archiveCleanup = .init(id: "cleanup", durableId: 1, status: "pending", startedAt: "now")
        precondition(active.sessionBusy && !TaskArchiveIndex.canArchive(active, lifecycleSupported: true))
        active.archivedAt = "now"; precondition(TaskArchiveIndex.canArchive(active, lifecycleSupported: true), "Restore stays available while cleanup is pending")
    }
}
