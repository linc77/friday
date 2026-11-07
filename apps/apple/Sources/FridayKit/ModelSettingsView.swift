import SwiftUI

struct ModelSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var state: ModelConnectionState?
    @State private var name = "DeepSeek"
    @State private var baseUrl = "https://api.deepseek.com"
    @State private var apiKey = ""
    @State private var models: [APIModel] = []
    @State private var selectedModel = ""
    @State private var search = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?

    private var editable: Bool { store.deviceId == "owner" && store.connected && state != nil && !busy }
    private var filteredModels: [APIModel] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return query.isEmpty ? models : models.filter { $0.id.localizedCaseInsensitiveContains(query) || $0.name.localizedCaseInsensitiveContains(query) }
    }
    private var draft: [String: String] { ["name": name, "baseUrl": baseUrl, "apiKey": apiKey, "model": selectedModel] }

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 6) {
                FridaySymbolLabel("Friday", systemImage: "sparkles")
                    .font(.system(size: 14, weight: .medium)).fridaySymbolFeedback()
                Text(friday: "主会话 · API").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            SettingsGroup("当前连接") {
                SettingsRow(verbatim: state?.provider ?? "Friday", detail: "用于对话、记忆和日常任务。") {
                    if let state {
                        FridaySymbolLabel(friday: state.connected ? "已配置" : "未配置", systemImage: state.connected ? "checkmark.circle" : "key")
                            .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize()
                            .fridaySymbolFeedback(value: state.connected)
                    } else {
                        Text(fridayString: store.connected ? "正在读取…" : "等待主机连接")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
                if let state {
                    SettingsDivider()
                    SettingsRow("当前模型") {
                        Text(state.model).font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }
            }
            if state != nil, store.deviceId == "owner" {
                providerFields
                modelSelection
                SettingsGroup("保存连接") {
                    SettingsRow("验证并保存", detail: "测试所选模型后启用，会产生少量 API 用量。") {
                        Button(friday: "验证并保存") { save() }
                            .buttonStyle(FridayButtonStyle(compact: true))
                            .disabled(!editable || selectedModel.isEmpty || !models.contains { $0.id == selectedModel })
                    }
                    if state?.connected == true {
                        SettingsDivider()
                        SettingsRow("移除密钥", detail: "保留供应商和模型设置，停止使用此连接。") {
                            Button(friday: "移除 API Key", role: .destructive) { removeKey() }
                                .buttonStyle(FridayButtonStyle(compact: true)).disabled(!editable)
                        }
                    }
                }
            } else if state != nil {
                Text(friday: "请在主机上配置模型供应商，所有已连接设备会共用 Friday。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if busy { Text(friday: "正在连接供应商…").font(.caption).foregroundStyle(.secondary) }
            if let notice { Text(fridayString: notice).font(.caption).foregroundStyle(.secondary) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .task(id: store.connected) { if store.connected { await refresh() } }
        .onDisappear { apiKey = "" }
    }

    private var providerFields: some View {
        SettingsGroup("模型供应商") {
            SettingsRow("名称") {
                TextField(friday: "供应商名称", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 280)
            }
            SettingsDivider()
            SettingsRow("Base URL", detail: "支持 OpenAI 兼容接口，填写 API 根地址（包含 /v1 等路径）。") {
                TextField("https://api.example.com/v1", text: Binding(get: { baseUrl }, set: { baseUrl = $0; invalidateModels() }))
                    .textFieldStyle(.roundedBorder).frame(maxWidth: 280).accessibilityLabel("Base URL")
            }
            SettingsDivider()
            SettingsRow("API Key", detail: "密钥仅保存在主机上。同一 URL 留空可沿用已保存密钥。") {
                SecureField(friday: state?.connected == true ? "留空沿用，输入新密钥以替换" : "输入 API Key", text: Binding(get: { apiKey }, set: { apiKey = $0; invalidateModels() }))
                    .textFieldStyle(.roundedBorder).accessibilityLabel("API Key").frame(maxWidth: 280)
            }
            SettingsDivider()
            SettingsRow("获取模型", detail: "读取供应商返回的模型列表，选择后再保存。") {
                Button(friday: "获取模型列表") { discover() }
                    .buttonStyle(FridayButtonStyle(compact: true))
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.disabled(!editable)
    }

    private var modelSelection: some View {
        SettingsGroup("选择模型") {
            if models.isEmpty {
                Text(friday: "填写 URL 和 Key，然后获取模型列表。")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(16)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    TextField(friday: "搜索模型名称或 ID", text: $search).textFieldStyle(.roundedBorder)
                    Text(friday: "\(models.count) 个模型").font(.caption).foregroundStyle(.secondary)
                    Text(friday: "请选择支持工具调用的对话模型。").font(.caption).foregroundStyle(.secondary)
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(filteredModels) { model in
                                Button { selectedModel = model.id; notice = nil } label: {
                                    HStack(spacing: 10) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(model.name).font(.system(size: 12, weight: .medium))
                                            if model.name != model.id { Text(model.id).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary) }
                                        }.frame(maxWidth: .infinity, alignment: .leading)
                                        if selectedModel == model.id { FridaySymbolImage(systemName: "checkmark").font(.system(size: 12)) }
                                    }.padding(10).contentShape(Rectangle())
                                }
                                .buttonStyle(FridaySymbolButtonStyle())
                                .background(selectedModel == model.id ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 6))
                                .accessibilityAddTraits(selectedModel == model.id ? .isSelected : [])
                            }
                        }
                    }.frame(height: min(220, CGFloat(filteredModels.count) * 52 + 8))
                    if filteredModels.isEmpty { Text(friday: "没有匹配的模型").font(.caption).foregroundStyle(.secondary) }
                    if !selectedModel.isEmpty { Text(selectedModel).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled) }
                }.padding(14)
            }
        }.disabled(!editable)
    }

    private func invalidateModels() { models = []; selectedModel = ""; search = ""; notice = nil }
    private func apply(_ value: ModelConnectionState) {
        state = value; name = value.provider
        baseUrl = value.baseUrl ?? "https://api.deepseek.com"
        models = value.models ?? []; selectedModel = value.model; search = ""; apiKey = ""
    }
    private func discover() {
        let identity = store.connectionIdentity, body = draft
        busy = true; error = nil; notice = nil
        Task {
            defer { if identity == store.connectionIdentity { busy = false } }
            do {
                let value = try await store.connection.decode(ModelDiscoveryState.self, "/api/model/models", method: "POST", body: body, timeout: 45)
                guard identity == store.connectionIdentity else { return }
                models = value.models; search = ""
                if !models.contains(where: { $0.id == selectedModel }) { selectedModel = models.first?.id ?? "" }
                notice = "已获取模型列表，选择模型后验证并保存。"
            } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
    private func save() {
        let identity = store.connectionIdentity, body = draft
        busy = true; error = nil; notice = nil
        Task {
            defer { if identity == store.connectionIdentity { busy = false } }
            do {
                let value = try await store.connection.decode(ModelConnectionState.self, "/api/model/settings", method: "PUT", body: body, timeout: 45)
                guard identity == store.connectionIdentity else { return }
                apply(value); notice = "模型连接已保存。"
            } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
    private func removeKey() {
        let identity = store.connectionIdentity
        busy = true; error = nil; notice = nil
        Task {
            defer { if identity == store.connectionIdentity { busy = false } }
            do {
                _ = try await store.connection.data("/api/model/key", method: "DELETE")
                guard identity == store.connectionIdentity else { return }
                await refresh()
            } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
    private func refresh() async {
        let identity = store.connectionIdentity
        do {
            let value = try await store.connection.decode(ModelConnectionState.self, "/api/model")
            guard identity == store.connectionIdentity, !Task.isCancelled else { return }
            apply(value); error = nil
        } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
    }
}
