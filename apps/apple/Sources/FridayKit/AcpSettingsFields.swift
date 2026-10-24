import SwiftUI

struct AcpSettingsFields: View {
    @ObservedObject var store: FridayStore
    let provider: String
    var instanceId: String? = nil
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
    @State private var authMethods: [AcpNativeAuthMethods.Method] = []
    @State private var selectedAuthMethod = ""
    @State private var loginState: AcpNativeLoginState?
    @State private var authScope = ""
    @StateObject private var terminal = AcpAuthTerminalState()
    private func endpoint(_ path: String = "") -> String { TaskProviderCatalog.endpoint(provider, instance: instanceId, path: path) }
    private var context: String { store.connectionIdentity + ":" + (instanceId ?? provider) }
    private var config: AcpNativeProviderConfig { draft.nativeConfig ?? AcpNativeProviderConfig() }
    private var registry: Bool { provider == "acp-registry" }
    private var selectedMethod: AcpNativeAuthMethods.Method? { authMethods.first { $0.id == selectedAuthMethod } ?? (selectedAuthMethod.isEmpty ? authMethods.first : nil) }
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
                        Button(friday: authenticating ? "正在认证…" : "登录") { Task { await login() } }.disabled(working || authenticating || busy || dirty || !draft.enabled)
                        if authenticating { Button(friday: "取消") { Task { await cancelLogin() } }.disabled(working) }
                        if registry, !authenticating { Button(friday: "退出登录") { Task { await logout() } }.disabled(working || busy || dirty) }
                    }
                }
                if registry {
                    SettingsDivider()
                    SettingsRow("认证方式", detail: "读取工具声明的浏览器、终端或环境变量认证方式。") {
                        VStack(alignment: .trailing, spacing: 7) {
                            Picker(selection: $selectedAuthMethod) {
                                Text(friday: "默认").tag("")
                                ForEach(authMethods) { method in Text(verbatim: method.name).tag(method.id) }
                                if !selectedAuthMethod.isEmpty && !authMethods.contains(where: { $0.id == selectedAuthMethod }) { Text(verbatim: selectedAuthMethod).tag(selectedAuthMethod) }
                            } label: { Text(friday: "认证方式") }
                                .labelsHidden().frame(maxWidth: 230).fridayInteractiveCursor().disabled(busy || working || authenticating)
                            Button(friday: "读取认证方式") { Task { await loadAuthMethods() } }.font(.caption).disabled(busy || working || authenticating || dirty || !draft.enabled)
                        }
                    }
                    if let method = selectedMethod {
                        VStack(alignment: .leading, spacing: 7) {
                            if let description = method.description { Text(verbatim: description).font(.caption).foregroundStyle(.secondary) }
                            if let names = method.envVarNames, !names.isEmpty { Text(friday: "请先在此工具的环境变量设置中保存：\(names.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary) }
                            if let link = method.link, let url = URL(string: link) { Button(friday: "打开凭据页面") { openURL(url) }.buttonStyle(FridayButtonStyle(compact: true)) }
                        }.padding(14)
                    }
                }
            }
            if let interaction = loginState?.interaction {
                if interaction.type == "browser", let raw = interaction.url, let url = URL(string: raw), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    VStack(alignment: .leading, spacing: 9) {
                        Text(friday: "工具请求在浏览器中完成认证").font(.callout)
                        Text(verbatim: raw).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        HStack {
                            Button(friday: "打开浏览器并继续") { openURL(url); Task { try? await respondLogin(action: "accept") } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(working)
                            Button(friday: "拒绝") { Task { try? await respondLogin(action: "decline") } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(working)
                        }
                    }.padding(14)
                } else if interaction.type == "terminal" {
                    AcpAuthTerminalSurface(state: terminal).frame(height: 280).clipShape(RoundedRectangle(cornerRadius: 8))
                    if let problem = terminal.inputProblem { Text(fridayString: problem).font(.caption).foregroundStyle(.orange) }
                }
            }
            if let message = error ?? installation?.error { Text(verbatim: message).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .task(id: context) {
            authScope = context; working = false; installation = nil; authenticating = false; openedURL = nil; loginState = nil; authMethods = []; selectedAuthMethod = config.authMethodId; terminal.clear(); error = nil
            guard store.connected else { return }; await updateInstall()
            let scope = context, connection = store.connection
            if let state = try? await connection.decode(AcpNativeLoginState.self, endpoint("/login")), authScope == scope, !Task.isCancelled { acceptLogin(state) }
        }
        .onDisappear { terminal.clear() }
        .task(id: context + ":" + query) { guard registry, store.connected else { return }; agents = []; do { try await Task.sleep(for: .milliseconds(300)) } catch { return }; await search() }
        .task(id: installation?.operationId) {
            while !Task.isCancelled && installation?.active == true { do { try await Task.sleep(for: .seconds(1)) } catch { return }; await updateInstall() }
            if installation?.phase == "complete" { await refresh() }
        }
        .task(id: authenticating) {
            guard authenticating else { return }
            let identity = context, connection = store.connection
            if registry, let flowId = loginState?.flowId {
                await streamLogin(flowId: flowId, connection: connection, scope: context)
                return
            }
            while !Task.isCancelled && authenticating {
                do {
                    try await Task.sleep(for: .seconds(1))
                    guard identity == context else { return }
                    let value = try await connection.decode(AcpNativeLoginState.self, endpoint("/login"))
                    guard identity == context else { return }
                    if let url = value.url, url != openedURL, let target = URL(string: url) { openedURL = url; openURL(target) }
                    if !value.pending { await refresh() }
                    authenticating = value.pending
                } catch { if identity == context && !Task.isCancelled { self.error = error.localizedDescription; authenticating = false }; return }
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
    @MainActor private func search() async { let expected = query, identity = context; do { let value = try await store.connection.decode(AcpRegistrySearchResult.self, endpoint("/registry/search"), method: "POST", body: ["query": expected]); guard expected == query && identity == context else { return }; agents = value.agents } catch { if identity == context { self.error = error.localizedDescription } } }
    @MainActor private func updateInstall() async { let identity = context, connection = store.connection; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint("/install")); guard identity == context else { return }; installation = value } catch { if identity == context && !Task.isCancelled { self.error = error.localizedDescription } } }
    @MainActor private func install() async { let identity = context, connection = store.connection; working = true; defer { working = false }; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint("/install"), method: "POST", body: [:]); guard identity == context else { return }; installation = value; error = nil } catch { if identity == context { self.error = error.localizedDescription } } }
    @MainActor private func cancelInstall() async { guard let operation = installation?.operationId else { return }; let identity = context, connection = store.connection; working = true; defer { working = false }; do { let value = try await connection.decode(NativeToolInstallState.self, endpoint("/install/cancel"), method: "POST", body: ["operationId": operation]); guard identity == context else { return }; installation = value } catch { if identity == context { self.error = error.localizedDescription } } }
    @MainActor private func acceptLogin(_ value: AcpNativeLoginState) {
        guard value.accepts(after: loginState) else { return }
        loginState = value; authenticating = value.pending; error = value.error
        terminal.receive(value) { data, cols, rows in try await respondLogin(data: data, cols: cols, rows: rows) }
    }
    @MainActor private func loadAuthMethods() async {
        let scope = context, connection = store.connection; working = true
        defer { if authScope == scope { working = false } }
        do {
            let value = try await connection.decode(AcpNativeAuthMethods.self, endpoint("/login/methods"))
            guard authScope == scope else { return }; authMethods = value.methods; error = nil
            if selectedAuthMethod.isEmpty, let preferred = value.defaultMethodId, value.methods.contains(where: { $0.id == preferred }) { selectedAuthMethod = preferred }
        } catch { if authScope == scope { self.error = error.localizedDescription } }
    }
    @MainActor private func login() async {
        let scope = context, connection = store.connection; working = true
        defer { if authScope == scope { working = false } }
        do {
            let body: [String: Any] = registry && !selectedAuthMethod.isEmpty ? ["methodId": selectedAuthMethod] : [:]
            let value = try await connection.decode(AcpNativeLoginState.self, endpoint("/login"), method: "POST", body: body)
            guard authScope == scope else { return }; acceptLogin(value)
            if !registry, let url = value.url, let target = URL(string: url) { openedURL = url; openURL(target) }
            await refresh()
        } catch { if authScope == scope { self.error = error.localizedDescription } }
    }
    @MainActor private func respondLogin(action: String? = nil, data: String? = nil, cols: Int? = nil, rows: Int? = nil) async throws {
        guard let state = loginState, let flow = state.flowId, let interaction = state.interaction else { throw ConnectionError.message("认证交互已改变，请刷新后重试") }
        let scope = context, connection = store.connection
        var body: [String: Any] = ["flowId": flow, "interactionId": interaction.id]
        if let action { body["action"] = action }; if let data { body["data"] = data }
        if let cols, let rows { body["cols"] = cols; body["rows"] = rows }
        do {
            let value = try await connection.decode(AcpNativeLoginState.self, endpoint("/login/respond"), method: "POST", body: body)
            guard authScope == scope, loginState?.flowId == flow else { return }; acceptLogin(value)
        } catch { if authScope == scope, loginState?.flowId == flow { self.error = error.localizedDescription }; throw error }
    }
    @MainActor private func cancelLogin() async {
        let scope = context, connection = store.connection; working = true
        defer { if authScope == scope { working = false } }
        do {
            let value = try await connection.decode(AcpNativeLoginState.self, endpoint("/login/cancel"), method: "POST", body: loginState?.flowId.map { ["flowId": $0] } ?? [:])
            guard authScope == scope else { return }; acceptLogin(value); await refresh()
        } catch { if authScope == scope { self.error = error.localizedDescription } }
    }
    @MainActor private func logout() async {
        let scope = context, connection = store.connection; working = true
        defer { if authScope == scope { working = false } }
        do {
            let value = try await connection.decode(AcpNativeLoginState.self, endpoint("/logout"), method: "POST", body: [:])
            guard authScope == scope else { return }; acceptLogin(value); terminal.clear(); await refresh()
        } catch { if authScope == scope { self.error = error.localizedDescription } }
    }
    @MainActor private func streamLogin(flowId: String, connection: Connection, scope: String) async {
        while authenticating, !Task.isCancelled, authScope == scope, loginState?.flowId == flowId {
            do {
                var request = try connection.request(endpoint("/login/events") + (instanceId == nil ? "?" : "&") + "flowId=" + flowId)
                request.timeoutInterval = 30; request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                if (response as? HTTPURLResponse)?.statusCode == 409 { authenticating = false; loginState = nil; terminal.clear(); error = "认证流程已改变，请重新打开设置读取当前状态。"; return }
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message("认证连接暂时不可用") }
                for try await line in bytes.lines {
                    guard !Task.isCancelled, authScope == scope, loginState?.flowId == flowId else { return }
                    if line.hasPrefix("data: "), let raw = line.dropFirst(6).data(using: .utf8), let value = try? JSONDecoder().decode(AcpNativeLoginState.self, from: raw), value.flowId == flowId {
                        acceptLogin(value)
                        if !value.pending { await refresh(); return }
                    }
                }
            } catch { if Task.isCancelled || authScope != scope { return }; self.error = error.localizedDescription }
            if authenticating { do { try await Task.sleep(for: .seconds(1)) } catch { return } }
        }
    }
}
