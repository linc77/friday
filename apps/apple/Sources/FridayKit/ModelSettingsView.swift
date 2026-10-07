import SwiftUI

struct ModelSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var state: ModelConnectionState?
    @State private var apiKey = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 32) {
            VStack(alignment: .leading, spacing: 6) {
                FridaySymbolLabel("Friday", systemImage: "sparkles")
                    .font(.system(size: 14, weight: .medium)).fridaySymbolFeedback()
                Text(friday: "主会话 · API")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            SettingsGroup("模型") {
                SettingsRow("DeepSeek", detail: "用于对话、记忆和日常任务。") {
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
            if let state, store.deviceId == "owner" {
                SettingsGroup("访问密钥") {
                    SettingsRow("API Key", detail: "密钥仅保存在主机上。") {
                        SecureField(friday: state.connected ? "输入新密钥以替换" : "DeepSeek API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder).accessibilityLabel("DeepSeek API Key")
                            .frame(maxWidth: 250).disabled(busy || !store.connected)
                    }
                    SettingsDivider()
                    SettingsRow("验证并保存", detail: "保存前发送一次简短测试请求，会产生少量 API 用量。") {
                        Button(friday: busy ? "正在验证…" : "验证并保存") {
                            busy = true; error = nil
                            Task {
                                do {
                                    self.state = try await store.connection.decode(ModelConnectionState.self, "/api/model/key", method: "PUT", body: ["apiKey": apiKey])
                                    apiKey = ""
                                } catch { self.error = error.localizedDescription }
                                busy = false
                            }
                        }.disabled(busy || !store.connected || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if state.connected {
                        SettingsDivider()
                        SettingsRow("移除密钥", detail: "移除后，需要重新配置才能使用模型。") {
                            Button(friday: "移除 API Key", role: .destructive) {
                                busy = true; error = nil
                                Task {
                                    do { _ = try await store.connection.data("/api/model/key", method: "DELETE"); apiKey = ""; await refresh() }
                                    catch { self.error = error.localizedDescription }
                                    busy = false
                                }
                            }.disabled(busy || !store.connected)
                        }
                    }
                }
                Link(destination: URL(string: "https://platform.deepseek.com/api_keys")!) {
                    FridaySymbolLabel(friday: "获取 DeepSeek API Key", systemImage: "arrow.up.right")
                        .font(.system(size: 12))
                        .fridaySymbolFeedback()
                }
            } else if state != nil {
                Text(friday: "请在主机上配置 DeepSeek API Key，所有已连接设备会共用 Friday。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
        }.task(id: store.connected) { if store.connected { await refresh() } }
        .onDisappear { apiKey = "" }
    }
    private func refresh() async {
        do { state = try await store.connection.decode(ModelConnectionState.self, "/api/model"); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
