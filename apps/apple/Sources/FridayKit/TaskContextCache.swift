import Foundation
import CryptoKit

enum TaskContextCache {
    private static func path(id: String, server: String, token: String) throws -> URL {
        guard id.range(of: #"^[a-zA-Z0-9_-]{1,128}$"#, options: .regularExpression) != nil else { throw CocoaError(.fileReadInvalidFileName) }
        let namespace = SHA256.hash(data: Data((server + "\n" + token).utf8)).map { String(format: "%02x", $0) }.joined()
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "dev.friday.client", isDirectory: true)
            .appendingPathComponent("TaskContexts", isDirectory: true).appendingPathComponent(namespace, isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return base.appendingPathComponent(id + ".json")
    }
    static func load(id: String, server: String, token: String) -> TaskContextSnapshot? {
        guard let url = try? path(id: id, server: server, token: token), let bytes = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(TaskContextSnapshot.self, from: bytes)
    }
    static func save(_ snapshot: TaskContextSnapshot, server: String, token: String) {
        guard let url = try? path(id: snapshot.reference.id, server: server, token: token), let bytes = try? JSONEncoder().encode(snapshot) else { return }
        do {
            try bytes.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch { /* Host capture remains authoritative if the local cache is unavailable. */ }
    }
}
