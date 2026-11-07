import SwiftUI

struct TaskWorktreeSetupCard: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem; let run: TaskRun; let snapshot: TaskWorktreeSetupSnapshot
    @State private var details = false
    @State private var expanded = false
    @State private var terminal: ProjectScriptIdentifier?
    @State private var stopping = false
    @State private var error: String?
    private var title: String { switch snapshot.phase { case "failed": "工作区准备失败"; case "cancelled": "工作区准备已停止"; case "done": snapshot.stages.contains { $0.status == "failed" } ? "初始化脚本未成功完成" : snapshot.stages.contains { $0.id == "submodules" && $0.status == "warning" } ? "子模块初始化未成功完成" : "工作区准备已结束"; default: snapshot.handedOff ? "初始化脚本仍在运行" : "正在准备工作区…" } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if snapshot.handedOff && !snapshot.active {
                    Button { expanded.toggle() } label: { FridaySymbolLabel(friday: title, systemImage: expanded ? "chevron.down" : "chevron.right") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.callout).foregroundStyle(.orange)
                } else { Text(fridayString: title).font(.callout.weight(.medium))
                    .foregroundStyle(snapshot.phase == "failed" ? Color.orange : .secondary) }
                Spacer(minLength: 8)
                if snapshot.active {
                    TimelineView(.periodic(from: .now, by: 1)) { context in elapsed(until: context.date) }
                } else { elapsed(until: CodexTranscript.date(snapshot.endedAt) ?? Date()) }
            }
            if snapshot.active || !snapshot.handedOff || expanded { ForEach(snapshot.stages) { stage in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 9) {
                        FridaySymbolImage(systemName: stage.symbol).frame(width: 16)
                            .foregroundStyle(stage.status == "failed" || stage.status == "warning" ? Color.orange : .secondary)
                            .fridaySymbolFeedback(value: stage.status)
                        Text(fridayString: stage.id == "setup-script" ? snapshot.setupScript?.name ?? stage.label : stage.label)
                        Spacer(minLength: 8)
                        if stage.status == "running" { Text(friday: "进行中").foregroundStyle(.secondary) }
                        else if stage.status == "skipped" { Text(friday: "已跳过").foregroundStyle(.secondary) }
                        if let detail = stage.detail { Text(verbatim: detail).foregroundStyle(.secondary).lineLimit(2).textSelection(.enabled) }
                    }
                    if stage.id == "setup-script", stage.status == "running" || stage.status == "failed", !stage.tail.isEmpty {
                        Text(verbatim: stage.tail.joined(separator: "\n")).font(.system(.caption2, design: .monospaced))
                            .foregroundStyle(stage.status == "failed" ? Color.orange : .secondary).textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(8).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6)).padding(.leading, 25)
                    }
                }
            } }
            if let message = snapshot.error { Text(fridayString: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(.leading, 25) }
            HStack(spacing: 12) {
                if let script = snapshot.setupScript {
                    Button(friday: "查看输出", systemImage: "terminal") { terminal = ProjectScriptIdentifier(id: script.runId) }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected)
                }
                Button { details.toggle() } label: { FridaySymbolLabel(friday: details ? "收起详情" : "准备详情", systemImage: details ? "chevron.up" : "chevron.down") }
                    .buttonStyle(FridaySymbolButtonStyle())
                if snapshot.canCancel {
                    Button(friday: stopping ? "正在停止" : "停止准备", systemImage: "stop") { stop() }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(stopping || !store.connected)
                }
            }.font(.caption).foregroundStyle(.secondary).padding(.leading, 25)
            if details {
                VStack(alignment: .leading, spacing: 5) {
                    if let branch = snapshot.branch { Text(verbatim: branch).font(.system(.caption, design: .monospaced)) }
                    if let path = snapshot.worktreePath { Text(verbatim: path).font(.system(.caption2, design: .monospaced)) }
                    if let command = snapshot.setupScript?.command { Text(verbatim: command).font(.system(.caption2, design: .monospaced)) }
                }.textSelection(.enabled).foregroundStyle(.secondary).padding(.leading, 25)
            }
            if run.preparationFailed { TaskWorkspacePreparationFailure(store: store, task: task, run: run, compact: true) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }.font(.caption).frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $terminal) { ProjectScriptRunView(store: store, id: $0.id).id(store.connectionIdentity + "\n" + $0.id) }
    }
    @ViewBuilder private func elapsed(until end: Date) -> some View {
        if let start = CodexTranscript.date(snapshot.startedAt) {
            Text(verbatim: "\(max(0, Int(end.timeIntervalSince(start))))s").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
    private func stop() {
        guard snapshot.canCancel, !stopping, store.connected else { return }
        let identity = store.connectionIdentity, connection = store.connection, taskID = task.id, runID = snapshot.runId, attempt = snapshot.attempt
        stopping = true; error = nil
        Task { @MainActor in
            defer { stopping = false }
            do {
                _ = try await connection.data("/api/tasks/\(taskID)/preparation/cancel", method: "POST", body: ["runId": runID, "attempt": attempt])
                guard store.connectionIdentity == identity else { return }; await store.refresh()
            } catch { if store.connectionIdentity == identity { self.error = error.localizedDescription } }
        }
    }
}
