import SwiftUI

private struct TaskGitSubmission {
    let review: TaskGitStatus
    let action: String
    var requestID = UUID().uuidString
    var message: String? = nil
    var paths: [String]? = nil
    var featureBranch = false
    var branchName = ""
    var confirmedDefaultBranch = false
    var creation: [String: String]? = nil
    var body: [String: Any] {
        var value: [String: Any] = ["requestId": requestID, "action": action, "fingerprint": review.fingerprint, "featureBranch": featureBranch, "confirmedDefaultBranch": confirmedDefaultBranch]
        if let creation { value["creation"] = creation }
        if let message { value["commitMessage"] = message }
        if let paths { value["filePaths"] = paths }
        if !branchName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { value["branchName"] = branchName.trimmingCharacters(in: .whitespacesAndNewlines) }
        return value
    }
}
private struct TaskGitSheet {
    enum Kind { case commit, publish, repository, request }
    let kind: Kind
    let submission: TaskGitSubmission
}
private struct TaskChangeRequestSheet: Identifiable { let id: String }

struct TaskGitActionsControl: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var status: TaskGitStatus?
    @State private var sheet: TaskGitSheet?
    @State private var showsProgress = false
    @State private var submitting = false
    @State private var fetching = false
    @State private var error: String?
    @State private var failedRequest: TaskGitSubmission?
    @State private var changeRequestSheet: TaskChangeRequestSheet?
    @State private var showLinks = false
    @State private var linkedOpenURL: String?
    @Environment(\.openURL) private var openURL
    private var busy: Bool { task.active || task.gitBusy || task.sessionBusy || task.branchChange?.active == true || submitting }
    private var quick: TaskGitQuickAction { TaskGitPresentation.quick(status, busy: busy) }
    private var canPush: Bool { !busy && store.connected && status?.branch != nil && status?.remote != nil && status?.behind == 0 && (status?.ahead ?? 0) > 0 }
    private var canPR: Bool { !busy && store.connected && status?.branch != nil && status?.canCreatePR == true && status?.behind == 0 }
    private var symbol: String { quick.action == "publish_repository" ? "arrow.up.right.square" : quick.openPR || quick.action == "create_pr" ? "arrow.up.right.square" : quick.action == "pull" ? "arrow.down.circle" : "checkmark.circle" }

    var body: some View {
        HStack(spacing: 2) {
            if let badge = TaskPullRequestPresentation.badge(task.pullRequests ?? [], stacks: task.changeRequestStacks ?? [:], branch: task.branchPullRequest) {
                Button { openReview(badge.current.url) } label: {
                    HStack(spacing: 4) {
                        FridaySymbolImage(systemName: badge.stacked ? "square.stack" : badge.state == "merged" ? "arrow.triangle.merge" : badge.state == "closed" ? "xmark.circle" : "arrow.triangle.pull").font(.system(size: 11))
                        Text("#\(badge.current.number)\(badge.count > 1 ? " +\(badge.count - 1)" : "")").font(.caption.monospacedDigit())
                    }.padding(.horizontal, 6).frame(height: 28)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(badge.state == "merged" ? .purple : badge.state == "open" ? .green : .secondary).help(badge.current.title)
            }
            #if os(macOS)
            Button {
                if quick.openPR { openCurrentPullRequest() }
                else if let action = quick.action, let status { prepare(TaskGitSubmission(review: status, action: action)) }
            } label: {
                HStack(spacing: 5) {
                    FridaySymbolImage(systemName: task.gitBusy ? "circle.dashed" : symbol).font(.system(size: 12))
                        .fridaySymbolFeedback(value: task.gitOperation?.status)
                    Text(fridayString: task.gitBusy ? TaskGitPresentation.phase(task.gitOperation?.phase ?? "queued", provider: task.gitOperation?.changeRequestProvider) : quick.title)
                        .font(.caption).lineLimit(1)
                }.padding(.horizontal, 7).frame(height: 28)
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(!quick.enabled || !store.connected)
                .help(Text(fridayString: quick.hint ?? quick.title))
            #endif
            Menu {
                if let status {
                    if status.remote == nil, status.status == "repository" {
                        Button(friday: "发布新仓库", systemImage: "arrow.up.right.square") { prepare(TaskGitSubmission(review: status, action: "publish_repository")) }
                            .disabled(busy || !store.connected || status.branch == nil)
                    }
                    Button(friday: "提交", systemImage: "checkmark.circle") { sheet = TaskGitSheet(kind: .commit, submission: TaskGitSubmission(review: status, action: "commit")) }
                        .disabled(busy || !store.connected || status.files.isEmpty)
                    Button(friday: "推送", systemImage: "arrow.up.circle") { prepare(TaskGitSubmission(review: status, action: "push")) }.disabled(!canPush)
                    if status.pullRequest?.state == "open" {
                        Button(friday: status.sourceControl?.provider == "gitlab" ? "查看 MR" : "查看 PR", systemImage: "arrow.up.right.square", action: openCurrentPullRequest)
                    } else {
                        Button(friday: status.sourceControl?.provider == "gitlab" ? "创建 MR" : "创建 PR", systemImage: "arrow.up.right.square") { prepare(TaskGitSubmission(review: status, action: "create_pr")) }.disabled(!canPR)
                    }
                    Button(friday: "拉取", systemImage: "arrow.down.circle") { prepare(TaskGitSubmission(review: status, action: "pull")) }
                        .disabled(busy || !store.connected || status.upstream == nil || !status.files.isEmpty || status.ahead > 0 && status.behind > 0)
                    Divider()
                }
                Button(friday: "刷新 Git 状态", systemImage: "arrow.clockwise") { Task { await load(refresh: true) } }.disabled(fetching || !store.connected)
                Button(friday: "管理关联的 PR／MR") { showLinks = true }.disabled(!store.connected)
                if let linked = task.pullRequests, !linked.isEmpty {
                    Menu {
                        ForEach(linked, id: \.url) { pr in Button("#\(pr.number) · \(pr.title)") { openReview(pr.url) } }
                    } label: { Text(friday: "关联的 PR／MR") }
                }
                if task.gitOperation != nil || error != nil {
                    Button(friday: "查看 Git 操作", systemImage: "list.bullet.rectangle") { showsProgress = true }
                }
            } label: {
                #if os(macOS)
                FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9)).frame(width: 18, height: 28)
                #else
                FridaySymbolImage(systemName: "arrow.triangle.branch").frame(width: 24, height: 28)
                #endif
            }.menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "Git 操作"))
            if task.gitOperation != nil {
                Button { showsProgress = true } label: {
                    FridaySymbolImage(systemName: task.gitBusy ? "ellipsis.circle" : task.gitOperation?.status == "completed" ? "checkmark.circle" : "exclamationmark.circle")
                        .font(.system(size: 12)).frame(width: 20, height: 28)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(task.gitOperation?.status == "failed" || task.gitOperation?.status == "interrupted" ? .orange : .secondary)
                    .accessibilityLabel(Text(friday: "查看 Git 操作"))
            }
        }
        .sheet(isPresented: Binding(get: { sheet != nil }, set: { if !$0 { sheet = nil } })) {
            if let sheet {
                if sheet.kind == .repository {
                    TaskRepositoryPublishDialog(store: store, taskID: task.id, review: sheet.submission.review, connectionIdentity: store.connectionIdentity, cancel: { self.sheet = nil })
                } else if sheet.kind == .request {
                    TaskChangeRequestCreationDialog(store: store, taskID: task.id, review: sheet.submission.review, submitting: submitting, submissionError: error, initialNewBranch: sheet.submission.featureBranch, initialName: sheet.submission.branchName, cancel: { self.sheet = nil }) { newBranch, name, selection in
                        var request = sheet.submission; request.featureBranch = newBranch; request.branchName = name; request.creation = selection; request.confirmedDefaultBranch = true
                        run(request)
                    }
                } else if sheet.kind == .commit {
                    TaskGitCommitDialog(submission: sheet.submission, submitting: submitting, error: error, cancel: { self.sheet = nil }) { message, paths, newBranch in
                        var request = sheet.submission; request.message = message; request.paths = paths; request.featureBranch = newBranch
                        prepare(request)
                    }
                } else {
                    TaskGitPublishDialog(submission: sheet.submission, submitting: submitting, error: error, cancel: { self.sheet = nil }) { newBranch, name in
                        var request = sheet.submission; request.featureBranch = newBranch; request.branchName = name; request.confirmedDefaultBranch = !newBranch
                        run(request)
                    }
                }
            }
        }
        .popover(isPresented: $showsProgress) {
            TaskGitProgress(operation: task.gitOperation, error: error, retry: failedRequest.map { request in { run(request) } }, openPR: { openReview(task.gitOperation?.pullRequest?.url) }, openRepository: { openPullRequest(task.gitOperation?.repositoryPublication?.url) })
                .frame(minWidth: 300, idealWidth: 440, maxWidth: 560)
        }
        .sheet(item: $changeRequestSheet) { target in TaskChangeRequestPanel(store: store, taskID: task.id, url: target.id) }
        .sheet(isPresented: $showLinks, onDismiss: { if let url = linkedOpenURL { linkedOpenURL = nil; openReview(url) } }) { TaskChangeRequestLinksView(store: store, taskID: task.id) { url in linkedOpenURL = url; showLinks = false } }
        .task(id: "\(task.id)|\(store.connection.server)|\(store.connected)") {
            guard store.connected else { return }
            while !Task.isCancelled {
                await load()
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
            }
        }
        .task(id: "\(task.gitOperation?.id ?? "")|\(task.gitOperation?.status ?? "")") {
            guard let operation = task.gitOperation, !operation.active else { return }
            await load()
        }
        .task(id: "\(task.gitOperation?.id ?? "")|\(task.gitOperation?.status ?? "")|\(showsProgress)") {
            guard showsProgress, let operation = task.gitOperation, operation.status == "completed" else { return }
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            if task.gitOperation?.id == operation.id { showsProgress = false }
        }
        .onChange(of: store.connectionIdentity) { _, _ in status = nil; sheet = nil; error = nil; failedRequest = nil; showLinks = false; linkedOpenURL = nil; changeRequestSheet = nil }
    }
    private func load(refresh: Bool = false) async {
        guard !fetching else { return }
        fetching = true; defer { fetching = false }
        do { let value = try await store.taskGitStatus(task.id, refresh: refresh); if !Task.isCancelled { status = value } }
        catch { if !Task.isCancelled && !task.gitBusy { self.error = error.localizedDescription } }
    }
    private func prepare(_ request: TaskGitSubmission) {
        error = nil; failedRequest = nil
        if request.action == "publish_repository" {
            sheet = TaskGitSheet(kind: .repository, submission: request)
        } else if TaskGitPresentation.createsPR(request.action) {
            sheet = TaskGitSheet(kind: .request, submission: request)
        } else if TaskGitPresentation.publishes(request.action), !request.featureBranch,
           request.review.isDefaultBranch || request.review.defaultBranch == nil {
            sheet = TaskGitSheet(kind: .publish, submission: request)
        } else { run(request) }
    }
    private func run(_ request: TaskGitSubmission) {
        guard !submitting else { return }
        submitting = true; error = nil; failedRequest = request
        Task {
            defer { submitting = false }
            do {
                _ = try await store.startTaskGitOperation(task.id, body: request.body)
                sheet = nil; failedRequest = nil; showsProgress = true
            } catch { self.error = error.localizedDescription; if sheet == nil { showsProgress = true } }
        }
    }
    private func openCurrentPullRequest() { openReview(status?.pullRequest?.url) }
    private func openReview(_ url: String?) { guard let url else { return }; showsProgress = false; changeRequestSheet = TaskChangeRequestSheet(id: url) }
    private func openPullRequest(_ raw: String?) {
        guard let raw,
              let url = URL(string: raw), url.scheme == "https" else { return }
        openURL(url)
    }
}

private struct TaskGitCommitDialog: View {
    let submission: TaskGitSubmission; let submitting: Bool; let error: String?
    let cancel: () -> Void
    let submit: (String, [String]?, Bool) -> Void
    @State private var message: String
    @State private var selected: Set<String>
    @State private var editing = false
    init(submission: TaskGitSubmission, submitting: Bool, error: String?, cancel: @escaping () -> Void, submit: @escaping (String, [String]?, Bool) -> Void) {
        self.submission = submission; self.submitting = submitting; self.error = error; self.cancel = cancel; self.submit = submit
        _message = State(initialValue: submission.message ?? ""); _selected = State(initialValue: Set(submission.paths ?? submission.review.files.map(\.path)))
    }
    private var files: [TaskChangedFile] { submission.review.files }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(friday: "提交改动").font(.headline)
            HStack {
                Text(friday: "分支").foregroundStyle(.secondary)
                Text(verbatim: submission.review.branch ?? "HEAD").font(.system(.callout, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                Spacer()
                if submission.review.isDefaultBranch { Text(friday: "默认分支").font(.caption).foregroundStyle(.orange) }
            }.font(.callout)
            HStack {
                if editing {
                    Button { selected = selected.count == files.count ? [] : Set(files.map(\.path)) } label: {
                        FridaySymbolImage(systemName: selected.count == files.count ? "checkmark.square.fill" : "square")
                    }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "全选文件"))
                }
                Text(friday: "文件").foregroundStyle(.secondary)
                Text(verbatim: "\(selected.count)/\(files.count)").font(.caption).monospacedDigit()
                Spacer()
                Button(friday: editing ? "完成" : "编辑") { editing.toggle() }.buttonStyle(FridaySymbolButtonStyle())
            }.font(.callout)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(files) { file in
                        if editing {
                            Button {
                                if selected.contains(file.path) { selected.remove(file.path) } else { selected.insert(file.path) }
                            } label: { fileRow(file) }
                                .buttonStyle(FridaySymbolButtonStyle()).disabled(submitting).help(file.path)
                                .accessibilityLabel(Text(verbatim: file.path)).accessibilityValue(Text(friday: selected.contains(file.path) ? "已选择" : "未选择"))
                        } else { fileRow(file).textSelection(.enabled).help(file.path) }
                    }
                }
            }.frame(height: 176).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                Spacer()
                TaskDiffStat(additions: files.filter { selected.contains($0.path) }.compactMap(\.additions).reduce(0, +), deletions: files.filter { selected.contains($0.path) }.compactMap(\.deletions).reduce(0, +))
            }
            Text(friday: "提交说明（可选）").font(.callout.weight(.medium))
            ZStack(alignment: .topLeading) {
                TextEditor(text: $message).font(.system(size: 13)).scrollContentBackground(.hidden).padding(4)
                if message.isEmpty { Text(friday: "留空将自动生成").font(.callout).foregroundStyle(.tertiary).padding(9).allowsHitTesting(false) }
            }.frame(height: 78).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel(Text(friday: "提交说明"))
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button(friday: "取消", action: cancel).buttonStyle(FridayButtonStyle(compact: true)).keyboardShortcut(.cancelAction)
                Spacer()
                Button(friday: "在新分支上提交") { send(newBranch: true) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(submitting || selected.isEmpty)
                Button(friday: "提交") { send(newBranch: false) }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(submitting || selected.isEmpty).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(minWidth: 320, idealWidth: 540, maxWidth: 640).interactiveDismissDisabled(submitting)
    }
    private func fileRow(_ file: TaskChangedFile) -> some View {
        HStack(spacing: 8) {
            if editing { FridaySymbolImage(systemName: selected.contains(file.path) ? "checkmark.square.fill" : "square") }
            Text(verbatim: file.path).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            TaskDiffStat(additions: file.additions, deletions: file.deletions)
        }.padding(8).frame(maxWidth: .infinity).contentShape(Rectangle()).opacity(selected.contains(file.path) ? 1 : 0.45)
    }
    private func send(newBranch: Bool) { submit(message, selected.count == files.count ? nil : files.filter { selected.contains($0.path) }.map(\.path), newBranch) }
}

private struct TaskGitPublishDialog: View {
    let submission: TaskGitSubmission; let submitting: Bool; let error: String?
    let cancel: () -> Void
    let submit: (Bool, String) -> Void
    @State private var name = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(friday: submission.review.isDefaultBranch ? "在默认分支上发布？" : "确认发布分支").font(.headline)
            Text(verbatim: submission.review.branch ?? "HEAD").font(.system(.body, design: .monospaced)).textSelection(.enabled)
            if let remote = submission.review.remoteDisplay { Text(verbatim: remote).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            Text(friday: "可以先创建功能分支，也可以明确选择在当前分支继续。").font(.callout).foregroundStyle(.secondary)
            TextField(friday: "新分支名称（可选）", text: $name).textFieldStyle(.roundedBorder).disabled(submitting)
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button(friday: "取消", action: cancel).buttonStyle(FridayButtonStyle(compact: true)).keyboardShortcut(.cancelAction)
                Spacer()
                Button(friday: "在当前分支继续") { submit(false, "") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(submitting)
                Button(friday: "新建分支后继续") { submit(true, name) }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(submitting).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(minWidth: 320, idealWidth: 540, maxWidth: 640).interactiveDismissDisabled(submitting)
    }
}

private struct TaskGitProgress: View {
    let operation: TaskGitOperation?; let error: String?
    let retry: (() -> Void)?; let openPR: () -> Void; let openRepository: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let operation {
                HStack(spacing: 9) {
                    FridaySymbolImage(systemName: operation.active ? "circle.dashed" : operation.status == "completed" ? "checkmark.circle" : "exclamationmark.circle")
                        .fridaySymbolFeedback(value: operation.status)
                    Text(fridayString: operation.active ? TaskGitPresentation.phase(operation.phase, provider: operation.changeRequestProvider) : operation.status == "completed" ? "Git 操作已完成" : "Git 操作未完成").font(.callout.weight(.medium))
                    Spacer()
                    if operation.active, let start = CodexTranscript.date(operation.phaseStartedAt ?? operation.createdAt) {
                        TimelineView(.periodic(from: .now, by: 1)) { context in Text(verbatim: "\(max(0, Int(context.date.timeIntervalSince(start))))s") }
                            .font(.caption).foregroundStyle(.secondary).monospacedDigit().accessibilityHidden(true)
                    }
                }
                if let context = operation.changeRequestCreation { Text("\(context.source.path):\(operation.featureBranch ?? context.sourceBranch) → \(context.target.path):\(context.baseBranch)").font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                if let message = operation.commitMessage { Text(verbatim: message).font(.callout).textSelection(.enabled).lineLimit(8) }
                if let output = operation.output, !output.isEmpty {
                    ScrollView { Text(verbatim: output.joined(separator: "\n")).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 200)
                }
                if let failure = operation.error { Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                if let sha = operation.commitSHA {
                    Button { copyAgentText(sha) } label: { FridaySymbolLabel(friday: "复制提交 ID", systemImage: "doc.on.doc") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
                }
                if operation.pullRequest != nil { Button(friday: operation.changeRequestProvider == "gitlab" ? "查看 MR" : "查看 PR", systemImage: "arrow.up.right.square", action: openPR).buttonStyle(FridayButtonStyle(compact: true)) }
                if let publication = operation.repositoryPublication {
                    Text(verbatim: publication.nameWithOwner).font(.callout).textSelection(.enabled)
                    Text(friday: publication.status == "pushed" ? "仓库已发布" : publication.status == "remote_added" ? "仓库已创建，远端已添加" : "远端仓库已创建").font(.caption).foregroundStyle(.secondary)
                    Button(friday: "打开仓库", systemImage: "arrow.up.right.square", action: openRepository).buttonStyle(FridayButtonStyle(compact: true))
                }
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let retry { Button(friday: "重试请求", action: retry).buttonStyle(FridayButtonStyle(compact: true)) }
        }.padding(18)
    }
}
