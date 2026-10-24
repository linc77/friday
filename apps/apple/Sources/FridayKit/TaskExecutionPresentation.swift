import Foundation

struct TaskDiffSelection: Codable, Equatable {
    // Historical IDs always resolve saved content, independent of current files.
    var eventID: String? = nil
    var runID: String? = nil
    var path: String? = nil
}
struct TaskPanelPreferences: Codable {
    var diff: TaskDiffSelection? = nil
    var width: Double = 460
    var terminalShown: Bool? = nil
    var files: TaskFilesPanelState? = nil
    var activePanel: String? = nil
    var browser:TaskBrowserPanelState? = nil
}
struct TaskFileTab: Codable, Equatable, Identifiable {
    let path: String
    var line: Int? = nil
    var reveal = 0
    var directory: Bool? = nil
    var trail: String? = nil
    var isDirectory: Bool { path.isEmpty || directory == true }
    var id: String { path }
    var name: String { path.isEmpty ? "" : URL(fileURLWithPath: path).lastPathComponent }
}
struct TaskFilesPanelState: Codable, Equatable {
    var tabs: [TaskFileTab] = []
    var selected: String? = nil
    var expanded: Set<String> = [""]
    var explorerShown = false
    var visible = false
    var tab: TaskFileTab? { tabs.first { $0.path == selected } }
    var folderView: Bool { selected == nil || tab?.isDirectory == true }
    mutating func open(_ path: String, line: Int? = nil) {
        visible = true
        if !path.isEmpty { tabs.removeAll { $0.path.isEmpty } }
        if let index = tabs.firstIndex(where: { $0.path == path }) { if !path.isEmpty { tabs[index].line = line; tabs[index].reveal += 1 } }
        else { tabs.append(TaskFileTab(path: path, line: line, directory: path.isEmpty ? true : nil)) }
        selected = path
        revealAncestors(path, directory: tab?.isDirectory == true)
    }
    mutating func navigate(_ path: String, trail: String, keepSource: Bool) {
        visible = true; guard path != selected else { return }; let source = selected, sourceIndex = tabs.firstIndex { $0.path == source }
        if let existing = tabs.first(where: { $0.path == path && $0.path != source }) {
            if !keepSource, let source { tabs.removeAll { $0.path == source } }; selected = existing.path; revealAncestors(path, directory: existing.isDirectory); return
        }
        let target = TaskFileTab(path: path, directory: path.isEmpty || trail != path ? true : nil, trail: trail == path ? nil : trail)
        if let index = sourceIndex {
            if keepSource { tabs.insert(target, at: index + 1) } else { tabs[index] = target }
        } else { tabs.append(target) }
        if !path.isEmpty { tabs.removeAll { $0.path.isEmpty } }
        selected = path
        revealAncestors(path, directory: target.isDirectory)
    }
    private mutating func revealAncestors(_ path: String, directory: Bool) {
        guard !path.hasPrefix("/") else { return }
        var parts = path.split(separator: "/").map(String.init); if !directory, !parts.isEmpty { parts.removeLast() }
        while !parts.isEmpty { expanded.insert(parts.joined(separator: "/")); parts.removeLast() }
    }
    mutating func classify(_ path: String, directory: Bool) {
        guard let index = tabs.firstIndex(where: { $0.path == path }) else { return }
        let wasDirectory = tabs[index].isDirectory
        tabs[index].directory = directory
        if directory { tabs[index].line = nil; if !wasDirectory && !path.hasPrefix("/") { expanded.insert(path) } }
        else { tabs[index].trail = nil; expanded = expanded.filter { $0 != path && !$0.hasPrefix(path + "/") } }
    }
    mutating func close(_ path: String) {
        guard let index = tabs.firstIndex(where: { $0.path == path }) else { return }; tabs.remove(at: index)
        if selected == path { selected = tabs.isEmpty ? nil : tabs[min(index, tabs.count - 1)].path }
        if tabs.isEmpty { visible = false }
    }
}
struct TaskComposerSubmission {
    let provider: String; let model: String; let effort: String
    let dispatch: TaskComposerDispatch; let interactionMode: String
    var planEventID: String? = nil
    var implementInNewThread = false
    var compactBeforeSend = false
    var providerInstanceId: String? = nil
    var modelOptions: [ProviderOptionSelection]? = nil
}

enum TaskExecutionPresentation {
    static func currentPlan(_ task: WorkItem?, mode: String, editing: Bool) -> TaskEvent? {
        guard let task, !editing, mode == "plan", task.status == "completed", !task.active,
              task.queue?.pending.isEmpty != false else { return nil }
        let event = task.events.last { $0.revertedAt == nil && CodexTranscript.isProposal($0) && $0.turnId == task.turnId }
        return event?.status == "completed" && event?.text.isEmpty == false ? event : nil
    }
    static func relativePath(_ path: String, cwd: String) -> String {
        let root = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return path.hasPrefix(root) ? String(path.dropFirst(root.count)) : path
    }
    static func planMarkdown(_ text: String) -> String {
        text.replacingOccurrences(of: "^\\s*<proposed_plan>\\s*|\\s*</proposed_plan>\\s*$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    static func planTitle(_ text: String) -> String? {
        planMarkdown(text).components(separatedBy: .newlines).first { $0.range(of: "^ {0,3}#{1,6}\\s+\\S", options: .regularExpression) != nil }
            .map { $0.replacingOccurrences(of: "^ {0,3}#{1,6}\\s+", with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
    }
    static func displayedPlan(_ text: String) -> String {
        var lines = planMarkdown(text).components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
        if lines.first?.range(of: "^ {0,3}#{1,6}\\s+", options: .regularExpression) != nil { lines.removeFirst() }
        while lines.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeFirst() }
        if lines.first?.range(of: "^ {0,3}#{1,6}\\s+summary\\s*$", options: [.regularExpression, .caseInsensitive]) != nil {
            lines.removeFirst()
            while lines.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { lines.removeFirst() }
        }
        return lines.joined(separator: "\n")
    }
    static func planPreview(_ text: String, maxLines: Int = 10) -> String {
        var result: [String] = []; var visible = 0; var more = false
        for line in displayedPlan(text).components(separatedBy: "\n") {
            if !line.trimmingCharacters(in: .whitespaces).isEmpty { if visible >= maxLines { more = true; break }; visible += 1 }
            result.append(line)
        }
        while result.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { result.removeLast() }
        if result.isEmpty { return planTitle(text) ?? "" }
        if more { result += ["", "..."] }
        return result.joined(separator: "\n")
    }
    static func planFilename(_ text: String) -> String {
        let title = planTitle(text) ?? "plan"
        let clean = title.lowercased().replacingOccurrences(of: "[`'\".,!?()\\[\\]{}]+", with: "", options: .regularExpression)
            .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return String((clean.isEmpty ? "plan" : clean).prefix(100)) + ".md"
    }
}

enum TaskFileTree {
    struct Row: Identifiable {
        let id: String; let path: String; let name: String; let depth: Int; let directory: Bool
        let originalPath: String?
    }
    static func rows(paths: [String], cwd: String, collapsed: Set<String> = []) -> [Row] {
        var directories: [String: Set<String>] = ["": []]
        var files: [String: String] = [:]
        for path in paths {
            let components = TaskExecutionPresentation.relativePath(path, cwd: cwd).split(separator: "/").map(String.init)
            var parent = ""
            for (index, name) in components.enumerated() {
                let current = parent.isEmpty ? name : parent + "/" + name
                directories[parent, default: []].insert(current)
                if index == components.count - 1 { files[current] = path }
                else { if directories[current] == nil { directories[current] = [] } }
                parent = current
            }
        }
        var result: [Row] = []
        func append(_ parent: String, depth: Int) {
            let children = (directories[parent] ?? []).sorted { lhs, rhs in
                let leftDirectory = directories[lhs] != nil; let rightDirectory = directories[rhs] != nil
                if leftDirectory != rightDirectory { return leftDirectory }
                return lhs.localizedStandardCompare(rhs) == .orderedAscending
            }
            for child in children {
                let directory = directories[child] != nil
                result.append(Row(id: (directory ? "dir:" : "file:") + child, path: child, name: (child as NSString).lastPathComponent, depth: depth, directory: directory, originalPath: files[child]))
                if directory && !collapsed.contains(child) { append(child, depth: depth + 1) }
            }
        }
        append("", depth: 0)
        return result
    }
    static func directories(paths: [String], cwd: String) -> Set<String> {
        Set(rows(paths: paths, cwd: cwd).filter(\.directory).map(\.path))
    }
}
