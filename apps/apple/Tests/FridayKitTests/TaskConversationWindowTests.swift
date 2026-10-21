import Foundation

@main struct TaskConversationWindowTests {
    static func message(_ index: Int, text: String? = nil) -> ChatMessage {
        var value = ChatMessage(id: "message-\(index)", role: index.isMultiple(of: 2) ? "user" : "assistant", text: text ?? "Message \(index)", at: "2026-10-18T00:00:00Z")
        value.runId = "run-\(index / 2)"; value.historyOrder = index; return value
    }
    static func event(_ index: Int, digest: String? = nil, text: String? = nil) -> TaskEvent {
        var value = TaskEvent(id: "event-\(index)", kind: "command", text: text ?? "Tool \(index)", at: "2026-10-18T00:00:01Z", status: "completed")
        value.runId = "run-\(index / 2)"; value.historyOrder = index; value.historyDigest = digest ?? "digest-\(index)"; return value
    }
    static func task(from: Int, to: Int, sequence: Int, epoch: String = "epoch", touchVersion: Int = 0, touches: [TaskConversationTouch] = []) throws -> WorkItem {
        let json = #"{"id":"task","title":"History","prompt":"Question","projectId":null,"cwd":"/tmp","agent":"codex","mode":"research","status":"completed","createdAt":"2026-10-18T00:00:00Z","updatedAt":"2026-10-18T00:00:01Z","durableId":null,"threadId":"thread","turnId":null,"result":"","error":null,"events":[],"approvals":[],"artifact":null}"#
        var value = try JSONDecoder().decode(WorkItem.self, from: Data(json.utf8))
        value.messages = (from..<to).map { message($0) }; value.events = (from..<to).map { event($0) }
        value.conversationHistory = TaskConversationHistory(epoch: epoch, sequence: sequence, from: from, to: to, count: to, nextCursor: from > 0 ? "cursor-\(from)" : nil,
            hasEarlier: from > 0, touchVersion: touchVersion, touches: touches)
        return value
    }
    static func page(from: Int, to: Int, sequence: Int, epoch: String = "epoch", events: [TaskEvent]? = nil) -> TaskConversationPage {
        TaskConversationPage(taskId: "task", epoch: epoch, sequence: sequence, from: from, to: to, count: max(220, to), nextCursor: from > 0 ? "cursor-\(from)" : nil,
            hasEarlier: from > 0, touchVersion: 0, touches: [], messages: (from..<to).map { message($0) }, events: events ?? (from..<to).map { event($0) })
    }
    static func main() throws {
        var window = TaskConversationWindow(); let scope = "account:task"
        var live = try task(from: 80, to: 100, sequence: 2)
        live.messages?.append(message(70, text: "New control context")); live.events.append(event(70, digest: "new-70", text: "New control output"))
        window.accept(live, scope: scope)
        precondition(window.hasEarlier && !window.needsAutomaticLoading)
        precondition(window.presenting(live, scope: scope).messages?.count == 20, "Retained control context is not an older visible message")
        precondition(!window.apply(page(from: 40, to: 80, sequence: 1), live: live, scope: scope, cursor: "wrong", gap: false))
        precondition(window.apply(page(from: 40, to: 80, sequence: 1), live: live, scope: scope, cursor: "cursor-80", gap: false))
        var shown = window.presenting(live, scope: scope)
        precondition(shown.messages?.count == 60 && window.earlierCursor == "cursor-40")
        precondition(shown.messages?.first { $0.id == "message-70" }?.text == "New control context")
        precondition(shown.events.first { $0.id == "event-70" }?.text == "New control output", "A late older page cannot overwrite newer control data")
        live = try task(from: 100, to: 120, sequence: 3); window.accept(live, scope: scope)
        precondition(window.gapCursor == nil && window.presenting(live, scope: scope).messages?.count == 80)
        live = try task(from: 200, to: 220, sequence: 4); window.accept(live, scope: scope)
        precondition(window.gapCursor == "cursor-200" && window.earlierCursor == "cursor-40")
        precondition(window.apply(page(from: 160, to: 200, sequence: 4), live: live, scope: scope, cursor: "cursor-200", gap: true))
        precondition(window.apply(page(from: 120, to: 160, sequence: 4), live: live, scope: scope, cursor: "cursor-160", gap: true))
        shown = window.presenting(live, scope: scope)
        precondition(window.gapCursor == nil && shown.messages?.count == 180 && window.earlierCursor == "cursor-40", "Reconnect fills only the middle gap and keeps the user's older boundary")
        precondition(Set(shown.messages!.map(\.id)).count == shown.messages?.count)
        let changed = TaskConversationTouch(id: "event-60", digest: "changed-60")
        live = try task(from: 200, to: 220, sequence: 5, touchVersion: 1, touches: [changed]); window.accept(live, scope: scope)
        precondition(window.staleEventIDs == ["event-60"])
        precondition(!window.apply(TaskEventPage(taskId: "task", epoch: "epoch", sequence: 4, events: [event(60)], missing: []), live: live, scope: scope))
        precondition(window.apply(TaskEventPage(taskId: "task", epoch: "epoch", sequence: 6, events: [event(60, digest: "changed-60", text: "Updated old output")], missing: []), live: live, scope: scope))
        precondition(!window.needsAutomaticLoading)
        precondition(window.apply(page(from: 0, to: 40, sequence: 1, events: [event(60)]), live: live, scope: scope, cursor: "cursor-40", gap: false))
        precondition(window.presenting(live, scope: scope).events.first { $0.id == "event-60" }?.text == "Updated old output")
        let rows = CodexTranscript.rows(window.presenting(live, scope: scope))
        precondition(rows.count == Set(rows.map(\.id)).count, "History merges preserve stable unique transcript identities")
        let oldEpochPage = page(from: 0, to: 40, sequence: 8)
        live = try task(from: 200, to: 220, sequence: 10, epoch: "rewound"); window.accept(live, scope: scope)
        precondition(!window.contains("message-0") && !window.contains("event-60"))
        precondition(!window.apply(oldEpochPage, live: live, scope: scope, cursor: "cursor-200", gap: false))
        precondition(!window.apply(page(from: 160, to: 200, sequence: 10, epoch: "rewound"), live: live, scope: "other-account:task", cursor: "cursor-200", gap: false))
        precondition(window.scope == scope, "An old page cannot rebind the window to another account")

        var missingWindow = TaskConversationWindow(); let initial = try task(from: 80, to: 100, sequence: 1)
        missingWindow.accept(initial, scope: scope)
        precondition(missingWindow.apply(page(from: 40, to: 80, sequence: 1), live: initial, scope: scope, cursor: "cursor-80", gap: false))
        let missed = try task(from: 80, to: 100, sequence: 20, touchVersion: 200)
        missingWindow.accept(missed, scope: scope)
        precondition(missingWindow.staleEventIDs.count == 40, "A missed update summary refreshes already-loaded cold records")
        precondition(missingWindow.apply(TaskEventPage(taskId: "task", epoch: "epoch", sequence: 21, events: [], missing: ["event-60"]), live: missed, scope: scope))
        precondition(!missingWindow.contains("event-60"))
        precondition(missingWindow.apply(page(from: 0, to: 40, sequence: 1, events: [event(60)]), live: missed, scope: scope, cursor: "cursor-40", gap: false))
        precondition(!missingWindow.contains("event-60"), "A stale page cannot resurrect an event confirmed absent by a newer read")

        var receiptWindow = TaskConversationWindow(); receiptWindow.accept(initial, scope: scope)
        precondition(receiptWindow.apply(page(from: 40, to: 80, sequence: 1), live: initial, scope: scope, cursor: "cursor-80", gap: false))
        var receiptLive = try task(from: 80, to: 100, sequence: 2)
        receiptLive.conversationHistory?.messageVersion = 1; receiptLive.conversationHistory?.messageTouches = ["message-60"]
        receiptWindow.accept(receiptLive, scope: scope); precondition(receiptWindow.staleEventIDs == ["message-60"])
        var acknowledged = message(60); acknowledged.delivery = "sent"
        var receiptPage = TaskEventPage(taskId: "task", epoch: "epoch", sequence: 3, events: [], missing: []); receiptPage.messages = [acknowledged]
        precondition(receiptWindow.apply(receiptPage, live: receiptLive, scope: scope))
        precondition(receiptWindow.presenting(receiptLive, scope: scope).messages?.first { $0.id == "message-60" }?.delivery == "sent")
        precondition(!receiptWindow.needsAutomaticLoading, "Late message receipts update already-expanded older turns")
        var missedReceipt = try task(from: 80, to: 100, sequence: 20)
        missedReceipt.conversationHistory?.messageVersion = 200
        receiptWindow.accept(missedReceipt, scope: scope)
        precondition(receiptWindow.staleEventIDs.count == 40)

        var delayedWindow = TaskConversationWindow(); delayedWindow.accept(initial, scope: scope)
        delayedWindow.accept(missed, scope: scope)
        precondition(delayedWindow.apply(page(from: 40, to: 80, sequence: 1), live: missed, scope: scope, cursor: "cursor-80", gap: false))
        precondition(delayedWindow.staleEventIDs.count == 40, "A page that arrives after a missed-summary gap still refreshes against the newer watermark")

        var timeline = initial
        timeline.runs = try JSONDecoder().decode([TaskRun].self, from: Data(#"[{"id":"run-0","durableId":null,"messageId":"message-0","requestId":"request","cwd":"/tmp","at":"2026-10-18T00:00:00Z","status":"completed","mode":"research","interactionMode":"default","changes":[{"path":"old.txt","kind":"update","additions":1,"deletions":0,"binary":false}]}]"#.utf8))
        precondition(!CodexTranscript.rows(timeline).contains { $0.id == "run-changes-run-0" }, "Older control runs do not render cards outside the loaded timeline")
        var keptInput = try task(from: 0, to: 2, sequence: 3)
        keptInput.runs = timeline.runs
        precondition(CodexTranscript.rows(keptInput).contains { $0.id == "run-changes-run-0" })
        keptInput.runs?[0].executionExcludedAt = "2026-10-18T01:00:00Z"
        precondition(!CodexTranscript.rows(keptInput).contains { $0.id == "run-changes-run-0" }, "A kept input cannot display a file-change card from an execution outside the retained prefix")
        try itemWindows(scope: scope)
        print("Whole-turn history merge, control context, reconnect gaps, late-update repair, stable identity and account/epoch isolation passed")
    }

    static func itemWindows(scope: String) throws {
        var live = try task(from: 80, to: 100, sequence: 2)
        live.messages = [message(4), message(5), message(1, text: "New control body")]
        live.events = [event(90), event(99)]
        live.conversationHistory?.kind = "items"; live.conversationHistory?.visibleMessageIds = ["message-4", "message-5"]
        live.conversationHistory?.payloadBudgetExceeded = false
        var window = TaskConversationWindow(); window.accept(live, scope: scope)
        precondition(window.presenting(live, scope: scope).messages?.map(\.id) == ["message-4", "message-5"], "Mixed item positions do not hide messages with their independent message order")
        precondition(!window.contains("message-1"), "A retained control body does not suppress paging to the actual visible message")
        let older = TaskConversationPage(taskId: "task", epoch: "epoch", sequence: 1, from: 5, to: 80, count: 100,
            nextCursor: "cursor-5", hasEarlier: true, touchVersion: 0, touches: [], messages: (0..<4).map { message($0) }, events: [event(10)],
            kind: "items", visibleMessageIds: (0..<4).map { "message-\($0)" }, beforeCursor: "cursor-80")
        let data = try JSONEncoder().encode(live)
        let decoded = try JSONDecoder().decode(WorkItem.self, from: data)
        precondition(decoded.conversationHistory?.kind == "items" && decoded.conversationHistory?.payloadBudgetExceeded == false)
        precondition(window.apply(older, live: live, scope: scope, cursor: "cursor-80", gap: false))
        precondition(window.presenting(live, scope: scope).messages?.count == 6)
        precondition(window.presenting(live, scope: scope).messages?.first { $0.id == "message-1" }?.text == "New control body")
        var shifted = page(from: 0, to: 6, sequence: 3)
        shifted.kind = "items"; shifted.beforeCursor = "cursor-5"; shifted.visibleMessageIds = ["message-0"]
        precondition(window.apply(shifted, live: live, scope: scope, cursor: "cursor-5", gap: false), "An anchored item cursor survives a late insertion before its numeric boundary")
        precondition(!window.hasEarlier)
        live = try task(from: 180, to: 200, sequence: 4)
        live.conversationHistory?.kind = "items"; live.conversationHistory?.visibleMessageIds = ["message-180", "message-181"]
        window.accept(live, scope: scope)
        precondition(window.gapCursor == "cursor-180")
        var gap = page(from: 100, to: 181, sequence: 5)
        gap.kind = "items"; gap.beforeCursor = "wrong"
        precondition(!window.apply(gap, live: live, scope: scope, cursor: "cursor-180", gap: true))
        gap.beforeCursor = "cursor-180"
        precondition(window.apply(gap, live: live, scope: scope, cursor: "cursor-180", gap: true))
        precondition(window.gapCursor == nil && window.contains("message-4"), "Reconnect joins an item gap without discarding previously expanded history")
        let ordinary = try task(from: 200, to: 220, sequence: 6)
        window.accept(ordinary, scope: scope)
        precondition(window.gapCursor == nil && window.contains("message-4"), "Changing range coordinates preserves already-loaded bodies and visible identities")
        precondition(!window.apply(gap, live: ordinary, scope: scope, cursor: "cursor-180", gap: true), "An item page cannot use a whole-turn cursor after a coordinate change")
        var legacy = try task(from: 5, to: 10, sequence: 1)
        legacy.messages = nil; legacy.conversationHistory?.kind = "items"; legacy.conversationHistory?.visibleMessageIds = []
        var legacyWindow = TaskConversationWindow(); legacyWindow.accept(legacy, scope: scope)
        let shown = legacyWindow.presenting(legacy, scope: scope)
        precondition(shown.messages == nil && shown.conversation.first?.id == "original-user", "Legacy prompt/result fallback is retained when there is no stored message list")
    }
}
