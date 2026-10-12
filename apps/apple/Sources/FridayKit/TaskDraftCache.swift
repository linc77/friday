import Foundation
import CryptoKit

struct TaskMessageDraft: Codable {
    var message: String
    var images: [IdeaImage]
    var requestId: String
}

/// Client-only drafts, scoped to the service and this app's workspace identity.
/// Attachments reference the existing private local image cache.
enum TaskDraftCache {
    private static func key(server: String, context: String) -> String {
        let source = server + "\n" + context
        let digest = SHA256.hash(data: Data(source.utf8)).map { String(format: "%02x", $0) }.joined()
        return "friday.taskDraft." + digest
    }
    static func load<T: Decodable>(_ type: T.Type, server: String, context: String) -> T? {
        guard let data = UserDefaults.standard.data(forKey: key(server: server, context: context)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
    static func save<T: Encodable>(_ value: T?, server: String, context: String) {
        let key = key(server: server, context: context)
        if let value, let data = try? JSONEncoder().encode(value) { UserDefaults.standard.set(data, forKey: key) }
        else { UserDefaults.standard.removeObject(forKey: key) }
    }
}
