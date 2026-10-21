import SwiftUI

struct TaskRepositoryPublishDialog: View {
    @ObservedObject var store: FridayStore
    let taskID: String
    let review: TaskGitStatus
    let connectionIdentity: String
    let cancel: () -> Void
    @State private var providers: [TaskPublishProvider] = []
    @State private var draft = TaskRepositoryPublishDraft()
    @State private var step = 0
    @State private var fetching = false
    @State private var submitting = false
    @State private var error: String?
    @State private var pendingBody: [String: Any]?
    @State private var operationID: String?
    @State private var operation: TaskGitOperation?
    @Environment(\.openURL) private var openURL
    private var selected: TaskPublishProvider? { providers.first { $0.provider == draft.provider && (draft.host == nil || $0.host == draft.host) && $0.baseURL == draft.baseURL } }
    private var sameConnection: Bool { store.connectionIdentity == connectionIdentity }
    private var locked: Bool { pendingBody != nil }
    private var active: Bool { submitting || operation?.active == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(friday: "发布新仓库").font(.headline)
            HStack(spacing: 14) {
                ForEach(Array(["平台", "仓库", "结果"].enumerated()), id: \.offset) { index, label in
                    (Text(verbatim: "\(index + 1). ") + Text(fridayString: label))
                        .font(.callout.weight(step == index ? .semibold : .regular)).foregroundStyle(step == index ? .primary : .secondary)
                    if index < 2 { FridaySymbolImage(systemName: "chevron.right").font(.system(size: 9)).foregroundStyle(.tertiary) }
                }
            }.accessibilityElement(children: .combine)
            if step == 0 { providerStep }
            else if step == 1 { repositoryStep }
            else { resultStep }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            footer
        }.padding(24).frame(minWidth: 320, idealWidth: 540, maxWidth: 640)
            .interactiveDismissDisabled(active)
            .task { await loadProviders() }
            .task(id: "\(operationID ?? "")|\(store.connected)") {
                guard let operationID, store.connected else { return }
                while !Task.isCancelled && sameConnection {
                    do {
                        let value = try await store.taskGitOperation(taskID, operationID: operationID)
                        guard !Task.isCancelled, sameConnection else { return }
                        operation = value; error = nil
                        if !value.active { await store.refresh(); return }
                        try await Task.sleep(for: .seconds(2))
                    } catch { if !Task.isCancelled && sameConnection { self.error = error.localizedDescription }; return }
                }
            }
    }

    private var providerStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(friday: "选择服务主机已登录的仓库平台").font(.callout).foregroundStyle(.secondary)
            if fetching { ProgressView().controlSize(.small) }
            ForEach(providers.sorted { $0.ready != $1.ready ? $0.ready : $0.label < $1.label }) { provider in
                Button {
                    draft.provider = provider.provider; draft.host = provider.host; draft.baseURL = provider.baseURL
                    draft.repository = ["bitbucket", "azure-devops"].contains(provider.provider) ? "" : provider.account.map { $0 + "/" } ?? ""
                } label: {
                    HStack(spacing: 10) {
                        FridaySymbolImage(systemName: selected?.id == provider.id ? "largecircle.fill.circle" : "circle")
                        VStack(alignment: .leading, spacing: 4) {
                            Text(verbatim: provider.label + " · " + (provider.baseURL ?? provider.host)).font(.callout.weight(.medium))
                            if let account = provider.account { Text(verbatim: account).font(.caption).foregroundStyle(.secondary) }
                            if let hint = provider.hint { Text(fridayString: hint).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.leading) }
                        }
                        Spacer(minLength: 0)
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(.primary.opacity(selected?.id == provider.id ? 0.07 : 0.025), in: RoundedRectangle(cornerRadius: 9))
                }.buttonStyle(FridaySymbolButtonStyle()).disabled(!provider.ready || fetching)
            }
            Button(friday: "刷新登录状态", systemImage: "arrow.clockwise") { Task { await loadProviders() } }
                .buttonStyle(FridayButtonStyle(compact: true)).disabled(fetching || !store.connected)
        }
    }

    private var repositoryStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let selected { Text(verbatim: selected.label + " · " + selected.host + " · " + (selected.account ?? "")).font(.callout).foregroundStyle(.secondary) }
            Text(friday: draft.provider == "azure-devops" ? "组织／项目／仓库名称" : "所有者／仓库名称").font(.callout.weight(.medium))
            TextField(draft.provider == "azure-devops" ? "organization/project/repository" : "owner/repository", text: $draft.repository).textFieldStyle(.roundedBorder)
                .accessibilityLabel(Text(friday: draft.provider == "azure-devops" ? "组织／项目／仓库名称" : "所有者／仓库名称")).disabled(locked)
            if draft.provider == "azure-devops" { Text(friday: "访问权限由 Azure 项目管理。").font(.caption).foregroundStyle(.secondary) }
            else {
            Picker(selection: $draft.visibility) {
                Text(friday: "私有仓库").tag("private")
                Text(friday: "公开仓库").tag("public")
            } label: { Text(friday: "可见性") }.pickerStyle(.segmented).disabled(locked).fridayInteractiveCursor()
            Text(friday: draft.visibility == "public" ? "任何人都可以查看已推送的提交历史和文件。" : "仅你和获授权的人可以访问。").font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(friday: "远端名称", text: $draft.remoteName).textFieldStyle(.roundedBorder)
                    Picker(selection: $draft.transport) {
                        Text(verbatim: "SSH").tag("ssh")
                        Text(verbatim: "HTTPS").tag("https")
                    } label: { Text(friday: "传输协议") }.pickerStyle(.segmented).fridayInteractiveCursor()
                }.padding(.top, 8).disabled(locked)
            } label: { Text(friday: "高级选项") }.font(.callout).fridayInteractiveCursor()
            Divider()
            Text(verbatim: review.root ?? review.cwd).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
            Text(verbatim: review.branch ?? "HEAD").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            Text(friday: review.head == nil ? "本地尚无提交：创建仓库并添加远端，提交后再推送。" : "发布当前分支已有的提交；未提交文件不会上传。").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var resultStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let operation {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: operation.active ? "circle.dashed" : operation.status == "completed" ? "checkmark.circle" : "exclamationmark.circle")
                        .fridaySymbolFeedback(value: operation.status)
                    Text(fridayString: operation.active ? TaskGitPresentation.phase(operation.phase) : operation.status == "completed" ? "Git 操作已完成" : "Git 操作未完成").font(.callout.weight(.medium))
                }
                if let publication = operation.repositoryPublication {
                    Text(verbatim: publication.nameWithOwner).font(.callout).textSelection(.enabled)
                    Text(friday: publication.status == "pushed" ? "仓库已发布" : publication.status == "remote_added" ? "仓库已创建，远端已添加" : "远端仓库已创建").font(.caption).foregroundStyle(.secondary)
                    if !operation.active, publication.status == "remote_added", review.head == nil {
                        Text(friday: "提交文件后，使用推送将代码发送到新仓库。").font(.caption).foregroundStyle(.secondary)
                    }
                    Button(friday: "打开仓库", systemImage: "arrow.up.right.square") {
                        if let url = URL(string: publication.url), ["http", "https"].contains(url.scheme ?? ""), url.user == nil, url.password == nil { openURL(url) }
                    }.buttonStyle(FridayButtonStyle(compact: true))
                }
                if let failure = operation.error { Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            } else { Text(friday: "正在确认仓库发布状态").font(.callout).foregroundStyle(.secondary) }
        }
    }

    private var footer: some View {
        HStack {
            Button(friday: step == 2 ? "完成" : "取消", action: cancel).buttonStyle(FridayButtonStyle(compact: true)).disabled(active).keyboardShortcut(.cancelAction)
            Spacer()
            if step == 0 {
                Button(friday: "下一步") { step = 1 }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(selected?.ready != true || fetching).keyboardShortcut(.defaultAction)
            } else if step == 1 {
                if !locked { Button(friday: "上一步") { step = 0 }.buttonStyle(FridayButtonStyle(compact: true)) }
                Button(friday: submitting ? "正在提交请求" : locked ? "重试请求" : "发布新仓库", action: submit)
                    .buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(submitting || !store.connected || !sameConnection || !draft.valid(account: selected?.account, credentialFingerprint: selected?.credentialFingerprint)).keyboardShortcut(.defaultAction)
            } else if error != nil, let operationID {
                Button(friday: "刷新 Git 状态") {
                    Task {
                        do { let value = try await store.taskGitOperation(taskID, operationID: operationID); if sameConnection { operation = value; error = nil } }
                        catch { if sameConnection { self.error = error.localizedDescription } }
                    }
                }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected)
            }
        }
    }

    private func loadProviders() async {
        guard !fetching, sameConnection else { return }
        fetching = true; defer { fetching = false }
        do {
            let values = try await store.taskPublishProviders(taskID)
            guard !Task.isCancelled, sameConnection else { return }
            providers = values; error = nil
            let value = values.first { $0.provider == draft.provider && (draft.host == nil || $0.host == draft.host) && $0.baseURL == draft.baseURL && $0.ready } ?? values.first(where: \.ready)
            if let value { draft.provider = value.provider; draft.host = value.host; draft.baseURL = value.baseURL; if draft.repository.isEmpty && !["bitbucket", "azure-devops"].contains(value.provider) { draft.repository = (value.account ?? "") + "/" } }
        } catch { if !Task.isCancelled && sameConnection { self.error = error.localizedDescription } }
    }

    private func submit() {
        guard !submitting, sameConnection, let account = selected?.account, draft.valid(account: account, credentialFingerprint: selected?.credentialFingerprint) else { return }
        let body = pendingBody ?? draft.body(review: review, account: account, requestID: UUID().uuidString, credentialFingerprint: selected?.credentialFingerprint)
        pendingBody = body; submitting = true; error = nil
        Task {
            defer { submitting = false }
            guard sameConnection, store.connected else { return }
            do {
                let id = try await store.startTaskGitOperation(taskID, body: body)
                guard sameConnection else { return }
                operationID = id; step = 2
            } catch { if sameConnection { self.error = error.localizedDescription } }
        }
    }
}
