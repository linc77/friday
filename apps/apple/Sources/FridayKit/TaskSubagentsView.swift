import SwiftUI

struct TaskSubagentTimelineRow: View {
    @ObservedObject var store: FridayStore
    let agent: TaskSubagent
    var allowsStop = false
    let openTask: (String) -> Void
    @State private var pending: UUID?
    @State private var failure: String?
    private var available: Bool { store.tasks.contains { $0.id == agent.childTaskId && $0.subagentOrigin?.subagentId == agent.id } }
    private var rootTaskId: String? { store.tasks.first { $0.id == agent.childTaskId }?.subagentOrigin?.rootTaskId }
    private var scope: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "") + "\n" + (rootTaskId ?? "") + "\n" + agent.id + "\n" + agent.sessionId + "\n" + agent.childTurnId }
    private var detail: String { (agent.active ? agent.progress ?? agent.result : agent.result ?? agent.progress) ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                Button { openTask(agent.childTaskId) } label: { rowContent }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(!available)
                    .accessibilityLabel(Text(friday: "查看子 Agent 对话"))
                    .accessibilityValue(Text(verbatim: agent.title + " · " + agent.statusText))
                    .help(Text(verbatim: [agent.title, agent.model, agent.progress, agent.result].compactMap { $0 }.joined(separator: "\n")))
                if allowsStop {
                    if agent.stop?.status == "pending" { Text(friday: "正在停止…").font(.caption).foregroundStyle(.secondary) }
                    else if agent.canStop == true {
                        Button { stop() } label: { FridaySymbolLabel(friday: "停止子 Agent", systemImage: "stop") }
                            .buttonStyle(FridayButtonStyle(compact: true)).font(.caption).disabled(pending != nil || !store.connected)
                    }
                }
            }
            if let error = failure ?? agent.stop?.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }.onChange(of: scope) { _, _ in pending = nil; failure = nil }
    }
    private var rowContent: some View {
        HStack(alignment: .center, spacing: 10) {
            FridaySymbolImage(systemName: "person.2").font(.system(size: 16)).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(verbatim: agent.title).font(.callout.weight(.medium)).lineLimit(1)
                    if !detail.isEmpty { Text(fridayString: agent.statusText).font(.caption).foregroundStyle(.secondary) }
                }
                if detail.isEmpty { Text(fridayString: agent.statusText).font(.caption).foregroundStyle(.secondary) }
                else { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let started = CodexTranscript.date(agent.startedAt) {
                if agent.active { Text(started, style: .relative).font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
                else if let ended = CodexTranscript.date(agent.completedAt) { Text(verbatim: "\(max(0, Int(ended.timeIntervalSince(started))))s").font(.caption.monospacedDigit()).foregroundStyle(.secondary) }
            }
            if available { FridaySymbolImage(systemName: "chevron.right").font(.system(size: 10)).foregroundStyle(.secondary) }
        }.padding(.horizontal, 8).padding(.vertical, 7).contentShape(Rectangle())
    }
    private func stop() {
        guard let root = rootTaskId, agent.canStop == true, pending == nil else { return }
        let identity = scope; let request = UUID(); let transport = store.connection; pending = request; failure = nil
        let body = ["sessionId": agent.sessionId, "childTurnId": agent.childTurnId, "requestId": request.uuidString]
        Task { @MainActor in
            defer { if scope == identity, pending == request { pending = nil } }
            do {
                _ = try await transport.data("/api/tasks/\(root)/subagents/\(agent.id)/stop", method: "POST", body: body)
                guard scope == identity, pending == request else { return }; await store.refresh()
            } catch { if scope == identity, pending == request { failure = error.localizedDescription } }
        }
    }
}

struct TaskNativeSubagentBar: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let openTask: (String) -> Void
    var body: some View {
        HStack(spacing: 12) {
            FridaySymbolImage(systemName: "person.2").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(friday: "原生子 Agent").font(.callout.weight(.medium))
                    if let model = task.model { Text(verbatim: model).font(.caption).foregroundStyle(.secondary) }
                    Text(fridayString: task.statusText).font(.caption).foregroundStyle(.secondary)
                }
                Text(friday: "在父任务中处理授权和继续对话").font(.caption).foregroundStyle(.secondary)
                TaskNativeHistoryStatus(store: store, task: task).id(task.id)
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let parent = task.subagentOrigin?.parentTaskId {
                Button { openTask(parent) } label: { FridaySymbolLabel(friday: "返回父任务", systemImage: "arrow.turn.up.left") }
                    .buttonStyle(FridayButtonStyle(compact: true))
                    .disabled(!store.tasks.contains { $0.id == parent })
            }
        }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
    }
}

private struct TaskNativeHistoryStatus: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var busy = false
    @State private var failed = false

    var body: some View {
        if task.nativeHistory?.status == "loading" {
            Text(friday: "正在读取历史…").font(.caption).foregroundStyle(.secondary)
        } else if task.nativeHistory?.status == "failed" || failed {
            HStack(spacing: 8) {
                Text(friday: "暂时无法读取对话历史").foregroundStyle(.secondary)
                Button(action: retry) { FridaySymbolLabel(friday: "重试", systemImage: "arrow.clockwise") }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(busy || !store.connected)
            }.font(.caption)
        }
    }
    private func retry() {
        guard !busy, store.connected else { return }
        let identity = store.connectionIdentity; let connection = store.connection; let id = task.id
        busy = true; failed = false
        Task { @MainActor in
            defer { busy = false }
            do { _ = try await connection.data("/api/tasks/\(id)/native-history/refresh", method: "POST", body: [:]) }
            catch { if store.connectionIdentity == identity { failed = true } }
        }
    }
}
