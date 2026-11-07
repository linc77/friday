import Foundation

struct TaskSearchMatch: Codable {
    enum Source: String, Codable { case user, assistant }
    let taskId: String; let projectId: String?; let epoch: String
    let source: Source; let snippet: String; let messageCreatedAt: String?
}
struct TaskSearchResponse: Decodable {
    let query: String; let sequence: Int; let sessionId: String; let matches: [TaskSearchMatch]
}

struct TaskSearchState {
    struct Request: Equatable { let id: UUID; let query: String; let scope: String; let session: String? }
    private(set) var request: Request?
    private(set) var query = ""
    private(set) var matches: [TaskSearchMatch] = []
    private(set) var loading = false
    private(set) var error: String?
    mutating func begin(_ query: String, scope: String, session: String?) -> Request? {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if request?.query != query || request?.scope != scope || request?.session != session { matches = [] }
        self.query = query; error = nil; loading = false; request = nil
        guard query.utf16.count >= 2 else { return nil }
        guard query.utf16.count <= 200 else { error = "搜索内容需要 2 到 200 个字符"; return nil }
        let next = Request(id: UUID(), query: query, scope: scope, session: session)
        request = next; loading = true; return next
    }
    @discardableResult mutating func accept(_ response: TaskSearchResponse, for request: Request, scope: String, session: String?, tasks: [WorkItem]) -> Bool {
        guard self.request == request, request.scope == scope, request.session == session, response.sessionId == session, response.query == request.query, response.sequence >= 0 else { return false }
        var epochs: [String: String] = [:]
        for task in tasks { if let epoch = task.history?.epoch ?? task.conversationHistory?.epoch { epochs[task.id] = epoch } }
        matches = response.matches.filter { epochs[$0.taskId] == $0.epoch }
        error = nil; loading = false; return true
    }
    mutating func fail(_ message: String, for request: Request, scope: String, session: String?) {
        guard self.request == request, request.scope == scope, request.session == session else { return }
        loading = false; error = message
    }
    func currentMatches(_ query: String, scope: String, session: String?) -> [TaskSearchMatch] {
        guard request?.query == query.trimmingCharacters(in: .whitespacesAndNewlines), request?.scope == scope, request?.session == session else { return [] }
        return matches
    }
}

enum TaskSearchPresentation {
    struct Result: Identifiable { let task: WorkItem; let match: TaskSearchMatch?; var id: String { task.id } }
    static func pullRequests(_ task: WorkItem) -> [TaskPullRequest] {
        if let linked = task.pullRequests { return linked + (task.branchPullRequest.map { branch in linked.contains(where: { $0.url == branch.url }) ? [] : [branch] } ?? []) }
        return [task.gitOperation?.pullRequest].compactMap { $0 }
    }
    static func terms(_ pr: TaskPullRequest) -> [String] {
        let parts = URL(string: pr.url)?.pathComponents.filter { $0 != "/" } ?? []
        let pull = parts.firstIndex { ["pull", "merge_requests", "pull-requests"].contains($0) }
        let repository = pr.repository ?? pull.map { parts.prefix($0).filter { $0 != "-" }.joined(separator: "/") } ?? ""
        return ["#\(pr.number)", "\(repository)#\(pr.number)", "\(pr.provider == "gitlab" ? "MR" : "PR") \(pr.number)", pr.url, pr.title]
    }
    static func displayedPullRequest(_ task: WorkItem, query: String) -> TaskPullRequest? {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let links = pullRequests(task)
        return links.first { terms($0).contains { $0.lowercased().contains(query) } } ?? links.first
    }
    static func results(tasks: [WorkItem], projects: [Project], scope: String?, query: String, matches: [TaskSearchMatch], now: Date) -> [Result] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }
        let candidates = TaskWorkspaces.tasks(tasks, scope: scope, projects: projects).filter { $0.projectId == nil || TaskWorkspaces.project(for: $0, in: projects) != nil }
        let ordered = TaskWorkspaces.Shelf.allCases.flatMap { TaskWorkspaces.shelfTasks(candidates, shelf: $0, now: now) }
        let content = Dictionary(matches.map { ($0.taskId, $0) }, uniquingKeysWith: { _, last in last })
        var titles: [Result] = []; var bodies: [Result] = []
        for task in ordered {
            let match = content[task.id].flatMap { ($0.epoch == (task.history?.epoch ?? task.conversationHistory?.epoch)) ? $0 : nil }
            if ([task.title] + pullRequests(task).flatMap(terms)).contains(where: { $0.lowercased().contains(needle) }) { titles.append(Result(task: task, match: match)) }
            else if let match { bodies.append(Result(task: task, match: match)) }
        }
        return titles + bodies
    }
    static func moved(_ delta: Int, selected: String?, ids: [String]) -> String? {
        guard !ids.isEmpty else { return nil }
        let index = selected.flatMap { ids.firstIndex(of: $0) } ?? 0
        return ids[((index + delta) % ids.count + ids.count) % ids.count]
    }
}

enum TaskSearchText {
    struct Part: Equatable { let text: String; let highlighted: Bool; let start: Int }
    private static func folded(_ value: String) -> [UInt16] {
        value.utf16.map { (65...90).contains($0) ? $0 + 32 : $0 }
    }
    static func parts(_ text: String, query: String) -> [Part] {
        let needle = folded(query.trimmingCharacters(in: .whitespacesAndNewlines))
        let units = Array(text.utf16); let haystack = folded(text)
        guard !needle.isEmpty, !units.isEmpty, needle.count <= units.count else { return [Part(text: text, highlighted: false, start: 0)] }
        var parts: [Part] = []; var cursor = 0; var scan = 0
        while scan <= haystack.count - needle.count {
            guard haystack[scan..<(scan + needle.count)].elementsEqual(needle) else { scan += 1; continue }
            if cursor < scan { parts.append(Part(text: String(decoding: units[cursor..<scan], as: UTF16.self), highlighted: false, start: cursor)) }
            parts.append(Part(text: String(decoding: units[scan..<(scan + needle.count)], as: UTF16.self), highlighted: true, start: scan))
            scan += needle.count; cursor = scan
        }
        if cursor < units.count { parts.append(Part(text: String(decoding: units[cursor...], as: UTF16.self), highlighted: false, start: cursor)) }
        return parts
    }
}
