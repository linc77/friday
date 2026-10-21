import SwiftUI

struct TaskRewindTarget: Identifiable { let id: String }

struct TaskRewindDialog: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let messageID: String
    let begin: (String) -> Void
    let end: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var options: TaskRewindOptions?
    @State private var error: String?
    @State private var sending = false
    @State private var requestID = UUID().uuidString
    @State private var submitted: (restore: Bool, fresh: Bool)?
    private var current: WorkItem { store.taskDetail(task.id) ?? task }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(friday: "从这里编辑？").font(.title3.weight(.semibold))
            Text(friday: "对话将回到这条消息之前，原请求和附件会放回输入框。").font(.callout).foregroundStyle(.secondary)
            if let options {
                Text(friday: "将回退 \(options.removedTurns) 轮执行").font(.caption).foregroundStyle(.secondary)
                if (options.additionalExecutionCount ?? 0) > 0 {
                    Text(friday: "也会回退较早请求后续产生的回复和处理记录，原请求会保留。").font(.caption).foregroundStyle(.secondary)
                }
                if let reason = options.restoreReason { Text(verbatim: reason).font(.caption).foregroundStyle(.secondary) }
                if let reason = options.nativeReason { Text(verbatim: reason).font(.caption).foregroundStyle(.orange) }
            } else if error == nil { ProgressView().controlSize(.small) }
            if let error { Text(verbatim: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let options, submitted == nil, options.nativeReason != nil || current.claudeResumePendingRun != nil {
                Button(friday: "从保留历史建立新会话") { submit(options, restore: false, fresh: true) }
                    .buttonStyle(.bordered).fridayInteractiveCursor().disabled(sending)
            }
            HStack(spacing: 12) {
                Button(friday: "取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(sending)
                Spacer(minLength: 4)
                if let submitted, let options {
                    Button(friday: "重试请求") { submit(options, restore: submitted.restore, fresh: submitted.fresh) }.buttonStyle(.borderedProminent).disabled(sending)
                } else if let options {
                    Button(friday: "同时恢复文件", role: .destructive) { submit(options, restore: true, fresh: false) }
                        .buttonStyle(.bordered).disabled(sending || !options.canRestore || options.nativeReason != nil)
                    Button(friday: "回退并保留改动") { submit(options, restore: false, fresh: false) }
                        .buttonStyle(.borderedProminent).disabled(sending || options.nativeReason != nil)
                } else if error != nil { Button(friday: "重试") { Task { await load() } }.buttonStyle(.bordered) }
                if sending { ProgressView().controlSize(.small) }
            }.fridayInteractiveCursor()
        }.padding(24)
            #if os(macOS)
            .frame(width: 530)
            #endif
            .task { await load() }
            .onChange(of: current.rewindOperation?.requestId) { _, id in
                if id == requestID { end(); dismiss() }
            }
    }
    private func load() async {
        error = nil
        do { options = try await store.taskRewindOptions(task.id, messageID: messageID) }
        catch { self.error = error.localizedDescription }
    }
    private func submit(_ options: TaskRewindOptions, restore: Bool, fresh: Bool) {
        guard !sending else { return }
        if submitted == nil { begin(requestID); submitted = (restore, fresh) }
        sending = true; error = nil
        Task {
            do {
                try await store.rewindTask(task.id, requestID: requestID, options: options, restoreFiles: restore, newSession: fresh)
                end(); dismiss()
            } catch { self.error = error.localizedDescription; end() }
            sending = false
        }
    }
}

struct TaskRewindStatusView: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let hasOriginalDraft: Bool
    let restoreOriginalDraft: () -> Void
    let openChanges: (String?) -> Void
    @State private var resolving = false
    @State private var error: String?
    @State private var showFiles = false
    @State private var showNewSession = false
    @State private var requestID = UUID().uuidString
    @State private var pendingAction: String?
    private var operation: TaskRewindOperation? { task.rewindOperation }
    var body: some View {
        if let operation, operation.status != "completed" || hasOriginalDraft {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    if operation.running || resolving { ProgressView().controlSize(.small) }
                    Text(friday: operation.running ? (operation.phase == "files" ? "正在恢复文件" : "正在回退会话") : operation.status == "completed" ? "原请求已放回输入框" : "回退需要处理")
                        .font(.caption.weight(.medium))
                    Spacer(minLength: 4)
                    if hasOriginalDraft { Button(friday: "恢复原草稿", action: restoreOriginalDraft).font(.caption) }
                }
                if let detail = error ?? operation.error { Text(verbatim: detail).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                if operation.needsReview || operation.status == "failed" {
                    HStack(spacing: 12) {
                        if operation.projectedAt != nil {
                            Button(friday: "查看当前改动") { openChanges(nil) }
                            Button(friday: "重新恢复文件") { showFiles = true }
                            Button(friday: "保留当前文件并结束") { resolve("keep_files") }
                        } else {
                            if operation.needsReview { Button(friday: "核对并继续回退") { resolve("inspect") } }
                            Button(friday: "从保留历史建立新会话") { showNewSession = true }
                        }
                    }.font(.caption).disabled(resolving || operation.running || !store.connected)
                }
            }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                .fridayInteractiveCursor()
                .sheet(isPresented: $showFiles) { TaskRewindFileReview(store: store, task: task, operation: operation, openChanges: openChanges) }
                .confirmationDialog(Text(friday: "从保留历史建立新会话？"), isPresented: $showNewSession, titleVisibility: .visible) {
                    Button(friday: "建立新会话并继续回退") { resolve("new_session") }
                    Button(friday: "取消", role: .cancel) {}
                } message: { Text(friday: "将保留已选历史并使用新的 Agent 会话。原会话记录仍保留；若这次请求包含文件恢复，将继续该操作。") }
        }
    }
    private func resolve(_ action: String) {
        guard !resolving, let operation else { return }
        if pendingAction != action { requestID = UUID().uuidString; pendingAction = action }
        resolving = true; error = nil
        Task {
            do { try await store.resolveTaskRewind(task.id, operationID: operation.id, requestID: requestID, action: action); pendingAction = nil }
            catch { self.error = error.localizedDescription }
            resolving = false
        }
    }
}

private struct TaskRewindFileReview: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem; let operation: TaskRewindOperation
    let openChanges: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var review: TaskRewindFileStatus?
    @State private var error: String?
    @State private var sending = false
    @State private var collapsed: Set<String> = []
    @State private var requestID = UUID().uuidString
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(friday: "重新恢复文件？").font(.title3.weight(.semibold))
            Text(friday: "将文件恢复到所选消息之前，保留当前分支和提交。请先核对当前改动。").font(.callout).foregroundStyle(.secondary)
            if let review {
                Text(verbatim: review.branch ?? "HEAD").font(.caption.monospaced())
                if review.missing { Text(friday: "Worktree 目录已清理，将重新创建并恢复所选检查点。").font(.caption).foregroundStyle(.secondary) }
                else if review.files.isEmpty { Text(friday: "当前没有未提交改动").font(.caption).foregroundStyle(.secondary) }
                else {
                    ScrollView {
                        TaskFileTreeView(paths: review.files.map(\.path), cwd: task.cwd, collapsed: $collapsed, selected: nil, canOpenLocalFiles: false, open: { path in dismiss(); openChanges(path) }) { path in
                            if let file = review.files.first(where: { $0.path == path }) { TaskDiffStat(additions: file.additions, deletions: file.deletions) }
                        }
                    }.frame(maxHeight: 240)
                }
            } else if error == nil { ProgressView().controlSize(.small) }
            if let error { Text(verbatim: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button(friday: "取消", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(sending)
                Spacer()
                if sending { ProgressView().controlSize(.small) }
                Button(friday: "刷新") { Task { await load() } }.disabled(sending)
                Button(friday: "恢复文件", role: .destructive) { submit() }.buttonStyle(.borderedProminent).disabled(sending || review == nil)
            }.fridayInteractiveCursor()
        }.padding(24)
            #if os(macOS)
            .frame(width: 500)
            #endif
            .task { await load() }
    }
    private func load() async {
        error = nil; review = nil; requestID = UUID().uuidString
        do { review = try await store.taskRewindFileReview(task.id, operationID: operation.id) }
        catch { self.error = error.localizedDescription }
    }
    private func submit() {
        guard !sending, let review else { return }
        sending = true; error = nil
        Task {
            do { try await store.resolveTaskRewind(task.id, operationID: operation.id, requestID: requestID, action: "retry_files", fileFingerprint: review.fingerprint); dismiss() }
            catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}
