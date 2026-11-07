import SwiftUI

struct TaskFileLocation: Equatable { let path: String; var line: Int? = nil }
struct TaskFileDocument: Codable, Sendable {
    let path: String; let kind: String; let language: String; let mimeType: String; let sizeBytes: Int; let version: String; let truncated: Bool; let contents: String?
    var workspaceVersion: String? = nil
    var writeSupported: Bool? = nil
    func saved(contents: String, version: String) -> Self {
        Self(path: path, kind: kind, language: language, mimeType: mimeType, sizeBytes: contents.utf8.count, version: version, truncated: false, contents: contents, workspaceVersion: workspaceVersion, writeSupported: writeSupported)
    }
}
struct TaskFileAssetURL: Decodable { let url: String; let expiresAt: String; var workspaceRoot: String? = nil }
enum TaskHostPath {
    static func absolute(_ path: String, root: String) -> String {
        (path.hasPrefix("/") ? URL(fileURLWithPath: path) : URL(fileURLWithPath: root, isDirectory: true).appendingPathComponent(path)).standardizedFileURL.path
    }
    static func relative(_ path: String, root: String) -> String? {
        let path = absolute(path, root: root), root = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL.path
        if path == root { return "" }; let prefix = root == "/" ? "/" : root + "/"
        return path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : nil
    }
    static func panel(_ path: String, root: String) -> String { relative(path, root: root) ?? absolute(path, root: root) }
    static func entry(_ entry: TaskFileEntry, root: String) -> TaskFileEntry { TaskFileEntry(path: absolute(entry.path, root: root), name: entry.name, kind: entry.kind, ignored: entry.ignored) }
    static func loadedMatches(_ entries: [TaskFileEntry], query: String) -> [TaskFileEntry] {
        TaskFileTreeSearch.matching(entries, query: query)
    }
}
enum TaskFileNavigation {
    static func settingTaskChecked(in source: String, markerOffset: Int, checked: Bool) -> String? {
        let text = source as NSString
        guard markerOffset >= 0, markerOffset <= text.length - 3 else { return nil }
        let marker = text.substring(with: NSRange(location: markerOffset, length: 3))
        guard marker == "[ ]" || marker == "[x]" || marker == "[X]" else { return nil }
        return text.replacingCharacters(in: NSRange(location: markerOffset + 1, length: 1), with: checked ? "x" : " ")
    }
    static func location(_ raw: String, basePath: String?, workspaceRoot: String, allowHost: Bool = false) -> TaskFileLocation? {
        guard let url = MarkdownLinkPolicy.target(raw, workspacePath: basePath ?? workspaceRoot, canOpenLocalFiles: true), url.isFileURL else { return nil }
        let root = URL(fileURLWithPath: workspaceRoot, isDirectory: true).standardizedFileURL.path
        let path = url.standardizedFileURL.path
        guard allowHost || TaskHostPath.relative(path, root: root) != nil else { return nil }
        let fragment = URLComponents(string: raw)?.fragment
        let expression = try! NSRegularExpression(pattern: #"(?::|#L?)(\d+)(?::\d+)?$"#)
        let match = expression.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw))
        let line = match.flatMap { Range($0.range(at: 1), in: raw).flatMap { Int(raw[$0]) } } ?? fragment.flatMap { Int($0.hasPrefix("L") ? String($0.dropFirst()) : $0) }
        return TaskFileLocation(path: TaskHostPath.panel(path, root: root), line: line.flatMap { $0 > 0 ? $0 : nil })
    }
    static func route(_ kind: String, taskID: String, path: String) -> String {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "taskId", value: taskID), URLQueryItem(name: "path", value: path)]
        return "/api/task-files" + (kind.isEmpty ? "" : "/" + kind) + "?" + (query.percentEncodedQuery ?? "")
    }
}
struct TaskFileOpenContext {
    let root: String
    let open: (TaskFileLocation) -> Void
    func target(_ raw: String, basePath: String?) -> URL? {
        guard let location = TaskFileNavigation.location(raw, basePath: basePath, workspaceRoot: root, allowHost: true) else { return nil }
        let file = URL(fileURLWithPath: TaskHostPath.absolute(location.path, root: root))
        var components = URLComponents(url: file, resolvingAgainstBaseURL: false)
        components?.fragment = location.line.map { "L" + String($0) }; return components?.url
    }
}
private struct TaskFileOpenKey: EnvironmentKey { static let defaultValue: TaskFileOpenContext? = nil }
extension EnvironmentValues { var taskFileOpen: TaskFileOpenContext? { get { self[TaskFileOpenKey.self] } set { self[TaskFileOpenKey.self] = newValue } } }
