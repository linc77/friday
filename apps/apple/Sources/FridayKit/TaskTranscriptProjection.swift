import Foundation
import Observation

/// A page owns a revision-scoped, immutable presentation. Layout and composer
/// updates only read it; history sorting and timeline derivation run off-main.
@MainActor @Observable final class TaskTranscriptProjection {
    struct Key: Equatable, Sendable {
        let scope: String
        let revision: Int
        let history: Int
        let conversation: Int
    }
    // These envelopes transfer immutable copies of the existing Codable value
    // models (structs/enums/arrays), not views, stores or mutable reference state.
    struct Input: @unchecked Sendable {
        let task: WorkItem
        let history: TaskHistoryWindow
        let conversation: TaskConversationWindow
        let scope: String
    }
    struct Value: @unchecked Sendable {
        let scope: String
        let task: WorkItem
        let rows: [CodexTranscriptRow]
    }
    private var value: Value?
    @ObservationIgnored private var committed: Key?
    @ObservationIgnored private var scope: String?
    @ObservationIgnored private var epoch = UUID()
    @ObservationIgnored private var pending: (key: Key, input: Input)?
    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private(set) var builds = 0
    @ObservationIgnored private(set) var lastBuildOnMainThread: Bool?
    private(set) var generation = 0

    func presentation(in scope: String) -> Value? {
        guard let value, value.scope == scope else { return nil }
        return value
    }

    func update(_ key: Key, input: Input?) {
        guard !Task.isCancelled else { return }
        if scope != key.scope { cancelPending(); scope = key.scope; value = nil }
        guard let input else { cancelPending(); value = nil; committed = key; return }
        guard committed != key || worker != nil else { return }
        pending = (key, input)
        guard worker == nil else { return }
        let token = epoch
        worker = Task { [weak self] in await self?.drain(token) }
    }

    private func drain(_ token: UUID) async {
        defer { if epoch == token { worker = nil } }
        while epoch == token, !Task.isCancelled, let next = pending {
            pending = nil
            guard let result = await TaskTranscriptRenderer.shared.render(next.input),
                  !Task.isCancelled, epoch == token else { return }
            // Commit completed work within this scope, even if a newer update
            // arrived meanwhile. Then render only the latest pending input.
            // Cancelling on every token would starve long, busy conversations.
            value = result.value; lastBuildOnMainThread = result.onMainThread
            committed = next.key; builds += 1; generation += 1
        }
    }

    func cancelPending() {
        epoch = UUID(); worker?.cancel(); worker = nil; pending = nil
    }
    func waitForPendingUpdates() async { await worker?.value }

}

private actor TaskTranscriptRenderer {
    static let shared = TaskTranscriptRenderer()
    struct Result: Sendable { let value: TaskTranscriptProjection.Value; let onMainThread: Bool }
    func render(_ input: TaskTranscriptProjection.Input) -> Result? {
        // Leaving a page or changing its scope cancels this work. Within a
        // scope, the owner coalesces queued updates without starving rendering.
        guard !Task.isCancelled else { return nil }
        let task = input.task.conversationHistory == nil
            ? input.history.presenting(input.task, scope: input.scope)
            : input.conversation.presenting(input.task, scope: input.scope)
        let rows = task.localAgent ? CodexTranscript.rows(task) : []
        guard !Task.isCancelled else { return nil }
        return Result(value: .init(scope: input.scope, task: task, rows: rows), onMainThread: Thread.isMainThread)
    }
}
