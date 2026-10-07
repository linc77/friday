import SwiftUI
#if os(macOS)
import AppKit
#endif

struct CodexSettingsView: View {
    @ObservedObject var store: FridayStore
    var provider = "codex"
    @ObservedObject private var modelPreferences = ProviderModelPreferences.shared
    @Environment(\.openURL) private var openURL
    @State private var state: CodexConnectionState?
    @State private var draft = CodexProviderSettings()
    @State private var saved: CodexProviderSettings?
    @State private var busy = false
    @State private var error: String?
    @State private var variableName = ""
    @State private var variableValue = ""
    @State private var addingVariable = false
    @State private var addingModel = false
    @State private var customModelID = ""
    @State private var customModelName = ""
    private var providerName: String { provider == "claude" ? "Claude" : "Codex" }
    private var endpoint: String { "/api/agents/\(provider)" }
    private var preferences: ModelPickerPreferences { modelPreferences.get(server: store.connection.server, provider: provider) }
    private var models: [CodexProviderModel] {
        let discovered = (state?.models ?? []).filter { $0.isCustom != true }
        let ids = Set(discovered.map(\.id))
        let custom = owner ? draft.customModels : (state?.models ?? []).filter { $0.isCustom == true }.map { CustomProviderModel(id: $0.id, name: $0.name) }
        return discovered + custom.filter { !ids.contains($0.id) }.map {
            CodexProviderModel(id: $0.id, name: $0.name, description: "", isDefault: false, reasoningEfforts: [], defaultReasoningEffort: "", isCustom: true)
        }
    }
    private var displayModels: [CodexProviderModel] { preferences.sorted(models) }
    private var owner: Bool { store.deviceId == "owner" }
    private var dirty: Bool { saved != nil && draft != saved }
    private var accountLabel: String {
        guard let state else { return store.connected ? "正在读取…" : "等待主机连接" }
        if !state.enabled { return "已停用" }
        if !state.connected { return state.installed ? "未登录" : "不可用" }
        if state.account?.type == "chatgpt" { return "ChatGPT · \(state.account?.plan?.capitalized ?? "已登录")" }
        if state.account?.type == "apiKey" { return "API Key" }
        if provider == "claude", let plan = state.account?.plan { return "Claude · \(plan)" }
        return "已连接"
    }
    private var selectedModel: CodexProviderModel? {
        models.first { $0.id == (draft.model.isEmpty ? state?.model : draft.model) }
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
                }.buttonStyle(FridayButtonStyle(compact: true)).controlSize(.small).disabled(busy || !store.connected)
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
                    FridaySymbolLabel(providerName, systemImage: "cpu").font(.system(size: 14, weight: .medium))
                        .fridaySymbolFeedback(value: state?.connected)
                    Text(fridayString: accountLabel).font(.system(size: 12)).foregroundStyle(.secondary)
                }
                Spacer()
                if let version = state?.version { Text("v\(version)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.tertiary) }
                if owner {
                    Toggle(isOn: $draft.enabled) { Text(providerName) }.labelsHidden().toggleStyle(.switch).controlSize(.mini)
                        .disabled(busy || !store.connected)
                }
            }
            SettingsGroup("账号") {
                SettingsRow("显示名称", detail: state?.account?.email ?? accountLabel) {
                    TextField(providerName, text: $draft.displayName).textFieldStyle(.roundedBorder).frame(maxWidth: 210)
                        .disabled(!owner || busy)
                }
                if owner && state?.connected != true && provider == "codex" {
                    SettingsDivider()
                    SettingsRow("连接账号", detail: "使用 Codex 登录，或读取配置目录中已有的账号。") {
                        Button(friday: state?.loginPending == true ? "等待浏览器登录…" : "登录 ChatGPT") { Task { await login() } }
                            .disabled(busy || dirty || !store.connected || state?.loginPending == true)
                    }
                }
            }
            if provider == "claude" {
                Text(friday: "在任务输入框中选择 Claude 模型，即可执行任务或继续会话。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                if owner && state?.connected != true {
                    Text(friday: "在主机运行 claude auth login，或添加 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 后重新检测。")
                        .font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if owner {
                SettingsGroup("运行配置") {
                    runtimeField("可执行文件", detail: "当前服务使用的本地程序。", placeholder: provider, value: $draft.binaryPath)
                    SettingsDivider()
                    runtimeField(provider == "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR", detail: "读取已有的账号、模型和网关配置。", placeholder: provider == "codex" ? "~/.codex" : "~/.claude", value: $draft.homePath)
                    if provider == "codex" {
                        SettingsDivider()
                        runtimeField("独立账号目录", detail: "单独保存账号凭据，共享 CODEX_HOME 中的配置和会话。", placeholder: "可选", value: $draft.shadowHomePath)
                    }
                    SettingsDivider()
                    runtimeField("启动参数", detail: provider == "codex" ? "传给 Codex app-server 的额外参数。" : "支持 --model、--effort 和 --setting-sources。", placeholder: "可选", value: $draft.launchArgs)
                }
                environment
            }
            if owner {
                SettingsGroup("权限") {
                    SettingsRow("权限模式", detail: "新任务和续聊使用此设置；正在执行的任务不受影响。") {
                        Picker(selection: $draft.permissionMode) {
                            Text("Auto").tag("auto")
                            Text(friday: "手动确认").tag("default")
                            if provider == "claude" {
                                Text(friday: "自动接受编辑").tag("acceptEdits")
                                Text(friday: "规划模式").tag("plan")
                            }
                        } label: { Text(friday: "权限模式") }
                            .labelsHidden().frame(maxWidth: 210).disabled(busy)
                    }
                    SettingsDivider()
                    Text(friday: "Auto 使用工具自带的自动审批；需要补充信息时仍会询问。")
                        .font(.system(size: 12)).foregroundStyle(.secondary).padding(14)
                }
            }
            SettingsGroup("模型") {
                SettingsRow("默认模型", detail: "保存在当前主机。") {
                    Picker(selection: Binding(get: { draft.model }, set: { draft.model = $0; draft.reasoningEffort = "" })) {
                        Text(friday: "工具默认").tag("")
                        ForEach(preferences.sorted(models, includeHidden: false)) { model in Text(model.selectionName).tag(model.id) }
                        if !draft.model.isEmpty && !(preferences.sorted(models, includeHidden: false).contains { $0.id == draft.model }) { Text(selectedModel?.selectionName ?? draft.model).tag(draft.model) }
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
            modelCatalog
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
                Text(friday: "运行配置由主机管理，收藏、显示和排序保存在此设备。").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var modelCatalog: some View {
        SettingsGroup("模型列表") {
            SettingsRow("模型管理", detail: "收藏、显示和排序保存在此设备，自定义模型保存在主机。") {
                if owner {
                    Button { addingModel.toggle() } label: { FridaySymbolLabel(friday: "添加模型", systemImage: "plus") }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected)
                }
            }
            if !models.isEmpty {
                SettingsDivider()
                HStack {
                    Text(friday: "\(displayModels.count) 个模型").font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    Button(friday: models.allSatisfy { preferences.hidden.contains($0.id) } ? "全部显示" : "全部隐藏") {
                        updatePreferences { value in
                            if models.allSatisfy({ value.hidden.contains($0.id) }) { value.hidden.removeAll { id in models.contains { $0.id == id } } }
                            else { value.hidden = Array(Set(value.hidden + models.map(\.id))) }
                        }
                    }.buttonStyle(FridayButtonStyle(compact: true))
                }.padding(14)
            }
            ForEach(Array(displayModels.enumerated()), id: \.element.id) { index, model in
                SettingsDivider()
                modelRow(model, index: index)
            }
            if models.isEmpty {
                SettingsDivider()
                Text(friday: "尚未获取到模型，请连接账号后重新检测。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(14)
            }
            if addingModel {
                SettingsDivider()
                VStack(alignment: .leading, spacing: 10) {
                    TextField(friday: "模型 ID", text: $customModelID).textFieldStyle(.roundedBorder)
                    TextField(friday: "显示名称（可选）", text: $customModelName).textFieldStyle(.roundedBorder)
                    Text(friday: "自定义 ID 需要当前账号或网关支持；添加不会验证可用性。")
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    HStack {
                        Spacer()
                        Button(friday: "添加") {
                            let id = customModelID.trimmingCharacters(in: .whitespacesAndNewlines)
                            guard !models.contains(where: { $0.id == id }) else { error = "模型 ID 已存在"; return }
                            guard id.count <= 160 && !id.contains(where: \.isWhitespace) else { error = "模型 ID 无效"; return }
                            let name = customModelName.trimmingCharacters(in: .whitespacesAndNewlines)
                            draft.customModels.append(CustomProviderModel(id: id, name: name.isEmpty ? id : name))
                            customModelID = ""; customModelName = ""; addingModel = false
                        }.disabled(customModelID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                    }
                }.padding(14)
            }
        }
    }

    private func modelRow(_ model: CodexProviderModel, index: Int) -> some View {
        HStack(spacing: 10) {
            Button {
                updatePreferences { value in
                    if value.favorites.contains(model.id) { value.favorites.removeAll { $0 == model.id } }
                    else { value.favorites.append(model.id) }
                }
            } label: {
                FridaySymbolImage(systemName: preferences.favorites.contains(model.id) ? "star.fill" : "star")
                    .foregroundStyle(preferences.favorites.contains(model.id) ? Color.orange : Color.secondary)
            }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: preferences.favorites.contains(model.id) ? "取消收藏" : "收藏模型"))
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(model.name).font(.system(size: 12)).lineLimit(2)
                    if model.isCustom == true { Text(friday: "自定义").font(.system(size: 10)).foregroundStyle(.secondary) }
                }
                Text(model.id).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(1)
                if let resolved = model.resolvedModel, resolved != model.id && resolved != model.name {
                    Text(resolved).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if !model.reasoningEfforts.isEmpty {
                Text(friday: "推理").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            Button { moveModel(model.id, by: -1) } label: { FridaySymbolImage(systemName: "arrow.up") }
                .buttonStyle(FridaySymbolButtonStyle()).disabled(index == 0 || preferences.favorites.contains(displayModels[index - 1].id) != preferences.favorites.contains(model.id))
                .accessibilityLabel(Text(friday: "上移模型"))
            Button { moveModel(model.id, by: 1) } label: { FridaySymbolImage(systemName: "arrow.down") }
                .buttonStyle(FridaySymbolButtonStyle()).disabled(index == displayModels.count - 1 || preferences.favorites.contains(displayModels[index + 1].id) != preferences.favorites.contains(model.id))
                .accessibilityLabel(Text(friday: "下移模型"))
            if owner && model.isCustom == true {
                Button {
                    draft.customModels.removeAll { $0.id == model.id }
                    if draft.model == model.id { draft.model = ""; draft.reasoningEffort = "" }
                } label: { FridaySymbolImage(systemName: "minus.circle") }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(busy).accessibilityLabel(Text(friday: "移除模型"))
            }
            Toggle(isOn: Binding(get: { !preferences.hidden.contains(model.id) }, set: { visible in
                updatePreferences { value in
                    value.hidden.removeAll { $0 == model.id }
                    if !visible { value.hidden.append(model.id) }
                }
            })) { Text(friday: "显示模型") }.labelsHidden().toggleStyle(.switch).controlSize(.mini)
                .accessibilityLabel(Text(friday: "显示模型") + Text(" " + model.name))
        }.padding(14)
    }

    private func updatePreferences(_ change: (inout ModelPickerPreferences) -> Void) {
        modelPreferences.update(server: store.connection.server, provider: provider, change)
    }
    private func moveModel(_ id: String, by offset: Int) {
        var ids = displayModels.map(\.id)
        guard let index = ids.firstIndex(of: id), ids.indices.contains(index + offset) else { return }
        ids.swapAt(index, index + offset)
        updatePreferences { $0.order = ids }
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
                    FridaySymbolLabel(friday: "添加变量", systemImage: "plus")
                }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy)
            }
            ForEach(draft.environment.indices, id: \.self) { index in
                SettingsDivider()
                HStack(spacing: 10) {
                    Text(draft.environment[index].name).font(.system(size: 11, design: .monospaced)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    SecureField(friday: "已保存，输入以替换", text: Binding(get: { draft.environment[index].value ?? "" }, set: { draft.environment[index].value = $0 }))
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 190).disabled(busy)
                    Button { draft.environment.remove(at: index) } label: { FridaySymbolImage(systemName: "minus.circle") }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(busy).accessibilityLabel(Text(friday: "移除变量"))
                }.padding(14)
            }
            if addingVariable {
                SettingsDivider()
                VStack(alignment: .leading, spacing: 10) {
                    TextField(provider == "codex" ? "OPENAI_BASE_URL" : "ANTHROPIC_API_KEY", text: $variableName).textFieldStyle(.roundedBorder).accessibilityLabel(Text(friday: "变量名称"))
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
            apply(try await store.connection.decode(CodexConnectionState.self, force && owner ? endpoint + "/check" : endpoint, method: force && owner ? "POST" : "GET", body: force && owner ? [:] : nil))
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    @MainActor private func save() async {
        busy = true; defer { busy = false }
        do {
            let value = try await store.connection.decode(CodexConnectionState.self, endpoint + "/settings", method: "PUT", body: draft.body)
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
