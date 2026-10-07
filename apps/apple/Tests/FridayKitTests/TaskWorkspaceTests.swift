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
        print("Workspace filtering, legacy/deleted directory handling, search, swipe axis lock, threshold, cancellation, and boundaries passed")
    }
}
