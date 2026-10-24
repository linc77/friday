import SwiftUI

struct ProvidersView: View {
    @ObservedObject var store: FridayStore
    @State private var selection = "friday"
    @State private var editingInstance: ProviderInstanceInfo?
    @State private var addingInstance = false

    var body: some View {
        SettingsPage(title: "Providers", subtitle: "Friday 通过 API 处理主会话，本地 Agent 用于任务执行。", contentWidth: 1020) {
            #if os(macOS)
            HStack(alignment: .top, spacing: 0) {
                providerList.frame(width: 190)
                Divider()
                details.padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: 500, alignment: .top)
            .background(FridayTheme.surface)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.primary.opacity(0.075)))
            #else
            Picker("Provider", selection: $selection) {
                Text("Friday").tag("friday")
                ForEach(store.providerInstances) { instance in Text(instance.name).tag(instance.id) }
                ForEach(store.agents.filter { !TaskProviderCatalog.order.contains($0.id) }) { agent in Text(agent.name).tag(agent.id) }
                if store.usageLimitSourcesSupported { Text(friday: "额度来源").tag("usage-sources") }
            }.pickerStyle(.menu)
            details
            #endif
        }
        .task(id: store.connectionIdentity + ":" + String(store.connected) + ":" + store.providerConfigurationVersions.sorted(by: { $0.key < $1.key }).map { $0.key + String($0.value) }.joined()) { if store.connected { await store.loadProviderInstances() } }
        .onChange(of: store.connectionIdentity) { _, _ in selection = "friday"; editingInstance = nil; addingInstance = false }
        .sheet(isPresented: $addingInstance) { ProviderInstanceEditor(store: store) { selection = $0 } }
        .sheet(item: $editingInstance) { instance in ProviderInstanceEditor(store: store, instance: instance) { selection = $0 } }
    }

    private var providerList: some View {
        VStack(alignment: .leading, spacing: 4) {
            providerRow(id: "friday", name: "Friday", icon: "sparkles", detail: "主会话 · API")
            ForEach(store.providerInstances) { instance in
                providerRow(id: instance.id, name: instance.name, icon: "terminal", detail: TaskProviderCatalog.name(instance.driver), status: instance.enabled ? nil : "已停用")
            }
            ForEach(store.agents.filter { !TaskProviderCatalog.order.contains($0.id) }) { agent in
                providerRow(id: agent.id, name: agent.name, icon: "terminal", detail: "任务 · 本地", status: agent.installed ? "尚未接入" : "未安装")
            }
            if store.usageLimitSourcesSupported { providerRow(id: "usage-sources", name: "额度来源", icon: "server.rack", detail: "共享账号配额") }
            if store.deviceId == "owner" {
                Button(friday: "添加实例", systemImage: "plus") { addingInstance = true }
                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected).padding(10)
            }
        }.padding(10)
    }

    private func providerRow(id: String, name: String, icon: String, detail: String, status: String? = nil) -> some View {
        Button { selection = id } label: {
            HStack(alignment: .top, spacing: 10) {
                FridaySymbolImage(systemName: icon).font(.system(size: 16)).frame(width: 20)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        if let color = store.providerInstances.first(where: { $0.id == id })?.accent { Circle().fill(color).frame(width: 6, height: 6).accessibilityHidden(true) }
                        Text(fridayString: name).font(.system(size: 13, weight: .medium))
                    }
                    Text(fridayString: detail).font(.system(size: 11)).foregroundStyle(.secondary)
                    if let status { Text(fridayString: status).font(.system(size: 11)).foregroundStyle(.tertiary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12).contentShape(Rectangle())
        }
        .buttonStyle(ProviderRowStyle(selected: selection == id))
        .accessibilityAddTraits(selection == id ? .isSelected : [])
    }

    @ViewBuilder private var details: some View {
        if selection == "friday" { ModelSettingsView(store: store) }
        else if selection == "usage-sources" { UsageSourceSettingsView(store: store) }
        else if let instance = store.providerInstances.first(where: { $0.id == selection }) {
            VStack(alignment: .leading, spacing: 14) {
                if store.deviceId == "owner" {
                    HStack {
                        Text(instance.name).font(.headline)
                        Spacer()
                        Button(friday: "实例设置") { editingInstance = instance }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }
                CodexSettingsView(store: store, provider: instance.driver, instanceId: instance.id).id(store.connectionIdentity + ":" + instance.id)
            }
        } else if let agent = store.agents.first(where: { $0.id == selection }) { localAgentDetails(agent) }
    }

    private func localAgentDetails(_ agent: AgentInfo) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 6) {
                FridaySymbolLabel(agent.name, systemImage: "terminal").font(.system(size: 14, weight: .medium))
                    .fridaySymbolFeedback(value: agent.installed)
                Text(friday: "任务 · 本地").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            SettingsGroup("本地连接") {
                SettingsRow("安装状态", detail: agent.description) {
                    Text(fridayString: agent.installed ? "尚未接入" : "未安装")
                        .font(.system(size: 12)).foregroundStyle(.secondary)
                }
                if let executable = agent.executable {
                    SettingsDivider()
                    SettingsRow("可执行文件") {
                        Text(executable).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                            .textSelection(.enabled).lineLimit(2).truncationMode(.middle)
                    }
                }
            }
            SettingsGroup("工具检测") {
                SettingsRow("重新检测", detail: "更新本机工具的安装状态。") {
                    Button { Task { await store.refresh() } } label: {
                        FridaySymbolLabel(friday: "重新检测", systemImage: "arrow.clockwise")
                    }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected)
                }
            }
        }
    }
}

private struct ProviderRowStyle: ButtonStyle {
    let selected: Bool
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.foregroundStyle(.primary)
            .background(.primary.opacity(selected ? 0.055 : configuration.isPressed ? 0.03 : 0),
                        in: RoundedRectangle(cornerRadius: 9))
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
    }
}
