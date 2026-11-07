import Foundation

// A bounded snapshot is a live window, not a deletion of previously loaded
// messages. Merge by stable identity and sequence, within one account/epoch.
struct TaskConversationWindow {
    private(set) var scope = ""
    private(set) var epoch = ""
    private(set) var earlierCursor: String?
    private(set) var gapCursor: String?
    private var from = Int.max
    private var latestTo = 0
    private var gapTo = 0
    private var gapStop = 0
    private var touchVersion = 0
    private var messageVersion = 0
    private var eventWatermark = 0
    private var messageWatermark = 0
    private var requiredMessageSequences: [String: Int] = [:]
    private var messages: [String: ChatMessage] = [:]
    private var events: [String: TaskEvent] = [:]
    private var messageSequences: [String: Int] = [:]
    private var eventSequences: [String: Int] = [:]
    private var stale: [String: Int] = [:]
    private var staleMessages: [String: Int] = [:]
    private var kind = "turns"
    private var visibleMessages = Set<String>()

    var hasEarlier: Bool { earlierCursor != nil }
    var needsAutomaticLoading: Bool { gapCursor != nil || !stale.isEmpty || !staleMessages.isEmpty }
    var staleEventIDs: [String] { Array(Set(Array(stale.keys) + Array(staleMessages.keys)).sorted().prefix(128)) }
    func contains(_ id: String) -> Bool { events[id] != nil || messages[id] != nil && visibleMessages.contains(id) }

    mutating func accept(_ task: WorkItem, scope: String) {
        guard let info = task.conversationHistory else { return }
        if self.scope != scope || epoch != info.epoch {
            self = TaskConversationWindow(); self.scope = scope; epoch = info.epoch
            from = info.from; earlierCursor = info.nextCursor; latestTo = info.to
            kind = info.kind ?? "turns"
            touchVersion = info.touchVersion
            messageVersion = info.messageVersion ?? 0
            for id in info.messageTouches ?? [] { requiredMessageSequences[id] = info.sequence }
        } else if kind != (info.kind ?? "turns") {
            // Importing an old prefix or starting its first ordinary turn can
            // change range coordinates. Keep loaded bodies and visible IDs,
            // but never apply an in-flight page against the other coordinate.
            kind = info.kind ?? "turns"; from = info.from; latestTo = info.to
            earlierCursor = info.nextCursor; gapCursor = nil; gapTo = 0; gapStop = 0
        } else {
            if info.from > latestTo, let cursor = info.nextCursor {
                gapStop = gapCursor == nil ? latestTo : min(gapStop, latestTo)
                gapCursor = cursor; gapTo = info.from
            }
            if info.from < from { from = info.from; earlierCursor = info.nextCursor }
            latestTo = max(latestTo, info.to)
        }
        if info.touchVersion - touchVersion > info.touches.count {
            eventWatermark = info.sequence
        }
        touchVersion = max(touchVersion, info.touchVersion)
        if let version = info.messageVersion, version > messageVersion {
            let touched = info.messageTouches ?? []
            if version - messageVersion > touched.count { messageWatermark = info.sequence }
            for id in touched { requiredMessageSequences[id] = info.sequence }
            messageVersion = version
        }
        merge(messages: task.messages ?? [], events: task.events, sequence: info.sequence)
        visibleMessages.formUnion(info.visibleMessageIds ?? (task.messages ?? []).filter { ($0.historyOrder ?? Int.max) >= info.from && ($0.historyOrder ?? Int.max) < info.to }.map(\.id))
        let liveEventIDs = Set(task.events.map(\.id)); let liveMessageIDs = Set((task.messages ?? []).map(\.id))
        for id in liveEventIDs where (eventSequences[id] ?? 0) >= (stale[id] ?? 0) { stale.removeValue(forKey: id) }
        for id in liveMessageIDs where (messageSequences[id] ?? 0) >= (staleMessages[id] ?? 0) { staleMessages.removeValue(forKey: id) }
        for id in events.keys where !liveEventIDs.contains(id) && (eventSequences[id] ?? 0) < eventWatermark { stale[id] = eventWatermark }
        for id in messages.keys where !liveMessageIDs.contains(id) {
            let required = max(messageWatermark, requiredMessageSequences[id] ?? 0)
            if (messageSequences[id] ?? 0) < required { staleMessages[id] = required }
        }
        for change in info.touches where events[change.id] != nil && (eventSequences[change.id] ?? 0) <= info.sequence {
            if events[change.id]?.historyDigest == change.digest { stale.removeValue(forKey: change.id) }
            else { stale[change.id] = info.sequence }
        }
    }

    @discardableResult mutating func apply(_ page: TaskConversationPage, live: WorkItem, scope: String, cursor: String, gap: Bool) -> Bool {
        guard self.scope == scope, self.epoch == page.epoch, let info = live.conversationHistory,
              page.taskId == live.id, page.epoch == info.epoch, page.from >= 0, page.to >= page.from,
              (page.kind ?? "turns") == (info.kind ?? "turns"),
              page.to <= info.count || page.kind == "items" && page.sequence >= info.sequence && page.to <= page.count else { return false }
        accept(live, scope: scope)
        guard cursor == (gap ? gapCursor : earlierCursor), page.kind == "items" ? page.beforeCursor == cursor : page.to == (gap ? gapTo : from) else { return false }
        merge(messages: page.messages, events: page.events, sequence: page.sequence)
        visibleMessages.formUnion(page.visibleMessageIds ?? page.messages.map(\.id))
        if gap {
            if page.from <= gapStop || page.nextCursor == nil { gapCursor = nil }
            else { gapCursor = page.nextCursor; gapTo = page.from }
        } else { from = page.from; earlierCursor = page.nextCursor }
        accept(live, scope: scope)
        return true
    }

    @discardableResult mutating func apply(_ page: TaskEventPage, live: WorkItem, scope: String) -> Bool {
        guard self.scope == scope, epoch == page.epoch, let info = live.conversationHistory, page.taskId == live.id, info.epoch == page.epoch else { return false }
        let expected = Dictionary(info.touches.map { ($0.id, $0.digest) }, uniquingKeysWith: { _, last in last })
        var progressed = false
        for message in page.messages ?? [] {
            guard let required = staleMessages[message.id], page.sequence >= required else { continue }
            merge(messages: [message], events: [], sequence: page.sequence)
            staleMessages.removeValue(forKey: message.id); progressed = true
        }
        for event in page.events {
            guard let required = stale[event.id], page.sequence >= required else { continue }
            guard page.sequence > info.sequence || expected[event.id] == nil || expected[event.id] == event.historyDigest else { continue }
            merge(messages: [], events: [event], sequence: page.sequence)
            stale.removeValue(forKey: event.id); progressed = true
        }
        let liveIDs = Set(live.events.map(\.id) + (live.messages ?? []).map(\.id))
        for id in page.missing where !liveIDs.contains(id) {
            if let required = stale[id], page.sequence >= required { events.removeValue(forKey: id); eventSequences[id] = page.sequence; stale.removeValue(forKey: id); progressed = true }
            if let required = staleMessages[id], page.sequence >= required { messages.removeValue(forKey: id); visibleMessages.remove(id); messageSequences[id] = page.sequence; staleMessages.removeValue(forKey: id); progressed = true }
        }
        accept(live, scope: scope)
        let returned = Set(page.events.map(\.id) + (page.messages ?? []).map(\.id) + page.missing)
        return progressed || (!returned.isEmpty && returned.allSatisfy { stale[$0] == nil && staleMessages[$0] == nil })
    }

    func presenting(_ task: WorkItem, scope: String) -> WorkItem {
        guard self.scope == scope, epoch == task.conversationHistory?.epoch else { return task }
        var result = task
        result.messages = messages.isEmpty && task.messages == nil ? nil : messages.values.filter { visibleMessages.contains($0.id) && $0.revertedAt == nil }
            .sorted { ($0.historyOrder ?? Int.max) < ($1.historyOrder ?? Int.max) }
        result.events = events.values.filter { $0.revertedAt == nil }.sorted {
            if $0.historyOrder != $1.historyOrder { return ($0.historyOrder ?? Int.max) < ($1.historyOrder ?? Int.max) }
            return $0.at == $1.at ? $0.id < $1.id : $0.at < $1.at
        }
        return result
    }

    private mutating func merge(messages newMessages: [ChatMessage], events newEvents: [TaskEvent], sequence: Int) {
        for message in newMessages where (messageSequences[message.id] ?? -1) <= sequence {
            messages[message.id] = message; messageSequences[message.id] = sequence
        }
        for event in newEvents where (eventSequences[event.id] ?? -1) <= sequence {
            events[event.id] = event; eventSequences[event.id] = sequence
        }
    }
}
