import Foundation

@main
struct TaskWorkspaceTests {
    static func main() throws {
        let projects = [
            Project(id: "a", name: "Friday", path: "/work/friday", context: ""),
            Project(id: "b", name: "Other", path: "/work/other", context: "")
        ]
        func task(_ id: String, project: String?, cwd: String, agent: String = "codex", updated: String = "2026-10-07") throws -> WorkItem {
            var data: [String: Any] = ["id": id, "title": "Task \(id)", "prompt": "", "cwd": cwd,
                "agent": agent, "mode": "code", "status": "completed", "createdAt": "2026-10-01",
                "updatedAt": updated, "result": "", "events": [], "approvals": []]
            if let project { data["projectId"] = project }
            return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: data))
        }
        let linked = try task("linked", project: "a", cwd: "/work/friday", updated: "2026-10-08")
        let legacy = try task("legacy", project: nil, cwd: "/work/other/", agent: "claude")
        let deleted = try task("deleted", project: "gone", cwd: "/work/old")
        let conversation = try task("conversation", project: "a", cwd: "/work/friday", agent: "friday")
        let tasks = [legacy, deleted, conversation, linked]
        precondition(TaskWorkspaces.tasks(tasks, scope: nil, projects: projects).map(\.id) == ["linked", "deleted", "legacy"], "All Workspaces includes orphaned tasks, sorted by activity, excluding Friday conversations")
        precondition(TaskWorkspaces.tasks(tasks, scope: "a", projects: projects).map(\.id) == ["linked"])
        precondition(TaskWorkspaces.tasks(tasks, scope: "b", projects: projects).map(\.id) == ["legacy"], "Legacy tasks match normalized cwd")
        precondition(TaskWorkspaces.tasks(tasks, scope: nil, projects: projects, query: "claude code").map(\.id) == ["legacy"])
        precondition(TaskWorkspaces.tasks(tasks, scope: nil, projects: projects, query: "friday").map(\.id) == ["linked"])
        precondition(TaskWorkspaces.name(for: deleted, in: projects) == "old")
        let recreated = [Project(id: "new", name: "Recreated", path: "/work/old", context: "")]
        precondition(TaskWorkspaces.project(for: deleted, in: recreated) == nil, "Do not silently reassign tasks from a deleted Workspace")

        let artifacts = try (0..<4).map { index in
            try task("artifact-\(index)", project: nil, cwd: index == 0 ? "/Friday/artifacts/" : "/Friday/artifacts", updated: "2026-10-0\(index + 1)")
        }
        let sameName = try task("other-artifacts", project: nil, cwd: "/Other/artifacts", updated: "2026-10-02")
        let legacyLinked = try task("legacy-linked", project: nil, cwd: "/work/friday/", updated: "2026-10-06")
        let worktree = try task("worktree", project: "a", cwd: "/worktrees/friday", updated: "2026-10-05")
        let groups = TaskWorkspaces.groups(tasks + artifacts + [sameName, legacyLinked, worktree], projects: projects)
        precondition(groups.map(\.id) == ["project:a", "missing-project:gone", "project:b", "directory:/Friday/artifacts", "directory:/Other/artifacts"], "Groups follow the latest task activity, with separate same-name directories")
        precondition(groups[0].tasks.map(\.id) == ["linked", "legacy-linked", "worktree"], "Legacy directory matches and linked Worktrees share their registered Workspace")
        precondition(groups[0].project?.id == "a" && groups[0].name == "Friday")
        precondition(groups[3].name == "artifacts" && groups[3].tasks.map(\.id) == ["artifact-3", "artifact-2", "artifact-1", "artifact-0"], "The four Artifacts tasks share one header, sorted by activity")
        precondition(groups.flatMap(\.tasks).count == 10, "Every local-agent task occurs once; Friday conversations stay excluded")
        let replacement = try task("replacement", project: "new", cwd: "/work/old")
        precondition(TaskWorkspaces.groups([deleted, replacement], projects: recreated).count == 2, "A deleted Workspace does not merge into a new one with the same path")
        precondition(TaskWorkspaces.groups([], projects: projects).isEmpty)

        var vertical = WorkspaceSwipe()
        precondition(!vertical.update(x: 2, y: 15))
        precondition(!vertical.update(x: -160, y: 2))
        precondition(vertical.destination(index: 1, count: 3) == 1, "Vertical gestures must not switch Workspaces even after horizontal drift")
        var horizontal = WorkspaceSwipe()
        precondition(horizontal.update(x: -16, y: 2))
        precondition(horizontal.destination(index: 1, count: 3) == 1, "Small gestures spring back")
        _ = horizontal.update(x: -90, y: 3)
        precondition(horizontal.destination(index: 0, count: 3) == 1)
        precondition(horizontal.destination(index: 2, count: 3) == 2, "The last page does not wrap")
        precondition(horizontal.destination(index: 1, count: 3, cancelled: true) == 1)
        var reverse = WorkspaceSwipe()
        _ = reverse.update(x: 90, y: 4)
        precondition(reverse.destination(index: 1, count: 3) == 0)
        precondition(reverse.destination(index: 0, count: 3) == 0)
        precondition(reverse.destination(index: 0, count: 1) == 0)

        func rowTask(_ overrides: [String: Any]) throws -> WorkItem {
            var data: [String: Any] = ["id": "row", "title": "Task", "prompt": "", "cwd": "/work/friday",
                "agent": "codex", "mode": "code", "status": "completed", "createdAt": "2026-10-05T12:00:00Z",
                "updatedAt": "2026-10-07T05:00:00.000Z", "result": "", "events": [], "approvals": []]
            data.merge(overrides) { _, new in new }
            return try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: data))
        }
        let now = CodexTranscript.date("2026-10-07T12:00:00Z")!
        let completed = try rowTask([:])
        let invalidUpdate = try rowTask(["updatedAt": "invalid"])
        let invalidDates = try rowTask(["updatedAt": "invalid", "createdAt": "invalid"])
        precondition(TaskRowPresentation.age(completed, now: now) == "7h")
        precondition(TaskRowPresentation.age(invalidUpdate, now: now) == "2d")
        precondition(TaskRowPresentation.age(invalidDates, now: now) == "—")
        precondition(TaskRowPresentation.elapsed(since: now.addingTimeInterval(10), now: now) == "0s", "Clock skew never shows negative time")
        precondition(TaskRowPresentation.elapsed(since: now.addingTimeInterval(-59), now: now) == "59s")
        precondition(TaskRowPresentation.elapsed(since: now.addingTimeInterval(-60), now: now) == "1m")
        precondition(TaskRowPresentation.elapsed(since: now.addingTimeInterval(-3_600), now: now) == "1h")
        precondition(TaskRowPresentation.elapsed(since: now.addingTimeInterval(-86_400), now: now) == "1d")
        let resumed = try rowTask([
            "status": "running", "turnId": "current", "updatedAt": "2026-10-07T12:00:00.000Z",
            "events": [
                ["id": "old", "kind": "turn", "text": "", "turnId": "old", "at": "2026-10-05T12:00:00Z"],
                ["id": "user", "kind": "user", "text": "Continue", "at": "2026-10-07T11:59:50Z"],
                ["id": "current", "kind": "turn", "text": "", "turnId": "current", "at": "2026-10-07T11:59:57.000Z"]
            ]
        ])
        precondition(TaskRowPresentation.elapsed(since: TaskRowPresentation.runningStart(resumed)!, now: now) == "3s", "Live output does not reset the clock; resumed tasks do not include the previous turn")
        let connecting = try rowTask([
            "status": "running",
            "events": [["id": "user", "kind": "user", "text": "Continue", "at": "2026-10-07T11:59:50Z"]]
        ])
        precondition(TaskRowPresentation.elapsed(since: TaskRowPresentation.runningStart(connecting)!, now: now) == "10s", "Before a turn starts, use the latest user request")
        precondition(completed.git == nil && TaskRowPresentation.branch(completed.git) == "无分支信息", "Older services never imply a main branch")
        let branch = try rowTask(["git": ["status": "repository", "branch": "feature/sidebar", "isWorktree": true]])
        precondition(TaskRowPresentation.branch(branch.git) == "feature/sidebar" && branch.git?.isWorktree == true)
        let detached = try rowTask(["git": ["status": "repository", "head": "1234abcd", "isWorktree": false]])
        precondition(TaskRowPresentation.branch(detached.git) == "HEAD · 1234abcd" && detached.git?.isWorktree == false)
        let noRepo = try rowTask(["git": ["status": "not_repository"]])
        precondition(TaskRowPresentation.branch(noRepo.git) == "非 Git 工作区")
        let unavailable = try rowTask(["git": ["status": "unavailable"]])
        precondition(TaskRowPresentation.branch(unavailable.git) == "分支不可用")

        let legacyWorkspace = try JSONDecoder().decode(Project.self, from: Data(#"{"id":"a","name":"Friday","path":"/work/friday","context":"Keep this"}"#.utf8))
        precondition(legacyWorkspace.icon == nil && legacyWorkspace.color == nil)
        precondition(WorkspaceStyle.icon(legacyWorkspace.icon) == "folder")
        var customized = legacyWorkspace
        customized.icon = "book.closed"; customized.color = "purple"; customized.name = "Reading"
        let restored = try JSONDecoder().decode(Project.self, from: JSONEncoder().encode(customized))
        precondition(restored.name == "Reading" && restored.icon == "book.closed" && restored.color == "purple")
        precondition(restored.path == legacyWorkspace.path && restored.context == legacyWorkspace.context)
        precondition(WorkspaceStyle.color(restored.color, name: "Another name") == "purple", "Renaming must not change a chosen color")
        precondition(WorkspaceStyle.icon("future-symbol") == "folder", "Unsupported saved icons have a visible fallback")
        precondition(WorkspaceStyle.colors.contains(WorkspaceStyle.color("future-color", name: "Friday")))
        precondition(!WorkspaceStyle.validName(" \n ") && !WorkspaceStyle.validName(String(repeating: "a", count: 121)))
        precondition(WorkspaceStyle.validName("工作区") && WorkspaceStyle.validName(String(repeating: "a", count: 120)))
        precondition(!WorkspaceStyle.validName(String(repeating: "😀", count: 61)), "Name length matches the service's UTF-16 limit")
        print("Workspace filtering, legacy/deleted directory handling, search, swipe axis lock, threshold, cancellation, and boundaries passed")
        print("Workspace grouping, Artifacts deduplication, activity ordering, Worktree ownership and same-name directory isolation passed")
        print("Sidebar relative time, continuation timing, Git branches, Worktrees, detached HEAD and older services passed")
        print("Workspace appearance decoding, persistence, rename stability, fallbacks and name validation passed")

        let choices = try JSONDecoder().decode(TaskWorkspaceOptions.self, from: Data(#"{"git":{"status":"repository","branch":"main","isWorktree":false},"hasCommit":true,"branches":[{"ref":"refs/heads/main","name":"main","remote":false},{"ref":"refs/remotes/origin/main","name":"origin/main","remote":true}]}"#.utf8))
        var selection = TaskWorkspaceSelection()
        precondition(selection.isValid(in: choices) && selection.branchName(in: choices) == "main")
        precondition(selection.body["branch"] == nil && selection.body["mode"] as? String == "checkout")
        selection.branch = "refs/remotes/origin/main"
        precondition(!selection.isValid(in: choices), "Remote branches cannot be switched into the current checkout")
        selection.mode = "worktree"
        precondition(selection.isValid(in: choices) && selection.branchName(in: choices) == "origin/main")
        precondition(selection.body["branch"] as? String == "refs/remotes/origin/main")
        selection.selectMode("checkout")
        precondition(selection.branch == nil && selection.isValid(in: choices), "Moving execution location out of a Worktree clears a remote-only starting branch")
        selection.branch = "refs/heads/main"
        selection.selectMode("worktree")
        precondition(selection.branch == "refs/heads/main", "Changing execution location preserves a usable starting branch")
        selection.branch = "refs/heads/deleted"
        precondition(!selection.isValid(in: choices), "A deleted branch cannot silently fall back to HEAD")
        let unbornOptions = try JSONDecoder().decode(TaskWorkspaceOptions.self, from: Data(#"{"git":{"status":"repository","branch":"new","isWorktree":false},"hasCommit":false,"branches":[]}"#.utf8))
        selection.branch = nil
        precondition(!selection.isValid(in: unbornOptions))
        selection.mode = "checkout"
        precondition(selection.isValid(in: unbornOptions))
        let plainOptions = try JSONDecoder().decode(TaskWorkspaceOptions.self, from: Data(#"{"git":{"status":"not_repository"},"hasCommit":false,"branches":[]}"#.utf8))
        precondition(selection.isValid(in: plainOptions))
        selection.mode = "worktree"
        precondition(!selection.isValid(in: plainOptions))
        selection.branch = "refs/remotes/origin/main"
        let plainSelection = selection.resolved(in: plainOptions)
        precondition(plainSelection.isValid(in: plainOptions) && plainSelection.body["mode"] as? String == "checkout" && plainSelection.body["branch"] == nil,
            "A non-Git directory uses its current location even when a saved draft previously selected a Worktree and branch")
        precondition(selection.resolved(in: choices) == selection && selection.resolved(in: nil) == selection,
            "Keep Git draft choices while loading and when the directory remains a repository")
        print("Execution workspace selection, API payload, deleted/remote branches and unborn/non-Git validation passed")
        precondition(completed.branchChange == nil, "Older task records need no branch-change metadata")
        let switching = try rowTask(["branchChange": ["requestId": "change", "branch": "refs/heads/feature", "status": "queued"]])
        precondition(switching.branchChange?.active == true && !switching.active, "Switching reserves the checkout without pretending the agent is running")
        let switchFailed = try rowTask(["branchChange": ["requestId": "change", "branch": "refs/heads/feature", "status": "failed", "error": "Uncommitted changes"]])
        precondition(switchFailed.branchChange?.active == false && switchFailed.branchChange?.error == "Uncommitted changes")
        precondition(switchFailed.status == "completed", "A refused switch preserves the completed conversation")
        print("Existing conversation branch-change state and legacy task compatibility passed")
    }
}
