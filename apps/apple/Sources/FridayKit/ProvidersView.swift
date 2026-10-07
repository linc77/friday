import SwiftUI

struct ProvidersView: View {
    @ObservedObject var store: FridayStore
    @State private var selection = "friday"

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
                Text("Codex").tag("codex")
                ForEach(store.agents.filter { $0.id != "codex" }) { agent in Text(agent.name).tag(agent.id) }
            }.pickerStyle(.menu)
            details
            #endif
        }
    }

    private var providerList: some View {
        VStack(alignment: .leading, spacing: 4) {
            providerRow(id: "friday", name: "Friday", icon: "sparkles", detail: "主会话 · API")
            providerRow(id: "codex", name: "Codex", icon: "cpu", detail: "任务 · 本地")
            ForEach(store.agents.filter { $0.id != "codex" }) { agent in
                providerRow(id: agent.id, name: agent.name, icon: "terminal", detail: "任务 · 本地",
                            status: agent.installed ? "尚未接入" : "未安装")
            }
        }.padding(10)
    }

    private func providerRow(id: String, name: String, icon: String, detail: String, status: String? = nil) -> some View {
        Button { selection = id } label: {
            HStack(alignment: .top, spacing: 10) {
                FridaySymbolImage(systemName: icon).font(.system(size: 16)).frame(width: 20)
                VStack(alignment: .leading, spacing: 5) {
                    Text(name).font(.system(size: 13, weight: .medium))
                    Text(fridayString: detail).font(.system(size: 11)).foregroundStyle(.secondary)
                    if let status { Text(fridayString: status).font(.system(size: 11)).foregroundStyle(.tertiary) }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(12).contentShape(Rectangle())
        }
        .buttonStyle(ProviderRowStyle(selected: selection == id))
        .accessibilityAddTraits(selection == id ? .isSelected : [])
        .fridaySymbolFeedback(active: selection == id)
    }

    @ViewBuilder private var details: some View {
        switch selection {
        case "friday": ModelSettingsView(store: store)
        case "codex": CodexSettingsView(store: store)
        default:
            if let agent = store.agents.first(where: { $0.id == selection }) { localAgentDetails(agent) }
        }
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
                        FridaySymbolLabel(friday: "重新检测", systemImage: "arrow.clockwise").fridaySymbolFeedback()
                    }.disabled(!store.connected)
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
    }
}
