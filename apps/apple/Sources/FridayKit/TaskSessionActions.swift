import SwiftUI

extension FridayStore {
    func taskSessionAction(_ id: String, kind: String, target: [String: Any]? = nil, requestID: String) async throws {
        let identity = connectionIdentity
        var body: [String: Any] = ["requestId": requestID, "kind": kind]; if let target { body["target"] = target }
        struct Result: Decodable { let ok: Bool; let operation: TaskSessionOperation? }
        do {
            let result = try await connection.decode(Result.self, "/api/tasks/\(id)/session-operation", method: "POST", body: body, timeout: 90)
            guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
            await refresh()
            if !result.ok { throw ConnectionError.message(result.operation?.error ?? "原生会话操作尚未确认") }
        } catch {
            if connectionIdentity == identity { await refresh() }
            throw error
        }
    }
    func mergeTaskBack(_ task: WorkItem, runID: String, requestID: String) async throws -> String {
        let identity = connectionIdentity
        struct Result: Decodable { let id: String }
        let result = try await connection.decode(Result.self, "/api/tasks/\(task.id)/merge-back", method: "POST", body: ["requestId": requestID, "runId": runID])
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        await refresh(); return result.id
    }
}

struct TaskSessionOperationNotice: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var retrying = false
    @State private var failure: String?
    var body: some View {
        if let operation = task.sessionOperation, operation.busy {
            HStack(spacing: 8) {
                if operation.status == "pending" {
                    ProgressView().controlSize(.small)
                    Text(friday: operation.kind == "handoff" ? "正在交接 Agent…" : "正在断开会话…")
                } else {
                    Text(fridayString: failure ?? operation.error ?? "原生会话操作尚未确认").foregroundStyle(.orange).lineLimit(3)
                    Spacer(minLength: 0)
                    Button(friday: "重试会话操作") {
                        let identity = store.connectionIdentity; retrying = true; failure = nil
                        Task { @MainActor in
                            defer { if identity == store.connectionIdentity { retrying = false } }
                            do {
                                _ = try await store.connection.data("/api/tasks/\(task.id)/session-operation/retry", method: "POST", body: ["requestId": UUID().uuidString], timeout: 90)
                                if identity == store.connectionIdentity { await store.refresh() }
                            } catch { if identity == store.connectionIdentity { failure = error.localizedDescription } }
                        }
                    }.buttonStyle(FridayButtonStyle(compact: true)).disabled(retrying || !store.connected)
                }
            }.font(.caption)
        }
    }
}

struct TaskPendingTransfers: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var preview: TaskContextReference?
    @State private var removing: String?
    @State private var failure: String?
    private var pending: [TaskContextTransfer] { (task.contextTransfers ?? []).filter { $0.kind == "merge_back" && $0.status == "pending" } }
    var body: some View {
        if !pending.isEmpty {
            VStack(alignment: .leading, spacing: 5) {
                ForEach(pending) { transfer in
                    HStack(spacing: 8) {
                        Text(friday: "待合并上下文").foregroundStyle(.secondary)
                        Button { preview = transfer.reference } label: { Text(verbatim: transfer.reference.label).lineLimit(1) }
                            .buttonStyle(FridaySymbolButtonStyle())
                        Spacer(minLength: 0)
                        Button {
                            let identity = store.connectionIdentity; removing = transfer.id
                            Task { @MainActor in
                                defer { if identity == store.connectionIdentity { removing = nil } }
                                do { _ = try await store.connection.data("/api/tasks/\(task.id)/context-transfers/\(transfer.id)", method: "DELETE"); if identity == store.connectionIdentity { await store.refresh() } }
                                catch { if identity == store.connectionIdentity { failure = error.localizedDescription } }
                            }
                        } label: { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }
                            .buttonStyle(FridaySymbolButtonStyle()).disabled(removing != nil || !store.connected).accessibilityLabel(Text(friday: "取消合并上下文"))
                    }
                }
                if let failure { Text(fridayString: failure).foregroundStyle(.orange) }
            }.font(.caption)
            .popover(item: $preview) { reference in TaskContextPreview(store: store, reference: reference, scope: TaskContextScope(taskID: task.id)) }
            .onChange(of: store.connectionIdentity) { _, _ in preview = nil; removing = nil; failure = nil }
        }
    }
}
