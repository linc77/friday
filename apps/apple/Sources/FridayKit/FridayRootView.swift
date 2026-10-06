import SwiftUI
#if os(macOS)
import AppKit
#endif

enum FridaySection: String, CaseIterable, Identifiable {
    case chat = "对话", inbox = "想法", tasks = "任务", projects = "项目", memory = "记忆", settings = "设置"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .chat: FridaySymbols.chat
        case .inbox: "scribble"
        case .tasks: "checklist.unchecked"
        case .projects: "folder"
        case .memory: "sparkles"
        case .settings: "gear"
        }
    }
}

@MainActor
final class FridayNavigation: ObservableObject {
    @Published var section: FridaySection = .chat
}

@MainActor
public struct FridayRootView: View {
    @StateObject private var store = FridayStore()
    @StateObject private var navigation = FridayNavigation()
    @State private var selectedTask: String?
    @State private var mobileTab = 0
    @AppStorage(FridayPreferenceKeys.appearance) private var appearance: FridayAppearance = .system
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @FocusState private var focusedSidebarSection: FridaySection?
    @State private var settingsSection: FridaySettingsSection = .appearance
    #endif
    public init() {}

    #if os(macOS)
    init(store: FridayStore, navigation: FridayNavigation) {
        _store = StateObject(wrappedValue: store)
        _navigation = StateObject(wrappedValue: navigation)
    }
    #endif

    public var body: some View {
        Group {
            #if os(macOS)
            HStack(spacing: 0) {
                sidebar
                VStack(spacing: 0) {
                    if let error = store.error { errorBanner(error) }
                    content
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(FridayReadingSurface())
                .padding([.top, .trailing, .bottom], FridayTheme.windowEdgeInset)
            }
            // The traffic lights sit over the rail; content reaches the top window edge.
            .ignoresSafeArea(.container, edges: .top)
            .background { FridayWindowBackground().ignoresSafeArea() }
            .navigationTitle("")
            .focusedSceneValue(\.newFridayConversation, { newTask() })
            .toolbarBackground(.hidden, for: .windowToolbar)
            .frame(minWidth: 980, minHeight: 640)
            #else
            TabView(selection: $mobileTab) {
                NavigationStack {
                    VStack(spacing: 0) { if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).padding(8) }; conversation }
                        .navigationTitle("Friday").toolbar { Button { newTask() } label: { FridaySymbolLabel(friday: "新对话", systemImage: "square.and.pencil") } }
                }.tabItem { Label(friday: "对话", systemImage: FridaySymbols.chat) }.tag(0)
                NavigationStack { inbox.navigationTitle(Text(friday: "想法")) }.tabItem { Label(friday: "想法", systemImage: "scribble") }.tag(1)
                NavigationStack { tasksList.navigationTitle(Text(friday: "任务")).navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id) } }.tabItem { Label(friday: "任务", systemImage: "checklist.unchecked") }.tag(2)
                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink(friday: "项目") { ProjectsView(store: store) }
                        NavigationLink(friday: "记忆") { MemoriesView(store: store) }
                        NavigationLink(friday: "本地工具") { AgentsView(store: store) }
                        NavigationLink(friday: "外观") { AppearanceSettingsView() }
                        NavigationLink(friday: "连接与设备") { ConnectionView(store: store) }
                    }.navigationTitle(Text(friday: "我的 Friday"))
                }.tabItem { Label(friday: "设置", systemImage: "gear") }.tag(3)
            }
            #endif
        }
        .tint(FridayTheme.accent)
        .accentColor(FridayTheme.accent)
        .symbolRenderingMode(.monochrome)
        .environment(\.locale, language.locale)
        .preferredColorScheme(appearance.colorScheme)
        .task { await store.importSharedIdeas(); await store.connect() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.importSharedIdeas(); await store.connect() } }
        }
        .onOpenURL { url in
            guard url.scheme == "friday", url.host == "capture", let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let text = components.queryItems?.first(where: { $0.name == "text" })?.value else { return }
            Task { await store.saveIdea(text) }
        }
    }

    #if os(macOS)
    private var sidebar: some View {
        VStack(spacing: 8) {
            VStack(spacing: 8) {
                ForEach(FridaySection.allCases.filter { $0 != .settings }) { item in sidebarRow(item) }
            }
            Spacer(minLength: 16)
            sidebarRow(.settings)
                .help(Text(friday: "设置（⌘,）"))
        }
        .padding(.top, FridayTheme.sidebarTopInset)
        .padding(.bottom, 12)
        .frame(width: FridayTheme.sidebarWidth)
        .frame(maxHeight: .infinity)
    }

    private func sidebarRow(_ item: FridaySection) -> some View {
        Button { navigation.section = item } label: {
            FridaySymbolLabel(friday: item.rawValue, systemImage: item.icon, motion: item == .settings ? .rotate : .drawOn)
        }
        .buttonStyle(FridaySidebarButtonStyle(selected: navigation.section == item, focused: focusedSidebarSection == item))
        .focused($focusedSidebarSection, equals: item)
        .focusEffectDisabled()
        .help(Text(fridayString: item.rawValue))
        .accessibilityAddTraits(navigation.section == item ? .isSelected : [])
        .accessibilityValue(item == .tasks && store.tasks.contains(where: { $0.active })
            ? Text(friday: "\(store.tasks.filter { $0.active }.count) 个进行中的任务") : Text(""))
    }
    #endif

    private var connectionStatus: some View {
        HStack(spacing: 8) {
            FridaySymbolImage(systemName: store.connected ? "checkmark.circle" : "wifi.slash")
                .foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                .fridaySymbolFeedback(active: store.connected)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(fridayString: store.connected ? "主机已连接" : "等待连接主机").font(.caption.weight(.medium))
                if !store.outbox.isEmpty { Text(friday: "\(store.outbox.count) 条想法待同步").font(.caption2).foregroundStyle(.secondary) }
            }
        }.accessibilityElement(children: .combine)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            FridaySymbolImage(systemName: "exclamationmark.circle").fridaySymbolFeedback()
            Text(fridayString: message).lineLimit(2)
            Spacer()
            Button(friday: "连接设置") {
                #if os(macOS)
                settingsSection = .connection
                navigation.section = .settings
                #else
                mobileTab = 3
                #endif
            }.buttonStyle(FridayButtonStyle(compact: true))
        }
        .font(.caption).padding(12).background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 20).padding(.top, 8)
    }

    @ViewBuilder private var content: some View {
        switch navigation.section {
        case .chat: conversation
        case .inbox: inbox
        case .tasks:
            #if os(macOS)
            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text(friday: "任务").font(.headline)
                        Spacer()
                        Text("\(store.tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }.padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 8)
                    tasksList
                }
                .frame(minWidth: 230, idealWidth: 260, maxWidth: 310, maxHeight: .infinity)
                if let selectedTask { TaskDetail(store: store, id: selectedTask).id(selectedTask).frame(minWidth: 420) }
                else { EmptyPanel(icon: "checklist", title: "专注眼前的一件事", subtitle: "选择左侧任务，查看进展、补充要求，或收下完成的成果。") }
            }
            #else
            tasksList
            #endif
        case .projects: ProjectsView(store: store)
        case .memory: MemoriesView(store: store)
        case .settings:
            #if os(macOS)
            FridaySettingsView(store: store, selection: $settingsSection)
            #else
            ConnectionView(store: store)
            #endif
        }
    }

    private var inbox: some View {
        InboxView(store: store) { idea in Task { if let id = await store.delegate(idea) { openConversation(id) } } }
    }

    @ViewBuilder private var conversation: some View {
        if let selectedTask { TaskDetail(store: store, id: selectedTask).id(selectedTask) }
        else { NewConversationView(store: store, onCreated: openConversation) }
    }

    private func openConversation(_ id: String) { selectedTask = id; navigation.section = .chat; mobileTab = 0 }

    private var tasksList: some View {
        Group {
            if store.tasks.isEmpty {
                EmptyPanel(icon: "checklist", title: "交给 Friday 一件事", subtitle: "从一个想法开始，或直接布置新任务。")
            } else {
                #if os(macOS)
                List(selection: $selectedTask) {
                    ForEach(store.tasks.reversed()) { task in
                        TaskRow(task: task).tag(task.id).listRowSeparator(.hidden)
                    }
                }.listStyle(.sidebar).scrollContentBackground(.hidden)
                #else
                List(store.tasks.reversed()) { task in NavigationLink(value: task.id) { TaskRow(task: task) } }.refreshable { await store.refresh() }
                #endif
            }
        }
    }

    private func newTask() { selectedTask = nil; navigation.section = .chat; mobileTab = 0 }
}

#if os(macOS)
private struct FridaySidebarButtonStyle: ButtonStyle {
    let selected: Bool
    let focused: Bool

    func makeBody(configuration: Configuration) -> some View {
        FridaySidebarButtonBody(configuration: configuration, selected: selected, focused: focused)
    }
}

private struct FridaySidebarButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let selected: Bool
    let focused: Bool
    @State private var hovering = false

    var body: some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.system(size: FridayTheme.sidebarIconSize, weight: .regular))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(selected || focused ? .primary : .secondary)
            .frame(width: FridayTheme.sidebarButtonSize, height: FridayTheme.sidebarButtonSize)
            .background {
                RoundedRectangle(cornerRadius: FridayTheme.sidebarCornerRadius)
                    .fill(.primary.opacity(configuration.isPressed ? 0.14 : selected ? 0.09 : hovering ? 0.055 : 0))
            }
            .contentShape(RoundedRectangle(cornerRadius: FridayTheme.sidebarCornerRadius))
            .onHover { hovering = $0 }
            .fridaySymbolFeedback(active: configuration.isPressed)
    }
}
#endif

struct TaskRow: View {
    let task: WorkItem
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(task.title).font(.callout.weight(.medium)).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                StatusBadge(task: task)
                Spacer(minLength: 4)
                Text(task.createdAt.prefix(10)).font(.caption).foregroundStyle(.tertiary)
            }
        }.padding(.vertical, 10)
    }
}

struct InboxView: View {
    @ObservedObject var store: FridayStore
    let delegate: (Idea) -> Void
    @AppStorage("friday.ideaDraft") private var draft = ""
    @State private var saving = false
    @FocusState private var focused: Bool
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                PageHeading(title: "把想法放在这里", subtitle: "先记下来，准备好了再交给 Friday。")
                    .padding(.top, 8)
                VStack(alignment: .leading, spacing: 16) {
                    ZStack(alignment: .topLeading) {
                        if draft.isEmpty {
                            Text(friday: "有什么想研究、想完成的事？").foregroundStyle(.tertiary)
                                .padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                        }
                        TextEditor(text: $draft).font(.body).frame(minHeight: 90)
                            .scrollContentBackground(.hidden).focused($focused).accessibilityLabel(Text(friday: "记录想法"))
                    }
                    HStack {
                        Text(friday: "文字、链接，都可以。").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            let text = draft; saving = true
                            Task { if await store.saveIdea(text), draft == text { draft = "" }; saving = false }
                        } label: { FridaySymbolLabel(friday: saving ? "正在收下" : "收下这个想法", systemImage: "arrow.up") }
                        .buttonStyle(FridayButtonStyle(prominent: true))
                        .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(20).fridayCard(highlighted: focused)
                if !store.ideas.isEmpty || !store.outbox.isEmpty {
                    HStack {
                        Text(friday: "已收集").font(.subheadline.weight(.semibold))
                        Text("\(store.ideas.count + store.outbox.count)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    }.padding(.top, 4)
                }
                LazyVStack(spacing: 14) {
                    ForEach(store.outbox) { idea in
                        HStack(spacing: 16) {
                            Text(idea.text).frame(maxWidth: .infinity, alignment: .leading)
                            FridaySymbolLabel(friday: "待同步", systemImage: "clock").font(.caption).foregroundStyle(.secondary).fridaySymbolFeedback()
                        }.padding(20).fridayCard()
                    }
                    ForEach(store.ideas) { idea in
                        VStack(alignment: .leading, spacing: 20) {
                            Text(idea.text).font(.body).lineSpacing(4).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            HStack {
                                Text(idea.createdAt.prefix(10)).font(.caption).foregroundStyle(.tertiary)
                                Spacer()
                                Button { delegate(idea) } label: {
                                    FridaySymbolLabel(friday: idea.taskId == nil ? "交给 Friday" : "打开对话", systemImage: idea.taskId == nil ? "arrow.up.right" : "bubble.left")
                                }
                                .buttonStyle(FridayButtonStyle(compact: true))
                                .disabled((!store.connected && idea.taskId == nil) || store.delegatingIdeas.contains(idea.id))
                            }
                        }.padding(22).fridayCard()
                        .contextMenu { Button(friday: "删除想法", role: .destructive) { Task { _ = await store.perform("/api/ideas/\(idea.id)", method: "DELETE") } } }
                    }
                }
                if store.ideas.isEmpty && store.outbox.isEmpty {
                    EmptyPanel(icon: "scribble", title: "为下一个念头留个位置", subtitle: "想研究的项目、突然出现的点子、要处理的小事，都可以从这里开始。")
                }
            }
            .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity)
        }.background(FridayTheme.canvas)
    }
}
