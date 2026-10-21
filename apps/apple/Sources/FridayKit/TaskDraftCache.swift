import Foundation
import CryptoKit

struct TaskMessageDraft: Codable {
    var message: String
    var images: [IdeaImage]
    var requestId: String
    var queueEdit: QueuedMessageEditDraft? = nil
    var interactionMode: String? = nil
    var rewindEdit: TaskRewindDraft? = nil
    var contexts: [TaskContextReference]? = nil
    var contextInsertion: TaskContextInsertion? = nil
    var hasUserContent: Bool { TaskDraftContent.hasUserContent(message, images: images.count, contexts: contexts?.count ?? 0, pendingContext: contextInsertion != nil) || queueEdit != nil || rewindEdit != nil }
}
struct TaskComposerDraftBackup: Codable {
    var message: String; var images: [IdeaImage]; var requestId: String; var interactionMode: String?
    var contexts: [TaskContextReference]? = nil
    var contextInsertion: TaskContextInsertion? = nil
}
struct TaskRewindDraft: Codable {
    var requestId: String; var applied: Bool; var original: TaskComposerDraftBackup
}
struct QueuedMessageEditDraft: Codable {
    var id: String
    var message: String
    var images: [IdeaImage]
    var requestId: String
    var interactionMode: String? = nil
    var contexts: [TaskContextReference]? = nil
    var contextInsertion: TaskContextInsertion? = nil
}

/// Client-only drafts, scoped to the service and this app's workspace identity.
/// Attachments reference the existing private local image cache.
enum TaskDraftCache {
    static let restored = Notification.Name("Friday.TaskDraftRestored")
    static func notifyRestored(server: String, context: String) { NotificationCenter.default.post(name: restored, object: key(server: server, context: context)) }
    static func isRestore(_ notification: Notification, server: String, context: String) -> Bool { notification.object as? String == key(server: server, context: context) }
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
