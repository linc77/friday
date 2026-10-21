import SwiftUI

struct AcpSettingsFields: View {
    @ObservedObject var store: FridayStore
    let provider: String
    @Binding var draft: CodexProviderSettings
    let dirty: Bool
    let busy: Bool
    let refresh: () async -> Void
    @Environment(\.openURL) private var openURL
    @State private var query = ""
    @State private var agents: [AcpRegistrySearchResult.Agent] = []
    @State private var installation: NativeToolInstallState?
    @State private var authenticating = false
    @State private var working = false
    @State private var openedURL: String?
    @State private var error: String?
    private var endpoint: String { "/api/agents/\(provider)" }
    private var config: AcpNativeProviderConfig { draft.nativeConfig ?? AcpNativeProviderConfig() }
    private var registry: Bool { provider == "acp-registry" }
    private var installedLabel: String {
        switch installation?.phase { case "downloading": "正在下载…"; case "extracting": "正在解包…"; case "verifying": "正在核对工具…"; case "complete": "工具已准备"; case "cancelled": "已取消"; case "failed": "准备失败"; default: "准备工具" }
    }
    private func text(_ path: WritableKeyPath<AcpNativeProviderConfig, String>) -> Binding<String> {
        Binding(get: { config[keyPath: path] }, set: { value in var next = config; next[keyPath: path] = value; draft.nativeConfig = next })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if registry { registryFields } else { antigravityFields }
            if !registry || config.source == "registry" {
                SettingsGroup("主机工具") {
                    SettingsRow("托管工具", detail: "保存配置后准备工具；已有可执行文件也可以直接使用。") {
                        HStack(spacing: 8) {
                            if installation?.active == true {
                                Text(fridayString: installedLabel).font(.caption).foregroundStyle(.secondary)
                                Button(friday: "取消") { Task { await cancelInstall() } }.disabled(working)
                            } else {
                                Button(friday: installedLabel) { Task { await install() } }.disabled(working || busy || dirty || registry && config.registryAgentId.isEmpty)
                            }
                        }
                    }
                    if let installation, installation.active {
                        Text(installation.totalBytes.map { String(format: "%.1f / %.1f MB", installation.downloadedBytes / 1_000_000, $0 / 1_000_000) } ?? String(format: "%.1f MB", installation.downloadedBytes / 1_000_000))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.bottom, 10)
                    }
                }
            }
            SettingsGroup("账号") {
                SettingsRow("连接账号", detail: registry ? "使用工具声明的认证方式；也可在主机的原生工具中登录。" : "Google 账号与凭据保存在此主机的独立配置中。") {
                    HStack(spacing: 8) {
                        Button(friday: authenticating ? "等待浏览器登录…" : "登录") { Task { await login() } }.disabled(working || authenticating || busy || dirty || !draft.enabled)
                        if authenticating { Button(friday: "取消") { Task { await cancelLogin() } }.disabled(working) }
                    }
                }
                if registry {
                    SettingsDivider()
                    SettingsRow("认证方式 ID", detail: "留空使用工具提供的 Agent 管理认证。") {
                        TextField("auto", text: text(\.authMethodId)).textFieldStyle(.roundedBorder).frame(maxWidth: 210).disabled(busy || working)
                    }
                }
            }
            if let message = error ?? installation?.error { Text(verbatim: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .task(id: store.connectionIdentity) { installation = nil; authenticating = false; openedURL = nil; error = nil; guard store.connected else { return }; await updateInstall() }
        .task(id: store.connectionIdentity + ":" + query) { guard registry, store.connected else { return }; agents = []; do { try await Task.sleep(for: .milliseconds(300)) } catch { return }; await search() }
        .task(id: installation?.operationId) {
            while !Task.isCancelled && installation?.active == true { do { try await Task.sleep(for: .seconds(1)) } catch { return }; await updateInstall() }
            if installation?.phase == "complete" { await refresh() }
        }
        .task(id: authenticating) {
            guard authenticating else { return }
            let identity = store.connectionIdentity, connection = store.connection
            while !Task.isCancelled && authenticating {
                do {
                    try await Task.sleep(for: .seconds(1))
                    guard identity == store.connectionIdentity else { return }
                    let value = try await connection.decode(AcpNativeLoginState.self, endpoint + "/login")
                    guard identity == store.connectionIdentity else { return }
                    if let url = value.url, url != openedURL, let target = URL(string: url) { openedURL = url; openURL(target) }
                    if !value.pending { await refresh() }
                    authenticating = value.pending
                } catch { if identity == store.connectionIdentity && !Task.isCancelled { self.error = error.localizedDescription; authenticating = false }; return }
            }
        }
    }
    private var registryFields: some View {
        SettingsGroup("ACP 工具") {
            SettingsRow("来源", detail: "从官方 Registry 选择，或使用主机上的本地 ACP 命令。") {
                Picker(selection: text(\.source)) { Text("ACP Registry").tag("registry"); Text(friday: "本地命令").tag("local") } label: { Text(friday: "来源") }
                    .labelsHidden().frame(maxWidth: 210).fridayInteractiveCursor().disabled(busy || working)
            }
            SettingsDivider()
            if config.source == "local" {
                SettingsRow("可执行文件", detail: "当前服务使用的本地程序。") { TextField("acp", text: $draft.binaryPath).textFieldStyle(.roundedBorder).frame(maxWidth: 300).disabled(busy || working) }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(config.commandArgs.enumerated()), id: \.offset) { index, _ in
                        HStack {
                            TextField(friday: "启动参数", text: Binding(get: { config.commandArgs.indices.contains(index) ? config.commandArgs[index] : "" }, set: { value in var next = config; if next.commandArgs.indices.contains(index) { next.commandArgs[index] = value }; draft.nativeConfig = next })).textFieldStyle(.roundedBorder)
                            Button { var next = config; if next.commandArgs.indices.contains(index) { next.commandArgs.remove(at: index) }; draft.nativeConfig = next } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "移除"))
                        }
                    }
                    Button(friday: "添加参数") { var next = config; next.commandArgs.append(""); draft.nativeConfig = next }.disabled(config.commandArgs.count >= 64)
                }.padding(14).disabled(busy || working)
            } else {
                SettingsRow("Registry 工具 ID", detail: config.registryAgentId) { TextField("devin", text: text(\.registryAgentId)).textFieldStyle(.roundedBorder).frame(maxWidth: 210).disabled(busy || working) }
                VStack(alignment: .leading, spacing: 8) {
                    TextField(friday: "搜索 ACP 工具", text: $query).textFieldStyle(.roundedBorder)
                    ForEach(agents) { agent in
                        Button {
                            var next = config; next.registryAgentId = agent.id; draft.nativeConfig = next; draft.model = ""; draft.reasoningEffort = ""
                        } label: {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 3) { Text(agent.name).font(.callout); Text(agent.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                                Spacer(minLength: 8); Text(agent.version).font(.caption.monospaced()).foregroundStyle(.secondary)
                                if config.registryAgentId == agent.id { FridaySymbolImage(systemName: "checkmark") }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(7)
                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(busy || working)
                    }
                }.padding(14)
                SettingsDivider()
                SettingsRow("可执行文件覆盖", detail: "可选；保留 Registry 声明的启动参数和环境。") { TextField(friday: "可选", text: text(\.commandOverride)).textFieldStyle(.roundedBorder).frame(maxWidth: 300).disabled(busy || working) }
            }
        }
    }
    private var antigravityFields: some View {
        SettingsGroup("Antigravity") {
            SettingsRow("认证方式", detail: "选择此主机使用的 Google 账号或密钥类型。") {
                Picker(selection: text(\.authMethod)) { Text("Google account").tag("oauth-personal"); Text("Gemini Enterprise").tag("oauth-business"); Text("Gemini API Key").tag("gemini-api-key"); Text("Agent Platform").tag("agent-platform") } label: { Text(friday: "认证方式") }
                    .labelsHidden().frame(maxWidth: 210).fridayInteractiveCursor().disabled(busy || working)
            }
            if ["gemini-api-key", "agent-platform"].contains(config.authMethod) {
                SettingsDivider()
                SettingsRow("API Key", detail: "已保存的密钥不会回传；留空保留原值。") {
                    VStack(alignment: .trailing, spacing: 5) {
                        SecureField(config.apiKeyConfigured ? "••••••••" : "API Key", text: Binding(get: { config.apiKey ?? "" }, set: { value in var next = config; next.apiKey = value.isEmpty ? nil : value; draft.nativeConfig = next })).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                        if config.apiKeyConfigured { Button(friday: "清除已保存的密钥") { var next = config; next.apiKey = ""; draft.nativeConfig = next }.font(.caption) }
                    }.disabled(busy || working)
                }
            }
            if ["oauth-business", "agent-platform"].contains(config.authMethod) {
                SettingsDivider()
                SettingsRow("GCP Project", detail: "Google Cloud 项目标识。") { TextField("project-id", text: text(\.gcpProject)).textFieldStyle(.roundedBorder).frame(maxWidth: 260).disabled(busy || working) }
                SettingsDivider()
                SettingsRow("GCP Location", detail: "Google Cloud 区域。") { TextField("us-central1", text: text(\.gcpLocation)).textFieldStyle(.roundedBorder).frame(maxWidth: 260).disabled(busy || working) }
            }
            SettingsDivider()
            SettingsRow("Harness 路径", detail: "留空使用 ACP 程序旁的原生 Harness。") { TextField(friday: "可选", text: text(\.harnessPath)).textFieldStyle(.roundedBorder).frame(maxWidth: 300).disabled(busy || working) }
        }
    }
    @MainActor private func search() async { let expected = query, identity = store.connectionIdentity; do { let value = try await store.connection.decode(AcpRegistrySearchResult.self, endpoint + "/registry/search", method: "POST", body: ["query": expected]); guard expected == query && identity == store.connectionIdentity else { return }; agents = value.agents } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } } }
    @MainActor private func updateInstall() async { let identity = store.connectionIdentity, connection = store.connection; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint + "/install"); guard identity == store.connectionIdentity else { return }; installation = value } catch { if identity == store.connectionIdentity && !Task.isCancelled { self.error = error.localizedDescription } } }
    @MainActor private func install() async { let identity = store.connectionIdentity, connection = store.connection; working = true; defer { working = false }; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint + "/install", method: "POST", body: [:]); guard identity == store.connectionIdentity else { return }; installation = value; error = nil } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } } }
    @MainActor private func cancelInstall() async { guard let operation = installation?.operationId else { return }; let identity = store.connectionIdentity, connection = store.connection; working = true; defer { working = false }; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint + "/install/cancel", method: "POST", body: ["operationId": operation]); guard identity == store.connectionIdentity else { return }; installation = value } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } } }
    @MainActor private func login() async { let identity = store.connectionIdentity, connection = store.connection; working = true; defer { working = false }; do { let value = try await connection.decode(AcpNativeLoginState.self, endpoint + "/login", method: "POST", body: [:]); guard identity == store.connectionIdentity else { return }; authenticating = value.pending; if let url = value.url, let target = URL(string: url) { openedURL = url; openURL(target) }; error = nil; await refresh() } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } } }
    @MainActor private func cancelLogin() async { let identity = store.connectionIdentity, connection = store.connection; working = true; defer { working = false }; do { _ = try await connection.decode(AcpNativeLoginState.self, endpoint + "/login/cancel", method: "POST", body: [:]); guard identity == store.connectionIdentity else { return }; authenticating = false; error = nil; await refresh() } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } } }
}
