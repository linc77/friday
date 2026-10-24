import Foundation
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// URL formats and editor IDs: T3 8cd9641f packages/contracts/src/editor.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
enum TaskRemoteEditors {
    static let revisionKey = "friday.tasks.remoteEditorRevision"
    private static let hostsKey = "friday.tasks.remoteEditorHosts"
    private static let schemes = ["cursor": "cursor", "vscode": "vscode", "vscode-insiders": "vscode-insiders", "vscodium": "vscodium", "zed": "zed"]
    private static let products = ["idea": "IU", "aqua": "QA", "clion": "CL", "datagrip": "DB", "dataspell": "DS", "goland": "GO", "phpstorm": "PS", "pycharm": "PY", "rider": "RD", "rubymine": "RM", "rustrover": "RR", "webstorm": "WS"]
    private static let catalog: [TaskHostEditor] = [
        ("cursor", "Cursor"), ("vscode", "VS Code"), ("vscode-insiders", "VS Code Insiders"), ("vscodium", "VSCodium"), ("zed", "Zed"),
        ("idea", "IntelliJ IDEA"), ("aqua", "Aqua"), ("clion", "CLion"), ("datagrip", "DataGrip"), ("dataspell", "DataSpell"), ("goland", "GoLand"), ("phpstorm", "PhpStorm"), ("pycharm", "PyCharm"), ("rider", "Rider"), ("rubymine", "RubyMine"), ("rustrover", "RustRover"), ("webstorm", "WebStorm")
    ].map { TaskHostEditor(id: $0.0, label: $0.1) }
    static func alias(for server: String, defaults: UserDefaults = .standard) -> String? {
        guard let value = (defaults.dictionary(forKey: hostsKey) as? [String: String])?[server], !value.isEmpty else { return nil }
        return value
    }
    static func save(_ alias: String, for server: String, defaults: UserDefaults = .standard) throws {
        let value = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.isEmpty || validHost(value) else { throw ConnectionError.message("SSH 主机别名无效") }
        var hosts = defaults.dictionary(forKey: hostsKey) as? [String: String] ?? [:]
        if value.isEmpty { hosts.removeValue(forKey: server) } else { hosts[server] = value }
        defaults.set(hosts, forKey: hostsKey); defaults.set(defaults.integer(forKey: revisionKey) &+ 1, forKey: revisionKey)
    }
    private static func validHost(_ host: String) -> Bool {
        !host.isEmpty && host.utf8.count <= 1024 && !host.unicodeScalars.contains { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) } && !host.contains("/") && !host.contains("\\") && !host.contains("?") && !host.contains("#")
    }
    static func remoteURL(editor: String, host: String, absolutePath: String) -> URL? {
        guard validHost(host), !absolutePath.isEmpty, !absolutePath.unicodeScalars.contains(where: { $0.value == 0 || $0.value == 10 || $0.value == 13 }) else { return nil }
        let path = absolutePath.replacingOccurrences(of: "\\", with: "/")
        let component = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        func encoded(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: component) ?? "" }
        if let product = products[editor] {
            let form = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._*")
            func field(_ value: String) -> String { (value.addingPercentEncoding(withAllowedCharacters: form) ?? "").replacingOccurrences(of: "%20", with: "+") }
            return URL(string: "jetbrains://gateway/ssh/environment?h=\(field(host))&launchIde=true&ideHint=\(product)&projectHint=\(field(path))")
        }
        guard let scheme = schemes[editor] else { return nil }
        var rooted = path.hasPrefix("/") ? path : "/" + path
        if editor == "zed", absolutePath.range(of: #"^[Cc]:[\\/]"#, options: .regularExpression) != nil { rooted = String(rooted.dropFirst(3)) }
        let encodedPath = rooted.components(separatedBy: "/").map(encoded).joined(separator: "/")
        return URL(string: editor == "zed" ? "\(scheme)://ssh/\(encoded(host))\(encodedPath)" : "\(scheme)://vscode-remote/ssh-remote+\(encoded(host))\(encodedPath)")
    }
    @MainActor static func available() -> [TaskHostEditor] {
        #if os(macOS)
        let found = catalog.filter { editor in
            let scheme = schemes[editor.id] ?? "jetbrains"
            return URL(string: "\(scheme)://").flatMap { NSWorkspace.shared.urlForApplication(toOpen: $0) } != nil
        }
        if !found.isEmpty { return found }
        #endif
        return [TaskHostEditor(id: "vscode", label: "VS Code")]
    }
    @MainActor static func open(_ action: TaskHostEditorAction, root: String, host: String) async throws {
        let absolute = action.path.hasPrefix("/") || action.path.range(of: #"^[A-Za-z]:[\\/]"#, options: .regularExpression) != nil
        let path = action.path.isEmpty ? root : absolute ? action.path : root + (root.hasSuffix("/") || root.hasSuffix("\\") ? "" : "/") + action.path
        guard !action.reveal, let url = remoteURL(editor: action.editor, host: host, absolutePath: path) else { throw ConnectionError.message("无法生成 SSH 编辑器链接") }
        #if os(macOS)
        let opened = NSWorkspace.shared.open(url)
        #else
        let opened = await UIApplication.shared.open(url)
        #endif
        guard opened else { throw ConnectionError.message("本机未能打开远程编辑器，请检查应用和 SSH 配置") }
    }
}
