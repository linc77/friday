import SwiftUI
#if os(macOS)
import AppKit
#endif

private enum FridaySection: String, CaseIterable, Identifiable {
    case inbox = "想法", tasks = "任务", projects = "项目", memory = "记忆"
    var id: String { rawValue }
    var icon: String {
        switch self {
        case .inbox: "tray"
        case .tasks: "checklist"
        case .projects: "folder"
        case .memory: "sparkles"
        }
    }
}

@MainActor
public struct FridayRootView: View {
    @StateObject private var store = FridayStore()
    @State private var section: FridaySection? = .inbox
    @State private var selectedTask: String?
    @State private var composing = false
    @State private var seed = ""
    @State private var ideaId: String?
    @State private var mobileTab = 0
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
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
            NavigationSplitView {
                sidebar.navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 270)
            } detail: {
                VStack(spacing: 0) {
                    if let error = store.error { errorBanner(error) }
                    content
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(FridayTheme.canvas)
                .navigationTitle(section?.rawValue ?? "Friday")
                .toolbar { windowToolbar }
                .toolbarBackground(.hidden, for: .windowToolbar)
            }
            .navigationSplitViewStyle(.balanced)
            .frame(minWidth: 980, minHeight: 640)
            #else
            TabView(selection: $mobileTab) {
                NavigationStack { inbox.navigationTitle("想法").toolbar { Button { newTask() } label: { Image(systemName: "plus") } } }.tabItem { Label("想法", systemImage: "tray") }.tag(0)
                NavigationStack { tasksList.navigationTitle("任务").navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id) } }.tabItem { Label("任务", systemImage: "checklist") }.tag(1)
                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink("项目") { ProjectsView(store: store) }
                        NavigationLink("记忆") { MemoriesView(store: store) }
                        NavigationLink("本地工具") { AgentsView(store: store) }
                        NavigationLink("连接与设备") { ConnectionView(store: store) }
                    }.navigationTitle("我的 Friday")
                }.tabItem { Label("设置", systemImage: "gear") }.tag(2)
            }
            #endif
        }
        .tint(FridayTheme.accent)
        .accentColor(FridayTheme.accent)
        .sheet(isPresented: $composing) {
            TaskComposer(store: store, initialPrompt: seed, ideaId: ideaId) { id in selectedTask = id; section = .tasks; mobileTab = 1 }
        }
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
    @ToolbarContentBuilder private var windowToolbar: some ToolbarContent {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            DefaultToolbarItem(kind: .sidebarToggle)
                .sharedBackgroundVisibility(.hidden)
            newTaskToolbarItem.sharedBackgroundVisibility(.hidden)
        } else {
            newTaskToolbarItem
        }
        #else
        newTaskToolbarItem
        #endif
    }

    private var newTaskToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button { newTask() } label: { Label("新任务", systemImage: "square.and.pencil") }
                .buttonStyle(FridayToolbarButtonStyle())
                .keyboardShortcut("n", modifiers: .command).help("新任务（⌘N）")
        }
    }

    private var sidebar: some View {
        List(selection: $section) {
            SwiftUI.Section("工作空间") {
                ForEach([FridaySection.inbox, .tasks, .projects, .memory]) { item in sidebarRow(item) }
            }
        }
        .listStyle(.sidebar).scrollContentBackground(.hidden)
        .safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) {
            FridaySettingsLink()
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
        }
    }

    private func sidebarRow(_ item: FridaySection) -> some View {
        HStack(spacing: 11) {
            Image(systemName: item.icon).font(.system(size: 16, weight: .regular)).frame(width: 22)
            Text(item.rawValue).font(.system(size: 14, weight: section == item ? .semibold : .regular))
            Spacer(minLength: 4)
            if item == .tasks, store.tasks.contains(where: { $0.active }) {
                Text("\(store.tasks.filter { $0.active }.count)").font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary).accessibilityLabel("进行中的任务数")
            }
        }
        .padding(.vertical, 7).tag(item).listRowSeparator(.hidden)
    }
    #endif

    private var connectionStatus: some View {
        HStack(spacing: 8) {
            Image(systemName: store.connected ? "checkmark.circle" : "wifi.slash")
                .foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(store.connected ? "主机已连接" : "等待连接主机").font(.caption.weight(.medium))
                if !store.outbox.isEmpty { Text("\(store.outbox.count) 条想法待同步").font(.caption2).foregroundStyle(.secondary) }
            }
        }.accessibilityElement(children: .combine)
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle")
            Text(message).lineLimit(2)
            Spacer()
            Button("连接设置") {
                #if os(macOS)
                selectConnectionSettings()
                openSettings()
                #else
                mobileTab = 2
                #endif
            }.buttonStyle(FridayButtonStyle(compact: true))
        }
        .font(.caption).padding(12).background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 20).padding(.top, 8)
    }

    @ViewBuilder private var content: some View {
        switch section ?? .inbox {
        case .inbox: inbox
        case .tasks:
            #if os(macOS)
            HSplitView {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("所有任务").font(.headline)
                        Spacer()
                        Text("\(store.tasks.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }.padding(.horizontal, 20).padding(.top, 22).padding(.bottom, 8)
                    tasksList
                }
                .frame(minWidth: 230, idealWidth: 260, maxWidth: 310, maxHeight: .infinity)
                .background(FridayTheme.surface.opacity(0.45))
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
        InboxView(store: store) { idea in seed = idea.text; ideaId = idea.id; composing = true }
    }

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

    private func newTask() { seed = ""; ideaId = nil; composing = true }
}

struct TaskRow: View {
    let task: WorkItem
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text(task.title).font(.callout.weight(.medium)).lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                StatusBadge(task: task)
                Spacer(minLength: 4)
                Image(systemName: task.mode == "research" ? "magnifyingglass" : "chevron.left.forwardslash.chevron.right")
                    .font(.caption).foregroundStyle(.tertiary)
                    .accessibilityLabel(task.mode == "research" ? "调研任务" : "代码任务")
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
                            Label("待同步", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
                        }.padding(20).fridayCard()
                    }
                    ForEach(store.ideas) { idea in
                        VStack(alignment: .leading, spacing: 20) {
                            Text(idea.text).font(.body).lineSpacing(4).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            HStack {
                                Text(idea.createdAt.prefix(10)).font(.caption).foregroundStyle(.tertiary)
                                Spacer()
                                if idea.taskId != nil {
                                    Label("已布置任务", systemImage: "checkmark.circle").font(.caption).foregroundStyle(FridayTheme.accent)
                                } else {
                                    Button { delegate(idea) } label: { Label("交给 Friday", systemImage: "arrow.up.right") }
                                        .buttonStyle(FridayButtonStyle(compact: true))
                                }
                            }
                        }.padding(22).fridayCard()
                        .contextMenu { Button("删除想法", role: .destructive) { Task { _ = await store.perform("/api/ideas/\(idea.id)", method: "DELETE") } } }
                    }
                }
                if store.ideas.isEmpty && store.outbox.isEmpty {
                    EmptyPanel(icon: "tray", title: "为下一个念头留个位置", subtitle: "想研究的项目、突然出现的点子、要处理的小事，都可以从这里开始。")
                }
            }
            .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity)
        }.background(FridayTheme.canvas)
    }
}

struct TaskComposer: View {
    @ObservedObject var store: FridayStore
    let initialPrompt: String; let ideaId: String?; let onCreated: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var project = ""
    @State private var mode = "research"
    @State private var requestId = UUID().uuidString
    @State private var submitting = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("交给 Friday").font(.title2.bold()); Spacer(); Button("取消") { dismiss() }.keyboardShortcut(.cancelAction) }
            Text("说清楚你想得到什么，Friday 会替你推进。").foregroundStyle(.secondary)
            TextEditor(text: $prompt).frame(minHeight: 130).padding(8).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary)).accessibilityLabel("任务要求")
            Picker("任务类型", selection: $mode) { Text("调研与整理").tag("research"); Text("代码任务").tag("code") }.pickerStyle(.segmented)
            Picker("关联项目", selection: $project) { Text("不关联项目").tag(""); ForEach(store.projects) { Text($0.name).tag($0.id) } }
            HStack { Image(systemName: "terminal"); Text("由主机上的 Codex 执行"); Spacer() }.font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack { Spacer(); if submitting { ProgressView().controlSize(.small) }; Button("开始任务") {
                submitting = true
                Task {
                    do { let id = try await store.createTask(prompt: prompt, projectId: project, mode: mode, ideaId: ideaId, requestId: requestId); onCreated(id); dismiss() }
                    catch { self.error = error.localizedDescription }
                    submitting = false
                }
            }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(submitting || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected || (mode == "code" && project.isEmpty)) }
        }.padding(28).background(FridayTheme.canvas)
        #if os(macOS)
        .frame(width: 550)
        #endif
        .onAppear { prompt = initialPrompt }
    }
}
