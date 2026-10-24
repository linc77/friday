import SwiftUI

struct ProviderInstanceEditor: View {
    @ObservedObject var store: FridayStore
    var instance: ProviderInstanceInfo? = nil
    var saved: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var id = ""
    @State private var driver = "codex"
    @State private var name = ""
    @State private var color = ""
    @State private var enabled = true
    @State private var busy = false
    @State private var error: String?
    private var valid: Bool {
        id.range(of: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$", options: .regularExpression) != nil &&
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 &&
        (color.isEmpty || color.range(of: "^#[a-fA-F0-9]{6}$", options: .regularExpression) != nil)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(friday: instance == nil ? "添加实例" : "实例设置").font(.headline)
            TextField(friday: "实例 ID", text: $id).disabled(instance != nil)
            Picker("Provider", selection: $driver) {
                ForEach(TaskProviderCatalog.order, id: \.self) { Text(TaskProviderCatalog.name($0)).tag($0) }
            }.disabled(instance != nil).fridayInteractiveCursor()
            TextField(friday: "显示名称", text: $name)
            TextField(friday: "标识颜色（#RRGGBB，可选）", text: $color)
            Toggle(isOn: $enabled) { Text(friday: "启用实例") }.fridayInteractiveCursor()
            Text(friday: "每个实例独立保存工具配置。工具原生账号由其配置目录或环境变量决定。")
                .font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                if let instance, instance.id != instance.driver {
                    Button(friday: "移除实例", role: .destructive) { Task { await submit(remove: true) } }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(busy)
                }
                Spacer()
                Button(friday: "取消") { dismiss() }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy)
                Button(friday: "保存") { Task { await submit() } }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(busy || !valid)
            }
        }.textFieldStyle(.roundedBorder).padding(24)
        #if os(macOS)
        .frame(width: 440)
        #endif
        .task {
            if let instance { id = instance.id; driver = instance.driver; name = instance.name; color = instance.accentColor ?? ""; enabled = instance.enabled }
        }
    }
    @MainActor private func submit(remove: Bool = false) async {
        let account = store.connectionIdentity; busy = true; defer { busy = false }
        var body: [String: Any] = ["operation": remove ? "remove" : instance == nil ? "create" : "upsert", "instanceId": id]
        if !remove {
            var config: [String: Any] = ["driver": driver, "displayName": name, "enabled": enabled]
            if !color.isEmpty { config["accentColor"] = color }
            body["instance"] = config
        }
        do {
            _ = try await store.connection.decode(ProviderInstancesResponse.self, "/api/provider-instances", method: "PUT", body: body)
            guard store.connectionIdentity == account else { return }
            await store.loadProviderInstances()
            guard store.connectionIdentity == account else { return }
            saved(remove ? "friday" : id); dismiss()
        } catch { if store.connectionIdentity == account { self.error = error.localizedDescription } }
    }
}

extension ProviderInstanceInfo {
    var accent: Color? {
        guard let value = accentColor, value.count == 7, value.first == "#", let rgb = UInt32(value.dropFirst(), radix: 16) else { return nil }
        return Color(red: Double((rgb >> 16) & 255) / 255, green: Double((rgb >> 8) & 255) / 255, blue: Double(rgb & 255) / 255)
    }
}
