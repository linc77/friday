import SwiftUI
import CryptoKit

struct TaskAnnotatableDiffView: View {
    @ObservedObject var store: FridayStore
    @ObservedObject var bridge: TaskFileMentionBridge
    let taskID: String; let root: String; let path: String; let patch: String; let split: Bool
    let identity: String; let sectionID: String; let sectionTitle: String
    @State private var comments: [TaskDiffInlineComment] = []
    @State private var pending: TaskDiffInlineComment?
    @State private var pendingTarget: String?
    @State private var error: String?
    private var context: TaskFileMentionContext? { bridge.context }
    private var scopeKey: String { store.connectionIdentity + root + (context?.scope ?? "") + (context?.reviewTarget ?? "") }
    private var recordsKey: String { scopeKey + identity + path + (context?.reviewRecords.map(\.id).joined(separator: ":") ?? "") }
    var body: some View {
        VStack(spacing: 0) {
            TaskDiffCodeView(patch: patch, split: split, identity: identity, comments: comments + (pending.map { [$0] } ?? []), canComment: !path.isEmpty && context?.reviewEnabled == true && pending == nil, beginComment: begin, submitComment: submit, removeComment: remove)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(8) }
        }
        .task(id: recordsKey) { await loadComments() }
        .onChange(of: identity) { _, _ in pending = nil; comments = []; pendingTarget = nil; error = nil }
        .onChange(of: scopeKey) { _, _ in pending = nil; pendingTarget = nil; comments = []; error = nil }
        .onChange(of: patch) { _, patch in
            if let pending, TaskDiffRenderedDocument(patch: patch, side: split ? pending.selection.endSide : nil).anchor(pending.selection.last) == nil { self.pending = nil; pendingTarget = nil; error = "选中的 Diff 行已改变，请重新选择" }
        }
    }
    private func begin(_ selection: TaskDiffReviewSelection) {
        guard context?.reviewEnabled == true, let review = TaskDiffReviewDocument(patch).review(selection, sectionID: sectionID, title: sectionTitle) else { return }
        pending = TaskDiffInlineComment(id: UUID(), selection: selection, rangeLabel: review.metadata.rangeLabel, text: nil, referenceID: nil); pendingTarget = context?.reviewTarget; error = nil
    }
    private func submit(_ id: UUID, _ text: String) {
        guard let pending, pending.id == id, let context, context.reviewEnabled, let target = pendingTarget, context.reviewTarget == target,
              let review = TaskDiffReviewDocument(patch).review(pending.selection, sectionID: sectionID, title: sectionTitle) else { error = "选中的 Diff 行已改变，请重新选择"; return }
        let draft = TaskFileReviewDraft(commentID: id.uuidString, scope: context.scope, target: target, workspaceRoot: root, workspaceVersion: "", path: path,
            range: TaskSourceLineRange(pending.selection.start, pending.selection.end), comment: TaskFileReviewDraft.clipped(text.trimmingCharacters(in: .whitespacesAndNewlines), length: 16_000), contents: TaskFileReviewDraft.clipped(review.patch, length: 32_000), diffReview: review.metadata)
        guard context.review?(.upsert(draft, replacing: nil)) == true else { error = "输入框尚未准备好接收批注"; return }
        comments.append(TaskDiffInlineComment(id: id, selection: pending.selection, rangeLabel: review.metadata.rangeLabel, text: draft.comment, referenceID: draft.reference.id))
        self.pending = nil; pendingTarget = nil; error = nil
    }
    private func remove(_ id: UUID) {
        if pending?.id == id { pending = nil; pendingTarget = nil; error = nil; return }
        guard let value = comments.first(where: { $0.id == id }), let reference = value.referenceID, let target = context?.reviewTarget,
              context?.review?(.remove(reference, target: target)) == true else { return }
        comments.removeAll { $0.id == id }; error = nil
    }
    private func loadComments() async {
        let key = recordsKey; guard let context else { comments = []; return }
        var values: [TaskDiffInlineComment] = [], seen: Set<String> = []
        for reference in context.reviewRecords where reference.path == path && seen.insert(reference.id).inserted {
            do {
                let contents: TaskFileReviewContents?
                if let draft = reference.reviewDraft { contents = TaskContextSnapshot(reference: reference, cwd: root, text: "").fileReview; guard draft.target == context.reviewTarget else { continue } }
                else { contents = try await store.taskContext(reference, scope: TaskContextScope(taskID: taskID)).fileReview }
                guard !Task.isCancelled, recordsKey == key else { return }
                guard let contents, let review = contents.diffReview, review.sectionID == sectionID else { continue }
                let hash = Array(SHA256.hash(data: Data(reference.id.utf8)).prefix(16))
                let id = reference.reviewDraft.flatMap { UUID(uuidString: $0.commentID) } ?? UUID(uuid: (hash[0],hash[1],hash[2],hash[3],hash[4],hash[5],hash[6],hash[7],hash[8],hash[9],hash[10],hash[11],hash[12],hash[13],hash[14],hash[15]))
                values.append(TaskDiffInlineComment(id: id, selection: review.selection, rangeLabel: review.rangeLabel, text: contents.text, referenceID: reference.id))
            } catch { if Task.isCancelled { return } }
        }
        if recordsKey == key { comments = values }
    }
}
