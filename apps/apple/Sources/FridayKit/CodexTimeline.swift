import SwiftUI

struct CodexTimeline: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    var worktreeSetup: TaskWorktreeSetupSnapshot? = nil
    var canOpenLocalFiles = false
    var openDiff: (TaskDiffSelection) -> Void = { _ in }
    var canEditMessages = true
    var editFromHere: (String) -> Void = { _ in }
    var openTask: (String) -> Void = { _ in }
    var body: some View {
        let rows = CodexTranscript.rows(task)
        let visibleSetup = worktreeSetup.flatMap { $0.belongs(to: task) ? $0 : nil }
        let currentWorkId = rows.first { row in
            if task.status != "queued" {
                switch row.content {
                case .work(let events): return events.contains { $0.turnId != nil && $0.turnId == task.turnId }
                case .proposal(let event), .changes(let event), .subagent(let event): return event.turnId != nil && event.turnId == task.turnId
                default: return false
                }
            }
            return false
        }?.id
        ForEach(rows) { row in
            if task.active && row.id == currentWorkId { AgentTaskWorkingLine(task: task) }
            if row.id == currentWorkId, let snapshot = visibleSetup, snapshot.threadId == task.id, snapshot.active && snapshot.handedOff,
               let run = task.runs?.first(where: { $0.id == snapshot.runId }) {
                TaskWorktreeSetupCard(store: store, task: task, run: run, snapshot: snapshot)
                    .id(store.connectionIdentity + ":background-setup:" + task.id + ":" + run.id)
            }
            switch row.content {
            case .user(let text):
                CodexUserMessage(store: store, taskID: task.id, text: text, message: task.messages?.first { $0.id == row.id },
                    showsEdit: task.runs?.contains { $0.messageId == row.id && $0.revertedAt == nil } == true,
                    canEdit: canEditMessages && !task.active && !task.gitBusy && !task.sessionBusy && store.connected,
                    edit: { editFromHere(row.id) }).id(row.id)
                if let snapshot = visibleSetup, snapshot.threadId == task.id, !(snapshot.active && snapshot.handedOff), let run = task.runs?.first(where: { $0.id == snapshot.runId && $0.messageId == row.id }) {
                    TaskWorktreeSetupCard(store: store, task: task, run: run, snapshot: snapshot)
                        .id(store.connectionIdentity + ":setup:" + task.id + ":" + run.id + ":" + String(snapshot.attempt))
                } else if let run = task.runs?.first(where: { $0.messageId == row.id && $0.preparationFailed }) {
                    TaskWorkspacePreparationFailure(store: store, task: task, run: run)
                        .id(store.connectionIdentity + ":preparation:" + task.id + ":" + run.id)
                }
            case .reply(let text):
                VStack(alignment: .leading, spacing: 8) {
                    CodexReply(store:store,taskID:task.id,messageID:row.id,text: text, canOpenLocalFiles: canOpenLocalFiles, workspacePath: task.cwd, isStreaming: row.isStreaming)
                    if let runID = row.runID ?? row.nativeTurnID {
                        TaskForkButton(store: store, task: task, runID: runID, openTask: openTask)
                            .id(store.connection.server + ":" + task.id + ":" + runID)
                    }
                }.id(row.id)
            case .proposal(let event):
                VStack(alignment: .leading, spacing: 8) {
                    TaskProposedPlanCard(store: store, task: task, event: event, canOpenLocalFiles: canOpenLocalFiles)
                    if let runID = row.runID ?? row.nativeTurnID {
                        TaskForkButton(store: store, task: task, runID: runID, openTask: openTask)
                            .id(store.connection.server + ":" + task.id + ":" + runID)
                    }
                }.id(row.id)
            case .changes(let event):
                TaskChangedFilesCard(task: task, event: event, canOpenLocalFiles: canOpenLocalFiles) { path in openDiff(TaskDiffSelection(eventID: event.id, path: path)) }.id(row.id)
            case .subagent(let event):
                if let agent = task.subagents?.first(where: { $0.id == event.subagentId }) {
                    TaskSubagentTimelineRow(store: store, agent: agent, openTask: openTask).id(row.id)
                } else {
                    CodexToolRow(store: store, task: task, event: event, showReasoning: false).id(row.id)
                }
            case .runChanges(let run):
                TaskRunChangesCard(run: run, canOpenLocalFiles: canOpenLocalFiles) { path in openDiff(TaskDiffSelection(runID: run.id, path: path)) }.id(row.id)
            case .work(let events):
                CodexWorkLog(store: store, events: events, task: task, canOpenLocalFiles: canOpenLocalFiles).id(row.id)
            }
        }
        if currentWorkId == nil, let snapshot = visibleSetup, snapshot.threadId == task.id, snapshot.active && snapshot.handedOff,
           let run = task.runs?.first(where: { $0.id == snapshot.runId }) {
            TaskWorktreeSetupCard(store: store, task: task, run: run, snapshot: snapshot)
                .id(store.connectionIdentity + ":background-setup:" + task.id + ":" + run.id)
        }
        if task.active && currentWorkId == nil {
            if task.preparingWorkspace != nil { if visibleSetup == nil { TaskWorkspacePreparationProgress() } }
            else { AgentTaskWorkingLine(task: task) }
        }
    }
}

private struct CodexUserMessage: View {
    @ObservedObject var store: FridayStore
    let taskID: String
    let text: String
    let message: ChatMessage?
    let showsEdit: Bool
    let canEdit: Bool
    let edit: () -> Void
    @State private var copied = false
    var body: some View {
        HStack {
            Spacer(minLength: 48)
            VStack(alignment: .trailing, spacing: 8) {
                VStack(alignment: .leading, spacing: 12) {
                    if message?.creationSource == "monitor" {
                        FridaySymbolLabel(friday: "自动跟进", systemImage: "eye").font(.caption).foregroundStyle(.secondary)
                    }
                    if message?.creationSource == "delegated" {
                        FridaySymbolLabel(friday: "子任务结果", systemImage: "person.2").font(.caption).foregroundStyle(.secondary)
                    }
                    if let images = message?.images, !images.isEmpty {
                        TaskImageRail(store: store, images: images, wraps: true).frame(maxWidth: 210)
                    }
                    if !text.isEmpty { TaskContextMessageText(store: store, text: text, contexts: message?.contexts ?? [], taskID: taskID) }
                }.padding(.horizontal, 18).padding(.vertical, 14)
                    .background(.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 16))
                HStack(spacing: 10) {
                    if showsEdit {
                        Button(action: edit) { FridaySymbolImage(systemName: "arrow.uturn.backward") }
                            .buttonStyle(FridaySymbolButtonStyle()).disabled(!canEdit).accessibilityLabel(Text(friday: "从这里编辑"))
                            .help(Text(friday: "从这里编辑"))
                    }
                    if message?.delivery == "uncertain" || message?.delivery == "sending" {
                        Text(friday: message?.delivery == "uncertain" ? "发送结果待确认" : "发送中").foregroundStyle(.orange)
                    }
                    if let date = CodexTranscript.date(message?.at) { Text(date, style: .time).foregroundStyle(.secondary) }
                    if !text.isEmpty {
                        Button { TaskContextText.copy(text); copied = true } label: {
                            FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc")
                        }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(.secondary)
                            .accessibilityLabel(Text(friday: copied ? "已复制" : "复制消息"))
                    }
                }.font(.system(size: 11))
            }
        }.onChange(of: text) { _, _ in copied = false }
    }
}

private struct CodexReply: View {
    @ObservedObject var store:FridayStore
    let taskID:String
    let messageID:String
    @Environment(\.taskFileMentionBridge) private var mentionBridge
    let text: String
    let canOpenLocalFiles: Bool
    let workspacePath: String
    let isStreaming: Bool
    @State private var copied = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let mentionBridge,let service=store.serviceId {
                TaskAssistantCitationSource(identity:TaskCitationSourceIdentity(environment:service,task:taskID,message:messageID,connection:store.connectionIdentity),bridge:mentionBridge) {
                    AgentMarkdown(text:text,canOpenLocalFiles:canOpenLocalFiles,workspacePath:workspacePath,isStreaming:isStreaming)
                }.id(store.connectionIdentity+"\n"+taskID+"\n"+messageID)
            } else { AgentMarkdown(text: text, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath, isStreaming: isStreaming) }
            Button { copyAgentText(text); copied = true } label: {
                FridaySymbolLabel(friday: copied ? "已复制" : "复制回答", systemImage: copied ? "checkmark" : "doc.on.doc")
            }.font(.caption).foregroundStyle(.secondary).buttonStyle(FridaySymbolButtonStyle())
        }.onChange(of: text) { _, _ in copied = false }
    }
}

private struct CodexWorkLog: View {
    @ObservedObject var store: FridayStore
    let events: [TaskEvent]
    let task: WorkItem
    let canOpenLocalFiles: Bool
    @State private var expanded: Bool? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var active: Bool { task.active && task.status != "queued" && events.contains { $0.turnId == task.turnId && $0.turnId != nil } }
    private var open: Bool { expanded ?? active }
    private var title: LocalizedStringKey {
        if let seconds = CodexTranscript.duration(events, task: task) {
            return seconds < 60 ? "处理了 \(seconds) 秒" : "处理了 \(seconds / 60) 分 \(seconds % 60) 秒"
        }
        return "处理过程"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !active {
                Button { expanded = !open } label: {
                    HStack(spacing: 9) {
                        Text(friday: title)
                        FridaySymbolImage(systemName: open ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .medium))
                        Spacer(minLength: 8)
                    }.contentShape(Rectangle())
                }.buttonStyle(FridaySymbolButtonStyle()).font(.callout).foregroundStyle(.secondary)
                    .accessibilityLabel(Text(friday: open ? "收起处理过程" : "展开处理过程"))
                    .accessibilityValue(Text(friday: open ? "已展开" : "已收起"))
            }
            if active || open {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(events) { event in
                        if event.kind == "message" {
                            AgentMarkdown(text: event.text, compact: true, canOpenLocalFiles: canOpenLocalFiles, workspacePath: task.cwd, isStreaming: event.status == "running")
                        } else if event.kind == "plan", let plan = event.plan {
                            TaskPlanProgress(steps: plan, explanation: event.detail)
                        } else { CodexToolRow(store: store, task: task, event: event, showReasoning: active) }
                    }
                }.padding(.leading, 4)
            }
        }
        // Only the fold animates. Streaming text never animates its layout.
        .animation(reduceMotion ? nil : FridayTheme.motion, value: open)
    }
}

private struct CodexToolRow: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    let event: TaskEvent
    var showReasoning = false
    @State private var expanded: Bool? = nil
    private var open: Bool { expanded ?? (showReasoning && event.kind == "reasoning") }
    private var symbol: String {
        if let action = event.commandActions?.first {
            switch action.type {
            case "read": return "doc.text.magnifyingglass"
            case "listFiles": return "folder"
            case "search": return "magnifyingglass"
            default: break
            }
        }
        return switch event.kind {
        case "command": "terminal"
        case "files": "doc.text"
        case "search": "magnifyingglass"
        case "reasoning": "sparkle"
        case "plan": "checklist"
        case "image": "photo"
        default: "wrench.and.screwdriver"
        }
    }
    private var title: String {
        if let actions = event.commandActions, !actions.isEmpty, actions.allSatisfy({ $0.type != "unknown" }) {
            return actions.map { $0.name ?? $0.query ?? $0.path ?? $0.command }.joined(separator: " · ")
        }
        if event.kind == "files" && event.itemId != nil {
            return event.text.components(separatedBy: "\n").map { ($0 as NSString).lastPathComponent }.joined(separator: " · ")
        }
        if event.kind == "files" { return "文件改动" }
        if event.kind == "reasoning" { return "思考摘要" }
        if event.kind == "plan" { return "执行计划" }
        return event.text.components(separatedBy: "\n").first ?? event.text
    }
    private var detail: String {
        if event.kind == "command" && event.itemId != nil {
            var value = event.text
            if let output = event.detail, !output.isEmpty { value += "\n\n" + output }
            if let exit = event.exitCode { value += "\n\n退出码：\(exit)" }
            return value
        }
        return event.detail?.isEmpty == false ? event.detail! : event.text
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button { expanded = !open } label: {
                HStack(spacing: 10) {
                    FridaySymbolImage(systemName: symbol).frame(width: 16).fridaySymbolFeedback(value: event.status)
                    Text(fridayString: title).font(event.kind == "command" ? .system(.callout, design: .monospaced) : .callout)
                        .lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                }.contentShape(Rectangle())
            }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(.secondary)
                .accessibilityLabel(Text(friday: open ? "收起执行项" : "展开执行项") + Text(verbatim: "，" + title))
                .accessibilityValue(Text(friday: open ? "已展开" : "已收起"))
            if open {
                if event.kind == "plan", let plan = event.plan {
                    TaskPlanProgress(steps: plan, explanation: event.detail)
                } else if event.kind == "command", event.detailOmitted == true {
                    AgentCodeBlock(language: "Terminal", text: event.text)
                    TaskCommandOutputView(store: store, task: task, event: event)
                    if let exit = event.exitCode { Text(fridayString: "退出码：\(exit)").font(.caption).foregroundStyle(.secondary) }
                } else if event.detailOmitted == true {
                    TaskToolOutputView(store: store, task: task, event: event)
                } else if ["command", "files"].contains(event.kind) { AgentCodeBlock(language: event.kind == "command" ? "Terminal" : "Diff", text: detail) }
                else { AgentMarkdown(text: detail, compact: true) }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
