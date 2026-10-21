import Foundation
import CryptoKit

struct TaskReviewGuide: Decodable {
    let headSha: String; let generatedAt: String; let modelSelection: TextGenerationModelSelection; let stops: [Stop]
    struct Stop: Decodable {
        let title: String; let summary: String; let attention: Attention?; let excerpts: [Excerpt]; let files: [File]; let notes: [Note]; let questions: [String]
    }
    struct Attention: Decodable { let kind: String; let note: String }
    struct Excerpt: Decodable { let path: String; let side: String; let start: Int; let end: Int; let caption: String }
    struct File: Decodable { let path: String; let note: String? }
    struct Note: Decodable { let path: String; let line: Int; let title: String; let body: String }
}
struct TaskGuideExcerptSnapshot: Decodable, Identifiable {
    let path: String; let oldPath: String?; let side: String; let start: Int; let end: Int; let caption: String
    let lines: [Line]; let unavailable: Bool?
    var id: String { "\(path)|\(side)|\(start)|\(end)" }
    struct Line: Decodable, Identifiable { let number: Int; let text: String; let position: TaskChangeRequestPosition?; var id: Int { number } }
}
struct TaskReviewGuideResponse: Decodable {
    let guide: TaskReviewGuide?; let excerpts: [TaskGuideExcerptSnapshot]; var run: TaskReviewGuideRun?; let currentHeadSha: String?; let enabled: Bool
    func accepts(_ next: TaskReviewGuideResponse) -> Bool {
        if let held = run, let incoming = next.run { if held.durableId > incoming.durableId { return false }; if held.id == incoming.id, held.updatedAt > incoming.updatedAt || !held.active && incoming.active { return false } }
        if let held = guide, let incoming = next.guide, held.generatedAt > incoming.generatedAt { return false }
        return true
    }
    var stale: Bool { guard let guide, let head = currentHeadSha else { return false }; return guide.headSha != head }
}
struct TaskGuideProgress: Codable, Equatable {
    var position = 0; var seen: Set<Int> = []
    mutating func move(to next: Int, count: Int) { let previous = max(0, min(position, max(0, count - 1))), bounded = max(0, min(next, max(0, count - 1))); seen = seen.filter { $0 >= 0 && $0 < count }; if bounded > previous { seen.insert(previous) }; position = bounded }
    static func key(server: String, serviceID: String?, url: String, head: String) -> String { "friday.reviewGuide." + SHA256.hash(data: Data([server, serviceID ?? "", url, head].joined(separator: "\0").utf8)).map { String(format: "%02x", $0) }.joined() }
}
struct TaskGuideComposerHandoff: Identifiable {
    let id = UUID(); let identity: String; let taskID: String; let question: String; let reference: TaskContextReference
    static func merge(current: String, previousBlock: String?, newBlock: String) -> String {
        if !newBlock.isEmpty, current.hasSuffix(newBlock) { return current }
        if let previousBlock, !previousBlock.isEmpty, let range = current.range(of: previousBlock) { var value = current; value.replaceSubrange(range, with: newBlock); return value }
        return current.isEmpty ? newBlock : current + (current.hasSuffix("\n") ? "\n" : "\n\n") + newBlock
    }
}
struct TaskGuideHandoffOutcome: Identifiable { let id: UUID; let error: String? }

struct TaskGuideNotice: Identifiable {
    let id: String; let taskID: String; let url: String; let title: String; let status: String; let error: String?
}
struct TaskGuideOpenRequest: Identifiable { let id = UUID(); let taskID: String; let url: String }
struct TaskGuideNoticeTracker {
    private var scope = ""
    private var previous: [String: TaskReviewGuideRun] = [:]
    mutating func observe(tasks: [WorkItem], scope: String) -> [TaskGuideNotice] {
        var latest: [String: (task: WorkItem, run: TaskReviewGuideRun)] = [:]
        for task in tasks {
            for run in task.changeRequestGuideRuns ?? [] {
                if let old = latest[run.url]?.run, old.createdAt > run.createdAt || old.createdAt == run.createdAt && old.durableId > run.durableId { continue }
                latest[run.url] = (task, run)
            }
        }
        defer { self.scope = scope; previous = latest.mapValues { $0.run } }
        guard self.scope == scope else { return [] }
        var notices: [TaskGuideNotice] = []
        for value in latest.values {
            let run = value.run
            if let old = previous[run.url], old.id == run.id, old.active, !run.active { notices.append(TaskGuideNotice(id: run.id, taskID: value.task.id, url: run.url, title: value.task.title, status: run.status, error: run.error)) }
        }
        return notices
    }
}

struct TaskReviewGuideStatusResponse: Decodable { let run: TaskReviewGuideRun? }
