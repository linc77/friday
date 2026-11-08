import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
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
    @State private var store: FridayStore
    @StateObject private var navigation = FridayNavigation()
    @State private var selectedTask: String?
    @State private var workspaceScope: String?
    @State private var draftProjectId: String?
    @State private var taskDrafts: [String: AgentTaskDraft] = [:]
    @State private var choosingMobileWorkspace = false
    @State private var selectedConversation: String?
    private var localTasks: [WorkItem] { store.tasks.filter { $0.localAgent && $0.subagentOrigin == nil && $0.archivedAt == nil } }
    @State private var mobileTab = 0
    @State private var mobileTaskPath: [String] = []
    @State private var startingConversation = false
    @FridayPreference(FridayPreferenceKeys.appearance) private var appearance: FridayAppearance = .system
    @FridayPreference(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @State private var mobileKeyboardVisible = false
    @State private var mobileModelChoice: TaskModelChoice?
    #endif
    #if os(macOS)
    @State private var taskSidebarWidth: Double = 250
    @State private var settingsSection: FridaySettingsSection = .appearance
    @State private var taskModelJump: TaskModelJumpContext?
    @State private var taskTitleEditors: Set<UUID> = []
    #endif
    public init() { _store = State(initialValue: FridayStore()) }

    #if os(macOS)
    init(store: FridayStore, navigation: FridayNavigation) {
        _store = State(initialValue: store)
        _navigation = StateObject(wrappedValue: navigation)
    }
    #endif

    public var body: some View {
        let _ = TaskPresentationTiming.changes(Self.self)
        Group {
            #if os(macOS)
            HStack(spacing: 0) {
                sidebar
                VStack(spacing: 0) {
                    if let error = store.error { errorBanner(error) }
                    content
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(FridayReadingSurface(isContainer: navigation.section == .tasks || navigation.section == .settings))
                .padding([.top, .trailing, .bottom], FridayTheme.windowEdgeInset)
            }
            // The traffic lights sit over the rail; content reaches the top window edge.
            .ignoresSafeArea(.container, edges: .top)
            .background { FridayWindowBackground().ignoresSafeArea() }
            .focusedSceneValue(\.newFridayConversation, { newTask() })
            .toolbarBackground(.hidden, for: .windowToolbar)
            .frame(minWidth: 980, minHeight: 640)
            #else
            TabView(selection: $mobileTab) {
                NavigationStack {
                    conversation
                        .fridayMobileHomeNavigation()
                        .navigationTitle("")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarTrailing) {
                                Button(friday: "新对话", systemImage: "square.and.pencil", action: newTask)
                            }
                        }
                }.tabItem { Label(friday: "对话", systemImage: "ellipsis.message") }.tag(0)

                NavigationStack { inbox.fridayMobilePageTitle("想法") }
                    .tabItem { Label(friday: "想法", systemImage: "scribble") }.tag(1)

                NavigationStack(path: $mobileTaskPath) {
                    tasksList.fridayMobilePageTitle("任务")
                        .fridayMobileBottomBar { mobileTaskDock }
                        .fridayMobileHomeNavigation()
                        .navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id, onOpenTask: openLocalTask).toolbar(.hidden, for: .tabBar) }
                        .toolbar {
                            if mobileTab == 2 {
                                TaskSearchControl(store: store, openTask: openLocalTask)
                            }
                        }
                        .sheet(isPresented: $choosingMobileWorkspace) { mobileNewTaskSheet }
                }.tabItem { Label(friday: "任务", systemImage: "checklist") }.tag(2)

                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink(friday: "Workspace") { ProjectsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "记忆") { MemoriesView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink("Providers") { ProvidersView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "文字生成") { TextGenerationSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "Source Control") { SourceControlSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "项目脚本") { ProjectScriptsSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "通用") { GeneralSettingsView().toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "外观") { AppearanceSettingsView().toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "任务侧栏") { TaskSidebarSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "任务设置") { TaskBehaviorSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "已归档任务") { TaskArchivedTasks(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "连接与设备") { ConnectionView(store: store).toolbar(.hidden, for: .tabBar) }
                        NavigationLink(friday: "健康与主动分享") { HealthSettingsView(store: store).toolbar(.hidden, for: .tabBar) }
                    }

                    .fridayMobileHomeNavigation(hasComposer: false)
                    .navigationTitle(Text(friday: "我的 Friday"))
                }.tabItem { Label(friday: "设置", systemImage: "gear") }.tag(3)

            }
            .toolbar(.hidden, for: .tabBar)
            .modifier(FridayNavigationMotionHost(selection: mobileTab))
            .environment(\.fridayMobileTabSelection, $mobileTab)
            .environment(\.fridayMobileKeyboardVisible, mobileKeyboardVisible)
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                mobileKeyboardVisible = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
                mobileKeyboardVisible = false
            }
            .onChange(of: mobileTab) { _, _ in
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
            #endif
        }
        .font(FridayTheme.interfaceFont)
        .foregroundStyle(FridayTheme.foreground)
        .tint(FridayTheme.accent)
        #if os(macOS)
        .buttonStyle(FridayDefaultButtonStyle())
        .environment(\.fridayModelJump, $taskModelJump)
        .environment(\.fridayTitleEditors, $taskTitleEditors)
        #endif
        .accentColor(FridayTheme.accent)
        .symbolRenderingMode(.monochrome)
        .environment(\.locale, language.locale)
        .environment(\.fridayNewTaskOnBranch, openSameBranchDraft)
        .environment(\.fridayTaskLifecycleNavigation, TaskLifecycleNavigation(selectedID: selectedLifecycleTask, archived: archiveSelectedTask, open: openLocalTask))
        .onChange(of: TaskActionUndo.context(store), initial: true) { _, _ in store.taskUndo.synchronize(store) }
        .onChange(of: store.tasks.map(\.id)) { _, _ in store.taskUndo.synchronize(store) }
        #if os(macOS)
        .background(TaskUndoKeyboard { store.taskUndo.undo(store: store) }.frame(width: 0, height: 0))
        #endif
        .preferredColorScheme(appearance.colorScheme)
        .onChange(of: appearance, initial: true) { _, value in FridayPalette.shared.appearance = value }
        .overlay(alignment: .bottomTrailing) { VStack(alignment: .trailing, spacing: 8) { ProjectPublicationNotices(store: store); TaskReviewGuideNotices(store: store) }.padding(16) }
        .sheet(item: $store.reviewGuideOpenRequest) { target in TaskChangeRequestPanel(store: store, taskID: target.taskID, url: target.url, initialTab: "guide") }
        .task(id: store.connection.server) {
            taskDrafts = TaskDraftCache.load([String: AgentTaskDraft].self, server: store.connection.server, context: "new-tasks") ?? [:]
            await store.importSharedIdeas(); await store.connect()
        }
        .onChange(of: store.reviewGuideComposerHandoff?.id) { _, _ in
            if let target = store.reviewGuideComposerHandoff, target.identity == store.connectionIdentity { openLocalTask(target.taskID) }
        }
        .onChange(of: store.changeRequestDraftHandoff?.id) { _, _ in openPreparedDraft() }
        .onChange(of: taskDrafts) { _, drafts in
            TaskDraftCache.save(drafts.isEmpty ? nil : drafts, server: store.connection.server, context: "new-tasks")
        }
        .onChange(of: scenePhase) { _, phase in
            #if os(iOS)
            if phase == .background {FridayClientLifecycle.enteredBackground()}
            if phase == .active {FridayClientLifecycle.cancelQuit()}
            #endif
            if phase == .active {
                #if os(iOS)
                Task { await HealthSync.shared.sync() }
                #endif
                Task { await store.importSharedIdeas(); await store.connect() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .fridayOpenConversation)) { note in
            if let id = note.object as? String { UserDefaults.standard.removeObject(forKey: "friday.openConversation"); openConversation(id) }
        }
        .onAppear {
            if let id = UserDefaults.standard.string(forKey: "friday.openConversation") { UserDefaults.standard.removeObject(forKey: "friday.openConversation"); openConversation(id) }
        }
        #if os(iOS)
        .modifier(FridayMobileSoftTopEdge())
        #endif
        #if os(macOS)
        .onChange(of: store.connectionIdentity) { _, _ in taskModelJump = nil; taskTitleEditors = [] }
        #endif
        .onOpenURL { url in
            guard url.scheme == "friday", url.host == "capture", let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let text = components.queryItems?.first(where: { $0.name == "text" })?.value else { return }
            Task { await store.saveIdea(text) }
        }
    }

    #if os(macOS)
    private var sidebar: some View {
        FridaySidebar(navigation: navigation, activeTaskCount: store.tasks.filter(\.active).count)
            .equatable()
    }
    #endif

    private var connectionStatus: some View {
        HStack(spacing: 8) {
            FridaySymbolImage(systemName: store.connected ? "checkmark.circle" : "wifi.slash")
                .foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(fridayString: store.connected ? "主机已连接" : "等待连接主机").font(.caption.weight(.medium))
                if !store.outbox.isEmpty { Text(friday: "\(store.outbox.count) 条想法待同步").font(.caption2).foregroundStyle(FridayTheme.secondaryText) }
            }
        }.accessibilityElement(children: .combine)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            FridaySymbolImage(systemName: "exclamationmark.circle")
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
        #if os(macOS)
        FridayModuleContainer(selection: navigation.section, scope: store.connectionIdentity) {
            moduleContent(navigation.section)
        }
        #else
        moduleContent(navigation.section)
        #endif
    }

    @ViewBuilder private func moduleContent(_ section: FridaySection) -> some View {
        switch section {
        case .chat: conversation
        case .inbox: inbox
        case .tasks:
            #if os(macOS)
            TaskPanelSplitView(width: $taskSidebarWidth, visible: true, panelOnLeadingEdge: true,
                main: FridayRetainedPages(selection: selectedTask,
                    scope: store.connectionIdentity + ":" + String(store.taskHistoryGeneration), capacity: 4,
                    validKeys: Set([nil] + store.tasks.map { Optional($0.id) }), presentationID: selectedTask) {
                    if let selectedTask { TaskDetail(store: store, id: selectedTask, onOpenTask: openLocalTask).id(selectedTask) }
                    else {
                        NewAgentTaskView(store: store, project: store.projects.first { $0.id == draftProjectId }, onSelectProject: { project in
                            draftProjectId = project.id
                        }, onCreated: openLocalTask, drafts: $taskDrafts)
                        .fridayPaneSurface()
                    }
                }
                .frame(minWidth: 420),
                panel: {
                    TaskWorkspaceSidebar(store: store, scope: $workspaceScope, draftProjectId: $draftProjectId, selectedTask: $selectedTask) {
                        selectedTask = nil
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .fridayPaneSurface()
                })
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

    private var selectedLifecycleTask: String? {
        #if os(macOS)
        navigation.section == .tasks ? selectedTask : nil
        #else
        mobileTab == 2 ? mobileTaskPath.last : nil
        #endif
    }
    private func archiveSelectedTask(_ id: String) {
        guard selectedLifecycleTask == id else { return }
        draftProjectId = store.tasks.first { $0.id == id }?.projectId
        selectedTask = nil; mobileTaskPath = []
    }
    private func openConversation(_ id: String) { startingConversation = false; selectedConversation = id; navigation.section = .chat; mobileTab = 0 }

    private func openPreparedDraft() {
        guard let handoff = store.changeRequestDraftHandoff, handoff.identity == store.connectionIdentity,
              store.projects.contains(where: { $0.id == handoff.result.projectId }) else { return }
        let key = handoff.result.projectId
        var draft = taskDrafts[key] ?? AgentTaskDraft(); draft.workspace = handoff.result.selection; draft.requestId = UUID().uuidString; taskDrafts[key] = draft
        draftProjectId = key; workspaceScope = key; selectedTask = nil; navigation.section = .tasks; mobileTab = 2; mobileTaskPath = []
        #if os(iOS)
        choosingMobileWorkspace = true
        #endif
    }

    private func openSameBranchDraft(_ source: WorkItem) {
        guard store.connected, store.taskExistingWorkspaceSupported, store.snapshotIdentity == store.connectionIdentity, source.subagentOrigin == nil,
              let current = store.tasks.first(where: { $0.id == source.id && $0.cwd == source.cwd }),
              let branch = current.git?.branch, let key = current.projectId,
              store.projects.contains(where: { $0.id == key }) else { return }
        var workspace = TaskWorkspaceSelection()
        workspace.mode = current.git?.isWorktree == true ? "worktree" : "checkout"
        workspace.branch = "refs/heads/" + branch; workspace.reuseTaskId = current.id
        workspace.preparedBranch = branch; workspace.preparedPath = current.cwd
        var draft = taskDrafts[key] ?? AgentTaskDraft(); draft.workspace = workspace; draft.requestId = UUID().uuidString; taskDrafts[key] = draft
        draftProjectId = key; selectedTask = nil; navigation.section = .tasks; mobileTab = 2; mobileTaskPath = []
        #if os(iOS)
        choosingMobileWorkspace = true
        #endif
    }
    #if os(iOS)
    private var mobileTaskDock: some View {
        FridayMobileComposerDock() {
            HStack(spacing: 0) {
                Button { draftProjectId = nil; choosingMobileWorkspace = true } label: {
                    Text("Let's do it.")
                        .font(.body).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.leading, 16)
                        .contentShape(Rectangle())
                }
                .buttonStyle(FridaySymbolButtonStyle())
                MobileTaskModelControl(store: store, selection: $mobileModelChoice)
            }
            .modifier(FridayMobileInputSurface())
        }
    }

    private var mobileNewTaskSheet: some View {
        NavigationStack {
            Group {
                if let project = store.projects.first(where: { $0.id == draftProjectId }),
                   taskDrafts[project.id]?.workspace.preparationId != nil || taskDrafts[project.id]?.workspace.reuseTaskId != nil {
                    NewAgentTaskView(store: store, project: project, onCreated: finishMobileTask, drafts: $taskDrafts)
                } else { mobileWorkspaceChoices }
            }.toolbar { Button(friday: "取消") { choosingMobileWorkspace = false } }
        }
        .environment(\.mobileNewTaskModel, $mobileModelChoice)
    }
    private func finishMobileTask(_ id: String) { choosingMobileWorkspace = false; openLocalTask(id) }
    private var mobileWorkspaceChoices: some View {
        NewAgentTaskView(store: store, project: store.projects.first { $0.id == draftProjectId }, onSelectProject: { draftProjectId = $0.id }, onCreated: finishMobileTask, drafts: $taskDrafts)
            .navigationTitle(Text(friday: "新任务"))
    }
    #endif

    private func openLocalTask(_ id: String) {
        if let task = store.tasks.first(where: { $0.id == id }), let workspaceScope {
            let defaults = UserDefaults.standard
            let groups = TaskProjectSidebar.groups(store.projects, tasks: store.tasks,
                mode: TaskProjectGrouping(rawValue: defaults.string(forKey: FridayPreferenceKeys.projectGrouping) ?? "") ?? .repository,
                overrides: TaskProjectSidebar.dictionaries(defaults.data(forKey: FridayPreferenceKeys.projectGroupingOverrides) ?? Data())[store.connection.server] ?? [:])
            if let group = groups.first(where: { $0.id == workspaceScope }), TaskProjectSidebar.filtered([task], group: group, projects: store.projects).isEmpty { self.workspaceScope = nil }
        }
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
                                TaskRow(task: task, workspaceName: TaskWorkspaces.name(for: task, in: store.projects), workspace: TaskWorkspaces.project(for: task, in: store.projects), selected: selectedTask == task.id,
                                    acknowledgeWake: { Task { await store.acknowledgeTaskWake(task) } }).padding(.horizontal, 12)
                                    .foregroundStyle(FridayTheme.foreground)
                            }.buttonStyle(TaskRowButtonStyle(selected: selectedTask == task.id))
                                .accessibilityAddTraits(selectedTask == task.id ? .isSelected : [])
                        }
                    }.padding(.horizontal, 10)
                }
                #else
                MobileTaskList(store: store)
                #endif
            }
        }
    }

    private func newTask() { startingConversation = true; selectedConversation = nil; navigation.section = .chat; mobileTab = 0 }
}

#if os(macOS)
/// Task output changes the store frequently; the rail only needs navigation
/// and the active count. Keep its symbols, hover and focus state independent.
private struct FridaySidebar: View, Equatable {
    @ObservedObject var navigation: FridayNavigation
    let activeTaskCount: Int
    @FocusState private var focusedSection: FridaySection?
    @State private var activations: [FridaySection: Int] = [:]

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.navigation === rhs.navigation && lhs.activeTaskCount == rhs.activeTaskCount
    }

    var body: some View {
        VStack(spacing: 8) {
            VStack(spacing: 8) {
                ForEach(FridaySection.allCases.filter { $0 != .settings }) { item in row(item) }
            }
            Spacer(minLength: 16)
            FridayUpdateNoticeButton()
            row(.settings)
                .help(Text(friday: "设置（⌘,）"))
        }
        .padding(.top, FridayTheme.sidebarTopInset)
        .padding(.bottom, 12)
        .frame(width: FridayTheme.sidebarWidth)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .top) {
            if #available(macOS 15.0, *) {
                FridayWindowControls().frame(height: FridayTheme.sidebarTopInset)
            }
        }
    }

    private func row(_ item: FridaySection) -> some View {
        let animatesSymbol = item == .inbox || item == .settings
        return Button {
            if animatesSymbol { activations[item, default: 0] += 1 }
            if navigation.section != item { navigation.section = item }
        } label: {
            if animatesSymbol {
                Label {
                    Text(fridayString: item.rawValue)
                } icon: {
                    FridaySidebarSymbolImage(systemName: item.icon,
                                             motion: item == .settings ? .rotate : .drawOn)
                }
                .fridaySidebarSymbolFeedback(value: activations[item, default: 0])
            } else {
                Label(friday: item.rawValue, systemImage: item.icon)
            }
        }
        .buttonStyle(FridaySidebarButtonStyle(selected: navigation.section == item, focused: focusedSection == item))
        .focused($focusedSection, equals: item)
        .focusEffectDisabled()
        .help(Text(fridayString: item.rawValue))
        .accessibilityAddTraits(navigation.section == item ? .isSelected : [])
        .accessibilityValue(item == .tasks && activeTaskCount > 0
            ? Text(friday: "\(activeTaskCount) 个进行中的任务") : Text(""))
    }
}

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
            .fridayInteractiveCursor()
    }
}
#endif
