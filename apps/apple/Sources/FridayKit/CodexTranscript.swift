import Foundation

struct CodexTranscriptRow: Identifiable {
    enum Content { case user(String), reply(String), work([TaskEvent]) }
    let id: String
    let content: Content
}

enum CodexTranscript {
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
        struct Entry { let id: String; let time: Double; let order: Int; let content: CodexTranscriptRow.Content }
        var entries: [Entry] = []
        let history = task.conversation
        var userEvents = task.events.filter { $0.kind == "user" }
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
            if message.role == "assistant" && task.events.contains(where: {
                $0.kind == "message" && $0.phase != "commentary" && (
                    (message.turnId != nil && $0.turnId == message.turnId && $0.phase == "final_answer") ||
                    ($0.text == message.text && (message.id == "current-answer" || (message.at != nil && abs((date(message.at)?.timeIntervalSince1970 ?? 0) - (date($0.at)?.timeIntervalSince1970 ?? 0)) < 5)))
                )
            }) { continue }
            // Old snapshots have no message timestamps. Place each saved answer
            // before the next user request, while retaining its conversation order.
            let nextUser = history.indices.dropFirst(index + 1).first { history[$0].role == "user" }
            let time = message.at == nil && message.role == "assistant" ? nextUser.map { messageTimes[$0] - 0.001 } ?? end : messageTimes[index]
            entries.append(Entry(id: message.id, time: time, order: index, content: message.role == "user" ? .user(message.text) : .reply(message.text)))
        }
        for (index, event) in task.events.enumerated() {
            guard !["user", "status", "turn", "recovery", "error"].contains(event.kind), !event.text.isEmpty else { continue }
            if event.kind == "command" && event.itemId == nil && event.text.hasPrefix("正在执行：") {
                let command = String(event.text.dropFirst("正在执行：".count))
                let later = task.events.dropFirst(index + 1).prefix { $0.kind != "user" }
                if later.contains(where: { $0.kind == "command" && $0.text.hasPrefix(command + "\n") }) { continue }
            }
            let content: CodexTranscriptRow.Content = event.kind == "message" && event.phase != "commentary" ? .reply(event.text) : .work([event])
            entries.append(Entry(id: event.id, time: date(event.at)?.timeIntervalSince1970 ?? start, order: history.count + index, content: content))
        }
        entries.sort { $0.time == $1.time ? $0.order < $1.order : $0.time < $1.time }
        var rows: [CodexTranscriptRow] = []
        var work: [TaskEvent] = []
        func flush() {
            if let first = work.first { rows.append(CodexTranscriptRow(id: "work-" + first.id, content: .work(work))) }
            work = []
        }
        for entry in entries {
            if case .work(let events) = entry.content { work += events }
            else { flush(); rows.append(CodexTranscriptRow(id: entry.id, content: entry.content)) }
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
