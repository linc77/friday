import SwiftUI
#if os(macOS)
import AppKit
#endif

private enum FridaySection: String, CaseIterable, Identifiable {
    case chat = "对话", inbox = "想法", tasks = "任务", projects = "项目", memory = "记忆"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .chat: FridaySymbols.chat
        case .inbox: "scribble"
        case .tasks: "checklist.unchecked"
        case .projects: "folder"
        case .memory: "sparkles"
        }
    }

    var motion: FridaySymbolMotion {
        switch self {
        case .chat, .projects: .bounce
        case .inbox, .tasks: .wiggle
        case .memory: .pulse
        }
    }
}

@MainActor
public struct FridayRootView: View {
    @StateObject private var store = FridayStore()
    @State private var section: FridaySection? = .chat
    @State private var selectedTask: String?
    @State private var mobileTab = 0
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    @FocusState private var focusedSidebarSection: FridaySection?
    private var selectConnectionSettings: () -> Void = {}
    #endif
    public init() {}

    #if os(macOS)
    init(store: FridayStore, selectConnectionSettings: @escaping () -> Void) {
        _store = StateObject(wrappedValue: store)
        self.selectConnectionSettings = selectConnectionSettings
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
                .padding(.top, 6)
                .padding([.trailing, .bottom], 10)
            }
            .background { FridayWindowBackground().ignoresSafeArea() }
            .navigationTitle("")
            .focusedSceneValue(\.newFridayConversation, { newTask() })
            .toolbarBackground(.hidden, for: .windowToolbar)
            .frame(minWidth: 980, minHeight: 640)
            #else
            TabView(selection: $mobileTab) {
                NavigationStack {
                    VStack(spacing: 0) { if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }; conversation }
                        .navigationTitle("Friday").toolbar { Button { newTask() } label: { Label("新对话", systemImage: "square.and.pencil") } }
                }.tabItem { Label("对话", systemImage: FridaySymbols.chat) }.tag(0)
                NavigationStack { inbox.navigationTitle("想法") }.tabItem { Label("想法", systemImage: "scribble") }.tag(1)
                NavigationStack { tasksList.navigationTitle("任务").navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id) } }.tabItem { Label("任务", systemImage: "checklist.unchecked") }.tag(2)
                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink("项目") { ProjectsView(store: store) }
                        NavigationLink("记忆") { MemoriesView(store: store) }
                        NavigationLink("本地工具") { AgentsView(store: store) }
                        NavigationLink("连接与设备") { ConnectionView(store: store) }
                    }.navigationTitle("我的 Friday")
                }.tabItem { Label("设置", systemImage: "gear") }.tag(3)
            }
            #endif
        }
        .tint(FridayTheme.accent)
        .accentColor(FridayTheme.accent)
        .symbolRenderingMode(.monochrome)
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
                ForEach(FridaySection.allCases) { item in sidebarRow(item) }
            }
            Spacer(minLength: 16)
            FridaySettingsLink()
                .frame(width: 40, height: 40)
        }
        .padding(.vertical, 12)
        .frame(width: 64)
        .frame(maxHeight: .infinity)
    }

    private func sidebarRow(_ item: FridaySection) -> some View {
        Button { section = item } label: {
            Label(item.rawValue, systemImage: item.icon)
        }
        .buttonStyle(FridaySidebarButtonStyle(selected: section == item, focused: focusedSidebarSection == item))
        .focused($focusedSidebarSection, equals: item)
        .focusEffectDisabled()
        .help(item.rawValue)
        .accessibilityAddTraits(section == item ? .isSelected : [])
        .accessibilityValue(item == .tasks && store.tasks.contains(where: { $0.active })
            ? "\(store.tasks.filter { $0.active }.count) 个进行中的任务" : "")
        .fridaySymbolFeedback(item.motion, active: section == item)
    }
    #endif

    private var connectionStatus: some View {
        HStack(spacing: 8) {
            Image(systemName: store.connected ? "checkmark.circle" : "wifi.slash")
                .foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                .fridaySymbolFeedback(active: store.connected)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(store.connected ? "主机已连接" : "等待连接主机").font(.caption.weight(.medium))
                if !store.outbox.isEmpty { Text("\(store.outbox.count) 条想法待同步").font(.caption2).foregroundStyle(.secondary) }
            }
        }.accessibilityElement(children: .combine)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle").fridaySymbolFeedback(.wiggle)
            Text(message).lineLimit(2)
            Spacer()
            Button("连接设置") {
                #if os(macOS)
                selectConnectionSettings()
                openSettings()
                #else
                mobileTab = 3
                #endif
            }.buttonStyle(FridayButtonStyle(compact: true))
        }
        .font(.caption).padding(12).background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 20).padding(.top, 8)
    }

    @ViewBuilder private var content: some View {
        switch section ?? .chat {
        case .chat: conversation
        case .inbox: inbox
        case .tasks:
            #if os(macOS)
            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("任务").font(.headline)
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
        }
    }

    private var inbox: some View {
        InboxView(store: store) { idea in Task { if let id = await store.delegate(idea) { openConversation(id) } } }
    }

    @ViewBuilder private var conversation: some View {
        if let selectedTask { TaskDetail(store: store, id: selectedTask).id(selectedTask) }
        else { NewConversationView(store: store, onCreated: openConversation) }
    }

    private func openConversation(_ id: String) { selectedTask = id; section = .chat; mobileTab = 0 }

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

    private func newTask() { selectedTask = nil; section = .chat; mobileTab = 0 }
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
            .font(.system(size: 18, weight: .regular))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(selected ? .primary : .secondary)
            .frame(width: 40, height: 40)
            .background {
                RoundedRectangle(cornerRadius: 10)
                    .fill(.primary.opacity(configuration.isPressed ? 0.14 : selected ? 0.09 : hovering ? 0.055 : 0))
            }
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(.primary.opacity(focused ? 0.3 : 0), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
            .onHover { hovering = $0 }
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
                            Text("有什么想研究、想完成的事？").foregroundStyle(.tertiary)
                                .padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                        }
                        TextEditor(text: $draft).font(.body).frame(minHeight: 90)
                            .scrollContentBackground(.hidden).focused($focused).accessibilityLabel("记录想法")
                    }
                    HStack {
                        Text("文字、链接，都可以。").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button {
                            let text = draft; saving = true
                            Task { if await store.saveIdea(text), draft == text { draft = "" }; saving = false }
                        } label: { Label(saving ? "正在收下" : "收下这个想法", systemImage: "arrow.up") }
                        .buttonStyle(FridayButtonStyle(prominent: true))
                        .disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(20).fridayCard(highlighted: focused)
                if !store.ideas.isEmpty || !store.outbox.isEmpty {
                    HStack {
                        Text("已收集").font(.subheadline.weight(.semibold))
                        Text("\(store.ideas.count + store.outbox.count)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    }.padding(.top, 4)
                }
                LazyVStack(spacing: 14) {
                    ForEach(store.outbox) { idea in
                        HStack(spacing: 16) {
                            Text(idea.text).frame(maxWidth: .infinity, alignment: .leading)
                            Label("待同步", systemImage: "clock").font(.caption).foregroundStyle(.secondary).fridaySymbolFeedback(.rotate)
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
                                    Label(idea.taskId == nil ? "交给 Friday" : "打开对话", systemImage: idea.taskId == nil ? "arrow.up.right" : "bubble.left")
                                }
                                .buttonStyle(FridayButtonStyle(compact: true))
                                .disabled((!store.connected && idea.taskId == nil) || store.delegatingIdeas.contains(idea.id))
                            }
                        }.padding(22).fridayCard()
                        .contextMenu { Button("删除想法", role: .destructive) { Task { _ = await store.perform("/api/ideas/\(idea.id)", method: "DELETE") } } }
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
