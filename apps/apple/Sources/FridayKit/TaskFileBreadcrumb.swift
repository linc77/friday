import Foundation

struct TaskFileBreadcrumb: Equatable, Identifiable {
    let label: String; let path: String
    var id: String { path }
    static func path(_ path: String) -> String { (path.hasPrefix("/") ? "/" : "") + path.split(separator: "/").joined(separator: "/") }
    static func crumbs(project: String, trail: String) -> [Self] {
        let parts = trail.split(separator: "/").map(String.init)
        let host = trail.hasPrefix("/")
        return (host ? [] : [Self(label: project, path: "")]) + parts.indices.map { Self(label: parts[$0], path: (host ? "/" : "") + parts.prefix($0 + 1).joined(separator: "/")) }
    }
    static func retained(_ trail: String?, at current: String) -> String {
        guard let trail else { return current }
        return crumbs(project: "", trail: trail).contains { $0.path == path(current) } ? trail : current
    }
    static func parent(_ path: String) -> String? { let path = self.path(path); return path.isEmpty || path == "/" ? nil : (path.hasPrefix("/") ? "/" : "") + path.split(separator: "/").dropLast().joined(separator: "/") }
    static func children(_ entries: [TaskFileEntry], of directory: String) -> [TaskFileEntry] {
        let directory = path(directory), prefix = directory.isEmpty ? "" : directory == "/" ? "/" : directory + "/"
        return entries.filter { entry in
            guard entry.path.hasPrefix(prefix) else { return false }; let tail = entry.path.dropFirst(prefix.count)
            return !tail.isEmpty && !tail.contains("/")
        }.sorted { left, right in left.kind != right.kind ? left.kind == "directory" : left.name.localizedStandardCompare(right.name) == .orderedAscending }
    }
}
