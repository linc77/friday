import Foundation

struct TaskSummaryPatch: Decodable {
    let sessionId: String; let sequence: Int; let serial: Int; let tasks: [WorkItem]; let removed: [String]; let order: [String]?
}
struct TaskDetailSnapshot: Decodable {
    let taskId: String; let sessionId: String; let sequence: Int; let serial: Int; let version: String; let task: WorkItem
}
struct TaskDetailRemoval: Decodable { let taskId: String; let sessionId: String; let sequence: Int; let serial: Int }

// Overview and task bodies have independent cursors. A busy second task must
// not invalidate the selected task's slower HTTP response, while a stale body
// of this task must never replace newer content or a deletion.
struct TaskStreamState {
    private(set) var scope = ""
    private(set) var session: String?
    private(set) var sequence = -1
    private(set) var serial = -1
    private(set) var historyGeneration = 0
    private var details: [String: TaskDetailSnapshot] = [:]
    private var recent: [String] = []
    private var removed: [String: Int] = [:]

    mutating func accept(_ snapshot: Snapshot, scope: String) -> Bool {
        if self.scope != scope { self = TaskStreamState(); self.scope = scope }
        let changedSession = session != snapshot.taskStreamSession
        if !changedSession, snapshot.revision < sequence || snapshot.revision == sequence && (snapshot.taskStreamSerial ?? serial) < serial { return false }
        if changedSession && snapshot.revision < sequence { details = [:]; recent = []; removed = [:]; historyGeneration += 1 }
        session = snapshot.taskStreamSession; sequence = snapshot.revision; serial = snapshot.taskStreamSerial ?? -1
        let ids = Set(snapshot.tasks.map(\.id)); details = details.filter { ids.contains($0.key) }; removed = removed.filter { ids.contains($0.key) }
        recent.removeAll { details[$0] == nil }
        return true
    }
    mutating func apply(_ patch: TaskSummaryPatch, to tasks: [WorkItem], scope: String) -> [WorkItem]? {
        guard self.scope == scope, session == patch.sessionId, patch.sequence >= sequence,
              patch.sequence != sequence || patch.serial >= serial, Set(patch.tasks.map(\.id)).count == patch.tasks.count,
              Set(patch.tasks.map(\.id)).isDisjoint(with: patch.removed) else { return nil }
        let removedIDs = Set(patch.removed)
        var values = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for id in removedIDs { values.removeValue(forKey: id) }
        for task in patch.tasks { values[task.id] = task }
        let order = patch.order ?? (tasks.map(\.id).filter { !removedIDs.contains($0) } + patch.tasks.map(\.id).filter { id in !tasks.contains { $0.id == id } })
        guard Set(order).count == order.count, Set(order) == Set(values.keys) else { return nil }
        for id in removedIDs { details.removeValue(forKey: id); removed[id] = patch.sequence; recent.removeAll { $0 == id } }
        sequence = patch.sequence; serial = patch.serial
        return order.compactMap { values[$0] }
    }
    @discardableResult mutating func accept(_ frame: TaskDetailSnapshot, for id: String, summaries: [WorkItem], scope: String) -> Bool {
        guard id == frame.taskId, self.scope == scope, session == frame.sessionId, frame.taskId == frame.task.id, frame.task.contentOmitted != true,
              frame.task.contentVersion == frame.version, frame.sequence >= 0, frame.serial >= 0,
              let summary = summaries.first(where: { $0.id == frame.taskId && $0.contentOmitted == true }) else { return false }
        if let deleted = removed[frame.taskId], frame.sequence <= deleted { return false }
        if let old = details[frame.taskId], old.sessionId == frame.sessionId {
            if frame.sequence < old.sequence || frame.sequence == old.sequence && frame.serial < old.serial { return false }
        }
        if (summary.contentSequence ?? 0) > frame.sequence && summary.contentVersion != frame.version { return false }
        details[frame.taskId] = frame; removed.removeValue(forKey: frame.taskId); touch(frame.taskId)
        return true
    }
    @discardableResult mutating func accept(_ frame: TaskDetailRemoval, for id: String, scope: String) -> Bool {
        guard id == frame.taskId, self.scope == scope, session == frame.sessionId else { return false }
        if let old = details[frame.taskId], frame.sequence < old.sequence || frame.sequence == old.sequence && frame.serial < old.serial { return false }
        details.removeValue(forKey: frame.taskId); recent.removeAll { $0 == frame.taskId }; removed[frame.taskId] = frame.sequence; return true
    }
    func task(_ id: String, summaries: [WorkItem], scope: String) -> WorkItem? {
        guard self.scope == scope, let summary = summaries.first(where: { $0.id == id }) else { return nil }
        guard summary.contentOmitted == true else { return summary }
        guard let task = details[id]?.task else { return nil }
        if let epoch = summary.history?.epoch, epoch != (task.conversationHistory?.epoch ?? task.history?.epoch) { return nil }
        return task
    }
    func version(_ id: String) -> String? { details[id]?.sessionId == session ? details[id]?.version : nil }
    func isRemoved(_ id: String) -> Bool { removed[id] != nil }
    mutating func touch(_ id: String) { recent.removeAll { $0 == id }; if details[id] != nil { recent.append(id) } }
    mutating func limitDetails(keeping ids: Set<String>, count: Int = 24) {
        while details.count > max(count, ids.count), let oldest = recent.first(where: { !ids.contains($0) }) {
            details.removeValue(forKey: oldest); recent.removeAll { $0 == oldest }
        }
    }
}

enum TaskWorkspaceUpdate { case snapshot(Snapshot), summaries(TaskSummaryPatch) }
struct TaskWorkspaceStream {
    private var event = ""
    mutating func read(_ line: String) throws -> TaskWorkspaceUpdate? {
        if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces); return nil }
        guard line.hasPrefix("data:") else { return nil }
        let data = Data(line.dropFirst(5).utf8); defer { event = "" }
        if event == "snapshot" { return .snapshot(try JSONDecoder().decode(Snapshot.self, from: data)) }
        if event == "taskSummaries" { return .summaries(try JSONDecoder().decode(TaskSummaryPatch.self, from: data)) }
        return nil
    }
}
enum TaskDetailUpdate { case snapshot(TaskDetailSnapshot), removed(TaskDetailRemoval) }
struct TaskDetailStream {
    private var event = ""
    mutating func read(_ line: String) throws -> TaskDetailUpdate? {
        if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces); return nil }
        guard line.hasPrefix("data:") else { return nil }
        let data = Data(line.dropFirst(5).utf8); defer { event = "" }
        if event == "taskSnapshot" { return .snapshot(try JSONDecoder().decode(TaskDetailSnapshot.self, from: data)) }
        if event == "taskRemoved" { return .removed(try JSONDecoder().decode(TaskDetailRemoval.self, from: data)) }
        return nil
    }
}
