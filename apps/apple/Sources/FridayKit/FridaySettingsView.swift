#if os(macOS)
import SwiftUI

enum FridaySettingsSection: String, CaseIterable, Identifiable {
    case appearance = "外观"
    case providers = "Providers"
    case devices = "设备管理"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .appearance: "circle.lefthalf.filled"
        case .providers: "cpu"
        case .devices: "laptopcomputer.and.iphone"
        }
    }

    var searchTerms: String {
        switch self {
        case .appearance: "外观 主题 系统 浅色 深色 语言 中文 英文 Appearance Theme System Light Dark Language Chinese English"
        case .providers: "Providers 模型服务 本地工具 Friday DeepSeek API 密钥 Codex Claude Code Hermes Pi 编码 账号 模型 路径 环境变量 推理 Runtime"
        case .devices: "设备管理 iPhone Mac 主机 连接 配对码 访问 撤销 重新连接 Devices Host Connection Access Reconnect"
        }
    }
}

struct FridaySettingsView: View {
    @ObservedObject var store: FridayStore
    @Binding var selection: FridaySettingsSection
    @State private var search = ""

    private var filteredSections: [FridaySettingsSection] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return FridaySettingsSection.allCases.filter {
            query.isEmpty || $0.searchTerms.localizedStandardContains(query)
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            Group {
                switch selection {
                case .appearance: AppearanceSettingsView()
                case .providers: ProvidersView(store: store)
                case .devices: ConnectionView(store: store)
                }
            }
            .id(selection)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(FridayTheme.surface)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .tint(FridayTheme.accent)
        .symbolRenderingMode(.monochrome)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(friday: "设置")
                .font(.system(size: 17, weight: .semibold))
                .padding(.horizontal, 8)
            HStack(spacing: 7) {
                FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(.secondary).fridaySymbolFeedback()
                TextField(friday: "搜索设置", text: $search)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(Text(friday: "搜索设置"))
                if !search.isEmpty {
                    Button { search = "" } label: {
                        FridaySymbolImage(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .buttonStyle(FridaySymbolButtonStyle())
                    .accessibilityLabel(Text(friday: "清除搜索"))
                }
            }
            .font(.system(size: 12))
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    navigationGroup("通用", sections: [.appearance])
                    navigationGroup("Friday", sections: [.providers])
                    navigationGroup("连接与同步", sections: [.devices])
                    if filteredSections.isEmpty {
                        Text(friday: "没有匹配的设置")
                            .font(.caption).foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
        .padding(.horizontal, 12)
        .padding(.top, 22)
        .padding(.bottom, 16)
        .frame(width: 220)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(FridayTheme.canvas.opacity(0.65))
    }

    @ViewBuilder private func navigationGroup(_ title: String, sections: [FridaySettingsSection]) -> some View {
        let visible = sections.filter { filteredSections.contains($0) }
        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(fridayString: title)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.bottom, 4)
                ForEach(visible) { section in
                    Button { selection = section } label: {
                        HStack(spacing: 9) {
                            FridaySymbolImage(systemName: section.icon)
                                .font(.system(size: 13, weight: .regular))
                                .frame(width: 16)
                            Text(fridayString: section.rawValue).font(.system(size: 13))
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8)
                        .frame(height: 30)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SettingsNavigationStyle(selected: selection == section))
                    .accessibilityAddTraits(selection == section ? .isSelected : [])
                }
            }
        }
    }
}

private struct SettingsNavigationStyle: ButtonStyle {
    let selected: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.primary)
            .background(.primary.opacity(selected ? 0.065 : configuration.isPressed ? 0.035 : 0),
                        in: RoundedRectangle(cornerRadius: 7))
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
    }
}
#endif
