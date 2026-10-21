import SwiftUI

struct TaskChangeRequestLinksView: View {
    @ObservedObject var store: FridayStore
    let taskID: String
    var open: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var response: TaskChangeRequestLinksResponse?
    @State private var reference = ""
    @State private var pending: TaskChangeRequestLinkSubmission?
    @State private var failure: String?
    @State private var loading = false
    @State private var sending = false
    @State private var scope = ""
    @State private var generation = UUID()
    private var identity: String { store.connectionIdentity + "|" + (store.taskStreamSession ?? "legacy") + "|" + taskID }
    private var current: Bool { scope == identity && !Task.isCancelled }
    private var busy: Bool { loading || sending }
    private var editable: Bool { store.tasks.contains { $0.id == taskID && $0.subagentOrigin == nil } }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(friday: "关联的 PR／MR").font(.headline)
                Spacer()
                Button(friday: "完成") { dismiss() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(sending)
            }
            Text(friday: "关联任意支持的平台地址，或输入当前 Workspace 的编号。查看详情与关联任务分别生效。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                TextField(friday: "PR／MR 地址或 #编号", text: $reference).textFieldStyle(.roundedBorder).onSubmit { submitLink() }
                Button(friday: "关联") { submitLink() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected || reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.disabled(sending || !editable)
            if let response {
                if response.links.isEmpty { Text(friday: "此任务尚未关联 PR／MR").foregroundStyle(.secondary).padding(.vertical, 16) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(TaskPullRequestPresentation.lines(response.links, stacks: store.tasks.first(where: { $0.id == taskID })?.changeRequestStacks ?? [:])) { line in
                            let pr = line.pullRequest
                            VStack(alignment: .leading, spacing: 6) {
                                HStack(alignment: .top) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("#\(pr.number) · \(pr.title)").font(.subheadline).textSelection(.enabled)
                                        Text(pr.repository ?? pr.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                        HStack {
                                            Text(fridayString: state(pr)).foregroundStyle(pr.state == "open" ? Color.green : Color.secondary)
                                            Text(fridayString: source(pr.linkSource)).foregroundStyle(.secondary)
                                            if pr.watch != nil { Text(friday: "正在自动跟进").foregroundStyle(.secondary) }
                                        }.font(.caption)
                                    }
                                    Spacer()
                                    if pr.state == "open" || pr.watch != nil {
                                        Button { change(TaskChangeRequestLinkSubmission(reference: pr.url, revision: response.revision, linked: true, watching: pr.watch == nil)) } label: {
                                            FridaySymbolImage(systemName: pr.watch == nil ? "eye" : "eye.slash").frame(width: 22, height: 22)
                                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(busy || !store.connected || !editable)
                                            .help(Text(friday: pr.watch == nil ? "自动跟进变化" : "停止自动跟进"))
                                            .accessibilityLabel(Text(friday: pr.watch == nil ? "自动跟进变化" : "停止自动跟进"))
                                    }
                                    Button(friday: "查看") { show(pr.url) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected)
                                    Button(friday: "取消关联") { change(TaskChangeRequestLinkSubmission(reference: pr.url, revision: response.revision, linked: false)) }
                                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected || !editable)
                                }
                                Divider()
                            }.padding(.leading, CGFloat(line.depth * 12))
                        }
                    }
                }
                if let branch = response.branch, !response.links.contains(where: { $0.url == branch.url }) {
                    HStack {
                        Text(friday: "当前分支").font(.caption).foregroundStyle(.secondary)
                        Text("#\(branch.number) · \(branch.title)").font(.caption).lineLimit(1)
                        Spacer()
                        Button(friday: "关联") { change(TaskChangeRequestLinkSubmission(reference: branch.url, revision: response.revision, linked: true)) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected || !editable)
                    }
                }
            }
            if loading { Text(friday: "正在加载关联…").font(.caption).foregroundStyle(.secondary) }
            Text(friday: "开启自动跟进后，CI、评论或冲突变化会让 Agent 继续此任务；停止按钮会结束跟进。")
                .font(.caption).foregroundStyle(.secondary)
            if sending { Text(friday: "正在保存关联…").font(.caption).foregroundStyle(.secondary) }
            if let failure {
                Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                HStack {
                    if let pending { Button(friday: "重试") { change(pending) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                    Button(friday: "重新加载") { pending = nil; Task { await load() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected)
                }
            }
        }.padding(20).frame(minWidth: 360, idealWidth: 620, minHeight: 380, idealHeight: 560)
        .interactiveDismissDisabled(sending)
        .task(id: identity) { scope = identity; response = nil; pending = nil; await load() }
        .onReceive(store.$tasks) { tasks in
            guard current, !busy, store.snapshotIdentity == store.connectionIdentity, let task = tasks.first(where: { $0.id == taskID }), let links = task.pullRequests else { return }
            response = TaskChangeRequestLinksResponse(revision: task.changeRequestLinksRevision ?? 0, links: links, branch: task.branchPullRequest)
        }
        .onDisappear { generation = UUID() }
    }
    private func state(_ pr: TaskPullRequest) -> String { pr.snapshot == nil ? "等待同步" : pr.snapshot?.isDraft == true ? "草稿" : pr.state == "merged" ? "已合并" : pr.state == "closed" ? "已关闭" : "待合并" }
    private func source(_ value: String?) -> String { value == "created" ? "由此任务创建" : value == "agent" ? "由 Agent 关联" : value == "stack" ? "堆叠成员" : "手动关联" }
    private func submitLink() {
        guard let response, !busy, current, editable else { return }
        let value = reference.trimmingCharacters(in: .whitespacesAndNewlines); guard !value.isEmpty else { return }
        if let pending, pending.linked, pending.watching == nil, pending.reference == value { change(pending) }
        else { change(TaskChangeRequestLinkSubmission(reference: value, revision: response.revision, linked: true)) }
    }
    private func load() async {
        guard current else { return }; let owner = UUID(); generation = owner; loading = true; failure = nil
        defer { if generation == owner { loading = false } }
        do { let value = try await store.taskChangeRequestLinks(taskID); guard current, generation == owner else { return }; response = value }
        catch { if current, generation == owner { failure = error.localizedDescription } }
    }
    private func change(_ submission: TaskChangeRequestLinkSubmission) {
        guard current, !busy, store.connected, editable else { return }; let owner = UUID(); generation = owner; sending = true; failure = nil; pending = submission
        let connection = store.connection
        Task { @MainActor in
            guard current, generation == owner else { return }
            defer { if generation == owner { sending = false } }
            do {
                let path = "/api/tasks/\(taskID)/change-request/\(submission.action)"
                if submission.watching != nil { _ = try await connection.decode(TaskChangeRequestWatchResult.self, path, method: "POST", body: submission.body) }
                else { _ = try await connection.decode(TaskChangeRequestLinkResult.self, path, method: "POST", body: submission.body) }
                guard current, generation == owner else { return }; pending = nil
                if submission.linked && submission.watching == nil { reference = "" }
                let refreshed = try await connection.decode(TaskChangeRequestLinksResponse.self, "/api/tasks/\(taskID)/change-request/links")
                guard current, generation == owner else { return }; response = refreshed
                await store.refresh()
            } catch { if current, generation == owner { failure = error.localizedDescription } }
        }
    }
    private func show(_ url: String) {
        guard current, !busy else { return }; let owner = generation
        Task { @MainActor in
            guard current, generation == owner else { return }
            do { let target = try await store.openTaskChangeRequestView(taskID, reference: url); guard current, generation == owner else { return }; open(target) }
            catch { if current, generation == owner { failure = error.localizedDescription } }
        }
    }
}
