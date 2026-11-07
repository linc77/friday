import Foundation

@main struct TaskSearchStateTests {
    static func task(_ id: String, title: String = "Task", project: String? = "project", epoch: String = "epoch", overrides: [String: Any] = [:]) throws -> WorkItem {
        var data: [String: Any] = ["id": id, "title": title, "agent": "codex", "prompt": "", "cwd": "/project", "mode": "code", "status": "completed",
            "createdAt": "2026-10-18T01:00:00Z", "updatedAt": "2026-10-18T02:00:00Z", "events": [], "approvals": [], "result": "",
            "history": ["epoch": epoch, "count": 0, "version": 0, "coverage": "complete", "recent": []]]
        if let project { data["projectId"] = project }
        data.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: data))
    }
    static func match(_ id: String, epoch: String = "epoch") -> TaskSearchMatch {
        TaskSearchMatch(taskId: id, projectId: "project", epoch: epoch, source: .user, snippet: "needle in history", messageCreatedAt: "2026-10-18T01:00:00Z")
    }
    static func main() throws {
        var state = TaskSearchState(); let task = try task("task")
        precondition(state.begin("x", scope: "account:project", session: "boot") == nil)
        precondition(state.begin(String(repeating: "😀", count: 101), scope: "account:project", session: "boot") == nil && state.error != nil)
        let first = state.begin("  needle  ", scope: "account:project", session: "boot")!
        precondition(first.query == "needle" && state.loading)
        let frame = TaskSearchResponse(query: "needle", sequence: 1, sessionId: "boot", matches: [match("task"), match("unknown")])
        precondition(!state.accept(frame, for: first, scope: "other-account:project", session: "boot", tasks: [task]))
        precondition(!state.accept(frame, for: first, scope: first.scope, session: "new-boot", tasks: [task]))
        precondition(state.accept(frame, for: first, scope: first.scope, session: "boot", tasks: [task]))
        precondition(state.matches.map(\.taskId) == ["task"] && !state.loading)
        precondition(state.currentMatches("different", scope: first.scope, session: "boot").isEmpty)
        precondition(state.currentMatches("needle", scope: "other-workspace", session: "boot").isEmpty)
        let retry = state.begin("needle", scope: first.scope, session: "boot")!
        state.fail("Offline", for: retry, scope: retry.scope, session: "boot")
        precondition(state.matches.count == 1 && state.error == "Offline", "The same scope can retain an already loaded result during an offline retry")
        let next = state.begin("new query", scope: first.scope, session: "boot")!
        precondition(state.matches.isEmpty && !state.accept(frame, for: first, scope: first.scope, session: "boot", tasks: [task]))
        state.fail("Old failure", for: first, scope: first.scope, session: "boot")
        precondition(state.error == nil && state.request == next, "An old failure cannot replace a later search")
        let rewound = try self.task("task", epoch: "rewound")
        let oldHistory = TaskSearchResponse(query: "new query", sequence: 1, sessionId: "boot", matches: [match("task")])
        precondition(state.accept(oldHistory, for: next, scope: next.scope, session: "boot", tasks: [rewound]) && state.matches.isEmpty)
        let epochRequest = state.begin("needle", scope: first.scope, session: "boot")!
        precondition(!state.accept(TaskSearchResponse(query: "needle", sequence: -1, sessionId: "boot", matches: []), for: epochRequest, scope: first.scope, session: "boot", tasks: [task]))
        _ = state.begin("needle", scope: "new-account:project", session: "boot"); precondition(state.matches.isEmpty)

        let project = Project(id: "project", name: "Project", path: "/project", context: "")
        let other = Project(id: "other", name: "Other", path: "/other", context: "")
        let title = try self.task("title", title: "A Needle title")
        var pr = try self.task("pr", title: "Unrelated title")
        pr.pullRequests = [TaskPullRequest(number: 42, url: "https://github.com/owner/repo/pull/42", title: "Old request", state: "closed", base: "main", head: "old"),
            TaskPullRequest(number: 99, url: "https://github.com/owner/repo/pull/99", title: "Needle PR title", state: "open", base: "main", head: "new")]
        let body = try self.task("body", overrides: ["pinnedAt": "2026-10-18T02:00:00Z"])
        let orphan = try self.task("orphan", title: "Needle", project: "gone")
        let archived = try self.task("archive", title: "Needle", overrides: ["archivedAt": "2026-10-18T02:00:00Z"])
        let foreign = try self.task("foreign", title: "Needle", project: "other")
        let friday = try self.task("friday", title: "Needle", overrides: ["agent": "friday"])
        let items = [body, title, pr, orphan, archived, foreign, friday]
        let rows = TaskSearchPresentation.results(tasks: items, projects: [project, other], scope: "project", query: "needle", matches: [match("body"), match("orphan"), match("archive")], now: CodexTranscript.date("2026-10-18T03:00:00Z")!)
        precondition(rows.map(\.id) == ["pr", "title", "body"], "Title/PR hits precede content-only hits while preserving the sidebar's stable order")
        precondition(TaskSearchPresentation.displayedPullRequest(pr, query: "#99")?.number == 99, "The displayed PR is the matching association rather than an unrelated first link")
        let prRows = TaskSearchPresentation.results(tasks: [pr], projects: [project], scope: nil, query: "OWNER/REPO#99", matches: [], now: .now)
        precondition(prRows.map(\.id) == ["pr"])
        var mergeRequest = TaskPullRequest(number: 7, url: "https://gitlab.com/group/sub/project/-/merge_requests/7", title: "Merge request", state: "open", base: "main", head: "feature")
        mergeRequest.provider = "gitlab"; mergeRequest.repository = "group/sub/project"
        var mrTask = try self.task("mr"); mrTask.pullRequests = [mergeRequest]
        precondition(TaskSearchPresentation.terms(mergeRequest).contains("MR 7"))
        precondition(TaskSearchPresentation.results(tasks: [mrTask], projects: [project], scope: nil, query: "group/sub/project#7", matches: [], now: .now).map(\.id) == ["mr"])
        let retired = try self.task("body", epoch: "new-epoch")
        precondition(TaskSearchPresentation.results(tasks: [retired], projects: [project], scope: nil, query: "needle", matches: [match("body")], now: .now).isEmpty)
        precondition(TaskSearchPresentation.moved(-1, selected: "a", ids: ["a", "b", "c"]) == "c")
        precondition(TaskSearchPresentation.moved(1, selected: "c", ids: ["a", "b", "c"]) == "a")
        precondition(TaskSearchPresentation.moved(1, selected: nil, ids: ["a", "b", "c"]) == "b")
        precondition(TaskSearchPresentation.moved(1, selected: nil, ids: []) == nil)

        let text = "A😀NEEDLE needle"
        let parts = TaskSearchText.parts(text, query: "needle")
        precondition(parts.map(\.text).joined() == text)
        precondition(parts.filter(\.highlighted).map(\.start) == [3, 10], "Highlight indices preserve UTF-16 offsets around emoji")
        precondition(TaskSearchText.parts("aaaa", query: "aa").filter(\.highlighted).count == 2)
        precondition(TaskSearchText.parts("🌏🌏", query: "🌏").filter(\.highlighted).map(\.start) == [0, 2])
        precondition(TaskSearchText.parts("中文中文", query: "中文").filter(\.highlighted).count == 2)
        precondition(TaskSearchText.parts("ΟΣ ος οσ", query: "οσ").filter(\.highlighted).map(\.start) == [6], "Search excerpts preserve SQLite's ASCII-only case behavior")
        precondition(TaskSearchText.parts("İ i", query: "i").filter(\.highlighted).map(\.start) == [2])
        precondition(TaskSearchText.parts(text, query: "  ") == [TaskSearchText.Part(text: text, highlighted: false, start: 0)])
        print("Search request/query/account/session guards, stale callbacks, offline cache and projection isolation passed")
        print("Title/PR/content priority, workspace/archive filtering, PR aliases and wrapping result selection passed")
        print("Literal ASCII case highlighting, non-overlap, CJK, emoji and UTF-16 offsets passed")
    }
}
