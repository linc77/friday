import Foundation

// Store-owned, so temporary sidebar unmounts and Workspace changes preserve
// observed returns. A different connection/service starts a fresh observation.
struct TaskInboxReturnTracker {
    private var context = ""
    private var lastWorking: Set<String>?
    private(set) var returnedAt: [String: Date] = [:]
    mutating func observe(_ tasks: [WorkItem]?, context: String, now: Date) {
        if self.context != context { self = TaskInboxReturnTracker(); self.context = context }
        guard let tasks else { lastWorking = nil; returnedAt = [:]; return }
        let local = tasks.filter { $0.localAgent && $0.subagentOrigin == nil }
        let present = Set(local.map(\.id)); let working = Set(local.filter(TaskWorkspaces.isWorking).map(\.id))
        returnedAt = returnedAt.filter { present.contains($0.key) }
        for id in lastWorking ?? [] where present.contains(id) && !working.contains(id) { returnedAt[id] = now }
        lastWorking = working
    }
}

struct TaskSidebarDragPayload: Codable, Equatable {
    let token: UUID
    let taskID: String
    let section: String
}
struct TaskSidebarMoveRequest {
    let taskID: String
    let body: [String: Any]
}
struct TaskSidebarMovement {
    var up: (() -> Void)?
    var down: (() -> Void)?
}
enum TaskSidebarOrdering {
    static func plan(_ payload: TaskSidebarDragPayload, token: UUID, tasks: [WorkItem], projectID: String?, section: TaskWorkspaces.Shelf, over: String?, after: Bool, now: Date, workingShelfEnabled: Bool = false, returnedAt: [String: Date] = [:], projectIDs: Set<String>? = nil, includeUnassociated: Bool = false) -> TaskSidebarMoveRequest? {
        guard payload.token == token, section != .snoozed, section != .working, payload.section != "working",
              let task = tasks.first(where: { $0.id == payload.taskID && $0.localAgent && $0.subagentOrigin == nil && $0.archivedAt == nil }),
              TaskWorkspaces.shelf(task, now: now, workingShelfEnabled: workingShelfEnabled).rawValue == payload.section,
              over != task.id else { return nil }
        let source = TaskWorkspaces.shelf(task, now: now, workingShelfEnabled: workingShelfEnabled)
        if workingShelfEnabled && section == .active && source == .active { return nil }
        let current = TaskWorkspaces.shelfTasks(tasks, shelf: section, now: now, workingShelfEnabled: workingShelfEnabled, returnedAt: returnedAt)
        var ids = current.filter { $0.id != task.id }.map(\.id)
        if let over {
            guard let index = ids.firstIndex(of: over) else { return nil }
            ids.insert(task.id, at: index + (after ? 1 : 0))
        } else { ids.insert(task.id, at: after ? ids.count : 0) }
        if source == section, section == .settled || current.map(\.id) == ids { return nil }
        let expected: [[String: Any]] = current.map { row in
            let key = section == .pinned ? row.pinOrderKey : section == .active ? row.activeOrderKey : nil
            return ["id": row.id, "key": key as Any? ?? NSNull()]
        }
        var body: [String: Any] = ["requestId": UUID().uuidString, "projectId": projectID as Any? ?? NSNull(),
            "source": source.rawValue, "section": section.rawValue, "expected": expected, "orderedIds": ids]
        if workingShelfEnabled { body["workingShelfEnabled"] = true }
        if let projectIDs { body["projectId"] = NSNull(); body["projectIds"] = projectIDs.sorted(); if includeUnassociated { body["includeUnassociated"] = true } }
        return TaskSidebarMoveRequest(taskID: task.id, body: body)
    }
}

struct TaskTitleEdit: Identifiable {
    let id: UUID
    let taskID: String
    let scope: String
    var text: String
}

struct TaskTitleRenameState {
    enum Result: Equatable { case unchanged, cancelled, invalid(String), save(taskID: String, title: String) }
    private(set) var edit: TaskTitleEdit?

    mutating func begin(taskID: String, title: String, scope: String) {
        edit = TaskTitleEdit(id: UUID(), taskID: taskID, scope: scope, text: title)
    }
    mutating func change(_ text: String, token: UUID) { if edit?.id == token { edit?.text = text } }
    mutating func cancel() { edit = nil }
    mutating func finish(token: UUID, scope: String, currentTitle: String, cancelled: Bool = false) -> Result? {
        guard let edit, edit.id == token else { return nil }
        self.edit = nil
        guard edit.scope == scope, !cancelled else { return .cancelled }
        let title = edit.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 200,
              !edit.text.unicodeScalars.contains(where: { $0.value < 32 }) else {
            return .invalid("任务名称不能为空，最多 200 个字符且不能包含换行")
        }
        return title == currentTitle ? .unchanged : .save(taskID: edit.taskID, title: title)
    }
}

enum TaskSidebarNavigation {
    enum Direction { case previous, next }
    static func visible(_ tasks: [WorkItem], now: Date, expanded: Set<String>, selected: String?, workingShelfEnabled: Bool = false, returnedAt: [String: Date] = [:]) -> [WorkItem] {
        TaskWorkspaces.Shelf.allCases.flatMap { shelf in
            let rows = TaskWorkspaces.shelfTasks(tasks, shelf: shelf, now: now, workingShelfEnabled: workingShelfEnabled, returnedAt: returnedAt)
            return shelf == .pinned || shelf == .active || expanded.contains(shelf.id) ? rows : rows.filter { $0.id == selected }
        }
    }
    static func adjacent(_ ids: [String], selected: String?, direction: Direction) -> String? {
        guard !ids.isEmpty else { return nil }
        guard let selected else { return direction == .previous ? ids.last : ids.first }
        guard let index = ids.firstIndex(of: selected) else { return nil }
        let next = index + (direction == .previous ? -1 : 1)
        return ids.indices.contains(next) ? ids[next] : nil
    }
    static func jump(_ index: Int, ids: [String]) -> String? {
        index >= 0 && index < 9 && ids.indices.contains(index) ? ids[index] : nil
    }
}

struct TaskModelJumpContext {
    let owner: UUID
    let revision: UUID
    let titles: [String]
    let enabled: Set<Int>
    let choose: (Int) -> Void
}

struct TaskNavigationActions {
    let rows: [WorkItem]
    let selected: String?
    let model: TaskModelJumpContext?
    let editingTitle: Bool
    let open: (String) -> Void
    var search: (() -> Void)? = nil
    var previous: String? { editingTitle ? nil : TaskSidebarNavigation.adjacent(rows.map(\.id), selected: selected, direction: .previous) }
    var next: String? { editingTitle ? nil : TaskSidebarNavigation.adjacent(rows.map(\.id), selected: selected, direction: .next) }
    func title(_ index: Int) -> String? {
        guard (0..<9).contains(index) else { return nil }
        if let model { return model.titles.indices.contains(index) ? model.titles[index] : nil }
        return rows.indices.contains(index) ? rows[index].title : nil
    }
    func enabled(_ index: Int) -> Bool {
        guard !editingTitle, title(index) != nil else { return false }
        return model?.enabled.contains(index) ?? true
    }
    func jump(_ index: Int) {
        guard enabled(index) else { return }
        if let model { model.choose(index); return }
        if let id = TaskSidebarNavigation.jump(index, ids: rows.map(\.id)) { open(id) }
    }
}

enum TaskRelationships {
    struct Row: Identifiable {
        let taskID: String
        let title: String
        let parent: Bool
        let task: WorkItem?
        var delegated: Bool = false
        var id: String { taskID }
    }
    static func rows(for task: WorkItem, in tasks: [WorkItem]) -> [Row] {
        guard task.localAgent else { return [] }
        let local = tasks.filter { $0.localAgent && $0.id != task.id }
        var rows: [Row] = []
        var seen = Set<String>()
        if let origin = task.delegationOrigin, origin.parentTaskId != task.id {
            let parent = local.first { $0.id == origin.parentTaskId }
            rows.append(Row(taskID: origin.parentTaskId, title: parent?.title ?? origin.parentTaskId, parent: true, task: parent, delegated: true))
            seen.insert(origin.parentTaskId)
        }
        if let origin = task.forkOrigin, origin.taskId != task.id, !seen.contains(origin.taskId) {
            let source = local.first { $0.id == origin.taskId }
            rows.append(Row(taskID: origin.taskId, title: source?.title ?? origin.title, parent: true, task: source))
            seen.insert(origin.taskId)
        }
        let children = local.filter { $0.forkOrigin?.taskId == task.id || $0.delegationOrigin?.parentTaskId == task.id }.sorted {
            let left = CodexTranscript.date($0.createdAt)
            let right = CodexTranscript.date($1.createdAt)
            if left != right { return (left ?? .distantPast) > (right ?? .distantPast) }
            return $0.id < $1.id
        }
        for child in children where seen.insert(child.id).inserted {
            rows.append(Row(taskID: child.id, title: child.title, parent: false, task: child, delegated: child.delegationOrigin?.parentTaskId == task.id))
        }
        return rows
    }
    static func visible(_ count: Int, total: Int) -> Int { min(max(count, 0), total) }
    static func showMore(_ count: Int, total: Int) -> Int { min(max(6, count) + 12, total) }
}
