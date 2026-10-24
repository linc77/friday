import Foundation

struct CodexTranscriptRow: Identifiable {
    enum Content { case user(String), reply(String), proposal(TaskEvent), subagent(TaskEvent), changes(TaskEvent), runChanges(TaskRun), work([TaskEvent]) }
    let id: String
    let content: Content
    var runID: String? = nil
    var nativeTurnID: String? = nil
    var isStreaming = false
}

enum TaskNativeForkBoundary {
    static func ids(_ task: WorkItem) -> Set<String> {
        guard ["codex", "opencode"].contains(task.agent), let thread = task.threadId, !thread.isEmpty else { return [] }
        if let origin = task.subagentOrigin {
            if task.agent == "codex" && origin.nativeId != thread { return [] }
            if task.agent == "opencode" && task.nativeHistory?.canFork != true { return [] }
        }
        return Set(task.events.compactMap { event in
            guard event.kind == "turn", event.runId == nil, event.revertedAt == nil,
            ["completed", "failed", "interrupted", "declined"].contains(event.status ?? "") &&
            (event.nativeTurnId?.isEmpty == false || event.id.hasPrefix("codex:") && event.id.hasSuffix(":turn") && event.id.count > 11) else { return nil }
            return event.turnId
        })
    }
    static func supported(_ task: WorkItem, id: String) -> Bool { ids(task).contains(id) }
}

enum CodexTranscript {
    static func isProposal(_ event: TaskEvent) -> Bool {
        event.kind == "proposal" || (event.kind == "plan" && event.plan == nil && event.itemId != nil && event.itemId != "plan")
    }
    private static let fractionalDate: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plainDate = ISO8601DateFormatter()
    static func date(_ value: String?) -> Date? {
        guard let value else { return nil }
        return fractionalDate.date(from: value) ?? plainDate.date(from: value)
    }

    static func rows(_ task: WorkItem) -> [CodexTranscriptRow] {
        struct Entry { let id: String; let time: Double; let order: Int; let content: CodexTranscriptRow.Content; var runID: String? = nil; var nativeTurnID: String? = nil; var isStreaming = false }
        var entries: [Entry] = []
        // Native children publish their actual assistant messages as events.
        // A result preview can lag one event transaction and must not create
        // a second, older reply while the child is streaming.
        let history = task.subagentOrigin == nil ? task.conversation : (task.messages ?? []).filter { $0.revertedAt == nil }
        let events = task.events.filter { $0.revertedAt == nil }
        let nativeTurns = TaskNativeForkBoundary.ids(task)
        let visibleRunIDs = Set(history.compactMap(\.runId) + events.compactMap(\.runId))
        let runs = task.runs?.filter { $0.revertedAt == nil && $0.executionExcludedAt == nil && (task.conversationHistory == nil || visibleRunIDs.contains($0.id)) } ?? []
        var canonicalEventIDs: [String: String] = [:]
        for message in history where message.role == "assistant" {
            let matching = events.last { event in
                (event.kind == "message" && event.phase != "commentary" || isProposal(event)) && event.text == message.text &&
                (message.turnId != nil && event.turnId == message.turnId || message.id == "current-answer" ||
                 message.at != nil && abs((date(message.at)?.timeIntervalSince1970 ?? 0) - (date(event.at)?.timeIntervalSince1970 ?? 0)) < 5)
            } ?? events.last { event in event.kind == "message" && event.phase == "final_answer" && message.turnId != nil && event.turnId == message.turnId }
            if let matching { canonicalEventIDs[matching.id] = message.id }
        }
        var userEvents = events.filter { $0.kind == "user" }
        let start = date(task.createdAt)?.timeIntervalSince1970 ?? 0
        let end = date(task.updatedAt)?.timeIntervalSince1970 ?? start + 1
        var messageTimes: [Double] = []
        for message in history {
            let legacyUser = message.role == "user" ? userEvents.firstIndex { $0.text == message.text } : nil
            let timestamp = message.at ?? legacyUser.map { userEvents[$0].at }
            messageTimes.append(date(timestamp)?.timeIntervalSince1970 ?? (message.role == "user" ? start : end))
            if let legacyUser { userEvents.remove(at: legacyUser) }
        }
        for (index, message) in history.enumerated() {
            if message.role == "assistant" && (canonicalEventIDs.values.contains(message.id) || events.contains(where: {
                ($0.kind == "message" && $0.phase != "commentary" || isProposal($0)) && (
                    (message.turnId != nil && $0.turnId == message.turnId && $0.phase == "final_answer") ||
                    (message.turnId != nil && $0.turnId == message.turnId && isProposal($0) && $0.text == message.text) ||
                    ($0.text == message.text && (message.id == "current-answer" || (message.at != nil && abs((date(message.at)?.timeIntervalSince1970 ?? 0) - (date($0.at)?.timeIntervalSince1970 ?? 0)) < 5)))
                )
            })) { continue }
            // Old snapshots have no message timestamps. Place each saved answer
            // before the next user request, while retaining its conversation order.
            let nextUser = history.indices.dropFirst(index + 1).first { history[$0].role == "user" }
            let time = message.at == nil && message.role == "assistant" ? nextUser.map { messageTimes[$0] - 0.001 } ?? end : messageTimes[index]
            entries.append(Entry(id: message.id, time: time, order: index, content: message.role == "user" ? .user(message.text) : .reply(message.text), runID: message.runId,
                nativeTurnID: message.turnId.flatMap { nativeTurns.contains($0) ? $0 : nil }, isStreaming: message.role == "assistant" && message.id == "current-answer" && task.active))
        }
        for (index, event) in events.enumerated() {
            guard !["user", "status", "turn", "recovery", "error"].contains(event.kind), !event.text.isEmpty else { continue }
            if event.kind == "command" && event.itemId == nil && event.text.hasPrefix("正在执行：") {
                let command = String(event.text.dropFirst("正在执行：".count))
                let later = events.dropFirst(index + 1).prefix { $0.kind != "user" }
                if later.contains(where: { $0.kind == "command" && $0.text.hasPrefix(command + "\n") }) { continue }
            }
            let content: CodexTranscriptRow.Content
            if isProposal(event) { content = .proposal(event) }
            else if event.kind == "subagent", event.subagentId != nil { content = .subagent(event) }
            else if event.kind == "files", event.changes?.isEmpty == false {
                let completeNetDiff = runs.contains { $0.id == event.runId && $0.changes != nil }
                content = completeNetDiff ? .work([event]) : .changes(event)
            }
            else { content = event.kind == "message" && event.phase != "commentary" ? .reply(event.text) : .work([event]) }
            entries.append(Entry(id: canonicalEventIDs[event.id] ?? event.id, time: date(event.at)?.timeIntervalSince1970 ?? start, order: history.count + (event.historyOrder ?? index), content: content, runID: event.runId,
                nativeTurnID: event.turnId.flatMap { nativeTurns.contains($0) ? $0 : nil }, isStreaming: event.status == "running"))
        }
        entries.sort { $0.time == $1.time ? $0.order < $1.order : $0.time < $1.time }
        for run in runs where run.changes?.isEmpty == false || run.diffError != nil {
            let index = entries.lastIndex { $0.runID == run.id }.map { $0 + 1 } ?? entries.firstIndex { $0.time > (date(run.completedAt)?.timeIntervalSince1970 ?? end) } ?? entries.endIndex
            entries.insert(Entry(id: "run-changes-" + run.id, time: date(run.completedAt)?.timeIntervalSince1970 ?? end, order: entries.count, content: .runChanges(run), runID: run.id), at: index)
        }
        var rows: [CodexTranscriptRow] = []
        var work: [TaskEvent] = []
        func flush() {
            if let first = work.first {
                let identity = first.runId ?? first.turnId ?? first.id
                rows.append(CodexTranscriptRow(id: "work-" + identity + "-after-" + (rows.last?.id ?? "start"), content: .work(work)))
            }
            work = []
        }
        for entry in entries {
            if case .work(let events) = entry.content { work += events }
            else { flush(); rows.append(CodexTranscriptRow(id: entry.id, content: entry.content, runID: entry.runID, nativeTurnID: entry.nativeTurnID, isStreaming: entry.isStreaming)) }
        }
        flush()
        return rows
    }

    static func duration(_ events: [TaskEvent], task: WorkItem) -> Int? {
        let turn = task.events.first { $0.kind == "turn" && $0.turnId == events.first?.turnId }
        if let milliseconds = turn?.durationMs { return max(1, Int(milliseconds / 1000)) }
        guard let first = date(events.first?.at), let last = date(events.last?.completedAt ?? events.last?.at) else { return nil }
        return max(1, Int(last.timeIntervalSince(first)))
    }
}
