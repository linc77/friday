import Foundation
import CryptoKit

struct TaskReviewReaction: Codable, Equatable, Identifiable {
    let content: String; let count: Int; let actors: [String]; let viewerHasReacted: Bool
    var id: String { content }
}
struct TaskReviewReactions: Decodable { let supported: Bool; let reactions: [TaskReviewReaction]; let truncated: Bool }
struct TaskViewedFilePress: Equatable { let path: String; let viewed: Bool }
struct TaskFilesViewedResponse: Decodable {
    let storage: String; let files: [File]; let truncated: Bool
    struct File: Decodable { let path: String; let state: String }
    var states: [String: String] { Dictionary(files.map { ($0.path, $0.state) }, uniquingKeysWith: { _, last in last }) }
}
struct TaskViewedFileBatch: Equatable {
    let files: [TaskViewedFilePress]; let generations: [String: UInt64]
}

/// Last-press ownership is per path. A late receipt cannot undo a later press,
/// and a successful write stays visible until a read could have observed it.
struct TaskFilesViewedOverlay {
    private(set) var overlay: [String: Bool] = [:]
    private(set) var queued: [String: Bool] = [:]
    private var generations: [String: UInt64] = [:]
    private var acknowledged: [String: UInt64] = [:]
    private var answeredFrom: [String: String] = [:]
    private(set) var serial: UInt64 = 0
    var hasQueued: Bool { !queued.isEmpty }
    mutating func press(_ path: String, viewed: Bool) { serial &+= 1; generations[path] = serial; overlay[path] = viewed; queued[path] = viewed; acknowledged.removeValue(forKey: path); answeredFrom.removeValue(forKey: path) }
    mutating func takeBatch() -> TaskViewedFileBatch? {
        let paths = Array(queued.keys.sorted().prefix(500)); guard !paths.isEmpty else { return nil }
        let files = paths.map { TaskViewedFilePress(path: $0, viewed: queued[$0]!) }, owned = Dictionary(uniqueKeysWithValues: paths.map { ($0, generations[$0]!) })
        for path in paths { queued.removeValue(forKey: path) }; return TaskViewedFileBatch(files: files, generations: owned)
    }
    mutating func acknowledge(_ batch: TaskViewedFileBatch, states: [String: String]) {
        for file in batch.files where generations[file.path] == batch.generations[file.path] {
            acknowledged[file.path] = batch.generations[file.path]; answeredFrom[file.path] = states[file.path] ?? "unviewed"
        }
    }
    mutating func fail(_ batch: TaskViewedFileBatch) {
        for file in batch.files where generations[file.path] == batch.generations[file.path] && queued[file.path] == nil { overlay.removeValue(forKey: file.path); acknowledged.removeValue(forKey: file.path); answeredFrom.removeValue(forKey: file.path) }
    }
    var readOwnership: [String: UInt64] { acknowledged }
    mutating func settle(_ states: [String: String], ownership: [String: UInt64]) {
        for (path, press) in overlay where queued[path] == nil && ownership[path] == generations[path] && acknowledged[path] == generations[path] {
            let state = states[path] ?? "unviewed"
            if (state == "viewed") == press || state != answeredFrom[path] { overlay.removeValue(forKey: path); acknowledged.removeValue(forKey: path); answeredFrom.removeValue(forKey: path) }
        }
    }
    func isViewed(_ path: String, states: [String: String]) -> Bool { overlay[path] ?? (states[path] == "viewed") }
    func isStale(_ path: String, states: [String: String]) -> Bool { overlay[path] == nil && states[path] == "dismissed" }
}

enum TaskRemoteThreadPlacement {
    static func annotations(_ threads: [TaskChangeRequestActivityResponse.Thread], file: TaskChangeRequestFiles.File, busy: Bool, presentation: String = "") -> [TaskDiffInlineComment] {
        let rows = TaskDiffReviewDocument(file.patch).rows
        return threads.compactMap { thread in
            guard !thread.isOutdated, ["left", "right"].contains(thread.side), let line = thread.line, line > 0, thread.path == file.path || thread.path == file.oldPath,
                  rows.contains(where: { thread.side == "left" ? $0.oldNumber == line : $0.newNumber == line }) else { return nil }
            let side = thread.side == "left" ? "deletions" : "additions", encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
            let revision = SHA256.hash(data: (try? encoder.encode(thread)) ?? Data()).map { String(format: "%02x", $0) }.joined() + (busy ? ":busy" : ":ready") + presentation
            let bytes = Array(SHA256.hash(data: Data(("friday.remote-review-thread\0" + thread.id).utf8)).prefix(16))
            let id = UUID(uuid: (bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
            return TaskDiffInlineComment(id: id, selection: TaskDiffReviewSelection(start: line, side: side, end: line, endSide: side), rangeLabel: "L\(line)", text: "", referenceID: nil, presentationID: thread.id, presentationVersion: revision)
        }
    }
}

enum TaskReviewReactionPresentation {
    static let order = ["thumbs-up", "thumbs-down", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]
    static func title(_ content: String) -> String {
        switch content { case "thumbs-up": "赞"; case "thumbs-down": "不赞同"; case "laugh": "笑"; case "hooray": "庆祝"; case "confused": "困惑"; case "heart": "喜欢"; case "rocket": "火箭"; case "eyes": "关注"; default: content }
    }
    static func symbol(_ content: String) -> String {
        switch content { case "thumbs-up": "hand.thumbsup"; case "thumbs-down": "hand.thumbsdown"; case "laugh": "face.smiling"; case "hooray": "party.popper"; case "confused": "questionmark.circle"; case "heart": "heart"; case "rocket": "paperplane"; default: "eyes" }
    }
    static func overlay(_ reactions: [TaskReviewReaction], input: TaskChangeRequestSubmission?, subjectID: String?) -> [TaskReviewReaction] {
        guard let input, input.action == "reaction", let value = input.collaboration, value.subjectID == subjectID, let content = value.content, let reacted = value.reacted else { return reactions }
        var values = Dictionary(reactions.map { ($0.content, $0) }, uniquingKeysWith: { _, last in last })
        if let previous = values[content], previous.viewerHasReacted != reacted {
            let count = previous.count + (reacted ? 1 : -1)
            values[content] = count > 0 ? TaskReviewReaction(content: content, count: count, actors: previous.actors, viewerHasReacted: reacted) : nil
        } else if values[content] == nil, reacted { values[content] = TaskReviewReaction(content: content, count: 1, actors: [], viewerHasReacted: true) }
        return order.compactMap { values[$0] }
    }
}
