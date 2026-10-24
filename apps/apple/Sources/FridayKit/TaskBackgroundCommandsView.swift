import SwiftUI

struct TaskBackgroundCommandsView: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    private var commands: [TaskBackgroundCommand] { TaskWorkspaces.isWorking(task) ? [] : (task.backgroundCommands ?? []).filter { $0.status == "running" || $0.status == "unknown" || $0.stop?.status == "pending" } }
    private var native: [TaskNativeBackgroundWork] {
        TaskWorkspaces.isWorking(task) ? [] : (task.nativeBackgroundWork ?? []).filter { work in
            work.visible && !(work.kind == "subagent" && task.subagents?.contains { $0.nativeId == work.taskId && $0.sessionId == work.transportId } == true)
        }
    }
    @State private var pending: UUID?
    @State private var failure: String?
    private var operation: TaskBackgroundStop? { task.backgroundStop?.sessionId == task.executionSessionId && (task.backgroundStop?.runId == nil || task.backgroundStop?.runId == task.currentRunId) ? task.backgroundStop : nil }
    private var scope: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "") + "\n" + task.id + "\n" + (task.executionSessionId ?? "") + "\n" + (task.currentRunId ?? "") }
    private var currentWork: Bool { commands.contains { $0.sessionId == task.executionSessionId } || native.contains { $0.transportId == task.executionSessionId } }
    private var canSettle: Bool { store.taskBackgroundSettlementSupported && !task.active && task.currentRunId != nil && task.executionSessionId != nil && operation?.status != "pending" && (currentWork || operation?.status == "uncertain") }
    var body: some View {
        Group {
            if !commands.isEmpty || !native.isEmpty || operation?.status == "pending" || operation?.status == "uncertain" {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        FridaySymbolLabel(friday: "后台工作", systemImage: "square.stack").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        Spacer()
                        if operation?.status == "pending" { Text(friday: "正在停止后台工作…").font(.caption).foregroundStyle(.secondary) }
                        else if canSettle {
                            Button { settle() } label: { FridaySymbolLabel(friday: operation?.status == "uncertain" ? "重新核对停止结果" : "停止后台工作", systemImage: operation?.status == "uncertain" ? "arrow.clockwise" : "stop") }
                                .buttonStyle(FridayButtonStyle(compact: true)).font(.caption).disabled(pending != nil || !store.connected)
                        }
                    }
                    if let error = failure ?? operation?.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                    ForEach(commands) { command in
                        TaskBackgroundCommandRow(store: store, task: task, command: command)
                    }
                    ForEach(native) { work in TaskNativeBackgroundRow(store: store, task: task, work: work) }
                }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                    .padding(.bottom, 8)
            }
        }.onChange(of: scope) { _, _ in pending = nil; failure = nil }
    }
    private func settle() {
        guard canSettle, pending == nil, let session = task.executionSessionId, let run = task.currentRunId else { return }
        let identity = scope; let transport = store.connection; let request = UUID(); pending = request; failure = nil
        Task { @MainActor in
            defer { if scope == identity, pending == request { pending = nil } }
            do {
                _ = try await transport.data("/api/tasks/\(task.id)/background/settle", method: "POST", body: ["sessionId": session, "runId": run, "requestId": request.uuidString])
                guard scope == identity, pending == request else { return }; await store.refresh()
            } catch { if scope == identity, pending == request { failure = error.localizedDescription } }
        }
    }
}

private struct TaskNativeBackgroundRow: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let work: TaskNativeBackgroundWork
    @State private var expanded = false
    @State private var pending: UUID?
    @State private var failure: String?
    private var scope: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "") + "\n" + task.id + "\n" + work.id }
    private var canStop: Bool { work.canStop != false && !task.backgroundStopPending && store.taskNativeBackgroundSupported && task.nativeBackgroundConnected == true && task.executionSessionId == work.transportId && work.status != "unknown" && !work.terminal && work.stop?.status != "pending" }
    private var parent: TaskNativeBackgroundWork? {
        guard let parentID = work.parentTaskId, parentID != work.taskId else { return nil }
        return task.nativeBackgroundWork?.filter { $0.taskId == parentID && $0.transportId == work.transportId }.max { $0.generation < $1.generation }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Button { expanded.toggle() } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        FridaySymbolImage(systemName: work.symbol).accessibilityHidden(true)
                        Text(verbatim: work.description).lineLimit(expanded ? nil : 2).frame(maxWidth: .infinity, alignment: .leading)
                    }.contentShape(Rectangle())
                }.buttonStyle(FridaySymbolButtonStyle()).font(.caption).fridaySymbolFeedback(value: expanded)
                    .accessibilityLabel(Text(fridayString: work.label)).accessibilityValue(Text(work.description))
                if work.stop?.status == "pending" {
                    Text(friday: "正在停止…").font(.caption).foregroundStyle(.secondary)
                } else if canStop {
                    Button { stop() } label: { FridaySymbolLabel(friday: "停止任务", systemImage: "stop") }
                        .buttonStyle(FridayButtonStyle(compact: true)).font(.caption).disabled(pending != nil || !store.connected)
                } else {
                    Text(fridayString: work.status == "unknown" || task.nativeBackgroundConnected != true ? "状态未确认" : work.label).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = failure ?? work.stop?.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if expanded {
                if let parent { HStack(spacing: 4) { Text(friday: "父任务"); Text(verbatim: parent.description) }.font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                if work.kind == "command" || work.kind == "monitor" { TaskCommandOutputView(store: store, task: task, event: work.outputEvent, nativeWork: work) }
                else if let summary = work.summary, !summary.isEmpty { Text(verbatim: summary).font(.caption).textSelection(.enabled) }
                else { Text(friday: "尚无进度摘要").font(.caption).foregroundStyle(.secondary) }
            }
        }.onChange(of: scope) { _, _ in pending = nil; failure = nil; expanded = false }
    }
    private func stop() {
        guard canStop, pending == nil else { return }
        let identity = scope; let transport = store.connection; let request = UUID(); pending = request; failure = nil
        Task { @MainActor in
            defer { if scope == identity, pending == request { pending = nil } }
            do {
                _ = try await transport.data("/api/tasks/\(task.id)/background/stop", method: "POST", body: ["eventId": work.id, "sessionId": work.transportId, "requestId": request.uuidString])
                guard scope == identity, pending == request else { return }; await store.refresh()
            } catch { if scope == identity, pending == request { failure = error.localizedDescription } }
        }
    }
}

private struct TaskBackgroundCommandRow: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let command: TaskBackgroundCommand
    @State private var pending: UUID?
    @State private var failure: String?
    private var scope: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "") + "\n" + task.id + "\n" + command.sessionId }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(verbatim: command.command).font(.system(.caption, design: .monospaced)).lineLimit(2).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if command.status == "unknown" || !store.taskBackgroundCommandsSupported {
                    Text(friday: "状态未确认").font(.caption).foregroundStyle(.orange)
                } else if command.stop?.status == "pending" {
                    Text(friday: "正在停止…").font(.caption).foregroundStyle(.secondary)
                } else if command.canStop {
                    Button { stop() } label: { FridaySymbolLabel(friday: "停止命令", systemImage: "stop") }
                        .buttonStyle(FridayButtonStyle(compact: true)).font(.caption)
                        .disabled(pending != nil || !store.connected || task.backgroundStopPending)
                } else {
                    Text(friday: "后台运行").font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = failure ?? command.stop?.error {
                Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
            }
        }
        .onChange(of: scope) { _, _ in pending = nil; failure = nil }
    }
    private func stop() {
        guard command.canStop, store.taskBackgroundCommandsSupported, !task.backgroundStopPending, pending == nil else { return }
        let identity = scope; let transport = store.connection; let request = UUID(); pending = request; failure = nil
        Task { @MainActor in
            defer { if scope == identity, pending == request { pending = nil } }
            do {
                _ = try await transport.data("/api/tasks/\(task.id)/background/stop", method: "POST", body: ["eventId": command.id, "sessionId": command.sessionId, "requestId": request.uuidString])
                guard scope == identity, pending == request else { return }
                await store.refresh()
            } catch { if scope == identity, pending == request { failure = error.localizedDescription } }
        }
    }
}
