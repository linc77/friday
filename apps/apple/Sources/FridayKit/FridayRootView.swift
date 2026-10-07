import SwiftUI
#if os(macOS)
import AppKit
#endif

enum FridaySection: String, CaseIterable, Identifiable {
    case chat = "对话", inbox = "想法", tasks = "任务", projects = "Workspace", memory = "记忆", settings = "设置"
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
    @State private var workspaceScope: String?
    @State private var draftProjectId: String?
    @State private var taskDrafts: [String: AgentTaskDraft] = [:]
    @State private var choosingMobileWorkspace = false
    @State private var selectedConversation: String?
    private var localTasks: [WorkItem] { store.tasks.filter { $0.localAgent } }
    @State private var mobileTab = 0
    @State private var mobileTaskPath: [String] = []
    @State private var startingConversation = false
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
                NavigationStack(path: $mobileTaskPath) {
                    tasksList.navigationTitle(Text(friday: "任务"))
                        .navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id, onOpenTask: openLocalTask) }
                        .toolbar {
                            Button { choosingMobileWorkspace = true } label: { FridaySymbolLabel(friday: "新任务", systemImage: "square.and.pencil") }
                        }
                        .sheet(isPresented: $choosingMobileWorkspace) {
                            NavigationStack {
                                List(store.projects) { project in
                                    NavigationLink {
                                        NewAgentTaskView(store: store, project: project, onCreated: { id in
                                            choosingMobileWorkspace = false; openLocalTask(id)
                                        }, drafts: $taskDrafts)
                                    } label: {
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(project.name)
                                            Text(project.path).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                }.navigationTitle(Text(friday: "选择 Workspace"))
                                    .toolbar { Button(friday: "取消") { choosingMobileWorkspace = false } }
                            }
                        }
                }.tabItem { Label(friday: "任务", systemImage: "checklist.unchecked") }.tag(2)
                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink(friday: "Workspace") { ProjectsView(store: store) }
                        NavigationLink(friday: "记忆") { MemoriesView(store: store) }
                        NavigationLink("Providers") { ProvidersView(store: store) }
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
                settingsSection = .devices
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
            HStack(spacing: 0) {
                TaskWorkspaceSidebar(store: store, scope: $workspaceScope, draftProjectId: $draftProjectId, selectedTask: $selectedTask) {
                    if let workspaceScope { draftProjectId = workspaceScope }
                    selectedTask = nil
                }
                .frame(width: 250)
                .frame(maxHeight: .infinity)
                Divider()
                if let selectedTask { TaskDetail(store: store, id: selectedTask, onOpenTask: openLocalTask).id(selectedTask).frame(minWidth: 420) }
                else { NewAgentTaskView(store: store, project: store.projects.first { $0.id == draftProjectId }, onCreated: openLocalTask, drafts: $taskDrafts) }
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
        if !startingConversation, let selectedConversation = selectedConversation ?? store.tasks.last(where: { $0.agent == "friday" })?.id, store.tasks.first(where: { $0.id == selectedConversation })?.agent == "friday" { TaskDetail(store: store, id: selectedConversation, onOpenTask: openLocalTask).id(selectedConversation) }
        else { NewConversationView(store: store, onCreated: openConversation) }
    }

    private func openConversation(_ id: String) { startingConversation = false; selectedConversation = id; navigation.section = .chat; mobileTab = 0 }

    private func openLocalTask(_ id: String) {
        if let task = store.tasks.first(where: { $0.id == id }), let workspaceScope,
           TaskWorkspaces.project(for: task, in: store.projects)?.id != workspaceScope { self.workspaceScope = nil }
        selectedTask = id; navigation.section = .tasks; mobileTab = 2; mobileTaskPath = [id]
    }

    private var tasksList: some View {
        Group {
            if localTasks.isEmpty {
                EmptyPanel(icon: "checklist", title: "交给 Friday 一件事", subtitle: "从一个想法开始，或直接布置新任务。")
            } else {
                #if os(macOS)
                ScrollView {
                    LazyVStack(spacing: 6) {
                        ForEach(localTasks.reversed()) { task in
                            Button { selectedTask = task.id } label: {
                                TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects), selected: selectedTask == task.id).padding(.horizontal, 12)
                                    .foregroundStyle(.primary)
                            }.buttonStyle(TaskRowButtonStyle(selected: selectedTask == task.id))
                                .accessibilityAddTraits(selectedTask == task.id ? .isSelected : [])
                        }
                    }.padding(.horizontal, 10)
                }
                #else
                List(localTasks.reversed()) { task in NavigationLink(value: task.id) { TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects)) } }.refreshable { await store.refresh() }
                #endif
            }
        }
    }

    private func newTask() { startingConversation = true; selectedConversation = nil; navigation.section = .chat; mobileTab = 0 }
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
