import SwiftUI

private struct UsageSourceSettings: Decodable {
    struct Source: Decodable, Identifiable { let id: String; let kind: String; var label: String? = nil; let url: String; let enabled: Bool; let hasManagementKey: Bool }
    let version: Int; let sources: [Source]
}
struct UsageSourceSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var settings: UsageSourceSettings?
    @State private var selection: String?
    @State private var editing = false
    @State private var label = ""
    @State private var url = ""
    @State private var managementKey = ""
    @State private var enabled = true
    @State private var clearKey = false
    @State private var busy = false
    @State private var failure: String?
    @State private var deletion: UsageSourceSettings.Source?
    @State private var operation = UUID()
    private var owner: Bool { store.deviceId == "owner" }
    private var selected: UsageSourceSettings.Source? { settings?.sources.first(where: { $0.id == selection }) }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text(friday: "额度来源").font(.headline)
                Text(friday: "连接 CLIProxy，查看多个账号的共享额度。").font(.caption).foregroundStyle(.secondary)
            }
            if !owner { Text(friday: "请在主机管理额度来源。").foregroundStyle(.secondary) }
            else {
                if let settings {
                    ForEach(settings.sources) { source in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 3) { Text(verbatim: source.label ?? source.url); Text(verbatim: source.url).font(.caption).foregroundStyle(.secondary); Text(fridayString: source.enabled ? "已启用" : "已停用").font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            Button { edit(source) } label: { Text(friday: "编辑") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy)
                            Button { deletion = source } label: { FridaySymbolImage(systemName: "trash").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).disabled(busy).accessibilityLabel(Text(friday: "移除额度来源"))
                        }
                    }
                    if !editing { Button { edit(nil) } label: { FridaySymbolLabel(friday: "添加额度来源", systemImage: "plus") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                }
                if editing { editor }
                if let failure { Text(fridayString: failure).font(.caption).foregroundStyle(.orange) }
                HStack { Button { Task { await load() } } label: { FridaySymbolLabel(friday: "重新加载", systemImage: "arrow.clockwise") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected); if busy { Text(friday: "正在处理…").font(.caption).foregroundStyle(.secondary) } }
            }
        }
        .task(id: store.connectionIdentity) { operation = UUID(); settings = nil; editing = false; label = ""; url = ""; managementKey = ""; failure = nil; busy = false; if owner { await load() } }
        .confirmationDialog(Text(friday: "移除额度来源？"), isPresented: Binding(get: { deletion != nil }, set: { if !$0 { deletion = nil } }), titleVisibility: .visible) {
            if let source = deletion { Button(role: .destructive) { deletion = nil; Task { await remove(source) } } label: { Text(friday: "移除额度来源") } }
            Button(role: .cancel) { deletion = nil } label: { Text(friday: "取消") }
        }
    }
    private var editor: some View {
        SettingsGroup("CLIProxy") {
            SettingsRow("名称") { TextField(friday: "可选", text: $label).textFieldStyle(.roundedBorder).frame(maxWidth: 320) }
            SettingsDivider()
            SettingsRow("地址") { TextField("https://", text: $url).textFieldStyle(.roundedBorder).frame(maxWidth: 320) }
            SettingsDivider()
            SettingsRow("管理密钥", detail: selected?.hasManagementKey == true ? "已保存密钥，留空保留。" : nil) { SecureField(friday: "管理密钥", text: $managementKey).textFieldStyle(.roundedBorder).frame(maxWidth: 320) }
            if selected?.hasManagementKey == true { SettingsDivider(); SettingsRow("清除已保存密钥") { Toggle("", isOn: $clearKey).labelsHidden().fridayInteractiveCursor() } }
            SettingsDivider()
            SettingsRow("启用") { Toggle("", isOn: $enabled).labelsHidden().fridayInteractiveCursor() }
            SettingsDivider()
            HStack { Spacer(); Button { editing = false; managementKey = "" } label: { Text(friday: "取消") }.buttonStyle(FridayButtonStyle(compact: true)); Button { Task { await save() } } label: { Text(friday: "保存") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }.padding(12)
        }.disabled(busy || !store.connected)
    }
    private func edit(_ source: UsageSourceSettings.Source?) { selection = source?.id; label = source?.label ?? ""; url = source?.url ?? ""; managementKey = ""; enabled = source?.enabled ?? true; clearKey = false; failure = nil; editing = true }
    private func load() async {
        guard !busy, owner, store.connected else { return }; let token = UUID(), identity = store.connectionIdentity, connection = store.connection; operation = token; busy = true; failure = nil
        defer { if operation == token { busy = false } }
        do { let value = try await connection.decode(UsageSourceSettings.self, "/api/usage-limit-sources/settings"); if operation == token, identity == store.connectionIdentity, !Task.isCancelled { settings = value } }
        catch { if operation == token, identity == store.connectionIdentity, !Task.isCancelled { failure = error.localizedDescription } }
    }
    private func save() async {
        guard let settings else { return }
        var source: [String: Any] = ["kind": "cliproxy", "url": url, "label": label, "enabled": enabled]
        if clearKey { source["managementKey"] = "" } else if !managementKey.isEmpty { source["managementKey"] = managementKey }
        await write(["version": settings.version, "id": selection ?? UUID().uuidString, "source": source])
    }
    private func remove(_ source: UsageSourceSettings.Source) async { guard let settings else { return }; await write(["version": settings.version, "id": source.id, "remove": true]) }
    private func write(_ body: [String: Any]) async {
        guard !busy, owner, store.connected else { return }; let token = UUID(), identity = store.connectionIdentity, connection = store.connection; operation = token; busy = true; failure = nil
        defer { if operation == token { busy = false } }
        do {
            let value = try await connection.decode(UsageSourceSettings.self, "/api/usage-limit-sources/settings", method: "POST", body: body)
            guard operation == token, identity == store.connectionIdentity else { return }
            settings = value; editing = false; managementKey = ""; await store.refresh()
        } catch { if operation == token, identity == store.connectionIdentity { failure = error.localizedDescription } }
    }
}
