import Foundation

struct TaskViewHistoryCache {
    struct Entry { let taskID: String; let epoch: String; let history: TaskHistoryWindow; let conversation: TaskConversationWindow }
    private var entries: [String: Entry] = [:]
    private var recent: [String] = []
    var capacity = 24
    mutating func save(task: WorkItem, scope: String, history: TaskHistoryWindow, conversation: TaskConversationWindow) {
        guard task.localAgent, let epoch = task.conversationHistory?.epoch ?? task.history?.epoch,
              task.conversationHistory == nil ? history.scope == scope && history.epoch == epoch : conversation.scope == scope && conversation.epoch == epoch else { return }
        entries[scope] = Entry(taskID: task.id, epoch: epoch, history: history, conversation: conversation)
        recent.removeAll { $0 == scope }; recent.append(scope)
        while recent.count > capacity { entries.removeValue(forKey: recent.removeFirst()) }
    }
    mutating func load(task: WorkItem, scope: String) -> Entry? {
        guard let entry = entries[scope], entry.taskID == task.id, entry.epoch == (task.conversationHistory?.epoch ?? task.history?.epoch) else { return nil }
        recent.removeAll { $0 == scope }; recent.append(scope); return entry
    }
    mutating func retain(_ ids: Set<String>) {
        entries = entries.filter { ids.contains($0.value.taskID) }; recent.removeAll { entries[$0] == nil }
    }
}
