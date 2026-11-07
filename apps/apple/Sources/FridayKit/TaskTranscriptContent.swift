import SwiftUI

/// Keep the transcript's row and layout types behind a concrete SwiftUI boundary.
/// Building them inline in GeometryReader/ScrollView multiplies temporary value
/// storage and can exhaust the iPhone main-thread stack in unoptimized builds.
struct TaskTranscriptContent: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let header: () -> TaskDetailHeader
    let hasEarlierHistory: Bool
    let historyLoading: Bool
    let historyError: String?
    let loadEarlier: () -> Void
    let worktreeSetup: TaskWorktreeSetupSnapshot?
    let canEditMessages: Bool
    let openDiff: (TaskDiffSelection) -> Void
    let editFromHere: (String) -> Void
    let openTask: (String) -> Void
    let hasOriginalDraft: Bool
    let restoreOriginalDraft: () -> Void
    let topInset: CGFloat
    let viewportHeight: CGFloat
    let endSpacing: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 24) {
            #if os(iOS)
            header()
            #endif
            TaskTranscriptMessages(
                store: store, task: task, hasEarlierHistory: hasEarlierHistory,
                historyLoading: historyLoading, historyError: historyError, loadEarlier: loadEarlier,
                worktreeSetup: worktreeSetup, canEditMessages: canEditMessages,
                openDiff: openDiff, editFromHere: editFromHere, openTask: openTask,
                hasOriginalDraft: hasOriginalDraft, restoreOriginalDraft: restoreOriginalDraft
            )
            TaskTranscriptFooter(store: store, task: task, openTask: openTask)
            // Keep the end anchor clear of the floating desktop composer.
            Color.clear.frame(height: endSpacing).id("transcript-end")
        }
        .scrollTargetLayout()
        // Animate only approval insertion/removal, never the streamed result.
        .animation(reduceMotion ? nil : FridayTheme.motion, value: task.approvals.filter { $0.state == "pending" }.map(\.id))
        .padding(.horizontal, 24)
        #if os(iOS)
        .padding(.bottom, 24)
        .padding(.top, task.localAgent ? 24 : topInset + 24)
        #else
        .padding(.bottom, task.localAgent ? 0 : 24)
        .padding(.top, 24)
        #endif
        .frame(maxWidth: FridayTheme.contentWidth + 48).frame(maxWidth: .infinity)
        .background(GeometryReader { geometry in
            let frame = geometry.frame(in: .named("task-transcript"))
            Color.clear.preference(key: TranscriptScrollKey.self, value: TranscriptScrollMetrics(top: frame.minY, bottom: frame.maxY, viewportHeight: viewportHeight))
        })
    }

}

private struct TaskTranscriptMessages: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let hasEarlierHistory: Bool
    let historyLoading: Bool
    let historyError: String?
    let loadEarlier: () -> Void
    let worktreeSetup: TaskWorktreeSetupSnapshot?
    let canEditMessages: Bool
    let openDiff: (TaskDiffSelection) -> Void
    let editFromHere: (String) -> Void
    let openTask: (String) -> Void
    let hasOriginalDraft: Bool
    let restoreOriginalDraft: () -> Void

    var body: some View {
        if task.localAgent {
            if hasEarlierHistory || historyError != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Button(action: loadEarlier) { FridaySymbolLabel(friday: historyLoading ? "正在加载历史…" : "加载更早的记录", systemImage: "clock.arrow.circlepath") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption).disabled(historyLoading || !store.connected)
                    if let historyError { Text(fridayString: historyError).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            TaskForkStatusView(store: store, task: task, openTask: openTask)
                .id(store.connection.server + ":fork:" + task.id)
            CodexTimeline(store: store, task: task, worktreeSetup: worktreeSetup, canOpenLocalFiles: store.deviceId == "owner", openDiff: openDiff, canEditMessages: canEditMessages, editFromHere: editFromHere, openTask: openTask)
            TaskRewindStatusView(store: store, task: task, hasOriginalDraft: hasOriginalDraft,
                restoreOriginalDraft: restoreOriginalDraft, openChanges: { openDiff(TaskDiffSelection(path: $0)) })
                .id("rewind-status-" + task.id + ":" + (task.rewindOperation?.id ?? ""))
        } else {
            ForEach(task.conversation) { message in conversationMessage(message, task: task) }
        }
    }

    @ViewBuilder private func conversationMessage(_ message: ChatMessage, task: WorkItem) -> some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 36)
                Text(message.text).font(.body).lineSpacing(5).textSelection(.enabled)
                    .padding(18)
                    .background(FridayTheme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 9) {
                    if task.localAgent {
                        FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback().font(.subheadline).foregroundStyle(.secondary)
                    } else { FridayMark(size: 30) }
                    Text(task.agentName).font(.subheadline.weight(.semibold))
                }
                Text(.init(message.text)).font(.body).lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.padding(task.localAgent ? 4 : 24).background(task.localAgent ? Color.clear : FridayTheme.surface, in: RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
        }
    }

}

private struct TaskTranscriptFooter: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let openTask: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        delegatedTasks(task)
        if task.status == "needs_project" { WorkspaceChoice(store: store, task: task).id(task.durableId) }
        ForEach(task.localAgent ? [] : task.approvals.filter { $0.state == "pending" }) { approval in
            ApprovalCard(store: store, taskId: task.id, approval: approval)
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
        }
        if let error = task.error, task.preparationFailure == nil {
            FridaySymbolLabel(friday: error, systemImage: "exclamationmark.circle")
                .fridaySymbolFeedback()
                .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                .padding(18).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
        }
    }

    @ViewBuilder private func delegatedTasks(_ task: WorkItem) -> some View {
        ForEach(store.tasks.filter { $0.parentId == task.id }) { child in
            Button { openTask(child.id) } label: {
                HStack(spacing: 12) {
                    FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(child.title).lineLimit(2)
                        Text(child.agentName).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusBadge(task: child)
                    FridaySymbolImage(systemName: "chevron.right").fridaySymbolFeedback()
                }.padding(16)
            }.buttonStyle(FridayButtonStyle()).accessibilityLabel(Text(friday: "打开任务"))
        }
    }
}
