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
            let messages = task.conversation
            let latestAssistantID = messages.last(where: { $0.role == "assistant" })?.id
            ForEach(messages) { message in
                conversationMessage(message, task: task, latest: message.id == latestAssistantID)
            }
            if task.active {
                Text(fridayString: assistantStatus)
                    .font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id("friday-activity")
            }
        }
    }

    private var assistantStatus: String {
        if task.status == "queued" { return "排队中…" }
        if task.status == "waiting" { return "等待你的确认或补充…" }
        switch task.assistantActivity?.phase {
        case "thinking": return "正在思考…"
        case "responding": return "正在回复…"
        case "preparingTool": return "正在准备工具调用…"
        case "tools": return "正在执行：\(assistantToolName(task.assistantActivity?.tool ?? ""))"
        case "retrying": return "模型连接重试中…"
        case "compacting": return "正在整理上下文…"
        default: return "正在等待模型响应…"
        }
    }

    @ViewBuilder private func conversationMessage(_ message: ChatMessage, task: WorkItem, latest: Bool) -> some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 36)
                Text(verbatim: message.text)
                    .font(FridayTheme.conversationFont).lineSpacing(FridayTheme.conversationUserLineSpacing)
                    .foregroundStyle(FridayTheme.conversationUserForeground).textSelection(.enabled)
                    .padding(.horizontal, 18).padding(.vertical, FridayTheme.conversationUserVerticalPadding)
                    .background(FridayTheme.conversationUserBackground, in: RoundedRectangle(cornerRadius: FridayTheme.conversationUserBubbleRadius))
            }
        } else {
            FridayAssistantMessage(message: message, name: task.agentName, active: task.active, latest: latest)
        }
    }

}

private func assistantToolName(_ name: String) -> String {
    switch name {
    case "workspace": "查看个人工作区"
    case "friday_request_workspace": "选择工作目录"
    case "save_idea": "保存想法"
    case "remember": "保存记忆"
    case "list_files": "列出文件"
    case "read_file": "读取文件"
    case "save_note": "保存笔记"
    case "write_file": "写入文件"
    case "ask_user": "询问用户"
    case "delegate_codex": "委派 Codex"
    default: name
    }
}

private struct FridayAssistantMessage: View {
    let message: ChatMessage
    let name: String
    let active: Bool
    let latest: Bool
    @State private var thinkingExpanded: Bool

    init(message: ChatMessage, name: String, active: Bool, latest: Bool) {
        self.message = message; self.name = name; self.active = active; self.latest = latest
        _thinkingExpanded = State(initialValue: message.streaming == true && active)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 9) {
                FridayMark(size: 32, interactive: latest)
                Text(name).font(.subheadline.weight(.semibold))
            }
            if let thinking = message.thinking, !thinking.isEmpty {
                DisclosureGroup(isExpanded: $thinkingExpanded) {
                    Text(verbatim: thinking).font(.callout).foregroundStyle(.secondary)
                        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                } label: {
                    Text(friday: "思考记录").font(.callout).foregroundStyle(.secondary).fridayInteractiveCursor()
                }
            }
            ForEach(message.tools ?? []) { tool in
                DisclosureGroup {
                    if let output = tool.output, !output.isEmpty {
                        Text(verbatim: output).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                } label: {
                    HStack {
                        Text(fridayString: assistantToolName(tool.name))
                        Spacer()
                        Text(fridayString: toolStatus(tool))
                    }.font(.callout).foregroundStyle(.secondary).fridayInteractiveCursor()
                }
            }
            if !message.text.isEmpty {
                AgentMarkdown(text: message.text, isStreaming: message.streaming == true && active,
                    bodyFont: FridayTheme.conversationFont, bodyLineSpacing: FridayTheme.conversationLineSpacing)
                    #if os(macOS)
                    .tint(FridayTheme.conversationUserBackground)
                    .accentColor(FridayTheme.conversationUserBackground)
                    #endif
            }
        }
        .padding(.horizontal, FridayTheme.conversationAssistantHorizontalPadding)
        .padding(.vertical, FridayTheme.conversationAssistantVerticalPadding)
        .background(FridayTheme.conversationAssistantBackground, in: RoundedRectangle(cornerRadius: FridayTheme.conversationBubbleRadius))
    }

    private func toolStatus(_ tool: AssistantTool) -> String {
        switch tool.status {
        case "completed": return "已完成"
        case "failed": return "失败"
        case "interrupted": return "已中断"
        case "preparing": return active ? "准备中" : "已中断"
        case "pending": return active ? "等待执行" : "已中断"
        default: return active ? "执行中" : "已中断"
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
