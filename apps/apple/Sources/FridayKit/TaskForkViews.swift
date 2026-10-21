import SwiftUI

private struct TaskForkRequest: Codable { let requestID: String }

struct TaskForkButton: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let runID: String
    let openTask: (String) -> Void
    @State private var busy = false
    @State private var error: String?

    private var supported: Bool {
        guard ["codex", "claude"].contains(task.agent) else { return false }
        guard let run = task.runs?.first(where: { $0.id == runID && $0.revertedAt == nil && $0.executionExcludedAt == nil }) else { return TaskNativeForkBoundary.supported(task, id: runID) }
        return ["completed", "failed", "cancelled", "interrupted"].contains(run.status)
    }
    var body: some View {
        if supported {
            VStack(alignment: .leading, spacing: 6) {
                Button(action: fork) {
                    FridaySymbolLabel(friday: "从此回复分叉", systemImage: "arrow.triangle.branch")
                }.buttonStyle(FridaySymbolButtonStyle())
                    .disabled(busy || !store.connected || task.sessionBusy || task.agent == "claude" && task.active)
                    .help(Text(friday: "保留到此轮为止的历史，在新任务中继续"))
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
    private func fork() {
        guard supported, !busy, store.connected, !task.sessionBusy else { return }
        let server = store.connection.server; let sourceID = task.id; let context = "fork:\(sourceID):\(runID)"
        let saved = TaskDraftCache.load(TaskForkRequest.self, server: server, context: context) ?? TaskForkRequest(requestID: UUID().uuidString)
        TaskDraftCache.save(saved, server: server, context: context)
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                let id = try await store.forkTask(sourceID, runID: runID, requestID: saved.requestID)
                TaskDraftCache.save(Optional<TaskForkRequest>.none, server: server, context: context)
                guard store.connection.server == server else { return }
                openTask(id)
            } catch { if store.connection.server == server { self.error = error.localizedDescription } }
        }
    }
}

struct TaskForkStatusView: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let openTask: (String) -> Void
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        if let origin = task.forkOrigin, task.forkOperation?.active == true || task.forkOperation?.strategy == "visible_history" {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "arrow.triangle.branch").font(.caption)
                    Text(friday: "分叉自").foregroundStyle(.secondary)
                    if let source = store.tasks.first(where: { $0.id == origin.taskId }) {
                        Button { openTask(source.id) } label: { Text(verbatim: source.title).lineLimit(1).truncationMode(.middle) }
                            .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "打开原任务"))
                    } else { Text(verbatim: origin.title).lineLimit(1).truncationMode(.middle) }
                    Spacer(minLength: 0)
                }.font(.caption)
                if let operation = task.forkOperation {
                    if operation.running {
                        HStack(spacing: 8) { ProgressView().controlSize(.small); Text(friday: "正在准备分叉会话…") }.font(.caption).foregroundStyle(.secondary)
                    } else if operation.active {
                        Text(fridayString: operation.error ?? "分叉结果尚未确认").font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                        HStack(spacing: 8) {
                            if operation.candidateId != nil {
                                Button(friday: "核对原生分叉") { resolve("inspect", operation: operation) }.buttonStyle(FridayButtonStyle(compact: true))
                            } else if operation.startedAt == nil {
                                Button(friday: "重试分叉") { resolve("retry", operation: operation) }.buttonStyle(FridayButtonStyle(compact: true))
                            }
                            Button(friday: "从可见历史建立新会话") { resolve("new_session", operation: operation) }.buttonStyle(FridayButtonStyle(compact: true))
                        }.disabled(busy || !store.connected)
                    } else if operation.strategy == "visible_history" {
                        Text(friday: "下一轮将在新会话中使用这里保留的可见历史。").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func resolve(_ action: String, operation: TaskForkOperation) {
        guard !busy, store.connected, operation.active, !operation.running else { return }
        let server = store.connection.server; let context = "fork-resolve:\(task.id):\(operation.id):\(action)"
        let saved = TaskDraftCache.load(TaskForkRequest.self, server: server, context: context) ?? TaskForkRequest(requestID: UUID().uuidString)
        TaskDraftCache.save(saved, server: server, context: context)
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do {
                try await store.resolveTaskFork(task.id, requestID: saved.requestID, action: action)
                TaskDraftCache.save(Optional<TaskForkRequest>.none, server: server, context: context)
            } catch { if store.connection.server == server { self.error = error.localizedDescription } }
        }
    }
}
