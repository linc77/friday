import SwiftUI

struct TaskDelegatedBar: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let openTask: (String) -> Void
    @State private var stopping = false
    @State private var failure: String?
    private var identity: String { store.connectionIdentity + ":" + task.id }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                FridaySymbolImage(systemName: "person.2").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(friday: "委派子任务").font(.callout.weight(.medium))
                    Text(friday: "新一轮任务请从父任务重新委派").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                if task.active || task.backgroundStopAvailable {
                    Button(friday: "停止", action: stop).buttonStyle(FridayButtonStyle(compact: true)).disabled(stopping || !store.connected)
                }
                if let parent = task.delegationOrigin?.parentTaskId {
                    Button { openTask(parent) } label: { FridaySymbolLabel(friday: "返回父任务", systemImage: "arrow.turn.up.left") }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.tasks.contains { $0.id == parent })
                }
            }
            if let failure { Text(verbatim: failure).font(.caption).foregroundStyle(.orange) }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            .onChange(of: identity) { _, _ in stopping = false; failure = nil }
    }
    private func stop() {
        guard !stopping else { return }; stopping = true; failure = nil
        let scope = identity, transport = store.connection, taskID = task.id
        var body: [String: Any] = [:]
        if let run = task.currentRunId { body["runId"] = run }
        if let session = task.executionSessionId { body["sessionId"] = session }
        Task { @MainActor in
            defer { if scope == identity { stopping = false } }
            do { _ = try await transport.data("/api/tasks/\(taskID)/cancel", method: "POST", body: body); if scope == identity { await store.refresh() } }
            catch { if scope == identity { failure = error.localizedDescription } }
        }
    }
}
