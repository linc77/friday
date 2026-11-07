import Foundation

/// Pierre Trees beta.6 searches trimmed, slash-normalized lowercase substrings.
enum TaskFileTreeSearch {
    private static let whitespace = CharacterSet(charactersIn: "\u{0009}\u{000B}\u{000C}\u{0020}\u{00A0}\u{FEFF}\u{000A}\u{000D}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}")
    private static let caseLocale = Locale(identifier: "en_US_POSIX")
    static func normalize(_ query: String) -> String { query.trimmingCharacters(in: whitespace).replacingOccurrences(of: "\\", with: "/").lowercased(with: caseLocale) }
    static func matching(_ entries: [TaskFileEntry], query: String) -> [TaskFileEntry] {
        let query = normalize(query); guard !query.isEmpty else { return [] }
        var values: [String: TaskFileEntry] = [:]
        for entry in entries where TaskFileMention(entry).valid { if values[entry.path] == nil { values[entry.path] = entry } }
        for entry in Array(values.values) {
            let parts = entry.path.split(separator: "/"); var path = ""
            for part in parts.dropLast() { path += (path.isEmpty ? "" : "/") + part; if values[path] == nil { values[path] = TaskFileEntry(path: path, name: String(part), kind: "directory") } }
        }
        return values.values.filter { entry in
            let path = (entry.path + (entry.kind == "directory" ? "/" : "")).lowercased(with: caseLocale) as NSString
            return path.range(of: query, options: .literal).location != NSNotFound
        }
    }
}

struct TaskFileTreeItem: Equatable {
    let entry: TaskFileEntry
    let chain: [String]
    let title: String
    let children: [Self]
    var path: String { entry.path }
    var directory: Bool { entry.kind == "directory" }
    func expanded(in paths: Set<String>) -> Bool { chain.contains { paths.contains($0) } }
}
struct TaskFileTreeProjection: Equatable {
    let roots: [TaskFileTreeItem]
    let searching: Bool
    let query: String
    let directories: Set<String>
    init(entries: [String: [TaskFileEntry]] = [:], matches: [TaskFileEntry] = [], query: String = "") {
        let normalized = TaskFileTreeSearch.normalize(query), search = !normalized.isEmpty; searching = search; self.query = normalized
        var values: [String: TaskFileEntry] = [:]
        let loaded = entries.values.flatMap { $0 }
        for entry in search ? TaskFileTreeSearch.matching(loaded + matches, query: query) : loaded where TaskFileMention(entry).valid { values[entry.path] = entry }
        if search {
            for entry in Array(values.values) {
                let segments = entry.path.split(separator: "/"); var path = ""
                for segment in segments.dropLast() { path += (path.isEmpty ? "" : "/") + segment; if values[path] == nil { values[path] = TaskFileEntry(path: path, name: String(segment), kind: "directory") } }
            }
        }
        directories = Set(values.values.filter { $0.kind == "directory" }.map(\.path))
        var children: [String: [TaskFileEntry]] = [:]
        for entry in values.values {
            let parent = entry.path.split(separator: "/").dropLast().joined(separator: "/")
            children[parent, default: []].append(entry)
        }
        for key in children.keys { children[key]?.sort { left, right in left.kind != right.kind ? left.kind == "directory" : left.name.localizedStandardCompare(right.name) == .orderedAscending } }
        func build(_ entry: TaskFileEntry) -> TaskFileTreeItem {
            var current = entry, chain = [entry.path], titles = [entry.name]
            while !search, current.kind == "directory", let next = children[current.path], next.count == 1, next[0].kind == "directory" {
                current = next[0]; chain.append(current.path); titles.append(current.name)
            }
            return TaskFileTreeItem(entry: current, chain: chain, title: titles.joined(separator: "/"), children: (children[current.path] ?? []).map(build))
        }
        roots = (children[""] ?? []).map(build)
    }
    func visible(expanded: Set<String>) -> [(item: TaskFileTreeItem, depth: Int)] {
        var result: [(TaskFileTreeItem, Int)] = []
        func append(_ items: [TaskFileTreeItem], depth: Int) { for item in items { result.append((item, depth)); if item.directory && item.expanded(in: expanded) { append(item.children, depth: depth + 1) } } }
        append(roots, depth: 0); return result
    }
}

/// Selection changes during AppKit mouse tracking are held until it is known
/// whether the gesture clicked or dragged. A drag never opens a file preview.
struct TaskFileTreeInteraction {
    private(set) var selected: [TaskFileEntry] = []
    private var tracking = false, dragged = false, changed = false
    mutating func beginMouse() { tracking = true; dragged = false; changed = false }
    mutating func select(_ entries: [TaskFileEntry]) -> String? {
        let different = selected.map(\.path) != entries.map(\.path); if tracking && different { changed = true }; selected = entries
        return different && !tracking && !dragged && entries.last?.kind == "file" ? entries.last?.path : nil
    }
    mutating func endMouse() -> String? { tracking = false; return !dragged && changed && selected.last?.kind == "file" ? selected.last?.path : nil }
    mutating func beginDrag() { dragged = true }
    mutating func endDrag() { selected = []; tracking = false; dragged = true }
    mutating func beginKeyboard() { tracking = false; dragged = false }
}
struct TaskFileTreeReveal {
    private var settled = ""
    func pending(_ request: String) -> Bool { request != settled }
    mutating func resolve(_ request: String, selected: String?, found: Bool) { if selected == nil || found { settled = request } }
    mutating func interacted(_ request: String) { settled = request }
}
struct TaskFileTreeSearchState {
    private var query = ""
    private var collapsed: Set<String> = []
    mutating func observe(_ query: String) { if self.query != query { collapsed = [] }; self.query = query }
    func expanded(_ projection: TaskFileTreeProjection, workspace: Set<String>) -> Set<String> { projection.searching ? projection.directories.subtracting(collapsed) : workspace }
    mutating func toggle(_ item: TaskFileTreeItem, expanded: Bool) { if expanded { collapsed.subtract(item.chain) } else { collapsed.formUnion(item.chain) } }
}
struct TaskFileTreeSelectionOrigin {
    private var treePath: String?
    mutating func openedFromTree(_ path: String) { treePath = path }
    mutating func revealClearsSearch(_ path: String?) -> Bool { defer { treePath = nil }; return path != nil && path != treePath }
}
