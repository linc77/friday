import SwiftUI

@MainActor private final class ChangeRequestReviewSession: ObservableObject {
    private static var sessions: [String: ChangeRequestReviewSession] = [:]
    static func forScope(_ scope: String) -> ChangeRequestReviewSession {
        if let session = sessions[scope] { return session }
        let session = ChangeRequestReviewSession(scope: scope); sessions[scope] = session; return session
    }
    let scope: String
    @Published var draft = TaskChangeRequestDraft()
    @Published var pending: TaskChangeRequestSubmission?
    @Published var sent: TaskChangeRequestSubmission?
    @Published var operation: TaskChangeRequestOperation?
    @Published var operationID: String?
    var sentOperationID: String?
    @Published var sending = false
    @Published var viewed = TaskFilesViewedOverlay()
    @Published var viewedFiles: TaskFilesViewedResponse?
    @Published var reactionOverlay: TaskChangeRequestSubmission?
    var reactionAcknowledged: String?
    init(scope: String) { self.scope = scope }
    @discardableResult func reconcile(_ operation: TaskChangeRequestOperation) -> Bool {
        if let held = self.operation, held.id == operation.id, held.updatedAt > operation.updatedAt || !held.active && operation.active { return false }
        self.operation = operation; operationID = operation.id
        if !operation.active, sentOperationID == operation.id, let sent {
            if let batch = sent.viewedBatch { if operation.status == "completed" { viewed.acknowledge(batch, states: viewedFiles?.states ?? [:]) } else { viewed.fail(batch) } }
            if sent.action == "reaction", reactionOverlay?.requestID == sent.requestID { if operation.status == "completed" { reactionAcknowledged = sent.requestID } else { reactionOverlay = nil; reactionAcknowledged = nil } }
            if operation.status == "completed" { draft.reconcile(sent); self.sent = nil; sentOperationID = nil }
        }
        return true
    }
}

struct TaskChangeRequestPanel: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String
    var initialTab = "summary"
    @State private var stackURL: String?
    private var activeURL: String { stackURL ?? url }
    var body: some View {
        TaskChangeRequestContent(store: store, taskID: taskID, url: activeURL, initialTab: initialTab, navigate: { stackURL = $0 }, session: ChangeRequestReviewSession.forScope(store.connectionIdentity + "|" + taskID + "|" + activeURL))
            .id(store.connectionIdentity + "|" + taskID + "|" + activeURL)
            .onChange(of: url) { _, _ in stackURL = nil }
    }
}

private struct TaskChangeRequestContent: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String; let initialTab: String; let navigate: (String) -> Void
    @ObservedObject var session: ChangeRequestReviewSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var detail: TaskChangeRequestDetail?
    @State private var showCheckout = false
    @State private var codeScope = TaskChangeRequestCodeScope()
    @State private var fileTarget: TaskChangeRequestFileTarget?
    @State private var activity: TaskChangeRequestActivityResponse?
    @State private var files: TaskChangeRequestFiles?
    @State private var tab = "summary"
    @State private var appliedInitialTab = false
    @State private var selectedPath: String?
    @State private var split = false
    @State private var loading = false
    @State private var loadingResource = false
    @State private var loadingFilePage = false
    @State private var filePageID = UUID()
    @State private var filePageError: String?
    @State private var fileRevealTarget: String?
    @State private var loadID = UUID()
    @State private var resourceID = UUID()
    @State private var error: String?
    @State private var resourceError: String?
    @State private var showLinkManager = false
    @State private var nextChecksAt = Date.distantPast
    @State private var checksFingerprint: String?
    @State private var snapshotFingerprint: TaskPullRequestSnapshot?
    @State private var pendingLine: TaskDiffInlineComment?
    @State private var pendingPath: String?
    @State private var confirmedAction: TaskChangeRequestConfirmation?
    @State private var editor: TaskChangeRequestEditorTarget?
    @State private var candidateSheet: TaskChangeRequestCandidateSheet?
    @State private var reviewers: TaskReviewerCandidates?
    @State private var labels: TaskLabelCandidates?
    @State private var candidateLoading = false
    @State private var candidateLoadID = UUID()
    @State private var candidateError: String?
    @State private var threadLoads: [String: UUID] = [:]
    @State private var rootReactions: TaskReviewReactions?
    @State private var viewedError: String?
    @State private var viewedLoadID = UUID()
    @State private var resourceRevision: UInt64 = 0
    private var current: Bool { session.scope == store.connectionIdentity + "|" + taskID + "|" + url && !Task.isCancelled }
    private var busy: Bool { session.sending || session.operation?.active == true || session.operationID != nil && session.operation?.id != session.operationID }
    private var staleComments: Bool { session.draft.comments.contains { $0.headSha != detail?.headSha || $0.baseSha != nil && $0.baseSha != detail?.baseSha } }
    private var permitsInlineComments: Bool { guard let detail else { return false }; return detail.canComment && detail.capabilities?.inlineReviews != false && codeScope.permitsInlineComments(head: detail.headSha, loadedHead: files?.headSha, loadedScope: files?.scopeCommit, base: detail.baseSha, loadedBase: files?.baseSha) }
    private var selectedFile: TaskChangeRequestFiles.File? { if fileRevealTarget != nil { return files?.files.first { $0.path == selectedPath } }; return files?.files.first { $0.path == selectedPath } ?? files?.files.first }

    var body: some View {
        VStack(spacing: 0) {
            header.padding(16)
            Divider()
            if let detail {
                if detail.pullRequest.provider == "github" || detail.capabilities?.stacks == true { TaskChangeRequestStackView(store: store, taskID: taskID, url: url, detail: detail, refreshID: loadID, busy: busy || session.pending != nil, draft: session.draft, navigate: navigate, submit: send) }
                HStack {
                    Picker(selection: $tab) {
                        Text(friday: "概览").tag("summary")
                        if detail.reviewGuidesEnabled == true { Text("Guide").tag("guide") }
                        Text(friday: "时间线").tag("timeline")
                        Text(friday: "代码").tag("code")
                    } label: { Text(friday: "PR／MR 详情") }
                    .pickerStyle(.segmented).frame(maxWidth: 360).fridayInteractiveCursor()
                    Spacer()
                    if !detail.actions.isEmpty { actions(detail) }
                }.padding(12)
                if let error { message(error) }
                if let operation = session.operation { operationStatus(operation) }
                Group {
                    if tab == "summary" { summary(detail) }
                    else if tab == "timeline" { timeline }
                    else if tab == "guide" { TaskReviewGuideView(store: store, taskID: taskID, url: url, detail: detail, canComment: detail.canComment && detail.capabilities?.inlineReviews != false && !busy && session.pending == nil && store.connected, pendingComments: session.draft.comments, removeComment: removeLine, comment: addGuideComment, refreshDetail: { Task { await reload() } }, openFile: { selectCodeCommit(nil); selectedPath = $0; fileRevealTarget = $0; tab = "code" }, finishReview: { selectCodeCommit(nil); tab = "code" }) }
                    else { code(detail) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                reviewForm(detail).padding(12)
            } else {
                Spacer()
                Text(fridayString: error ?? "正在读取 PR／MR").foregroundStyle(error == nil ? Color.secondary : Color.orange).textSelection(.enabled).padding(24)
                Spacer()
            }
        }
        .frame(minWidth: 360, idealWidth: 980, maxWidth: .infinity, minHeight: 520, idealHeight: 780, maxHeight: .infinity)
        .environment(\.markdownMediaContext, MarkdownMediaContext.githubTask(store: store, taskID: taskID))
        .task { if !appliedInitialTab { appliedInitialTab = true; tab = initialTab }; do { _ = try await store.openTaskChangeRequestView(taskID, reference: url); guard current else { return } } catch { if current { self.error = error.localizedDescription } }; await reload() }
        .task { await followChecks() }
        .task(id: "\(tab)|\(detail?.headSha ?? "")|\(resourceRevision)|\(codeScope.identity)") { await loadResource() }
        .onChange(of: tab) { _, value in if value != "code" { filePageID = UUID(); loadingFilePage = false } }
        .onChange(of: loadID) { _, _ in filePageID = UUID(); loadingFilePage = false; filePageError = nil }
        .onDisappear { filePageID = UUID(); loadingFilePage = false }
        .task(id: "\(tab)|\(fileRevealTarget ?? "")|\(files?.nextCursor ?? "")|\(files?.files.count ?? 0)|\(loadingFilePage)") {
            guard let path = fileRevealTarget, files != nil, tab == "code" else { return }
            if files?.files.contains(where: { $0.path == path }) == true { selectedPath = path; fileRevealTarget = nil }
            else if files?.nextCursor != nil && !loadingFilePage && filePageError == nil { loadNextFilePage() }
            else if files?.nextCursor == nil { fileRevealTarget = nil; selectedPath = files?.files.first?.path; filePageError = "所选文件不在当前 Diff 范围中" }
        }
        .onChange(of: store.textGenerationSettingsVersion) { _, _ in Task { await reload() } }
        .task(id: session.operationID) { await poll() }
        .onReceive(store.$tasks) { tasks in
            if current, store.snapshotIdentity == store.connectionIdentity,
               let snapshot = tasks.first(where: { $0.id == taskID })?.pullRequests?.first(where: { $0.url == url })?.snapshot,
               snapshot != snapshotFingerprint {
                let hadSnapshot = snapshotFingerprint != nil; snapshotFingerprint = snapshot
                if detail != nil, !loading, hadSnapshot || snapshot.headSha != detail?.headSha || snapshot.state != detail?.pullRequest.state { Task { await reload(background: true) } }
            }
            guard current, store.snapshotIdentity == store.connectionIdentity, let id = session.operationID,
                  let operation = tasks.first(where: { $0.id == taskID })?.changeRequestOperations?.first(where: { $0.id == id }),
                  operation.updatedAt != session.operation?.updatedAt || operation.status != session.operation?.status else { return }
            if session.reconcile(operation), !operation.active { Task { await reload() } }
        }
        .task(id: "\(session.viewed.serial)|\(busy)|\(session.pending?.requestID ?? "")") { await flushViewedFiles() }
        .onDisappear { Task { await flushViewedFiles(immediate: true) } }
        .sheet(isPresented: $showLinkManager) { TaskChangeRequestLinksView(store: store, taskID: taskID) { target in showLinkManager = false; if target != url { navigate(target) } } }
        .sheet(item: $fileTarget) { target in TaskChangeRequestFileView(store: store, taskID: taskID, url: url, target: target) }
        .sheet(item: $editor) { target in
            TaskChangeRequestEditor(target: target, draft: editorBinding(target), busy: busy || session.pending != nil || !store.connected,
                error: error ?? (session.sent?.editorKey == target.key ? session.operation?.error : nil), close: { editor = nil }, submit: { submitEditor(target) }, retry: pendingRetry, isSending: busy)
        }
        .sheet(item: $candidateSheet) { target in
            if target.id == "reviewers", detail?.capabilities?.reviewerCandidates == false {
                TaskChangeRequestManualReviewers(reviewers: detail?.reviewers ?? [], busy: busy || session.pending != nil || !store.connected, error: error ?? session.operation?.error, close: { candidateSheet = nil }, submit: { reviewer, requested in sendCollaboration("reviewers", value: TaskChangeRequestCollaboration(reviewers: [.init(id: reviewer, kind: "user")], requested: requested)) })
            } else {
            TaskChangeRequestCandidatePicker(kind: target.id, rows: candidateRows(target.id), truncated: target.id == "reviewers" ? reviewers?.truncated == true : labels?.truncated == true,
                loading: candidateLoading, busy: busy || session.pending != nil || !store.connected, error: candidateError ?? error ?? (session.sent?.action == target.id ? session.operation?.error : nil),
                refresh: { Task { await loadCandidates(target.id, generation: target.generation) } }, close: { candidateSheet = nil }, toggle: { id in if candidateSheet?.generation == target.generation { toggleCandidate(id, kind: target.id) } }, retry: pendingRetry, isSending: busy)
                .task { await loadCandidates(target.id, generation: target.generation) }
            }
        }
        .onChange(of: session.operation?.updatedAt) { _, _ in
            if session.operation?.status == "completed" {
                if let editor, session.draft.editors[editor.key] == nil { self.editor = nil }
                if let kind = candidateSheet?.id { Task { await loadCandidates(kind) } }
            }
        }
        .confirmationDialog(Text(fridayString: confirmedAction?.title ?? "确认平台操作？"), isPresented: Binding(get: { confirmedAction != nil }, set: { if !$0 { confirmedAction = nil } }), titleVisibility: .visible) {
            if let confirmation = confirmedAction {
                Button(friday: TaskChangeRequestConfirmation.label(confirmation.action), role: confirmation.action == "delete-branch" || confirmation.action == "merge" ? .destructive : nil) {
                    sendAction(confirmation.action, mergeMethod: confirmation.mergeMethod, expectedHeadSha: confirmation.headSha, expectedWorkflowSource: confirmation.workflowSource); confirmedAction = nil
                }.disabled(busy || !store.connected)
            }
            Button(friday: "取消", role: .cancel) { confirmedAction = nil }
        } message: {
            if let confirmation = confirmedAction, !confirmation.message.isEmpty {
                Text(fridayString: confirmation.message)
                if confirmation.action == "delete-branch", let detail { Text("\(detail.branch?.repository ?? detail.pullRequest.repository ?? "") · \(detail.pullRequest.head)") }
            }
        }
    }
    private var checkoutProject: Project? {
        guard let id = store.tasks.first(where: { $0.id == taskID })?.projectId else { return nil }; return store.projects.first { $0.id == id }
    }
    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(detail.map { "\($0.term) #\($0.pullRequest.number) · \($0.pullRequest.title)" } ?? "PR／MR").font(.headline).textSelection(.enabled)
                if let detail {
                    HStack(spacing: 8) {
                        Text(fridayString: detail.isDraft ? "草稿" : detail.pullRequest.state == "merged" ? "已合并" : detail.pullRequest.state == "closed" ? "已关闭" : "待合并")
                            .foregroundStyle(detail.pullRequest.state == "open" ? Color.green : Color.secondary)
                        Text(detail.author).foregroundStyle(.secondary)
                        Text("\(detail.pullRequest.head) → \(detail.pullRequest.base)").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                    }.font(.caption)
                }
            }
            Spacer()
            if checkoutProject != nil {
                Button { showCheckout = true } label: { FridaySymbolImage(systemName: "arrow.triangle.pull").frame(width: 26, height: 26) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected).help(Text(friday: "检出并打开新任务草稿"))
            }
            Button(friday: "管理关联") { showLinkManager = true }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected)
            Button { Task { await reload(refresh: true) } } label: { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 26, height: 26) }
                .buttonStyle(FridaySymbolButtonStyle()).disabled(loading || !store.connected).help(Text(friday: "刷新"))
            Button { if let link = URL(string: url), link.scheme == "https" { openURL(link) } } label: { FridaySymbolImage(systemName: "arrow.up.right.square").frame(width: 26, height: 26) }
                .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "在平台打开"))
            Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 26, height: 26) }
                .buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭"))
        }.sheet(isPresented: $showCheckout) {
            if let project = checkoutProject { TaskChangeRequestCheckoutDialog(store: store, project: project, initialReference: url) { result in
                showCheckout = false; store.changeRequestDraftHandoff = TaskChangeRequestDraftHandoff(identity: store.connectionIdentity, result: result); dismiss()
            } }
        }
    }
    private func actions(_ detail: TaskChangeRequestDetail) -> some View {
        Menu {
            if detail.actions.contains("merge") {
                ForEach(detail.mergeMethods, id: \.self) { method in
                    Button(friday: method == "squash" ? "压缩合并" : method == "rebase" ? "变基合并" : "合并") { confirmedAction = .init(action: "merge", mergeMethod: method, headSha: detail.headSha) }
                }.disabled(conflicting(detail))
            }
            if detail.autoMergeEnabled == true, detail.actions.contains("disable-auto-merge") {
                Button(friday: "取消自动合并") { sendAction("disable-auto-merge") }
            } else if detail.actions.contains("enable-auto-merge"), !conflicting(detail) {
                Menu {
                    ForEach(detail.mergeMethods, id: \.self) { method in
                        Button(friday: method == "squash" ? "压缩合并" : method == "rebase" ? "变基合并" : "合并") { confirmedAction = .init(action: "enable-auto-merge", mergeMethod: method, headSha: detail.headSha) }
                    }
                } label: { Text(friday: "开启自动合并") }
            }
            if detail.actions.contains("update-branch"), detail.behindBy != 0, detail.baseComparison != "up-to-date" {
                Menu {
                    ForEach(detail.updateMethods ?? [], id: \.self) { method in
                        Button(friday: method == "rebase" ? "通过变基更新" : "通过合并更新") { sendAction("update-branch", updateMethod: method) }
                    }
                } label: { Text(friday: "更新源分支") }
            }
            ForEach(detail.actions.filter { ["ready", "draft", "close", "reopen", "revert", "delete-branch"].contains($0) }, id: \.self) { action in
                Button(friday: TaskChangeRequestConfirmation.label(action)) {
                    if action == "revert" || action == "delete-branch" { confirmedAction = .init(action: action, headSha: detail.headSha) } else { sendAction(action) }
                }
            }
            if detail.actions.contains("approve-workflows"), (detail.workflowApprovalsRequired ?? 0) > 0 {
                Button(friday: "批准 Fork 工作流") { confirmedAction = .init(action: "approve-workflows", headSha: detail.headSha, workflowSource: ["branch": detail.pullRequest.head, "owner": detail.branch?.owner ?? ""]) }
            }
        } label: { Label { Text(friday: "操作") } icon: { FridaySymbolImage(systemName: "ellipsis.circle") } }
            .menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor().disabled(busy || session.pending != nil || !store.connected)
    }
    private func conflicting(_ detail: TaskChangeRequestDetail) -> Bool { ["conflicting", "dirty"].contains(detail.mergeability.lowercased()) }
    private func summary(_ detail: TaskChangeRequestDetail) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let behind = detail.behindBy, behind > 0 { Text(String(behind) + " " + String(localized: "个提交落后于目标分支", bundle: .module)).font(.caption).foregroundStyle(.secondary) }
                if detail.workflowApprovalsUnavailable == true { Text(friday: "无法确认待批准工作流，请刷新或在平台查看").font(.caption).foregroundStyle(.orange) }
                if detail.autoMergeEnabled == true { Text(friday: "自动合并已开启").font(.caption).foregroundStyle(.green) }
                if detail.behindBy == 0 { Text(friday: "分支已是最新版本").font(.caption).foregroundStyle(.secondary) }
                if detail.behindBy == nil, detail.baseComparison == "up-to-date" { Text(friday: "分支已是最新版本").font(.caption).foregroundStyle(.secondary) }
                if detail.behindBy == nil, detail.baseComparison == "behind" { Text(friday: "源分支落后于目标分支").font(.caption).foregroundStyle(.secondary) }
                HStack {
                    if detail.management?.canEdit == true { Button(friday: "编辑 PR／MR", systemImage: "pencil") { openEditor(action: "edit_request", key: "request", title: detail.pullRequest.title, body: detail.body) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                    if detail.management?.canRequestReviewers == true { Button(friday: "请求审查", systemImage: "person.badge.plus") { candidateError = nil; candidateSheet = TaskChangeRequestCandidateSheet(id: "reviewers") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                    if detail.management?.canSetLabels == true { Button(friday: "管理标签", systemImage: "tag") { candidateError = nil; candidateSheet = TaskChangeRequestCandidateSheet(id: "labels") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                }
                if !detail.body.isEmpty { TaskChangeRequestMarkdown(text: detail.body) }
                else { Text(friday: "暂无描述").foregroundStyle(.secondary) }
                if detail.management?.canReact == true { TaskReviewReactionsBar(reactions: effectiveReactions(rootReactions?.reactions ?? activity?.reactions ?? [], subjectID: nil), enabled: canReact) { content, reacted in react(content, reacted: reacted, subjectID: nil) } }
                if let resourceError { message(resourceError) }
                if !detail.labels.isEmpty { Text(detail.labels.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                if !detail.reviewers.isEmpty { HStack { Text(friday: "审查者"); Text(detail.reviewers.joined(separator: ", ")) }.font(.caption) }
                Divider()
                HStack { Text(friday: "合并状态"); Text(detail.mergeability).foregroundStyle(.secondary); Spacer(); if let count = detail.changedFiles { Text(String(count)); Text(friday: "个文件") } }.font(.callout)
                if let additions = detail.additions, let deletions = detail.deletions { Text("+\(additions)  −\(deletions)").font(.system(.caption, design: .monospaced)) }
                if detail.mergeQueue == true { Text(friday: "此仓库使用合并队列；合并请求将按平台规则处理。").font(.caption).foregroundStyle(.secondary) }
                if detail.checksUnavailable == true { Text(friday: "暂时无法读取检查状态，请刷新后重试").foregroundStyle(.orange) }
                if let state = detail.checksState { Text(friday: state == "passing" ? "检查通过" : state == "pending" ? "检查进行中" : "检查失败").font(.caption).foregroundStyle(state == "passing" ? Color.green : state == "pending" ? Color.secondary : Color.orange) }
                ForEach(Array(detail.checks.enumerated()), id: \.offset) { _, check in
                    HStack { Text(check.name); Spacer(); Text(check.state).foregroundStyle(.secondary); if let url = check.url, let link = URL(string: url) { Link(destination: link) { FridaySymbolImage(systemName: "arrow.up.right.square") }.fridayInteractiveCursor() } }.font(.callout)
                }
            }.padding(18).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var timeline: some View {
        TaskChangeRequestTimelineList(detail: detail, activity: activity, loading: loadingResource, error: resourceError,
            comment: { AnyView(commentCard($0)) }, thread: { AnyView(threadCard($0)) }, openCommit: { selectCodeCommit($0.oid); tab = "code" }, footer: AnyView(commentComposer))
    }
    @ViewBuilder private var commentComposer: some View {
        if detail?.canComment == true {
            TextEditor(text: $session.draft.comment).font(.body).frame(minHeight: 65, maxHeight: 100).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary)).accessibilityLabel(Text(friday: "发表评论"))
            Button(friday: "发表评论") { sendAction("comment") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || session.pending != nil || !store.connected || session.draft.comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private var codeScopePicker: some View {
        HStack {
            if detail?.capabilities?.commitDiff != false {
            Menu {
                Button(friday: "全部提交") { selectCodeCommit(nil) }
                ForEach(TaskChangeRequestCodeScope.ordered(activity?.commits ?? [])) { commit in
                    Button { selectCodeCommit(commit.oid) } label: { Text(String(commit.oid.prefix(7)) + " · " + commit.messageHeadline) }
                }
            } label: {
                let selected = activity?.commits?.first { $0.oid == codeScope.commit }
                if let selected { Text(String(selected.oid.prefix(7)) + " · " + selected.messageHeadline).lineLimit(1) }
                else if let commit = codeScope.commit { Text(verbatim: String(commit.prefix(7))) }
                else { Text(friday: "全部提交") }
            }.menuStyle(.borderlessButton).fridayInteractiveCursor()
            } else { Text(friday: "全部提交").font(.callout).foregroundStyle(.secondary) }
            if activity?.commitsTruncated == true { Text(friday: "提交列表已截断").font(.caption).foregroundStyle(.secondary) }
            Spacer()
        }.padding(10)
    }
    private func selectCodeCommit(_ commit: String?) {
        guard commit == nil || detail?.capabilities?.commitDiff != false else { return }
        codeScope.commit = commit; pendingLine = nil; pendingPath = nil; files = nil; fileTarget = nil; resourceError = nil; resourceID = UUID(); loadingResource = false; filePageID = UUID(); loadingFilePage = false; filePageError = nil; fileRevealTarget = nil; resourceRevision &+= 1
    }
    private func scopedFiles(head: String, commit: String?) async throws -> TaskChangeRequestFiles {
        let value = try await store.taskChangeRequestDiffSlice(taskID, url: url, head: head, base: detail?.baseSha, commit: commit, cursor: nil)
        guard value.headSha == (commit ?? head), value.requestHeadSha == head, value.scopeCommit == commit, value.cursor == nil,
              detail?.baseSha == nil || detail?.baseSha == value.baseSha, Set(value.files.map(\.path)).count == value.files.count else { throw TaskChangeRequestRejection(message: "平台返回的文件版本不一致") }
        return value
    }
    private func loadNextFilePage() {
        guard current, store.connected, !loadingFilePage, let detail, let cursor = files?.nextCursor else { return }
        let owner = UUID(), context = loadID, head = detail.headSha, base = files?.baseSha, commit = codeScope.commit
        filePageID = owner; loadingFilePage = true; filePageError = nil
        Task { @MainActor in
            defer { if filePageID == owner { loadingFilePage = false } }
            do {
                let value = try await store.taskChangeRequestDiffSlice(taskID, url: url, head: head, base: base, commit: commit, cursor: cursor)
                guard current, filePageID == owner, loadID == context, self.detail?.headSha == head, codeScope.commit == commit, var loaded = files else { return }
                guard loaded.appendPage(value, requestedCursor: cursor, requestHead: head) else { throw TaskChangeRequestRejection(message: "文件页所属的版本或范围已改变，请刷新") }
                files = loaded; await loadViewedFiles()
            } catch { if current, filePageID == owner, loadID == context { filePageError = error.localizedDescription } }
        }
    }

    private func code(_ detail: TaskChangeRequestDetail) -> some View {
        VStack(spacing: 0) {
            codeScopePicker
            if let resourceError { HStack { message(resourceError); Button(friday: "重试读取") { resourceRevision &+= 1 }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loadingResource || !store.connected) } }
            if codeScope.commit != nil { Text(friday: "单次提交只读；切换到全部提交后可添加行内评论").font(.caption).foregroundStyle(.secondary).padding(8) }
            if let viewedError { message(viewedError) }
            if detail.management?.viewedFiles != nil {
                HStack(spacing: 6) {
                    Text(friday: "已读"); Text("\((files?.files ?? []).filter { session.viewed.isViewed($0.path, states: session.viewedFiles?.states ?? [:]) }.count) / \(files?.files.count ?? 0)")
                    Spacer(); Text(fridayString: detail.management?.viewedFiles == "environment" ? "已读标记仅保存在当前环境" : "已读标记同步到平台")
                    if session.viewedFiles?.truncated == true { Text(friday: "列表已截断") }
                }.font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.vertical, 5)
            }
            if loadingResource { Text(friday: files == nil ? "正在读取远端 Diff" : "正在读取审查状态…").foregroundStyle(.secondary).padding() }
            if files?.truncated == true { Text(friday: "当前切片中有内容被平台省略，文件统计仍保留").font(.caption).foregroundStyle(.secondary).padding(8) }
            if let filePageError { HStack { message(filePageError); Button(friday: "刷新详情") { Task { await reload(refresh: true) } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loading || !store.connected) } }
            if files?.nextCursor != nil {
                HStack { Text(friday: "已加载文件"); Text(verbatim: "\(files?.files.count ?? 0)"); Spacer(); Button(friday: loadingFilePage ? "正在读取下一页…" : filePageError == nil ? "加载更多文件" : "重试下一页") { loadNextFilePage() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loadingFilePage || !store.connected) }.font(.caption).foregroundStyle(.secondary).padding(8)
            }
            HStack(spacing: 0) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(files?.files ?? []) { file in
                            HStack(spacing: 0) {
                            Button { fileRevealTarget = nil; selectedPath = file.path; pendingLine = nil; pendingPath = nil } label: {
                                VStack(alignment: .leading, spacing: 3) { Text(file.path).lineLimit(2); Text("+\(file.additions)  −\(file.deletions)").font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary) }
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(8).background(selectedFile?.path == file.path ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 5))
                            }.buttonStyle(FridaySymbolButtonStyle())
                            if detail.management?.viewedFiles != nil { viewedButton(file.path) }
                            }
                        }
                        if let cursor = files?.nextCursor {
                            Button(friday: loadingFilePage ? "正在读取下一页…" : filePageError == nil ? "加载更多文件" : "重试下一页") { loadNextFilePage() }
                                .buttonStyle(FridayButtonStyle(compact: true)).disabled(loadingFilePage || !store.connected)
                                .frame(maxWidth: .infinity).padding(8).id(cursor)
                                .onAppear { if filePageError == nil { loadNextFilePage() } }
                        }
                    }.padding(6)
                }.frame(width: 190)
                Divider()
                if let file = selectedFile {
                    VStack(spacing: 0) {
                        HStack { Text(file.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Spacer(); if detail.capabilities?.fileContents != false { Button(friday: "完整文件") { var target = TaskChangeRequestFileTarget(path: file.path, head: detail.headSha, commit: codeScope.commit, initialSide: ["removed", "deleted"].contains(file.status) ? "old" : "new"); target.base = files?.baseSha; target.diffCursor = file.diffCursor; target.usesDiffSlices = true; fileTarget = target }.buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected) }; Toggle(isOn: $split) { Text(friday: "并排") }.toggleStyle(.switch).controlSize(.mini).fixedSize().fridayInteractiveCursor() }.padding(8)
                        Divider()
                        if file.unavailable { Spacer(); Text(fridayString: file.omissionReason == "binary" ? "二进制文件没有文本 Diff" : file.omissionReason == "too_large" ? "平台未提供过大文件的行级 Diff" : file.omissionReason == "collapsed" ? "平台折叠了此文件的 Diff" : "平台未提供此文件的行级 Diff").font(.caption).foregroundStyle(.secondary).padding(); if let link = URL(string: url) { Link(destination: link) { Text(friday: "在平台查看") }.fridayInteractiveCursor() }; Spacer() }
                        else if file.noHunks == true { Spacer(); Text(friday: "此变更没有行级 Diff").font(.caption).foregroundStyle(.secondary).padding(); Spacer() }
                        else {
                            TaskDiffCodeView(patch: file.patch, split: split, identity: codeScope.identity + ":" + (files?.headSha ?? "") + file.path, comments: inlineComments(file), canComment: permitsInlineComments && !busy && pendingLine == nil && store.connected,
                                beginComment: { begin($0, file: file) }, submitComment: { submitLine($0, body: $1, file: file) }, removeComment: removeLine,
                                customComment: { id in guard let thread = activity?.threads?.first(where: { $0.id == id }) else { return AnyView(EmptyView()) }; return AnyView(threadCard(thread)) })
                        }
                        if !unplacedThreads(file).isEmpty {
                            DisclosureGroup { ScrollView { LazyVStack(spacing: 8) { ForEach(unplacedThreads(file)) { threadCard($0) } }.padding(6) }.frame(maxHeight: 220) } label: { Text(friday: "未定位的审查线程") }.padding(8).fridayInteractiveCursor()
                        }
                    }
                } else { Spacer(); if fileRevealTarget != nil { Text(friday: "正在查找所选文件…").foregroundStyle(.secondary) } else if !loadingResource { Text(friday: files?.nextCursor != nil || files?.truncated == true ? "当前切片没有可显示的文件" : "暂无文件改动").foregroundStyle(.secondary) }; Spacer() }
            }
            if !orphanFileThreads.isEmpty {
                DisclosureGroup { ScrollView { LazyVStack(spacing: 8) { ForEach(orphanFileThreads) { threadCard($0) } }.padding(6) }.frame(maxHeight: 220) } label: { Text(friday: "其他文件的审查线程") }.padding(8).fridayInteractiveCursor()
            }
        }
    }
    private func reviewForm(_ detail: TaskChangeRequestDetail) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if staleComments { Text(friday: "代码版本已改变，请移除旧版本批注并重新审查").font(.caption).foregroundStyle(.orange) }
            if !session.draft.comments.isEmpty {
                ScrollView(.horizontal) {
                    HStack { ForEach(session.draft.comments) { comment in
                        HStack(spacing: 4) { Text("\(comment.path):\(comment.selection.end)").font(.caption).lineLimit(1); Button { removeLine(comment.id) } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()) }
                            .padding(5).background(.quaternary, in: RoundedRectangle(cornerRadius: 5))
                    } }
                }
            }
            TextEditor(text: $session.draft.summary).font(.body).frame(minHeight: 55, maxHeight: 85).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary)).accessibilityLabel(Text(friday: "审查意见"))
            HStack {
                Picker(selection: $session.draft.verdict) {
                    ForEach(detail.verdicts, id: \.self) { verdict in Text(fridayString: verdict == "approve" ? "批准" : verdict == "request-changes" ? "请求修改" : "评论").tag(verdict) }
                } label: { Text(friday: "审查结论") }
                .frame(maxWidth: 180).fridayInteractiveCursor()
                Spacer()
                if let pending = session.pending {
                    Button(friday: "重试发送") { send(pending) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected)
                }
                Button(friday: "提交审查") { sendAction("review") }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .disabled(busy || session.pending != nil || !store.connected || staleComments || !detail.verdicts.contains(session.draft.verdict) || detail.pullRequest.provider == "forgejo" && session.draft.verdict == "request-changes" && session.draft.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.draft.verdict == "comment" && session.draft.summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && session.draft.comments.isEmpty)
            }
        }
    }
    private func operationStatus(_ operation: TaskChangeRequestOperation) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(fridayString: operation.active ? "正在发送平台操作" : operation.status == "completed" ? "平台操作已提交" : "平台操作未完成").font(.caption)
            if operation.stackNumber != nil, operation.status == "completed" {
                Text(friday: operation.completedEffects.contains("stack-merge-enqueued") ? "堆叠已加入合并队列" : operation.action == "merge" ? "堆叠已合并" : "整栈变基已完成").font(.caption).foregroundStyle(.secondary)
            }
            if let value = operation.resultURL, let link = URL(string: value), link.scheme == "https" {
                Link(destination: link) { Label { Text(friday: "查看回退 PR") } icon: { FridaySymbolImage(systemName: "arrow.up.right.square") } }.font(.caption).fridayInteractiveCursor()
            }
            if let message = operation.error ?? operation.refreshError { Text(fridayString: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if !operation.completedEffects.isEmpty, operation.status != "completed" { Text(String(operation.completedEffects.count) + " " + String(localized: "步已发送，请先核对平台", bundle: .module)).font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal, 14).padding(.vertical, 6).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func message(_ value: String) -> some View { Text(fridayString: value).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(10).frame(maxWidth: .infinity, alignment: .leading) }

    private var pendingRetry: (() -> Void)? { guard !busy, store.connected, let pending = session.pending else { return nil }; return { send(pending) } }
    private func commentCard(_ item: TaskChangeRequestActivityResponse.Item) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.author).fontWeight(.medium)
                if let state = item.state { Text(fridayString: reviewLabel(state)).foregroundStyle(TaskChangeRequestTimeline.isStale(item, commits: activity?.commits ?? []) ? Color.secondary : reviewColor(state)) }
                Spacer()
                TaskTimelineDate(value: item.createdAt)
                if let value = item.url, let address = URL(string: value), address.scheme == "https" {
                    Link(destination: address) { FridaySymbolImage(systemName: "arrow.up.right.square").frame(width: 20, height: 20) }.fridayInteractiveCursor().help(Text(friday: "在平台打开"))
                }
                if item.canEdit == true, let id = item.sourceID, let kind = item.commentKind {
                    Button { openEditor(action: "edit_comment", key: "comment:" + id, body: item.body, commentID: id, commentKind: kind) } label: { FridaySymbolImage(systemName: "pencil").frame(width: 20, height: 20) }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(busy || !store.connected).help(Text(friday: "编辑评论"))
                }
            }
            if let path = item.path { Text(path + (item.line.map { ":\($0)" } ?? "")).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary) }
            if TaskChangeRequestTimeline.isStale(item, commits: activity?.commits ?? []) { Text(friday: "此审查早于最新提交").font(.caption).foregroundStyle(.secondary) }
            if let edited = item.editedAt, TaskChangeRequestTimeline.date(edited) != TaskChangeRequestTimeline.date(item.createdAt) { Text(friday: "已编辑").font(.caption).foregroundStyle(.secondary) }
            if let reason = item.dismissalMessage, !reason.isEmpty { HStack(alignment: .top) { Text(friday: "撤销原因").fontWeight(.medium); Text(reason).textSelection(.enabled) }.font(.caption).foregroundStyle(.secondary) }
            if let body = TaskChangeRequestTimeline.visibleBody(item.body) { TaskChangeRequestMarkdown(text: body, compact: true) }
            if detail?.management?.canReact == true, let id = item.sourceID { TaskReviewReactionsBar(reactions: effectiveReactions(item.reactions ?? [], subjectID: id), enabled: canReact) { content, reacted in react(content, reacted: reacted, subjectID: id) } }
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10))
    }
    private func reviewLabel(_ state: String) -> String {
        switch TaskChangeRequestTimeline.outcome(state) {
        case "approved": return "已批准"
        case "changes-requested": return "请求修改"
        case "dismissed": return "审查已撤销"
        default: return state.lowercased() == "commented" ? "已审查" : state
        }
    }
    private func reviewColor(_ state: String) -> Color {
        switch TaskChangeRequestTimeline.outcome(state) { case "approved": return .green; case "changes-requested": return .orange; default: return .secondary }
    }
    private func openEditor(action: String, key: String, title: String = "", body: String = "", threadID: String? = nil, commentID: String? = nil, commentKind: String? = nil) {
        guard current else { return }
        error = nil
        if session.draft.editors[key] == nil { session.draft.editors[key] = TaskChangeRequestEditorDraft(title: title, body: body, originalTitle: action == "edit_request" ? title : nil, originalBody: action == "edit_request" ? body : nil) }
        editor = TaskChangeRequestEditorTarget(key: key, action: action, threadID: threadID, commentID: commentID, commentKind: commentKind)
    }
    private func editorBinding(_ target: TaskChangeRequestEditorTarget) -> Binding<TaskChangeRequestEditorDraft> {
        Binding(get: { session.draft.editors[target.key] ?? TaskChangeRequestEditorDraft() }, set: { value in guard current, editor?.id == target.id else { return }; session.draft.editors[target.key] = value })
    }
    private func submitEditor(_ target: TaskChangeRequestEditorTarget) {
        guard editor?.id == target.id, let draft = session.draft.editors[target.key] else { return }
        let value = target.action == "edit_request" ? draft.changeRequestFields : TaskChangeRequestCollaboration(body: draft.body, threadID: target.threadID, commentID: target.commentID, commentKind: target.commentKind)
        sendCollaboration(target.action, value: value, editorKey: target.key)
    }
    private func sendCollaboration(_ action: String, value: TaskChangeRequestCollaboration, editorKey: String? = nil) {
        guard let detail, !busy, session.pending == nil else { return }
        send(TaskChangeRequestSubmission(url: url, headSha: detail.headSha, action: action, mergeMethod: nil, draft: session.draft, collaboration: value, editorKey: editorKey))
    }
    private func candidateRows(_ kind: String) -> [TaskChangeRequestCandidateRow] {
        if kind == "reviewers" { return (reviewers?.candidates ?? []).map { TaskChangeRequestCandidateRow(id: $0.key, title: $0.login, subtitle: $0.name, selected: $0.isRequested) } }
        return (labels?.candidates ?? []).map { TaskChangeRequestCandidateRow(id: $0.name, title: $0.name, subtitle: $0.description, selected: $0.isApplied) }
    }
    private func loadCandidates(_ kind: String, generation requestedGeneration: UUID? = nil) async {
        if kind == "reviewers", detail?.capabilities?.reviewerCandidates == false { return }
        guard current, candidateSheet?.id == kind, let generation = candidateSheet?.generation, requestedGeneration == nil || requestedGeneration == generation else { return }
        let owner = UUID(); candidateLoadID = owner; candidateLoading = true; candidateError = nil
        defer { if candidateLoadID == owner { candidateLoading = false } }
        do {
            if kind == "reviewers" { let value = try await store.taskChangeRequestReviewers(taskID, url: url); guard current, candidateLoadID == owner, candidateSheet?.generation == generation else { return }; reviewers = value }
            else { let value = try await store.taskChangeRequestLabels(taskID, url: url); guard current, candidateLoadID == owner, candidateSheet?.generation == generation else { return }; labels = value }
        } catch { if current, candidateLoadID == owner, candidateSheet?.generation == generation { candidateError = error.localizedDescription } }
    }
    private func toggleCandidate(_ id: String, kind: String) {
        guard current, candidateSheet?.id == kind, !candidateLoading else { return }
        if kind == "reviewers", let person = reviewers?.candidates.first(where: { $0.key == id }) { sendCollaboration("reviewers", value: TaskChangeRequestCollaboration(reviewers: [.init(id: person.id, kind: person.kind)], requested: !person.isRequested)) }
        else if kind == "labels", let label = labels?.candidates.first(where: { $0.name == id }) { sendCollaboration("labels", value: TaskChangeRequestCollaboration(labels: [label.name], applied: !label.isApplied)) }
    }
    private func loadThreadComments(_ thread: TaskChangeRequestActivityResponse.Thread) async {
        guard let cursor = thread.nextCursor, threadLoads[thread.id] == nil else { return }
        let owner = UUID(), context = loadID; threadLoads[thread.id] = owner
        defer { if threadLoads[thread.id] == owner { threadLoads.removeValue(forKey: thread.id) } }
        do {
            let page = try await store.taskChangeRequestThreadComments(taskID, url: url, threadID: thread.id, cursor: cursor)
            guard current, loadID == context, threadLoads[thread.id] == owner else { return }
            _ = activity?.appendThreadPage(page, threadID: thread.id, cursor: cursor)
        } catch { if current, loadID == context { resourceError = error.localizedDescription } }
    }

    private func inlineComments(_ file: TaskChangeRequestFiles.File) -> [TaskDiffInlineComment] {
        guard codeScope.commit == nil else { return [] }
        return session.draft.comments.filter { $0.path == file.path && $0.headSha == detail?.headSha }.map { TaskDiffInlineComment(id: $0.id, selection: $0.selection, rangeLabel: "L\($0.selection.end)", text: $0.body, referenceID: nil) } + (pendingPath == file.path ? pendingLine.map { [$0] } ?? [] : []) + remoteAnnotations(file)
    }
    private var canReact: Bool { !busy && session.pending == nil && store.connected }
    private func effectiveReactions(_ values: [TaskReviewReaction], subjectID: String?) -> [TaskReviewReaction] { TaskReviewReactionPresentation.overlay(values, input: session.reactionOverlay, subjectID: subjectID) }
    private func react(_ content: String, reacted: Bool, subjectID: String?) { sendCollaboration("reaction", value: TaskChangeRequestCollaboration(subjectID: subjectID, content: content, reacted: reacted)) }
    private func threadCard(_ thread: TaskChangeRequestActivityResponse.Thread) -> some View {
        let reaction: ((String, String, Bool) -> Void)? = detail?.management?.canReact == true ? { id, content, reacted in react(content, reacted: reacted, subjectID: id) } : nil
        return TaskReviewThreadCard(thread: thread, canResolve: detail?.management?.canResolve == true, canReply: detail?.canComment == true && detail?.capabilities?.replyToThreads != false,
            busy: busy || session.pending != nil || !store.connected, loadingMore: threadLoads[thread.id] != nil,
            reply: { openEditor(action: "reply", key: "reply:" + thread.id, threadID: thread.id) },
            resolve: { sendCollaboration("resolve", value: TaskChangeRequestCollaboration(threadID: thread.id, resolved: !thread.isResolved)) },
            edit: { comment in openEditor(action: "edit_comment", key: "comment:" + comment.id, body: comment.body, commentID: comment.id, commentKind: comment.commentKind) },
            loadMore: { Task { await loadThreadComments(thread) } }, reactionValues: { effectiveReactions($0.reactions ?? [], subjectID: $0.id) }, react: reaction)
    }
    private func remoteAnnotations(_ file: TaskChangeRequestFiles.File) -> [TaskDiffInlineComment] {
        guard codeScope.commit == nil else { return [] }
        return TaskRemoteThreadPlacement.annotations(activity?.threads ?? [], file: file, busy: busy || session.pending != nil || !store.connected, presentation: threadLoads.keys.sorted().joined(separator: ":") + (session.reactionOverlay?.requestID ?? ""))
    }
    private func unplacedThreads(_ file: TaskChangeRequestFiles.File) -> [TaskChangeRequestActivityResponse.Thread] {
        let placed = Set(remoteAnnotations(file).compactMap(\.presentationID))
        return (activity?.threads ?? []).filter { ($0.path == file.path || $0.path == file.oldPath) && !placed.contains($0.id) }
    }
    private var orphanFileThreads: [TaskChangeRequestActivityResponse.Thread] {
        let paths = Set((files?.files ?? []).flatMap { [$0.path, $0.oldPath].compactMap { $0 } })
        return files == nil ? [] : (activity?.threads ?? []).filter { !paths.contains($0.path) }
    }
    private func viewedButton(_ path: String) -> some View {
        let states = session.viewedFiles?.states ?? [:], viewed = session.viewed.isViewed(path, states: states), stale = session.viewed.isStale(path, states: states)
        return Button { session.viewed.press(path, viewed: !viewed) } label: { FridaySymbolImage(systemName: viewed ? "checkmark.square.fill" : stale ? "arrow.triangle.2.circlepath" : "square").font(.caption).frame(width: 25, height: 25).foregroundStyle(viewed ? Color.accentColor : Color.secondary) }
            .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected).help(Text(fridayString: stale ? "文件已改变，需要重新阅读" : viewed ? "标记为未读" : "标记为已读"))
    }
    private func flushViewedFiles(immediate: Bool = false) async {
        guard current, !busy, session.pending == nil, session.viewed.hasQueued, store.connected, detail?.management?.viewedFiles != nil else { return }
        if !immediate { do { try await Task.sleep(for: .milliseconds(400)) } catch { return } }
        guard current, !busy, session.pending == nil, let detail, let batch = session.viewed.takeBatch() else { return }
        send(TaskChangeRequestSubmission(url: url, headSha: detail.headSha, action: "files_viewed", mergeMethod: nil, draft: session.draft, collaboration: TaskChangeRequestCollaboration(files: batch.files), viewedBatch: batch))
    }
    private func loadViewedFiles() async {
        guard current, detail?.management?.viewedFiles != nil else { return }
        let owner = UUID(), ownership = session.viewed.readOwnership; viewedLoadID = owner
        do { let value = try await store.taskChangeRequestViewedFiles(taskID, url: url); guard current, viewedLoadID == owner else { return }; session.viewedFiles = value; session.viewed.settle(value.states, ownership: ownership); viewedError = nil }
        catch { if current, viewedLoadID == owner { viewedError = error.localizedDescription } }
    }
    private func begin(_ selection: TaskDiffReviewSelection, file: TaskChangeRequestFiles.File) {
        guard permitsInlineComments else { return }
        let point = selection.last
        pendingLine = TaskDiffInlineComment(id: UUID(), selection: TaskDiffReviewSelection(start: point.line, side: point.side, end: point.line, endSide: point.side), rangeLabel: "L\(point.line)", text: nil, referenceID: nil); pendingPath = file.path
    }
    private func submitLine(_ id: UUID, body: String, file: TaskChangeRequestFiles.File) {
        guard permitsInlineComments, let pending = pendingLine, pending.id == id, pendingPath == file.path, let detail, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let doc = TaskDiffReviewDocument(file.patch)
        guard let index = doc.index(pending.selection.last) else { return }
        let row = doc.rows[index], position: TaskChangeRequestPosition
        if row.kind == .addition, let new = row.newNumber { position = TaskChangeRequestPosition(kind: "added", newLine: new) }
        else if row.kind == .deletion, let old = row.oldNumber { position = TaskChangeRequestPosition(kind: "deleted", oldLine: old) }
        else if let old = row.oldNumber, let new = row.newNumber { position = TaskChangeRequestPosition(kind: "context", newLine: new, oldLine: old, side: pending.selection.endSide == "deletions" ? "left" : "right") }
        else { return }
        session.draft.comments.append(TaskRemoteReviewDraft(id: id, path: file.path, oldPath: file.oldPath, position: position, selection: pending.selection, headSha: detail.headSha, body: body, baseSha: files?.baseSha ?? detail.baseSha))
        pendingLine = nil; pendingPath = nil
    }
    private func removeLine(_ id: UUID) { if pendingLine?.id == id { pendingLine = nil; pendingPath = nil }; session.draft.comments.removeAll { $0.id == id } }
    private func reload(refresh: Bool = false, background: Bool = false) async {
        guard current else { return }
        let owner = UUID(); loadID = owner; loading = true; error = nil
        defer { if loadID == owner { loading = false } }
        do {
            if refresh { _ = try await store.openTaskChangeRequestView(taskID, reference: url); guard current, loadID == owner else { return } }
            async let fetched = store.taskChangeRequest(taskID, url: url, refresh: refresh)
            async let operations = store.taskChangeRequestOperations(taskID, url: url)
            let (value, records) = try await (fetched, operations)
            guard current, loadID == owner else { return }
            let versionChanged = detail?.headSha != value.headSha || detail?.baseSha != value.baseSha
            if versionChanged { files = nil; pendingLine = nil; pendingPath = nil; fileTarget = nil }
            if tab == "guide", value.reviewGuidesEnabled != true { tab = "summary" }
            detail = value
            if !background || versionChanged { files = nil }
            activity = nil; rootReactions = nil; resourceRevision &+= 1
            if value.stale == true { error = "刷新暂不可用，正在显示最近的数据"; nextChecksAt = value.retryAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date().addingTimeInterval(30) }
            if !value.verdicts.contains(session.draft.verdict) { session.draft.verdict = "comment" }
            if let record = records.last { session.reconcile(record) }
        } catch { if current, loadID == owner { self.error = error.localizedDescription; if let limited = error as? ConnectionError, case .rateLimited = limited { nextChecksAt = limited.retryAt ?? Date().addingTimeInterval(30) } } }
    }
    private func followChecks() async {
        while current {
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
            guard current, store.connected, !loading, !busy, Date() >= nextChecksAt, var currentDetail = detail else { continue }
            let owner = loadID
            do {
                let value = try await store.taskChangeRequestChecks(taskID, url: url)
                guard current, owner == loadID, !loading else { continue }
                nextChecksAt = Date().addingTimeInterval(15)
                if value.headSha != currentDetail.headSha || value.state != currentDetail.pullRequest.state
                    || value.updatedAt.map({ !$0.isEmpty && $0 != currentDetail.updatedAt }) == true
                    || value.isDraft.map({ $0 != currentDetail.isDraft }) == true
                    || value.mergeability.map({ $0 != currentDetail.mergeability }) == true {
                    await reload(background: true); continue
                }
                if value.checksUnavailable != true { currentDetail.checks = value.checks; currentDetail.checksState = value.checksState }
                currentDetail.checksUnavailable = value.checksUnavailable
                currentDetail.workflowApprovalsRequired = value.workflowApprovalsRequired
                currentDetail.workflowApprovalsUnavailable = value.workflowApprovalsUnavailable
                detail = currentDetail
                let fingerprint = value.checks.map { "\($0.name)|\($0.state)|\($0.url ?? "")" }.joined(separator: "\n")
                if let held = checksFingerprint, held != fingerprint, tab == "timeline" { activity = nil; resourceRevision &+= 1 }
                checksFingerprint = fingerprint
            } catch {
                guard current, owner == loadID else { continue }
                if let limited = error as? ConnectionError, case .rateLimited = limited { nextChecksAt = limited.retryAt ?? Date().addingTimeInterval(30) }
            }
        }
    }
    private func loadResource() async {
        guard current, let detail else { return }
        let owner = UUID(), context = loadID, target = tab, head = detail.headSha, commit = codeScope.commit
        let reactionAcknowledged = session.reactionAcknowledged
        resourceID = owner
        loadingResource = true; resourceError = nil
        defer { if resourceID == owner { loadingResource = false } }
        do {
            if target == "timeline", activity == nil {
                let value = try await store.taskChangeRequestActivity(taskID, url: url); guard current, loadID == context, resourceID == owner, self.detail?.headSha == head else { return }; activity = value
                clearReactionOverlay(reactionAcknowledged, rootOnly: false)
            } else if target == "code", files == nil {
                async let fetchedFiles = scopedFiles(head: head, commit: commit)
                async let fetchedActivity = store.taskChangeRequestActivity(taskID, url: url)
                let value = try await fetchedFiles
                guard current, loadID == context, resourceID == owner, self.detail?.headSha == head, codeScope.commit == commit else { return }
                files = value
                if fileRevealTarget == nil && !(files?.files.contains(where: { $0.path == selectedPath }) ?? false) { selectedPath = files?.files.first?.path }
                await loadViewedFiles()
                let discussion = try await fetchedActivity
                guard current, loadID == context, resourceID == owner, self.detail?.headSha == head, codeScope.commit == commit else { return }
                activity = discussion
                if codeScope.reconcile(discussion.commits ?? []) { selectCodeCommit(nil); return }
                clearReactionOverlay(reactionAcknowledged, rootOnly: false)
            } else if target == "code", activity == nil {
                let discussion = try await store.taskChangeRequestActivity(taskID, url: url)
                guard current, loadID == context, resourceID == owner, self.detail?.headSha == head, codeScope.commit == commit else { return }
                activity = discussion
                if codeScope.reconcile(discussion.commits ?? []) { selectCodeCommit(nil); return }
                clearReactionOverlay(reactionAcknowledged, rootOnly: false)
            } else if target == "summary", detail.management?.canReact == true {
                let value = try await store.taskChangeRequestReactions(taskID, url: url)
                guard current, loadID == context, resourceID == owner else { return }; rootReactions = value
                clearReactionOverlay(reactionAcknowledged, rootOnly: true)
            }
        } catch { if current, loadID == context, resourceID == owner { resourceError = error.localizedDescription } }
    }
    private func addGuideComment(_ headSha: String, _ excerpt: TaskGuideExcerptSnapshot, line: TaskGuideExcerptSnapshot.Line, body: String) {
        guard let detail, detail.headSha == headSha, !busy, session.pending == nil, let position = line.position else { return }
        let side = excerpt.side == "old" ? "deletions" : "additions"
        session.draft.comments.append(TaskRemoteReviewDraft(id: UUID(), path: excerpt.path, oldPath: excerpt.oldPath, position: position, selection: TaskDiffReviewSelection(start: line.number, side: side, end: line.number, endSide: side), headSha: headSha, body: body, baseSha: detail.baseSha))
    }
    private func sendAction(_ action: String, mergeMethod: String? = nil, updateMethod: String? = nil, expectedHeadSha: String? = nil, expectedWorkflowSource: [String: String]? = nil) {
        guard let detail, !busy, session.pending == nil else { return }
        var input = TaskChangeRequestSubmission(url: url, headSha: expectedHeadSha ?? detail.headSha, action: action, mergeMethod: mergeMethod, draft: session.draft)
        input.updateMethod = updateMethod; input.expectedWorkflowSource = expectedWorkflowSource; send(input)
    }
    private func send(_ submitted: TaskChangeRequestSubmission) {
        var input = submitted
        if input.action == "review", !input.draft.comments.isEmpty, input.expectedBaseSha == nil { input.expectedBaseSha = input.draft.comments.compactMap(\.baseSha).first ?? detail?.baseSha }
        guard current, !busy else { return }
        session.pending = input; session.sending = true; error = nil
        if input.action == "reaction" { session.reactionOverlay = input; session.reactionAcknowledged = nil }
        Task {
            defer { session.sending = false }
            guard current else { return }
            do {
                let id = try await store.startTaskChangeRequestOperation(taskID, body: input.body)
                guard current else { return }
                session.sent = input; session.sentOperationID = id; session.operationID = id; session.pending = nil
            } catch {
                if current {
                    if error is TaskChangeRequestRejection {
                        session.pending = nil
                        if let batch = input.viewedBatch { session.viewed.fail(batch) }
                        if session.reactionOverlay?.requestID == input.requestID { session.reactionOverlay = nil; session.reactionAcknowledged = nil }
                    }
                    self.error = error.localizedDescription
                }
            }
        }
    }
    private func clearReactionOverlay(_ acknowledged: String?, rootOnly: Bool) {
        guard let acknowledged, session.reactionAcknowledged == acknowledged, session.reactionOverlay?.requestID == acknowledged,
              !rootOnly || session.reactionOverlay?.collaboration?.subjectID == nil else { return }
        session.reactionOverlay = nil; session.reactionAcknowledged = nil
    }
    private func poll() async {
        guard let id = session.operationID, session.operation?.id != id || session.operation?.active == true else { return }
        while current, session.operationID == id, session.operation?.id != id || session.operation?.active == true {
            do {
                let operation = try await store.taskChangeRequestOperation(taskID, operationID: id)
                guard current, session.operationID == id else { return }
                let changed = session.reconcile(operation)
                if session.operation?.active != true { if changed { await reload() }; return }
                try await Task.sleep(for: .seconds(2))
            } catch { if current { self.error = error.localizedDescription }; return }
        }
    }
}
