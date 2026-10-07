import Foundation

enum TaskRowPresentation {
    static func elapsed(since start: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(start)))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3_600 { return "\(seconds / 60)m" }
        if seconds < 86_400 { return "\(seconds / 3_600)h" }
        return "\(seconds / 86_400)d"
    }

    static func age(_ task: WorkItem, now: Date) -> String {
        guard let date = CodexTranscript.date(task.updatedAt) ?? CodexTranscript.date(task.createdAt) else { return "—" }
        return elapsed(since: date, now: now)
    }

    static func runningStart(_ task: WorkItem) -> Date? {
        // Streaming updates change updatedAt; use the current turn's original
        // timestamp so the running clock neither resets nor includes old turns.
        if let turnId = task.turnId,
           let turn = task.events.last(where: { $0.kind == "turn" && $0.turnId == turnId }),
           let start = CodexTranscript.date(turn.at) { return start }
        return CodexTranscript.date(task.events.last(where: { $0.kind == "user" })?.at)
            ?? CodexTranscript.date(task.messages?.last(where: { $0.role == "user" })?.at)
            ?? CodexTranscript.date(task.createdAt)
    }

    static func branch(_ git: TaskGitContext?) -> String {
        guard let git else { return "无分支信息" }
        if git.status == "not_repository" { return "非 Git 工作区" }
        guard git.status == "repository" else { return "分支不可用" }
        if let branch = git.branch, !branch.isEmpty { return branch }
        if let head = git.head, !head.isEmpty { return "HEAD · \(head)" }
        return "无分支信息"
    }
}
