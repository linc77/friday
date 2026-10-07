import Foundation

/// UI terminology is Workspace; the existing service keeps its Project contract.
enum TaskWorkspaces {
    struct Group: Identifiable {
        let id: String
        let name: String
        let project: Project?
        var tasks: [WorkItem]
    }

    static func project(for task: WorkItem, in projects: [Project]) -> Project? {
        if let id = task.projectId { return projects.first { $0.id == id } }
        return projects.first { normalized($0.path) == normalized(task.cwd) }
    }

    static func name(for task: WorkItem, in projects: [Project]) -> String {
        if let project = project(for: task, in: projects) { return project.name }
        guard !task.cwd.isEmpty else { return "未关联 Workspace" }
        return URL(fileURLWithPath: task.cwd).lastPathComponent
    }

    static func tasks(_ tasks: [WorkItem], scope: String?, projects: [Project], query: String = "") -> [WorkItem] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return tasks.filter { task in
            task.localAgent && (scope == nil || project(for: task, in: projects)?.id == scope)
                && (search.isEmpty || [task.title, name(for: task, in: projects), task.agentName]
                    .contains { $0.localizedStandardContains(search) })
        }.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }

    static func groups(_ input: [WorkItem], projects: [Project]) -> [Group] {
        var groups: [Group] = []
        var indices: [String: Int] = [:]
        // The first task is the most recent, so both groups and their tasks
        // retain activity order. Names alone never identify a workspace.
        for task in tasks(input, scope: nil, projects: projects) {
            let project = project(for: task, in: projects)
            let id: String
            if let project { id = "project:\(project.id)" }
            else if let projectId = task.projectId { id = "missing-project:\(projectId)" }
            else { id = "directory:\(normalized(task.cwd))" }
            if let index = indices[id] {
                groups[index].tasks.append(task)
            } else {
                indices[id] = groups.count
                groups.append(Group(id: id, name: name(for: task, in: projects), project: project, tasks: [task]))
            }
        }
        return groups
    }

    private static func normalized(_ path: String) -> String {
        guard !path.isEmpty else { return "" }
        return URL(fileURLWithPath: path).standardizedFileURL.path
    }
}

/// Locks the gesture axis before consuming native scroll events. Momentum never
/// starts another page, and a vertically locked gesture remains a normal scroll.
struct WorkspaceSwipe {
    enum Axis { case undecided, horizontal, vertical }
    private(set) var axis: Axis = .undecided
    private(set) var x: Double = 0
    private var y: Double = 0

    mutating func update(x dx: Double, y dy: Double) -> Bool {
        x += dx; y += dy
        if axis == .undecided && max(abs(x), abs(y)) >= 8 {
            if abs(x) > abs(y) * 1.35 { axis = .horizontal }
            else if abs(y) > abs(x) { axis = .vertical }
        }
        return axis == .horizontal
    }

    func destination(index: Int, count: Int, cancelled: Bool = false) -> Int {
        guard !cancelled, axis == .horizontal, abs(x) >= 64 else { return index }
        return min(max(index + (x < 0 ? 1 : -1), 0), max(0, count - 1))
    }
}
