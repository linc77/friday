import Foundation

/// UI terminology is Workspace; the existing service keeps its Project contract.
enum TaskWorkspaces {
    static let historyGroupId = "history:deleted-workspaces"

    struct Group: Identifiable {
        let id: String
        let name: String
        let project: Project?
        var tasks: [WorkItem]
        var isHistory: Bool { id == TaskWorkspaces.historyGroupId }
    }

    static func project(for task: WorkItem, in projects: [Project]) -> Project? {
        if let id = task.projectId { return projects.first { $0.id == id } }
        return projects.first { normalized($0.path) == normalized(task.cwd) }
    }

    static func name(for task: WorkItem, in projects: [Project]) -> String {
        if let project = project(for: task, in: projects) { return project.isScratch == true ? "无项目" : project.name }
        guard !task.cwd.isEmpty else { return "未关联 Workspace" }
        return URL(fileURLWithPath: task.cwd).lastPathComponent
    }

    static func tasks(_ tasks: [WorkItem], scope: String?, projects: [Project], query: String = "", includeArchived: Bool = false) -> [WorkItem] {
        let search = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return tasks.filter { task in
            task.localAgent && task.subagentOrigin == nil && (includeArchived || task.archivedAt == nil) && (scope == nil || project(for: task, in: projects)?.id == scope)
                && (search.isEmpty || [task.title, name(for: task, in: projects), task.agentName]
                    .contains { $0.localizedStandardContains(search) })
        }.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt > $1.updatedAt }
    }

    enum Shelf: String, CaseIterable, Identifiable {
        case pinned, active, working, snoozed, settled
        var id: String { rawValue }
        var title: String {
            switch self { case .pinned: "置顶"; case .active: "活跃"; case .working: "Working"; case .snoozed: "稍后处理"; case .settled: "已结束" }
        }
    }

    static func isWorking(_ task: WorkItem) -> Bool {
        if let activity = task.sidebarActivity { return activity.working }
        // Old compact summaries omit approvals. Keep an ambiguous waiting
        // task in the inbox until an authoritative activity summary arrives.
        return task.localAgent && task.backgroundWaiting != true && (task.status == "queued" || task.status == "running" || task.queueActive) && !task.approvals.contains { $0.state == "pending" }
    }

    static func shelf(_ task: WorkItem, now: Date, workingShelfEnabled: Bool = false) -> Shelf {
        if TaskSnooze.isSnoozed(task, now: now) { return .snoozed }
        if task.settledAt != nil { return .settled }
        if task.pinnedAt != nil { return .pinned }
        if task.active || isWorking(task) { return workingShelfEnabled && isWorking(task) ? .working : .active }
        if task.settlementManaged == true { return .active }
        // T3's default auto-settle interval is three days. Manual Un-settle
        // restarts that interval without pretending new agent output arrived.
        let activity = max(CodexTranscript.date(task.updatedAt) ?? now, CodexTranscript.date(task.unsettledAt) ?? .distantPast)
        if task.autoSettle != false && now.timeIntervalSince(activity) >= 3 * 86_400 { return .settled }
        return .active
    }

    static func shelfTasks(_ tasks: [WorkItem], shelf: Shelf, now: Date, workingShelfEnabled: Bool = false, returnedAt: [String: Date] = [:]) -> [WorkItem] {
        tasks.filter { $0.subagentOrigin == nil && $0.archivedAt == nil && self.shelf($0, now: now, workingShelfEnabled: workingShelfEnabled) == shelf }.sorted {
            let left = $0; let right = $1
            if shelf == .working || shelf == .active && workingShelfEnabled {
                let a = shelf == .working ? workingSentAt(left) : inboxReturnAt(left, observed: returnedAt[left.id])
                let b = shelf == .working ? workingSentAt(right) : inboxReturnAt(right, observed: returnedAt[right.id])
                return a == b ? left.id < right.id : a > b
            }
            if shelf == .pinned || shelf == .active {
                let a = shelf == .pinned ? left.pinOrderKey : left.activeOrderKey
                let b = shelf == .pinned ? right.pinOrderKey : right.activeOrderKey
                if let a, let b { return a == b ? left.id < right.id : a < b }
                if (a != nil) != (b != nil) { return shelf == .pinned ? a != nil : a == nil }
                let anchor: (WorkItem) -> Date = { task in
                    let created = CodexTranscript.date(task.createdAt) ?? .init(timeIntervalSince1970: 0)
                    return shelf == .pinned ? created : max(created, CodexTranscript.date(task.unsettledAt) ?? .init(timeIntervalSince1970: 0))
                }
                return anchor(left) == anchor(right) ? left.id < right.id : anchor(left) > anchor(right)
            }
            if shelf == .snoozed {
                let a = CodexTranscript.date(left.snoozedUntil) ?? .init(timeIntervalSince1970: 0)
                let b = CodexTranscript.date(right.snoozedUntil) ?? .init(timeIntervalSince1970: 0)
                return a == b ? left.id < right.id : a < b
            }
            let a = settledDate(left); let b = settledDate(right)
            return a == b ? left.id < right.id : a > b
        }
    }

    private static func workingSentAt(_ task: WorkItem) -> Date {
        let authored: Date?
        if let activity = task.sidebarActivity { authored = CodexTranscript.date(activity.latestUserAuthoredMessageAt) }
        else {
            authored = task.messages?.filter { $0.role == "user" && $0.revertedAt == nil && $0.creationSource != "monitor" }.compactMap { CodexTranscript.date($0.at) }.max()
                ?? task.runs?.last(where: { $0.revertedAt == nil && $0.executionExcludedAt == nil }).flatMap { CodexTranscript.date($0.at) }
        }
        return max(CodexTranscript.date(task.createdAt) ?? .init(timeIntervalSince1970: 0), authored ?? .init(timeIntervalSince1970: 0))
    }

    private static func inboxReturnAt(_ task: WorkItem, observed: Date?) -> Date {
        let run = task.runs?.last { $0.revertedAt == nil && $0.executionExcludedAt == nil }
        let requested = task.sidebarActivity?.latestRunRequestedAt ?? (task.sidebarActivity == nil ? run?.at : nil)
        let completed = task.sidebarActivity?.latestRunCompletedAt ?? (task.sidebarActivity == nil ? run?.completedAt : nil)
        return ([task.createdAt, task.unsettledAt, requested, completed].compactMap { CodexTranscript.date($0) } + [observed].compactMap { $0 }).max() ?? .init(timeIntervalSince1970: 0)
    }

    private static func settledDate(_ task: WorkItem) -> Date {
        if let date = CodexTranscript.date(task.sidebarSettledAt ?? task.settledAt) { return date }
        let run = task.runs?.last { $0.revertedAt == nil && $0.executionExcludedAt == nil }
        let user = task.messages?.last { $0.role == "user" && $0.revertedAt == nil && $0.delivery == nil && $0.creationSource != "monitor" }
        return [user?.at, run?.at, run?.startedAt, run?.completedAt].compactMap { CodexTranscript.date($0) }.max()
            ?? CodexTranscript.date(task.updatedAt) ?? .init(timeIntervalSince1970: 0)
    }

    static func groups(_ input: [WorkItem], projects: [Project]) -> [Group] {
        var groups: [Group] = []
        var indices: [String: Int] = [:]
        var history: [WorkItem] = []
        // The first task is the most recent, so both groups and their tasks
        // retain activity order. Names alone never identify a workspace.
        for task in tasks(input, scope: nil, projects: projects) {
            let project = project(for: task, in: projects)
            if project == nil && task.projectId != nil {
                history.append(task)
                continue
            }
            let id: String
            if let project { id = "project:\(project.id)" }
            else { id = "directory:\(normalized(task.cwd))" }
            if let index = indices[id] {
                groups[index].tasks.append(task)
            } else {
                indices[id] = groups.count
                groups.append(Group(id: id, name: name(for: task, in: projects), project: project, tasks: [task]))
            }
        }
        if !history.isEmpty {
            groups.append(Group(id: historyGroupId, name: "历史任务", project: nil, tasks: history))
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
