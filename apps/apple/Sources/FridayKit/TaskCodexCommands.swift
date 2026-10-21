import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class TaskCodexCommandState: ObservableObject {
    struct Submission: Codable {
        let threadId: String; let command: String; var requestId = UUID().uuidString
        var body: [String: Any] { ["threadId": threadId, "command": command, "requestId": requestId] }
    }
    @Published private(set) var busy = false
    @Published private(set) var notice: TaskFeedbackReceipt?
    @Published private(set) var failure: String?
    @Published private(set) var pending: Submission?
    @Published private(set) var kind = "feedback"
    private var operation = UUID()
    func reset() { operation = UUID(); busy = false; notice = nil; failure = nil; pending = nil }
    func dismiss() { notice = nil; failure = nil }
    private func key(store: FridayStore, task: WorkItem, kind: String) -> String { "codex-command:" + store.connectionIdentity + ":" + task.id + ":" + (task.threadId ?? "") + ":" + kind }
    func recover(store: FridayStore, task: WorkItem) { pending = TaskDraftCache.load(Submission.self, server: store.connection.server, context: key(store: store, task: task, kind: "feedback")); notice = task.feedback?.last(where: { !["queued", "uploading"].contains($0.status) }) }
    func feedback(store: FridayStore, task: WorkItem, command: String) async {
        guard !busy, store.connected, task.agent == "codex", let threadId = task.threadId else { return }
        let connection = store.connection, identity = store.connectionIdentity, token = UUID(), context = key(store: store, task: task, kind: "feedback"), server = connection.server
        let submission = pending ?? TaskDraftCache.load(Submission.self, server: server, context: context) ?? Submission(threadId: threadId, command: command)
        guard submission.command == command, submission.threadId == threadId else { failure = "请先检查上次反馈的提交结果。"; return }
        operation = token; kind = "feedback"; busy = true; failure = nil; notice = nil; pending = submission; TaskDraftCache.save(submission, server: server, context: context)
        defer { if operation == token { busy = false } }
        do {
            let receipt = try await connection.decode(TaskFeedbackReceipt.self, "/api/tasks/\(task.id)/feedback", method: "POST", body: submission.body)
            if TaskDraftCache.load(Submission.self, server: server, context: context)?.requestId == submission.requestId { TaskDraftCache.save(Optional<Submission>.none, server: server, context: context) }
            guard operation == token, identity == store.connectionIdentity else { return }
            pending = nil; notice = receipt; await store.refresh()
        } catch { if operation == token, identity == store.connectionIdentity { failure = error.localizedDescription } }
    }
    func goal(store: FridayStore, task: WorkItem, command: String, model: String, effort: String, mode: String) async {
        guard !busy, store.connected, !task.active else { return }
        let identity = store.connectionIdentity, token = UUID(), context = key(store: store, task: task, kind: command), server = store.connection.server
        let submission = TaskDraftCache.load(Submission.self, server: server, context: context) ?? Submission(threadId: task.threadId ?? "", command: command)
        operation = token; kind = "goal"; busy = true; failure = nil; TaskDraftCache.save(submission, server: server, context: context)
        defer { if operation == token { busy = false } }
        do {
            try await store.sendTaskMessage(taskId: task.id, text: command, requestId: submission.requestId, images: [], model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, interactionMode: mode)
            if TaskDraftCache.load(Submission.self, server: server, context: context)?.requestId == submission.requestId { TaskDraftCache.save(Optional<Submission>.none, server: server, context: context) }
        } catch { if operation == token, identity == store.connectionIdentity { failure = error.localizedDescription } }
    }
}

struct TaskGoalBanner: View {
    let goal: TaskProviderGoal; let working: Bool; let disabled: Bool; let resume: () -> Void; let clear: () -> Void
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            FridaySymbolImage(systemName: "target").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(fridayString: goal.title(working: working)).fontWeight(.medium)
                Text(verbatim: goal.objective).lineLimit(3).textSelection(.enabled)
                if let usage = goal.usage { Text(verbatim: usage).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 4)
            if !working {
                if goal.canResume { Button(action: resume) { Text(friday: "继续目标") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(disabled) }
                Button(action: clear) { Text(friday: "清除目标") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(disabled)
            }
        }.font(.caption).padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TaskFeedbackBanner: View {
    @ObservedObject var state: TaskCodexCommandState
    let retry: () -> Void
    var body: some View {
        if state.kind == "feedback" && state.busy || state.notice != nil || state.failure != nil || state.pending != nil {
            HStack(alignment: .top, spacing: 8) {
                FridaySymbolImage(systemName: "bubble.left").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    if state.kind == "goal", let failure = state.failure { Text(fridayString: failure).foregroundStyle(.secondary) }
                    else if state.busy { Text(friday: "正在向 OpenAI 提交反馈…") }
                    else if let receipt = state.notice {
                        Text(fridayString: receipt.status == "sent" ? "反馈已发送给 OpenAI" : "反馈提交结果尚未确认")
                        if let id = receipt.feedbackId { Text(verbatim: id).textSelection(.enabled).font(.caption).foregroundStyle(.secondary) }
                        if let error = receipt.error { Text(fridayString: error).foregroundStyle(.secondary) }
                    } else { Text(friday: "请检查上次反馈的提交结果。"); if let failure = state.failure { Text(fridayString: failure).foregroundStyle(.secondary) } }
                }
                Spacer(minLength: 4)
                if let id = state.notice?.feedbackId {
                    Button { copy(id) } label: { FridaySymbolImage(systemName: "doc.on.doc").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "复制反馈 ID"))
                }
                if state.pending != nil, !state.busy { Button(action: retry) { Text(friday: "检查提交结果") }.buttonStyle(FridayButtonStyle(compact: true)) }
                if !state.busy, state.pending == nil { Button { state.dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭")) }
            }.font(.caption).padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        }
    }
    private func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
