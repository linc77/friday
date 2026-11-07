import Foundation

struct TaskChangeRequestCodeScope: Equatable {
    var commit: String? = nil
    var identity: String { commit ?? "all" }
    func permitsInlineComments(head: String, loadedHead: String?, loadedScope: String?, base: String? = nil, loadedBase: String? = nil) -> Bool {
        commit == nil && loadedScope == nil && loadedHead == head && (base == nil || loadedBase == nil || base == loadedBase)
    }
    mutating func reconcile(_ commits: [TaskChangeRequestCommit]) -> Bool {
        guard let commit, !commits.contains(where: { $0.oid == commit }) else { return false }
        self.commit = nil; return true
    }
    static func ordered(_ commits: [TaskChangeRequestCommit]) -> [TaskChangeRequestCommit] {
        commits.enumerated().sorted {
            let a = TaskChangeRequestTimeline.date($0.element.committedDate) ?? .distantPast, b = TaskChangeRequestTimeline.date($1.element.committedDate) ?? .distantPast
            return a == b ? $0.offset < $1.offset : a > b
        }.map { $0.element }
    }
}
struct TaskChangeRequestFileContents: Decodable {
    let path: String; let side: String; let revision: String?; let requestHeadSha: String; let scopeCommit: String?
    let kind: String; let mimeType: String; let byteLength: Int; let text: String?; let base64: String?; let reason: String?
    var requestBaseSha: String? = nil
}
struct TaskChangeRequestFileTarget: Identifiable {
    let path: String; let head: String; let commit: String?
    var initialSide = "new"
    var base: String? = nil
    var diffCursor: String? = nil
    var usesDiffSlices = false
    var id: String { head + ":" + (base ?? "") + ":" + (commit ?? "all") + ":" + (diffCursor ?? "") + ":" + String(usesDiffSlices) + ":" + path }
}

extension TaskChangeRequestFiles {
    mutating func appendPage(_ next: Self, requestedCursor: String, requestHead: String) -> Bool {
        guard let page = TaskChangeRequestDiffCursor(requestedCursor, head: requestHead, base: baseSha), consumedCursors?.contains(requestedCursor) != true else { return false }
        if let cursor = next.nextCursor { guard consumedCursors?.contains(cursor) != true, let following = TaskChangeRequestDiffCursor(cursor, head: requestHead, base: baseSha), following.follows(page) else { return false } }
        guard nextCursor == requestedCursor, next.cursor == requestedCursor, next.nextCursor != requestedCursor,
              headSha == next.headSha, scopeCommit == next.scopeCommit, baseSha == next.baseSha,
              self.requestHeadSha == requestHead, next.requestHeadSha == requestHead else { return false }
        guard Set(files.map(\.path)).count == files.count, Set(next.files.map(\.path)).count == next.files.count else { return false }
        var positions = Dictionary(uniqueKeysWithValues: files.enumerated().map { ($0.element.path, $0.offset) })
        for file in next.files { if let index = positions[file.path] { files[index] = file } else { positions[file.path] = files.count; files.append(file) } }
        var omitted = omittedFileStats ?? [], indexes = Dictionary((omittedFileStats ?? []).enumerated().map { ($0.element.path, $0.offset) }, uniquingKeysWith: { first, _ in first })
        for file in next.omittedFileStats ?? [] { if let index = indexes[file.path] { omitted[index] = file } else { indexes[file.path] = omitted.count; omitted.append(file) } }
        omittedFileStats = omitted; truncated = truncated || next.truncated; nextCursor = next.nextCursor; consumedCursors = (consumedCursors ?? []).union([requestedCursor]); return true
    }
}

private enum TaskChangeRequestDiffCursor {
    case page(Int)
    case iteration(Int, Int)
    case version(Int, String)
    init?(_ raw: String, head: String, base: String?) {
        guard raw.utf8.count <= 8192 else { return nil }
        if let number = Int(raw), (1...9_999_999).contains(number), String(number) == raw { self = .page(number); return }
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        if parts.count == 2, let iteration = Int(parts[0]), iteration > 0, let index = Int(parts[1]), index >= 0, "\(iteration):\(index)" == raw { self = .iteration(iteration, index); return }
        struct Version: Decodable { let version: Int; let headOid: String; let baseOid: String; let after: String }
        guard let data = raw.data(using: .utf8), let value = try? JSONDecoder().decode(Version.self, from: data), value.version >= 0,
              value.headOid == head, base == nil || value.baseOid == base, !value.after.isEmpty, value.after.count <= 4096,
              value.after.rangeOfCharacter(from: .controlCharacters) == nil else { return nil }
        self = .version(value.version, value.after)
    }
    func follows(_ previous: Self) -> Bool {
        switch (previous, self) {
        case let (.page(a), .page(b)): return b > a
        case let (.iteration(a, i), .iteration(b, j)): return a == b && j > i
        case let (.version(a, i), .version(b, j)): return a == b && i != j
        default: return false
        }
    }
}
