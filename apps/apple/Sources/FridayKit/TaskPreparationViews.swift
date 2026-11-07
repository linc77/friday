import SwiftUI
import CryptoKit

private struct TaskPreparationRequest: Codable { let requestID: String }

struct TaskWorkspacePreparationFailure: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let run: TaskRun
    var compact = false
    @State private var busy = false
    @State private var failure: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !compact { FridaySymbolLabel(friday: "工作区准备失败", systemImage: "exclamationmark.circle")
                .foregroundStyle(.red).fontWeight(.medium) }
            VStack(alignment: .leading, spacing: 10) {
                if !compact, let error = run.workspacePreparation?.error { Text(fridayString: error).textSelection(.enabled) }
                if run.inheritedFrom == nil && run.before == nil && run.turnId == nil {
                    Button(action: retry) { FridaySymbolLabel(friday: "重试准备", systemImage: "arrow.counterclockwise") }
                        .buttonStyle(FridayButtonStyle(compact: true))
                        .disabled(busy || !store.connected || !task.canRetryPreparation(run))
                }
                if let failure { Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            }.padding(.leading, 25)
        }.font(.callout).frame(maxWidth: .infinity, alignment: .leading)
    }

    private func retry() {
        guard !busy, store.connected, task.canRetryPreparation(run) else { return }
        let server = store.connection.server; let identity = store.connectionIdentity
        let account = SHA256.hash(data: Data(store.connection.token.utf8)).map { String(format: "%02x", $0) }.joined()
        let context = "preparation:\(account):\(task.id):\(run.id):\(run.workspacePreparation?.attempt ?? 0)"
        let request = TaskDraftCache.load(TaskPreparationRequest.self, server: server, context: context) ?? TaskPreparationRequest(requestID: UUID().uuidString)
        TaskDraftCache.save(request, server: server, context: context)
        busy = true; failure = nil
        Task { @MainActor in
            defer { busy = false }
            guard store.connectionIdentity == identity else { return }
            do {
                _ = try await store.connection.data("/api/tasks/\(task.id)/runs/\(run.id)/preparation/retry", method: "POST", body: ["requestId": request.requestID])
                TaskDraftCache.save(Optional<TaskPreparationRequest>.none, server: server, context: context)
                guard store.connectionIdentity == identity else { return }
                await store.refresh()
            } catch { if store.connectionIdentity == identity { failure = error.localizedDescription } }
        }
    }
}

struct TaskWorkspacePreparationProgress: View {
    var body: some View {
        FridaySymbolLabel(friday: "正在准备工作区…", systemImage: "circle.dashed")
            .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
    }
}
