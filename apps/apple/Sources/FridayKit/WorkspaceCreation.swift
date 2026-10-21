import Foundation
import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NamedProjectCreationResult: Decodable {
    let status: String; let requestId: String
    var project: Project?; var commitError: String?; var error: String?
}


struct WorkspaceAddView: View {
    @ObservedObject var store: FridayStore
    var onAdded: (Project) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    private enum Mode: Hashable { case new, existing, clone }
    @State private var mode: Mode = .new
    @State private var name = ""
    @State private var path = ""
    @State private var busy = false
    @State private var requestID: String?
    @State private var operation: UUID?
    @State private var error: String?
    @State private var created: Project?
    @State private var commitError: String?
    @State private var publicationError = false
    @State private var providers: [TaskPublishProvider] = []
    @State private var publishID = ""
    @State private var pendingProvider: TaskPublishProvider?
    @State private var cloneSource = "url"
    @State private var repositoryInput = ""
    @State private var cloneInfo: CloneRepositoryInfo?
    @State private var cloneTransport = "ssh"
    @State private var lookupRequest: UUID?
    @State private var pendingCloneBody: [String: Any]?
    @State private var generatedName = ""
    @State private var generatedPath = ""
    private var canCreate: Bool { store.namedProjectCreationSupported && store.newProjectsRoot != nil && store.snapshotIdentity == store.connectionIdentity }
    private var canClone: Bool { store.projectRepositoryOperationsSupported && store.snapshotIdentity == store.connectionIdentity }
    private var existing: Bool { mode == .existing || !canCreate }
    private var publishProvider: TaskPublishProvider? { providers.first { $0.id == publishID } }
    private var privateTargets: [TaskPublishProvider] { providers.filter { $0.status == "ready" && $0.account != nil && ["github", "gitlab", "forgejo", "gitcafe"].contains($0.provider) } }
    private var cloneProvider: TaskPublishProvider? { providers.first { $0.id == cloneSource } }
    private var cloneRemote: String? { cloneSource == "url" ? repositoryInput : cloneInfo.map { cloneTransport == "https" ? $0.httpsURL : $0.sshURL } }
    private var preview: String { (store.newProjectsRoot ?? "") + "/" + ManagedProjectNaming.folderName(name) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text(friday: "添加 Workspace").font(.title2.bold())
                Spacer()
                Button(friday: "取消") { cancelOrDismiss() }.keyboardShortcut(.cancelAction).disabled(busy && (requestID == nil || mode == .clone))
            }
            if let created {
                Text(friday: publicationError ? "项目已创建，仓库发布未完成" : commitError == nil ? "项目已创建" : "项目已创建，首次提交未完成").font(.headline)
                Text(verbatim: created.path).font(.caption.monospaced()).textSelection(.enabled)
                if let commitError { Text(fridayString: commitError).font(.callout).foregroundStyle(.orange) }
                HStack { Spacer(); Button(friday: "打开项目") { onAdded(created); dismiss() }.buttonStyle(FridayButtonStyle(prominent: true)).keyboardShortcut(.defaultAction) }
            } else {
                if canCreate {
                    Picker(selection: $mode) {
                        Text(friday: "新建项目").tag(Mode.new)
                        Text(friday: "已有目录").tag(Mode.existing)
                        if canClone { Text(friday: "克隆仓库").tag(Mode.clone) }
                    } label: { Text(friday: "项目来源") }.pickerStyle(.segmented).fridayInteractiveCursor().disabled(busy || requestID != nil)
                }
                if mode == .clone { cloneFields }
                TextField(friday: "Workspace 名称", text: $name).textFieldStyle(.roundedBorder).disabled(busy || requestID != nil)
                if existing || mode == .clone {
                    HStack {
                        TextField(friday: mode == .clone ? "克隆目标目录" : "主机上的绝对目录", text: $path).textFieldStyle(.roundedBorder).disabled(busy || requestID != nil)
                        #if os(macOS)
                        if store.deviceId == "owner" {
                            Button(friday: mode == .clone ? "选择父目录" : "选择目录") { chooseDirectory() }.disabled(busy || requestID != nil)
                        }
                        #endif
                    }
                } else {
                    Text(verbatim: preview).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                    Text(friday: "在主机创建独立目录和 Git 仓库，包含 README、项目图标及首次提交。").font(.callout).foregroundStyle(.secondary)
                    if canClone {
                        Picker(selection: $publishID) {
                            Text(friday: "不发布到远端").tag("")
                            ForEach(privateTargets) { provider in Text(verbatim: provider.label + " · " + provider.host + " · " + (provider.account ?? "")).tag(provider.id) }
                        } label: { Text(friday: "创建后发布为私有仓库") }.fridayInteractiveCursor().disabled(busy || requestID != nil)
                    }
                }
                if mode == .clone { Text(friday: "克隆开始后可关闭面板；进度、取消和重试会显示在项目中。").font(.caption).foregroundStyle(.secondary) }
                if let error { Text(fridayString: error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
                HStack {
                    if busy { Text(friday: "正在准备项目…").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button(friday: requestID != nil ? "核对创建结果" : mode == .clone ? "开始克隆" : existing ? "添加 Workspace" : "创建项目") { submit() }
                        .buttonStyle(FridayButtonStyle(prominent: true))
                        .keyboardShortcut(.defaultAction)
                        .disabled(busy || !store.connected || !WorkspaceStyle.validName(name) || (existing || mode == .clone) && path.isEmpty || mode == .clone && (cloneRemote?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false))
                }
            }
        }.padding(26)
        #if os(macOS)
        .frame(width: 560)
        #endif
        .interactiveDismissDisabled(busy)
        .onChange(of: store.connectionIdentity) { _, _ in operation = nil; lookupRequest = nil; busy = false; mode = .new; requestID = nil; pendingCloneBody = nil; pendingProvider = nil; providers = []; cloneSource = "url"; repositoryInput = ""; cloneInfo = nil; publishID = ""; path = ""; name = ""; error = nil; created = nil; commitError = nil }
        .onChange(of: repositoryInput) { _, _ in cloneInfo = nil; lookupRequest = nil; updateCloneDefaults() }
        .onChange(of: cloneSource) { _, _ in cloneInfo = nil; lookupRequest = nil; cloneTransport = cloneProvider?.provider == "forgejo" ? "https" : "ssh"; updateCloneDefaults() }
        .onChange(of: mode) { _, _ in if mode == .clone { updateCloneDefaults() } }
        .task(id: "\(store.connectionIdentity)|\(canClone)") { await loadProviders() }
        .onDisappear { operation = nil }
    }
    private var cloneFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker(selection: $cloneSource) {
                Text(verbatim: "Git URL").tag("url")
                ForEach(providers) { provider in
                    Text(verbatim: provider.label + " · " + provider.host).tag(provider.id).disabled(!provider.ready)
                        .accessibilityHint(Text(fridayString: provider.hint ?? ""))
                }
            } label: { Text(friday: "仓库来源") }.fridayInteractiveCursor()
            HStack {
                TextField(friday: cloneSource == "url" ? "Git 仓库地址" : "所有者／仓库名称", text: $repositoryInput).textFieldStyle(.roundedBorder)
                if cloneSource != "url" {
                    Button(friday: "查询仓库") { lookupRepository() }.disabled(repositoryInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || lookupRequest != nil)
                }
            }
            if let cloneInfo {
                Text(verbatim: cloneInfo.nameWithOwner).font(.caption).foregroundStyle(.secondary)
                Picker(selection: $cloneTransport) { Text(verbatim: "SSH").tag("ssh"); Text(verbatim: "HTTPS").tag("https") }
                label: { Text(friday: "传输协议") }.pickerStyle(.segmented).fridayInteractiveCursor()
            }
        }.disabled(busy || requestID != nil)
    }
    private func loadProviders() async {
        guard canClone, store.connected else { return }; let identity = store.connectionIdentity
        do { let values = try await store.projectRepositoryProviders(); if !Task.isCancelled, identity == store.connectionIdentity { providers = values } }
        catch { /* Local creation and pasted Git URLs remain available. */ }
    }
    private func updateCloneDefaults() {
        guard mode == .clone else { return }
        let remote = cloneInfo?.httpsURL ?? repositoryInput
        let next = ManagedProjectNaming.cloneDirectoryName(ManagedProjectNaming.publicCloneRemote(ManagedProjectNaming.normalizeCloneRemote(remote)))
        if name.isEmpty || name == generatedName { name = next }; generatedName = next
        let target = (store.newProjectsRoot ?? "") + "/" + next
        if path.isEmpty || path == generatedPath { path = target }; generatedPath = target
    }
    private func lookupRepository() {
        guard let provider = cloneProvider else { return }
        let identity = store.connectionIdentity, token = UUID(); lookupRequest = token; error = nil
        var body: [String: Any] = ["provider": provider.provider, "host": provider.host, "repository": repositoryInput]
        if let base = provider.baseURL { body["baseURL"] = base }
        Task {
            defer { if lookupRequest == token { lookupRequest = nil } }
            guard identity == store.connectionIdentity, lookupRequest == token else { return }
            do { let value = try await store.lookupCloneRepository(body); guard identity == store.connectionIdentity, lookupRequest == token else { return }; cloneInfo = value; updateCloneDefaults() }
            catch { if identity == store.connectionIdentity, lookupRequest == token { self.error = error.localizedDescription } }
        }
    }
    private func submit() {
        guard !busy else { return }
        let identity = store.connectionIdentity, token = UUID(); operation = token; busy = true; error = nil
        let checking = requestID != nil
        if !existing && canCreate && requestID == nil { requestID = UUID().uuidString; pendingProvider = publishProvider }
        let request = requestID, capturedName = name, capturedPath = path
        if mode == .clone, let request, pendingCloneBody == nil { pendingCloneBody = ["requestId": request, "name": capturedName, "path": capturedPath, "remoteURL": cloneRemote ?? ""] }
        if mode == .clone, !checking, let provider = cloneProvider {
            pendingCloneBody?["provider"] = provider.provider; pendingCloneBody?["host"] = provider.host
            pendingCloneBody?["repository"] = repositoryInput; pendingCloneBody?["protocol"] = cloneTransport
            if let base = provider.baseURL { pendingCloneBody?["baseURL"] = base }
        }
        let cloneBody = pendingCloneBody
        Task {
            defer { if operation == token { busy = false } }
            guard identity == store.connectionIdentity, operation == token else { return }
            do {
                if let cloneBody, mode == .clone {
                    let project = try await store.cloneProject(cloneBody)
                    guard operation == token, identity == store.connectionIdentity else { return }
                    onAdded(project); dismiss()
                } else if let request {
                    var result = checking ? try await store.namedProjectCreationStatus(request) : try await store.createNamedProject(name: capturedName, requestID: request)
                    if result.status == "missing" { result = try await store.createNamedProject(name: capturedName, requestID: request) }
                    guard operation == token, identity == store.connectionIdentity else { return }
                    if result.status == "created", let project = result.project, let provider = pendingProvider {
                        do { try await store.publishNewProject(project, provider: provider, requestID: request + "-publish") }
                        catch { guard operation == token, identity == store.connectionIdentity else { return }; created = project; publicationError = true; commitError = error.localizedDescription; return }
                        guard operation == token, identity == store.connectionIdentity else { return }
                    }
                    accept(result)
                } else {
                    let project = try await store.registerProject(name: capturedName, path: capturedPath)
                    guard operation == token, identity == store.connectionIdentity else { return }
                    onAdded(project); dismiss()
                }
            } catch {
                if operation == token, identity == store.connectionIdentity {
                    self.error = error.localizedDescription
                    if let code = (error as? ConnectionError)?.statusCode, (400..<500).contains(code), code != 408, code != 429 { requestID = nil; pendingCloneBody = nil }
                }
            }
        }
    }
    private func accept(_ result: NamedProjectCreationResult) {
        if result.status == "created", let project = result.project {
            if let warning = result.commitError { created = project; commitError = warning }
            else { onAdded(project); dismiss() }
        } else if result.status == "cancelled" { dismiss() }
        else { error = result.error ?? "项目创建结果待核对"; if result.status == "failed" { requestID = nil } }
    }
    private func cancelOrDismiss() {
        guard mode != .clone, busy, let request = requestID else { dismiss(); return }
        let identity = store.connectionIdentity, token = UUID(); operation = token
        Task {
            defer { if operation == token { busy = false } }
            guard identity == store.connectionIdentity, operation == token else { return }
            do {
                let result = try await store.namedProjectCreationStatus(request, cancel: true)
                guard operation == token, identity == store.connectionIdentity else { return }
                accept(result)
            } catch { if operation == token, identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
    #if os(macOS)
    private func chooseDirectory() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { path = mode == .clone ? url.appendingPathComponent(name).path : url.path; if name.isEmpty { name = url.lastPathComponent } }
    }
    #endif
}
