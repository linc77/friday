import SwiftUI
import CryptoKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskFileMention: Codable, Equatable, Sendable {
    let path: String; let kind: String
    init(_ entry: TaskFileEntry) { path = entry.path; kind = entry.kind }
    init(path: String, kind: String) { self.path = path; self.kind = kind }
    var valid: Bool {
        ["file", "directory"].contains(kind) && !path.isEmpty && (path as NSString).length <= 2048 && !path.contains("\0") &&
        (path == "/" ? kind == "directory" : !(path.hasPrefix("/") ? String(path.dropFirst()) : path).split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.lowercased() == ".git" }))
    }
    /// T3 serializeComposerFileLink: basename label, encodeURI destination with
    /// parentheses, hashes, question marks and backslashes escaped as well.
    var markdown: String {
        let name = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? path
        let label = name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*';/:@&=+$,")
        return "[" + label + "](" + (path.addingPercentEncoding(withAllowedCharacters: allowed) ?? "") + ")"
    }
}
struct TaskFileMentionPayload: Codable, Equatable, Sendable {
    var version = 1
    let scope: String
    let entries: [TaskFileMention]
    var markdown: String { entries.map(\.markdown).joined(separator: " ") }
    var data: Data? { try? JSONEncoder().encode(self) }
    static func scope(server: String, token: String, cwd: String, serviceId: String? = nil) -> String {
        if let serviceId, serviceId.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil {
            return SHA256.hash(data: Data(["service", serviceId, cwd].joined(separator: "\0").utf8)).map { String(format: "%02x", $0) }.joined()
        }
        let auth = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        return SHA256.hash(data: Data([server, auth, cwd].joined(separator: "\0").utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func decode(_ data: Data) -> Self? {
        guard data.count <= 128 * 1024, let value = try? JSONDecoder().decode(Self.self, from: data), value.version == 1,
              value.scope.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              !value.entries.isEmpty, value.entries.count <= 20, value.entries.allSatisfy(\.valid) else { return nil }
        return value
    }
    static func combine(_ values: [Self]) -> Self? {
        guard let first = values.first, values.allSatisfy({ $0.version == 1 && $0.scope == first.scope }) else { return nil }
        var seen: Set<String> = [], entries: [TaskFileMention] = []
        for value in values { for entry in value.entries where seen.insert(entry.path).inserted { entries.append(entry) } }
        guard !entries.isEmpty, entries.count <= 20, entries.allSatisfy(\.valid) else { return nil }; return Self(scope: first.scope, entries: entries)
    }
}
struct TaskFileMentionContext {
    let scope: String
    let enabled: Bool
    let insert: (TaskFileMentionPayload) -> Bool
    var reviewTarget: String? = nil
    var reviewEnabled = false
    var reviewRecords: [TaskContextReference] = []
    var review: ((TaskFileReviewMutation) -> Bool)? = nil
    var citations: TaskCitationComposer? = nil
    var browserAnnotations:TaskBrowserAnnotationComposer? = nil
    func receive(_ data: Data) -> Bool {
        guard enabled, let payload = TaskFileMentionPayload.decode(data), payload.scope == scope else { return false }
        return insert(payload)
    }
}
@MainActor final class TaskFileMentionBridge: ObservableObject {
    @Published private(set) var context: TaskFileMentionContext?
    private var owner: UUID?
    func register(_ context: TaskFileMentionContext, owner: UUID) { self.owner = owner; self.context = context }
    func clear(owner: UUID) { if self.owner == owner { context = nil; self.owner = nil } }
}
private struct TaskFileMentionBridgeKey: EnvironmentKey { static let defaultValue: TaskFileMentionBridge? = nil }
extension EnvironmentValues { var taskFileMentionBridge: TaskFileMentionBridge? { get { self[TaskFileMentionBridgeKey.self] } set { self[TaskFileMentionBridgeKey.self] = newValue } } }

enum TaskFileMentionTransfer {
    static let type = "dev.friday.file-mentions.v1"
    static let contentType = UTType(exportedAs: type, conformingTo: .data)
    #if os(macOS)
    static let pasteboardType = NSPasteboard.PasteboardType(type)
    static func read(_ pasteboard: NSPasteboard) -> TaskFileMentionPayload? {
        let items = pasteboard.pasteboardItems ?? []
        let data = items.compactMap { $0.data(forType: pasteboardType) }
        guard !data.isEmpty, data.count == items.count else { return nil }
        let payloads = data.compactMap(TaskFileMentionPayload.decode)
        guard payloads.count == data.count else { return nil }; return TaskFileMentionPayload.combine(payloads)
    }
    static func copy(_ payload: TaskFileMentionPayload) {
        guard let data = payload.data else { return }; let item = NSPasteboardItem()
        item.setData(data, forType: pasteboardType); item.setString(payload.markdown, forType: .string)
        NSPasteboard.general.clearContents(); NSPasteboard.general.writeObjects([item])
    }
    #else
    static func read(_ pasteboard: UIPasteboard) -> TaskFileMentionPayload? {
        guard let data = pasteboard.data(forPasteboardType: type) else { return nil }; return TaskFileMentionPayload.decode(data)
    }
    static func copy(_ payload: TaskFileMentionPayload) {
        guard let data = payload.data else { return }
        UIPasteboard.general.items = [[type: data, UTType.utf8PlainText.identifier: Data(payload.markdown.utf8)]]
    }
    #endif
    static func provider(_ payload: TaskFileMentionPayload) -> NSItemProvider {
        let provider = NSItemProvider()
        if let data = payload.data { provider.registerDataRepresentation(forTypeIdentifier: type, visibility: .all) { completion in completion(data, nil); return nil } }
        return provider
    }
}
