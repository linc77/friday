#if os(macOS)
import SwiftUI

enum FridaySettingsSection: String, CaseIterable, Identifiable {
    case general = "通用"
    case appearance = "外观"
    case taskSidebar = "任务侧栏"
    case taskBehavior = "任务设置"
    case providers = "Providers"
    case textGeneration = "文字生成"
    case sourceControl = "Source Control"
    case projectScripts = "项目脚本"
    case browser = "浏览器"
    case archived = "已归档任务"
    case devices = "设备管理"
    case health = "健康与主动分享"

    var id: String { rawValue }

    var icon: String {
        switch self {
        case .general: "slider.horizontal.3"
        case .appearance: "circle.lefthalf.filled"
        case .taskSidebar: "sidebar.left"
        case .taskBehavior: "checklist"
        case .providers: "cpu"
        case .textGeneration: "text.bubble"
        case .sourceControl: "arrow.triangle.branch"
        case .projectScripts: "play"
        case .browser: "globe"
        case .archived: "archivebox"
        case .devices: "laptopcomputer.and.iphone"
        case .health: "heart.text.square"
        }
    }

    var searchTerms: String {
        switch self {
        case .general: "通用 语言 中文 英文 输入框 斜杠 菜单 Skill 技能 General Language Chinese English Composer Input Slash Menu"
        case .appearance: "外观 主题 系统 浅色 深色 字体 字号 正文 代码 布局 内容 宽度 全宽 配色 高亮 Appearance Theme System Light Dark Font Size Typography Layout Width Syntax Highlight Midnight 午夜 深蓝 Pierre GitHub Visual Studio Code Catppuccin"
        case .taskSidebar: "任务 侧栏 项目 分组 仓库 排序 顺序 最近 活动 发送 手动 旧版 项目树 默认 显示 数量 恢复 Working Inbox Beta Sidebar Project Group Sort Order Preview"
        case .taskBehavior: "任务 设置 操作 归档 确认 自动 结束 跟进 不活跃 天数 主机 Workspace PR 合并 Task Settings Archive Confirmation Auto Settle Inactivity Merge"
        case .providers: "Providers 模型服务 供应商 Base URL 本地工具 Friday DeepSeek API 密钥 Codex Claude Code Hermes Pi 编码 账号 模型 路径 环境变量 推理 Runtime"
        case .textGeneration: "文字生成 任务标题 命名 提交 PR 说明 模型 推理 Workspace Text generation Titles Commit Source Control"
        case .sourceControl: "Source Control Git GitHub GitLab Bitbucket Token 仓库 发布 认证 登录 主机 密钥 合并 Agent 署名 credits merge squash"
        case .projectScripts: "项目脚本 初始化 收起 终端 Worktree setup settle scripts commands t3.json"
        case .browser: "浏览器 浏览配置 默认 缩放 外观 Cookie 缓存 网页 Browser Profiles Appearance Zoom Cache"
        case .archived: "归档 历史 任务 恢复 删除 Workspace Archived Threads Restore Delete"
        case .devices: "设备管理 iPhone Mac 主机 连接 配对码 访问 撤销 重新连接 Devices Host Connection Access Reconnect"
        case .health: "健康 主动 分享 睡眠 步数 心率 推送 通知 APNs Health Proactive Sleep Activity Notifications"
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
        HStack(spacing: FridayTheme.paneSpacing) {
            sidebar.fridayPaneSurface()
            Group {
                switch selection {
                case .general: GeneralSettingsView()
                case .appearance: AppearanceSettingsView()
                case .taskSidebar: TaskSidebarSettingsView(store: store)
                case .taskBehavior: TaskBehaviorSettingsView(store: store)
                case .providers: ProvidersView(store: store)
                case .textGeneration: TextGenerationSettingsView(store: store)
                case .sourceControl: SourceControlSettingsView(store: store)
                case .projectScripts: ProjectScriptsSettingsView(store: store)
                case .browser: TaskBrowserPreferencesView(store:store,preferences:TaskBrowserPreferences.shared(server:store.connection.server))
                case .archived: TaskArchivedTasks(store: store)
                case .devices: ConnectionView(store: store)
                case .health: HealthSettingsView(store: store)
                }
            }
            .id(selection)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .fridayPaneSurface()
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
                FridaySymbolImage(systemName: "magnifyingglass").foregroundStyle(FridayTheme.secondaryText).fridaySymbolFeedback()
                TextField(friday: "搜索设置", text: $search)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(Text(friday: "搜索设置"))
                if !search.isEmpty {
                    Button { search = "" } label: {
                        FridaySymbolImage(systemName: "xmark.circle.fill").foregroundStyle(FridayTheme.secondaryText)
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
                    navigationGroup("通用", sections: [.general, .appearance, .taskSidebar, .browser])
                    navigationGroup("任务与项目", sections: [.taskBehavior, .archived, .sourceControl, .projectScripts])
                    navigationGroup("Friday", sections: [.providers, .health, .textGeneration])
                    navigationGroup("连接与同步", sections: [.devices])
                    if filteredSections.isEmpty {
                        Text(friday: "没有匹配的设置")
                            .font(.caption).foregroundStyle(FridayTheme.secondaryText)
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
        .background(FridayTheme.canvas)
    }

    @ViewBuilder private func navigationGroup(_ title: String, sections: [FridaySettingsSection]) -> some View {
        let visible = sections.filter { filteredSections.contains($0) }
        if !visible.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(fridayString: title)
                    .font(.system(size: 12, weight: .medium)).foregroundStyle(FridayTheme.secondaryText)
                    .padding(.horizontal, 8).padding(.bottom, 4)
                ForEach(visible) { section in
                    Button { selection = section } label: {
                        HStack(spacing: 9) {
                            FridaySymbolImage(systemName: section.icon)
                                .font(.system(size: 13, weight: .regular))
                                .frame(width: 16)
                            Text(fridayString: section.rawValue).font(FridayTheme.interfaceFont)
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
            .foregroundStyle(FridayTheme.foreground)
            .background(.primary.opacity(selected ? 0.065 : configuration.isPressed ? 0.035 : 0),
                        in: RoundedRectangle(cornerRadius: 7))
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
    }
}
#endif
