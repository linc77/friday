import SwiftUI
#if os(macOS)
import AppKit
#endif

struct CodexSettingsView: View {
    @ObservedObject var store: FridayStore
    @Environment(\.openURL) private var openURL
    @State private var state: CodexConnectionState?
    @State private var draft = CodexProviderSettings()
    @State private var saved: CodexProviderSettings?
    @State private var busy = false
    @State private var error: String?
    @State private var variableName = ""
    @State private var variableValue = ""
    @State private var addingVariable = false
    private var owner: Bool { store.deviceId == "owner" }
    private var dirty: Bool { saved != nil && draft != saved }
    private var accountLabel: String {
        guard let state else { return store.connected ? "正在读取…" : "等待主机连接" }
        if !state.enabled { return "已停用" }
        if !state.connected { return state.installed ? "未登录" : "不可用" }
        if state.account?.type == "chatgpt" { return "ChatGPT · \(state.account?.plan?.capitalized ?? "已登录")" }
        return state.account?.type == "apiKey" ? "API Key" : "已连接"
    }
    private var selectedModel: CodexProviderModel? {
        state?.models.first { $0.id == (draft.model.isEmpty ? state?.model : draft.model) }
    }
    private var checkedTime: String? {
        guard let value = state?.checkedAt else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: value) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                FridaySymbolLabel(friday: "当前主机 · 全部项目", systemImage: "laptopcomputer")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fridaySymbolFeedback()
                Spacer()
                if let checkedTime { Text(checkedTime).font(.system(size: 11)).foregroundStyle(.tertiary) }
                Button { Task { await refresh(force: true) } } label: {
                    FridaySymbolLabel(friday: busy ? "检测中…" : "重新检测", systemImage: "arrow.clockwise")
                        .fridaySymbolFeedback(active: busy)
                }.controlSize(.small).disabled(busy || !store.connected)
            }
            details
            if let error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .task(id: store.connected) { if store.connected { await refresh() } }
        .task(id: state?.loginPending) {
            guard state?.loginPending == true else { return }
            while !Task.isCancelled && state?.loginPending == true {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await refresh(force: true)
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    FridaySymbolLabel("Codex", systemImage: "cpu").font(.system(size: 14, weight: .medium))
                        .fridaySymbolFeedback(value: state?.connected)
                    Text(fridayString: accountLabel).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                if let version = state?.version { Text("v\(version)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary) }
                if owner {
                    Toggle(isOn: $draft.enabled) { Text(friday: "启用 Codex") }.labelsHidden().toggleStyle(.switch).controlSize(.mini)
                        .disabled(busy || !store.connected)
                }
            }
            SettingsGroup("账号") {
                SettingsRow("显示名称", detail: state?.account?.email ?? accountLabel) {
                    TextField("Codex", text: $draft.displayName).textFieldStyle(.roundedBorder).frame(maxWidth: 210)
                        .disabled(!owner || busy)
                }
                if owner && state?.connected != true {
                    SettingsDivider()
                    SettingsRow("连接账号", detail: "使用 Codex 登录，或读取配置目录中已有的账号。") {
                        Button(friday: state?.loginPending == true ? "等待浏览器登录…" : "登录 ChatGPT") { Task { await login() } }
                            .disabled(busy || dirty || !store.connected || state?.loginPending == true)
                    }
                }
            }
            if owner {
                SettingsGroup("运行配置") {
                    runtimeField("可执行文件", detail: "当前服务使用的 Codex 程序。", placeholder: "codex", value: $draft.binaryPath)
                    SettingsDivider()
                    runtimeField("CODEX_HOME", detail: "Codex 的配置与会话目录。", placeholder: "~/.codex", value: $draft.homePath)
                    SettingsDivider()
                    runtimeField("独立账号目录", detail: "单独保存账号凭据，共享 CODEX_HOME 中的配置和会话。", placeholder: "可选", value: $draft.shadowHomePath)
                    SettingsDivider()
                    runtimeField("启动参数", detail: "传给 Codex app-server 的额外参数。", placeholder: "可选", value: $draft.launchArgs)
                }
                environment
            }
            SettingsGroup("模型") {
                SettingsRow("默认模型", detail: "用于新的 Codex 任务。") {
                    Picker(selection: Binding(get: { draft.model }, set: { draft.model = $0; draft.reasoningEffort = "" })) {
                        Text(friday: "Codex 默认").tag("")
                        ForEach(state?.models ?? []) { model in Text(model.name).tag(model.id) }
                        if !draft.model.isEmpty && !(state?.models.contains { $0.id == draft.model } ?? false) { Text(draft.model).tag(draft.model) }
                    } label: { Text(friday: "默认模型") }.labelsHidden().frame(maxWidth: 210).disabled(!owner || busy)
                }
                SettingsDivider()
                SettingsRow("推理强度", detail: "按当前模型提供的选项设置。") {
                    Picker(selection: $draft.reasoningEffort) {
                        Text(friday: "模型默认").tag("")
                        ForEach(selectedModel?.reasoningEfforts ?? [], id: \.self) { Text($0.capitalized).tag($0) }
                    } label: { Text(friday: "推理强度") }.labelsHidden().frame(maxWidth: 210).disabled(!owner || busy)
                }
            }
            if let message = state?.error { Text(fridayString: message).font(.system(size: 12)).foregroundStyle(.secondary) }
            if owner {
                HStack {
                    Text(friday: dirty ? "有未保存的修改" : "配置保存在当前主机").font(.system(size: 11)).foregroundStyle(.tertiary)
                    Spacer()
                    Button(friday: "恢复") { if let saved { draft = saved }; error = nil }.disabled(!dirty || busy)
                    Button(friday: "保存配置") { Task { await save() } }
                        .buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(!dirty || busy || !store.connected)
                }
            } else {
                Text(friday: "请在主机上配置 Codex，已连接设备共用该服务。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func runtimeField(_ title: String, detail: String, placeholder: String, value: Binding<String>) -> some View {
        SettingsRow(title, detail: detail) {
            TextField(friday: placeholder, text: value).textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced)).frame(maxWidth: 210).disabled(busy)
                .accessibilityLabel(Text(fridayString: title))
        }
    }

    private var environment: some View {
        SettingsGroup("环境变量") {
            SettingsRow("变量", detail: "配置 API 地址等运行环境，值会隐藏显示。") {
                Button { addingVariable.toggle() } label: {
                    FridaySymbolLabel(friday: "添加变量", systemImage: "plus").fridaySymbolFeedback(active: addingVariable)
                }.disabled(busy)
            }
            ForEach(draft.environment.indices, id: \.self) { index in
                SettingsDivider()
                HStack(spacing: 10) {
                    Text(draft.environment[index].name).font(.system(size: 11, design: .monospaced)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    SecureField(friday: "已保存，输入以替换", text: Binding(get: { draft.environment[index].value ?? "" }, set: { draft.environment[index].value = $0 }))
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 190).disabled(busy)
                    Button { draft.environment.remove(at: index) } label: { FridaySymbolImage(systemName: "minus.circle").fridaySymbolFeedback() }
                        .buttonStyle(.plain).disabled(busy).accessibilityLabel(Text(friday: "移除变量"))
                }.padding(14)
            }
            if addingVariable {
                SettingsDivider()
                VStack(alignment: .leading, spacing: 10) {
                    TextField("OPENAI_BASE_URL", text: $variableName).textFieldStyle(.roundedBorder).accessibilityLabel(Text(friday: "变量名称"))
                    SecureField(friday: "变量值", text: $variableValue).textFieldStyle(.roundedBorder)
                    HStack { Spacer(); Button(friday: "添加") {
                        let name = variableName.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !draft.environment.contains(where: { $0.name == name }) else { error = "环境变量名称重复"; return }
                        draft.environment.append(CodexEnvironmentVariable(name: name, value: variableValue, hasValue: false))
                        variableName = ""; variableValue = ""; addingVariable = false
                    }.disabled(variableName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy) }
                }.padding(14)
            }
        }
    }

    @MainActor private func apply(_ value: CodexConnectionState) {
        state = value
        if !dirty {
            if let settings = value.settings { draft = settings; saved = settings }
            else { draft.model = value.model }
        }
    }
    @MainActor private func refresh(force: Bool = false) async {
        busy = true; defer { busy = false }
        do {
            apply(try await store.connection.decode(CodexConnectionState.self, force && owner ? "/api/agents/codex/check" : "/api/agents/codex", method: force && owner ? "POST" : "GET", body: force && owner ? [:] : nil))
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func save() async {
        busy = true; defer { busy = false }
        do {
            let value = try await store.connection.decode(CodexConnectionState.self, "/api/agents/codex/settings", method: "PUT", body: draft.body)
            saved = value.settings; draft = value.settings ?? draft; state = value; error = nil
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func login() async {
        busy = true; defer { busy = false }
        do {
            let response = try await store.connection.decode(CodexLoginResponse.self, "/api/agents/codex/login", method: "POST", body: [:])
            if let url = URL(string: response.url) { openURL(url) }
            apply(try await store.connection.decode(CodexConnectionState.self, "/api/agents/codex")); error = nil
        } catch { self.error = error.localizedDescription }
    }
}
