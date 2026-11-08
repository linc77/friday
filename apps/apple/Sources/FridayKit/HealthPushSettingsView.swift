#if os(macOS)
import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct HealthPushSettingsView: View {
    @Bindable var store: FridayStore
    let onSaved: () async -> Void
    @State private var provider: PushProviderState?
    @State private var keyId = ""
    @State private var teamId = ""
    @State private var topic = ""
    @State private var selectedKey: URL?
    @State private var busy = false
    @State private var error: String?
    private var canSave: Bool { !busy && store.connected && !keyId.isEmpty && !teamId.isEmpty && !topic.isEmpty && (selectedKey != nil || provider?.source == "file") }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(friday: "主机推送配置").font(.headline)
            TextField("Key ID", text: $keyId)
            TextField("Team ID", text: $teamId)
            TextField(friday: "iOS App 的 Bundle Identifier", text: $topic)
            HStack {
                Button(friday: "选择 APNs 密钥…") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
                    panel.allowedContentTypes = [UTType(filenameExtension: "p8") ?? .data]
                    if panel.runModal() == .OK { selectedKey = panel.url }
                }.disabled(busy).fridayInteractiveCursor()
                if let selectedKey { Text(selectedKey.lastPathComponent).font(.caption).foregroundStyle(.secondary) }
                else if provider?.source == "file" { Text(friday: "主机已保存密钥").font(.caption).foregroundStyle(.secondary) }
            }
            Text(friday: "选择 Apple 开发者后台创建的 APNs .p8 密钥，并填写对应的 Key ID、Team ID 和签名 App 的 Bundle Identifier。密钥仅保存到 Friday 主机的私有文件中，不发送给手机或模型。")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(friday: "保存推送配置") { save() }.disabled(!canSave).fridayInteractiveCursor()
                if provider?.source == "file" {
                    Button(friday: "移除推送配置") { remove() }.disabled(busy || !store.connected).fridayInteractiveCursor()
                }
                if busy { ProgressView().controlSize(.small) }
            }
            if provider?.source == "environment" {
                Text(friday: "当前使用服务启动时的推送配置。保存新密钥后使用主机保存的配置；移除后仍会沿用启动配置。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Text(friday: "保存会检查密钥格式；能否向手机推送，需要手机注册通知后实际发送验证。")
                .font(.caption).foregroundStyle(.secondary)
            if let error = error ?? provider?.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
        }
        .task { await load() }
    }
    private func load() async {
        do {
            let value = try await store.connection.decode(PushProviderState.self, "/api/notifications/provider")
            apply(value)
        } catch { self.error = error.localizedDescription }
    }
    private func apply(_ value: PushProviderState) {
        provider = value; keyId = value.keyId ?? ""; teamId = value.teamId ?? ""; topic = value.topic ?? ""
    }
    private func save() {
        busy = true; error = nil
        Task {
            do {
                var body: [String: Any] = ["keyId": keyId.trimmingCharacters(in: .whitespacesAndNewlines), "teamId": teamId.trimmingCharacters(in: .whitespacesAndNewlines), "topic": topic.trimmingCharacters(in: .whitespacesAndNewlines)]
                if let selectedKey {
                    let data = try Data(contentsOf: selectedKey)
                    guard data.count <= 16384, let privateKey = String(data: data, encoding: .utf8) else { throw ConnectionError.message("请选择有效的 APNs .p8 密钥") }
                    body["privateKey"] = privateKey
                }
                apply(try await store.connection.decode(PushProviderState.self, "/api/notifications/provider", method: "PUT", body: body))
                selectedKey = nil; await onSaved()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
    private func remove() {
        busy = true; error = nil
        Task {
            do {
                apply(try await store.connection.decode(PushProviderState.self, "/api/notifications/provider", method: "DELETE"))
                selectedKey = nil; await onSaved()
            } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}
#endif
