import Foundation

struct TaskChangeRequestCommit: Decodable, Identifiable {
    let oid: String; let messageHeadline: String; let committedDate: String
    let additions: Int?; let deletions: Int?; let authors: [Author]
    var id: String { oid }
    struct Author: Decodable { let login: String; let name: String?; let avatarURL: String? }
}
struct TaskChangeRequestCommitResponse: Decodable {
    let commit: TaskChangeRequestCommit; let headSha: String; let files: [TaskChangeRequestFiles.File]; let truncated: Bool
}
struct TaskChangeRequestTimelineEntry: Identifiable {
    let id: String; let createdAt: String; let kind: String
    var item: TaskChangeRequestActivityResponse.Item? = nil
    var thread: TaskChangeRequestActivityResponse.Thread? = nil
    var commit: TaskChangeRequestCommit? = nil
    var conversational: Bool { thread != nil || item.map { TaskChangeRequestTimeline.outcome($0.state) == nil } == true }
}
struct TaskChangeRequestTimelineRow: Identifiable {
    var entries: [TaskChangeRequestTimelineEntry]
    var id: String { entries.first?.id ?? "empty" }
    var isConversation: Bool { entries.first?.conversational == true }
    var commentCount: Int { entries.reduce(0) { $0 + ($1.thread?.commentCount ?? 1) } }
    var authorCount: Int { Set(entries.flatMap { $0.thread?.comments.map(\.author) ?? [$0.item?.author ?? ""] }.filter { !$0.isEmpty }).count }
}

private struct TaskTimelineDates {
    let standard = ISO8601DateFormatter()
    let fractional: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }()
    func date(_ value: String) -> Date? { fractional.date(from: value) ?? standard.date(from: value) }
}

enum TaskChangeRequestTimeline {
    static func date(_ value: String) -> Date? { TaskTimelineDates().date(value) }
    static func entries(detail: TaskChangeRequestDetail?, activity: TaskChangeRequestActivityResponse?, newestFirst: Bool) -> [TaskChangeRequestTimelineEntry] {
        var values = (activity?.items ?? []).map { TaskChangeRequestTimelineEntry(id: "item:" + $0.id, createdAt: $0.createdAt, kind: $0.kind, item: $0) }
        values += (activity?.threads ?? []).map { TaskChangeRequestTimelineEntry(id: "thread:" + $0.id, createdAt: $0.comments.first?.createdAt ?? "", kind: "thread", thread: $0) }
        values += (activity?.commits ?? []).map { TaskChangeRequestTimelineEntry(id: "commit:" + $0.oid, createdAt: $0.committedDate, kind: "commit", commit: $0) }
        if let detail {
            if !detail.createdAt.isEmpty { values.append(.init(id: "lifecycle:opened", createdAt: detail.createdAt, kind: "opened")) }
            if let at = detail.mergedAt, !at.isEmpty { values.append(.init(id: "lifecycle:merged", createdAt: at, kind: "merged")) }
            else if detail.pullRequest.state != "merged", let at = detail.closedAt, !at.isEmpty { values.append(.init(id: "lifecycle:closed", createdAt: at, kind: "closed")) }
        }
        let parser = TaskTimelineDates()
        return values.map { ($0, parser.date($0.createdAt)?.timeIntervalSince1970 ?? -Double.greatestFiniteMagnitude) }
            .sorted { lhs, rhs in
                let order = lhs.1 == rhs.1 ? lhs.0.id < rhs.0.id : lhs.1 < rhs.1
                return newestFirst ? (lhs.1 == rhs.1 ? lhs.0.id > rhs.0.id : lhs.1 > rhs.1) : order
            }.map(\.0)
    }
    static func rows(_ entries: [TaskChangeRequestTimelineEntry]) -> [TaskChangeRequestTimelineRow] {
        var rows: [TaskChangeRequestTimelineRow] = []
        for entry in entries {
            if entry.conversational, rows.last?.isConversation == true { rows[rows.count - 1].entries.append(entry) }
            else { rows.append(.init(entries: [entry])) }
        }
        return rows
    }
    static func outcome(_ state: String?) -> String? {
        switch state?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "_", with: "-") {
        case "approved": return "approved"
        case "changes-requested": return "changes-requested"
        case "dismissed": return "dismissed"
        default: return nil
        }
    }
    static func isStale(_ item: TaskChangeRequestActivityResponse.Item, commits: [TaskChangeRequestCommit]) -> Bool {
        guard outcome(item.state) != nil else { return false }
        let parser = TaskTimelineDates()
        guard let at = parser.date(item.createdAt), let newest = commits.compactMap({ parser.date($0.committedDate) }).max() else { return false }
        return at < newest
    }
    static func visibleBody(_ value: String) -> String? {
        let stripped = value.replacingOccurrences(of: "<!--[\\s\\S]*?-->", with: "", options: .regularExpression)
        return stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
