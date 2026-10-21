import Foundation

// Adapted from T3 Code 8cd9641f client-runtime/state/projectGrouping.ts,
// threadSort.ts and web/Sidebar.logic.ts. MIT, Copyright (c) 2026 T3 Tools Inc.;
// complete license in server/src/task-sidebar-order.ts.
enum TaskProjectSort: String, CaseIterable, Identifiable {
    case updated = "updated_at", created = "created_at", manual
    var id: String { rawValue }
    var title: String { switch self { case .updated: "最近活动"; case .created: "最近创建"; case .manual: "手动排序" } }
}
enum TaskProjectGrouping: String, CaseIterable, Identifiable {
    case repository, repositoryPath = "repository_path", separate
    var id: String { rawValue }
    var title: String { switch self { case .repository: "按仓库"; case .repositoryPath: "按仓库与子目录"; case .separate: "分别显示" } }
}
enum TaskThreadSort: String, CaseIterable, Identifiable {
    case updated = "updated_at", created = "created_at"
    var id: String { rawValue }
    var title: String { self == .updated ? "最近发送" : "最近创建" }
}
enum TaskProjectSidebar {
    static let scratchKey = "\0no-project"
    struct Version: Equatable {
        let projects: [[String]]; let tasks: [[String]]; let mode: TaskProjectGrouping; let order: TaskProjectSort
        let overrides: [String: String]; let preferred: [String]; let context: String
    }
    final class Cache {
        private var version: Version?
        private var value: [Group] = []
        func resolve(_ next: Version, projects: [Project], tasks: [WorkItem]) -> [Group] {
            if version != next {
                value = TaskProjectSidebar.groups(projects, tasks: tasks, mode: next.mode, overrides: next.overrides, order: next.order, preferred: next.preferred)
                version = next
            }
            return value
        }
    }
    static func version(_ projects: [Project], tasks: [WorkItem], mode: TaskProjectGrouping, overrides: [String: String], order: TaskProjectSort, preferred: [String], context: String) -> Version {
        let projectVersions: [[String]] = projects.map { project in
            let identity = project.repositoryIdentity
            var fields = [project.id, project.path, project.name, project.icon ?? "", project.color ?? ""]
            fields += [project.createdAt ?? "", project.updatedAt ?? "", project.isScratch == true ? "scratch" : "ordinary"]
            fields += [project.clone?.operationId ?? "", project.clone?.phase ?? "", project.clone?.stage ?? "", project.clone?.percent.map { String($0) } ?? ""]
            fields += [identity?.canonicalKey ?? "", identity?.rootPath ?? "", identity?.displayName ?? "", identity?.name ?? ""]
            fields += [identity?.origin?.canonicalKey ?? "", identity?.origin?.displayName ?? ""]
            return fields
        }
        let taskVersions: [[String]] = tasks.map { task in
            var fields = [task.id, task.projectId ?? "", task.cwd, task.agent, task.archivedAt ?? "", task.createdAt]
            fields.append(task.subagentOrigin == nil ? "root" : "child")
            fields.append(String(threadTimestamp(task, order: order == .created ? .created : .updated)))
            return fields
        }
        return Version(projects: projectVersions, tasks: taskVersions, mode: mode, order: order, overrides: overrides, preferred: preferred, context: context)
    }
    struct Group: Identifiable {
        let id: String; let name: String; let representative: Project; let members: [Project]; let projectIDs: Set<String>
        var scratch: Bool { id == TaskProjectSidebar.scratchKey }
        var draftProjectID: String? { scratch && members.isEmpty ? nil : representative.id }
    }
    static func normalize(_ path: String) -> String {
        var value = path.trimmingCharacters(in: .whitespacesAndNewlines)
        let root = value == "/" || value == "\\" || value.range(of: "^[A-Za-z]:[/\\\\]$", options: .regularExpression) != nil
        if !root {
            let trimmed = value.replacingOccurrences(of: value.hasPrefix("/") ? "/+$" : "[/\\\\]+$", with: "", options: .regularExpression)
            if !trimmed.isEmpty { value = trimmed.range(of: "^[A-Za-z]:$", options: .regularExpression) != nil ? trimmed + "\\" : trimmed }
        }
        if value.hasPrefix("\\\\") || value.range(of: "^[A-Za-z]:([/\\\\]|$)", options: .regularExpression) != nil { value = value.replacingOccurrences(of: "/", with: "\\").lowercased() }
        return value
    }
    static func logicalKey(_ project: Project, mode: TaskProjectGrouping) -> String {
        if project.isScratch == true { return scratchKey }
        let path = normalize(project.path), physical = "local:" + path
        guard mode != .separate, let identity = project.repositoryIdentity, !identity.groupingKey.isEmpty, !identity.groupingKey.contains("\0") else { return physical }
        if mode == .repositoryPath {
            let root = normalize(identity.rootPath)
            let separator = root.contains("\\") ? "\\" : "/"
            if !root.isEmpty && path.hasPrefix(root + separator) { return identity.groupingKey + "::" + path.dropFirst(root.count + 1).replacingOccurrences(of: "\\", with: "/") }
        }
        return identity.groupingKey
    }
    static func groups(_ projects: [Project], tasks: [WorkItem], mode: TaskProjectGrouping, overrides: [String: String] = [:], order: TaskProjectSort = .updated, preferred: [String] = []) -> [Group] {
        var physical: [String: [Project]] = [:], paths: [String] = []
        let ranks = Dictionary(preferred.enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        let input = order == .manual ? projects.enumerated().sorted { (ranks[normalize($0.element.path)] ?? Int.max, $0.offset) < (ranks[normalize($1.element.path)] ?? Int.max, $1.offset) }.map(\.element) : projects
        for project in input { let path = normalize(project.path); if physical[path] == nil { paths.append(path) }; physical[path, default: []].append(project) }
        var members: [String: [Project]] = [:], identifiers: [String: Set<String>] = [:], keys: [String] = []
        for path in paths {
            let values = physical[path]!, winner = values.max { newer($1, than: $0) }!
            let identity = winner.repositoryIdentity == nil ? values.filter { $0.repositoryIdentity != nil }.max { newer($1, than: $0) } : winner
            let grouping = TaskProjectGrouping(rawValue: overrides[path] ?? "") ?? mode
            let key = logicalKey(identity ?? winner, mode: grouping)
            if members[key] == nil { keys.append(key) }; members[key, default: []].append(winner)
            identifiers[key, default: []].formUnion(values.map(\.id))
        }
        var groups = keys.map { key in
            let items = members[key]!, first = items[0]
            return Group(id: key, name: key == scratchKey ? "无项目" : items.count > 1 ? groupName(items, first: first) : first.name, representative: first, members: items, projectIDs: identifiers[key]!)
        }
        if !groups.contains(where: { $0.scratch }) && tasks.contains(where: { $0.localAgent && $0.subagentOrigin == nil && $0.archivedAt == nil && $0.projectId == nil && TaskWorkspaces.project(for: $0, in: projects) == nil }) {
            groups.append(Group(id: scratchKey, name: "无项目", representative: Project(id: scratchKey, name: "无项目", path: "", context: ""), members: [], projectIDs: []))
        }
        guard order != .manual else { return groups }
        var groupByProject: [String: String] = [:]
        for group in groups { for id in group.projectIDs { groupByProject[id] = group.id } }
        var latest: [String: Double] = [:]
        for task in tasks where task.localAgent && task.subagentOrigin == nil && task.archivedAt == nil {
            let projectID = task.projectId ?? TaskWorkspaces.project(for: task, in: projects)?.id
            let key = projectID.flatMap { groupByProject[$0] } ?? (projectID == nil && task.projectId == nil ? scratchKey : "")
            if !key.isEmpty { latest[key] = max(latest[key] ?? -.infinity, threadTimestamp(task, order: order == .created ? .created : .updated)) }
        }
        let timestamps = Dictionary(groups.map { group in
            let timestamp = latest[group.id] ?? date(order == .created ? group.representative.createdAt : group.representative.updatedAt ?? group.representative.createdAt)
            return (group.id, timestamp)
        }, uniquingKeysWith: max)
        groups.sort {
            if timestamps[$0.id] != timestamps[$1.id] { return timestamps[$0.id]! > timestamps[$1.id]! }
            let names = $0.representative.name.compare($1.representative.name, options: [], locale: Locale(identifier: "en"))
            // T3 uses localeCompare: the reserved NUL is a namespace marker,
            // ignored by collation rather than sorted before every project.
            let keys = $0.id.replacingOccurrences(of: "\0", with: "").compare($1.id.replacingOccurrences(of: "\0", with: ""), options: [], locale: Locale(identifier: "en"))
            return names == .orderedSame ? keys == .orderedAscending : names == .orderedAscending
        }
        return groups
    }
    static func filtered(_ tasks: [WorkItem], group: Group?, projects: [Project]) -> [WorkItem] {
        guard let group else { return tasks }
        return tasks.filter { task in
            let project = TaskWorkspaces.project(for: task, in: projects)
            return project.map { group.projectIDs.contains($0.id) } == true || (group.scratch && task.projectId == nil && project == nil)
        }
    }
    static func threads(_ tasks: [WorkItem], order: TaskThreadSort) -> [WorkItem] {
        tasks.sorted { let a = threadTimestamp($0, order: order), b = threadTimestamp($1, order: order); return a == b ? $0.id > $1.id : a > b }
    }
    static func threadTimestamp(_ task: WorkItem, order: TaskThreadSort) -> Double {
        if order == .created { return validDate(task.createdAt) ?? validDate(task.updatedAt) ?? -.infinity }
        if let reported = task.sidebarActivity?.latestUserAuthoredMessageAt, let at = validDate(reported) { return at }
        if let at = task.messages?.filter({ $0.role == "user" && $0.revertedAt == nil }).compactMap({ validDate($0.at) }).max() { return at }
        return validDate(task.updatedAt) ?? validDate(task.createdAt) ?? -.infinity
    }
    static func preview(_ tasks: [WorkItem], expanded: Bool, overflow: Bool, count: Int, selected: String?) -> [WorkItem] {
        if !expanded { return tasks.filter { $0.id == selected } }
        return overflow ? tasks : Array(tasks.prefix(max(1,min(15,count))))
    }
    static func search(_ groups: [Group], query: String) -> [Group] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? groups : groups.filter { $0.name.range(of: query, options: [.caseInsensitive,.diacriticInsensitive]) != nil }
    }
    static func dictionaries(_ data: Data) -> [String: [String: String]] { (try? JSONDecoder().decode([String: [String: String]].self, from: data)) ?? [:] }
    static func orders(_ data: Data) -> [String: [String]] { (try? JSONDecoder().decode([String: [String]].self, from: data)) ?? [:] }
    static func scopes(_ data: Data) -> [String: String] { (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:] }
    private static func validDate(_ value: String?) -> Double? { CodexTranscript.date(value)?.timeIntervalSince1970 }
    private static func date(_ value: String?) -> Double { validDate(value) ?? -.infinity }
    private static func newer(_ a: Project, than b: Project) -> Bool { let left = validDate(a.updatedAt) ?? validDate(a.createdAt) ?? 0, right = validDate(b.updatedAt) ?? validDate(b.createdAt) ?? 0; return left == right ? a.id > b.id : left > right }
    private static func groupName(_ items: [Project], first: Project) -> String {
        func unique(_ values: [String]) -> [String] { var result: [String] = []; var seen: Set<String> = []; for value in values { let value = value.trimmingCharacters(in: .whitespacesAndNewlines); if !value.isEmpty && seen.insert(value).inserted { result.append(value) } }; return result }
        let names = unique(items.map(\.name)), display = unique(items.compactMap { $0.repositoryIdentity?.groupingName }), repositories = unique(items.compactMap { $0.repositoryIdentity?.name })
        if names.count == 1, !display.contains(names[0]), !repositories.contains(names[0]) { return names[0] }
        return display.count == 1 ? display[0] : repositories.count == 1 ? repositories[0] : first.name
    }
}
