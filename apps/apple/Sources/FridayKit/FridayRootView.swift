import SwiftUI
#if os(macOS)
import AppKit
#endif

private let fridayResourceBundle: Bundle = {
    // The packaged Mac app keeps SwiftPM resources in Contents/Resources.
    #if os(macOS)
    if let url = Bundle.main.url(forResource: "Friday_FridayKit", withExtension: "bundle"),
       let bundle = Bundle(url: url) { return bundle }
    #endif
    return .module
}()

private let fridayAccent = Color(red: 0.12, green: 0.49, blue: 0.43)
private enum Section: String, CaseIterable, Identifiable {
    case chat = "对话", inbox = "想法", tasks = "记录", projects = "项目", memory = "记忆", agents = "工具", connection = "连接"
    var id: String { rawValue }
    var icon: String {
        switch self { case .chat: "bubble.left.and.bubble.right"; case .inbox: "tray"; case .tasks: "clock"; case .projects: "folder"; case .memory: "sparkles"; case .agents: "terminal"; case .connection: "network" }
    }
}

@MainActor
public struct FridayRootView: View {
    @StateObject private var store = FridayStore()
    @State private var section: Section? = .chat
    @State private var selectedTask: String?
    @State private var mobileTab = 0
    @Environment(\.scenePhase) private var scenePhase
    public init() {}
    public var body: some View {
        Group {
            #if os(macOS)
            NavigationSplitView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack(spacing: 10) {
                        Image("FridayLogo", bundle: fridayResourceBundle)
                            .resizable().scaledToFit().frame(width: 36, height: 36)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) { Text("Friday").font(.title2.bold()); Text("你的个人 Agent").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.horizontal, 16).padding(.top, 20)
                    List(Section.allCases, selection: $section) { item in Label(item.rawValue, systemImage: item.icon).tag(item).padding(.vertical, 5) }.listStyle(.sidebar)
                    connectionStatus.padding(16)
                }.navigationSplitViewColumnWidth(min: 160, ideal: 190, max: 240)
            } detail: {
                VStack(spacing: 0) {
                    if let error = store.error { errorBanner(error) }
                    content
                }
                .navigationTitle(section == .chat ? "Friday" : section?.rawValue ?? "Friday")
                .toolbar { Button { newTask() } label: { Label("新对话", systemImage: "square.and.pencil") }.keyboardShortcut("n", modifiers: .command) }
            }
            .frame(minWidth: 920, minHeight: 620)
            #else
            TabView(selection: $mobileTab) {
                NavigationStack {
                    VStack(spacing: 0) { if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).padding(8) }; conversation }
                        .navigationTitle("Friday").toolbar { Button { newTask() } label: { Label("新对话", systemImage: "square.and.pencil") } }
                }.tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }.tag(0)
                NavigationStack { inbox.navigationTitle("想法") }.tabItem { Label("想法", systemImage: "tray") }.tag(1)
                NavigationStack { tasksList.navigationTitle("记录").navigationDestination(for: String.self) { id in TaskDetail(store: store, id: id) } }.tabItem { Label("记录", systemImage: "clock") }.tag(2)
                NavigationStack {
                    List {
                        connectionStatus
                        if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange) }
                        NavigationLink("项目") { ProjectsView(store: store) }
                        NavigationLink("记忆") { MemoriesView(store: store) }
                        NavigationLink("本地工具") { AgentsView(store: store) }
                        NavigationLink("连接与设备") { ConnectionView(store: store) }
                    }.navigationTitle("我的 Friday")
                }.tabItem { Label("设置", systemImage: "slider.horizontal.3") }.tag(3)
            }
            #endif
        }
        .tint(fridayAccent)
        .task { await store.importSharedIdeas(); await store.connect() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await store.importSharedIdeas(); await store.connect() } }
        }
        .onOpenURL { url in
            guard url.scheme == "friday", url.host == "capture", let components = URLComponents(url: url, resolvingAgainstBaseURL: false), let text = components.queryItems?.first(where: { $0.name == "text" })?.value else { return }
            Task { await store.saveIdea(text) }
        }
    }
    private var connectionStatus: some View {
        HStack(spacing: 7) {
            Circle().fill(store.connected ? fridayAccent : Color.orange).frame(width: 7, height: 7)
            Text(store.connected ? "主机已连接" : "等待连接主机").font(.caption).foregroundStyle(.secondary)
            if !store.outbox.isEmpty { Text("\(store.outbox.count) 条待同步").font(.caption2) }
        }
    }
    private func errorBanner(_ message: String) -> some View {
        HStack { Image(systemName: "exclamationmark.circle"); Text(message).lineLimit(2); Spacer(); Button("连接设置") { section = .connection } }
            .font(.caption).padding(10).background(Color.orange.opacity(0.1))
    }
    @ViewBuilder private var content: some View {
        switch section ?? .chat {
        case .chat: conversation
        case .inbox: inbox
        case .tasks:
            #if os(macOS)
            HSplitView {
                tasksList.frame(minWidth: 230, idealWidth: 280, maxWidth: 340)
                if let selectedTask { TaskDetail(store: store, id: selectedTask).frame(minWidth: 460) }
                else { EmptyPanel(icon: "checklist", title: "选择一个任务", subtitle: "查看进展、补充要求，或收下完成的成果。") }
            }
            #else
            tasksList
            #endif
        case .projects: ProjectsView(store: store)
        case .memory: MemoriesView(store: store)
        case .agents: AgentsView(store: store)
        case .connection: ConnectionView(store: store)
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
                List(selection: $selectedTask) { ForEach(store.tasks.reversed()) { task in TaskRow(task: task).tag(task.id) } }.listStyle(.inset)
                #else
                List(store.tasks.reversed()) { task in NavigationLink(value: task.id) { TaskRow(task: task) } }.refreshable { await store.refresh() }
                #endif
            }
        }
    }
    private func newTask() { selectedTask = nil; section = .chat; mobileTab = 0 }
}

struct EmptyPanel: View {
    let icon: String; let title: String; let subtitle: String
    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: icon).font(.system(size: 34, weight: .light)).foregroundStyle(fridayAccent)
            Text(title).font(.title3.weight(.semibold))
            Text(subtitle).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 340)
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
struct StatusBadge: View {
    let task: WorkItem
    var color: Color { switch task.status { case "completed": fridayAccent; case "waiting", "interrupted", "needs_project": .orange; case "failed": .red; case "running": .blue; default: .secondary } }
    var body: some View { Text(task.statusText).font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 4).background(color.opacity(0.1), in: Capsule()).foregroundStyle(color) }
}
struct TaskRow: View {
    let task: WorkItem
    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack { Text(task.title).font(.body.weight(.medium)).lineLimit(2); Spacer(minLength: 0) }
            HStack { StatusBadge(task: task); Spacer(); Text(task.createdAt.prefix(10)).font(.caption).foregroundStyle(.secondary) }
        }.padding(.vertical, 8)
    }
}

struct InboxView: View {
    @ObservedObject var store: FridayStore
    let delegate: (Idea) -> Void
    @AppStorage("friday.ideaDraft") private var draft = ""
    @State private var saving = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) { Text("把想法放在这里").font(.largeTitle.weight(.semibold)); Text("先记下来，准备好了再交给 Friday。").foregroundStyle(.secondary) }
                VStack(alignment: .trailing, spacing: 12) {
                    TextEditor(text: $draft).font(.body).frame(minHeight: 85).scrollContentBackground(.hidden).accessibilityLabel("记录想法")
                    HStack {
                        Text("文字、链接，都可以。").font(.caption).foregroundStyle(.secondary); Spacer()
                        Button("收下这个想法") {
                            let text = draft; saving = true
                            Task { if await store.saveIdea(text), draft == text { draft = "" }; saving = false }
                        }.buttonStyle(.borderedProminent).disabled(saving || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(16).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 16))
                ForEach(store.outbox) { idea in HStack { Text(idea.text); Spacer(); Label("待同步", systemImage: "clock").font(.caption).foregroundStyle(.secondary) }.padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 12)) }
                if store.ideas.isEmpty && store.outbox.isEmpty { EmptyPanel(icon: "tray", title: "为下一个念头留个位置", subtitle: "想研究的项目、突然出现的点子、要处理的小事，都可以从这里开始。") }
                ForEach(store.ideas) { idea in
                    VStack(alignment: .leading, spacing: 14) {
                        Text(idea.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        HStack {
                            Text(idea.createdAt.prefix(10)).font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button { delegate(idea) } label: { Label(idea.taskId == nil ? "交给 Friday" : "打开对话", systemImage: idea.taskId == nil ? "arrow.up.right" : "bubble.left") }.buttonStyle(.bordered).disabled((!store.connected && idea.taskId == nil) || store.delegatingIdeas.contains(idea.id))
                        }
                    }.padding(18).background(.background, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
                    .contextMenu { Button("删除想法", role: .destructive) { Task { _ = await store.perform("/api/ideas/\(idea.id)", method: "DELETE") } } }
                }
            }.padding(28).frame(maxWidth: 850)
            .frame(maxWidth: .infinity)
        }
    }
}

struct TaskDetail: View {
    @ObservedObject var store: FridayStore; let id: String
    @State private var message = ""
    @State private var messageId = UUID().uuidString
    @State private var showEvents = false
    @State private var sending = false
    var task: WorkItem? { store.tasks.first { $0.id == id } }
    var body: some View {
        if let task {
            VStack(spacing: 0) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 8) { Text(task.title).font(.title3.bold()).lineLimit(2).textSelection(.enabled); StatusBadge(task: task) }
                    Spacer()
                    if task.active || task.status == "needs_project" { Button("停止", role: .destructive) { Task { _ = await store.perform("/api/tasks/\(id)/cancel") } }.disabled(!store.connected) }
                }.padding(22)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        DisclosureGroup("执行详情", isExpanded: $showEvents) {
                            VStack(alignment: .leading, spacing: 16) {
                                Text("执行工具：\(task.agent.capitalized)").font(.caption).foregroundStyle(.secondary)
                                if task.projectId != nil { Text("工作目录：\(task.cwd)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                                if let thread = task.threadId { Text("会话 \(thread)").font(.caption2.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled) }
                                ForEach(task.events) { event in
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text("\(event.at.dropFirst(11).prefix(8)) · \(event.kind)").font(.caption2).foregroundStyle(.secondary)
                                        Text(event.text).font(.system(.caption, design: event.kind == "command" || event.kind == "files" ? .monospaced : .default)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                            }.padding(.top, 12)
                        }.font(.callout)
                        ForEach(task.conversation) { message in
                            if message.role == "user" {
                                HStack { Spacer(minLength: 36); Text(message.text).padding(14).background(fridayAccent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14)).textSelection(.enabled) }
                            } else {
                                VStack(alignment: .leading, spacing: 8) { Text("Friday").font(.caption.weight(.medium)).foregroundStyle(.secondary); Text(.init(message.text)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled).lineSpacing(5) }
                            }
                        }
                        if task.status == "needs_project" { WorkspaceChoice(store: store, task: task).id(task.durableId) }
                        ForEach(task.approvals.filter { $0.state == "pending" }) { approval in ApprovalCard(store: store, taskId: id, approval: approval) }
                        if let error = task.error { Label(error, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
                        if task.active { HStack { ProgressView().controlSize(.small); Text(task.status == "queued" ? "已排队，稍后开始。" : task.status == "waiting" ? "等你处理上面的请求。" : "正在处理，可以继续补充。").font(.callout).foregroundStyle(.secondary) } }
                        if task.artifact != nil { ShareLink(item: task.result) { Label("导出结果", systemImage: "square.and.arrow.up") }.font(.caption) }
                    }.padding(22)
                }
                Divider()
                VStack(alignment: .leading, spacing: 10) {
                    TextField("补充要求，或接着聊…", text: $message, axis: .vertical).lineLimit(2...5).textFieldStyle(.plain).accessibilityLabel("补充要求")
                    HStack {
                        if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).lineLimit(2) }
                        Spacer()
                        Button("发送") {
                            sending = true
                            let text = message
                            Task {
                                if await store.perform("/api/tasks/\(id)/message", body: ["text": text, "requestId": messageId]) { if message == text { message = "" }; messageId = UUID().uuidString }
                                sending = false
                            }
                        }.buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).disabled(sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued")
                    }
                }.padding(18)
            }.navigationTitle("Friday")
            .onChange(of: id) { _, _ in message = ""; messageId = UUID().uuidString }
        } else { EmptyPanel(icon: "checklist", title: "正在加载任务", subtitle: "连接主机后会显示最新进展。") }
    }
}

struct ApprovalCard: View {
    @ObservedObject var store: FridayStore; let taskId: String; let approval: Approval
    @State private var answers: [String: String] = [:]
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(approval.title, systemImage: "hand.raised").font(.headline)
            Text(approval.detail).font(.callout).textSelection(.enabled)
            ForEach(approval.questions) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.question).font(.callout.weight(.medium))
                    ForEach(question.options, id: \.label) { option in Button(option.label) { answers[question.id] = option.label }.buttonStyle(.bordered) }
                    TextField("你的回答", text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 })).textFieldStyle(.roundedBorder)
                }
            }
            HStack { Spacer(); if approval.questions.isEmpty { Button("拒绝") { respond("decline") }.buttonStyle(.bordered) }; Button(approval.questions.isEmpty ? "允许本次" : "提交回答") { respond("accept") }.buttonStyle(.borderedProminent) }
        }.padding(18).background(Color.orange.opacity(0.09), in: RoundedRectangle(cornerRadius: 12)).disabled(busy || !store.connected)
    }
    private func respond(_ decision: String) {
        busy = true
        Task { _ = await store.perform("/api/tasks/\(taskId)/approvals/\(approval.id)", body: ["decision": decision, "answers": answers.mapValues { [$0] }]); busy = false }
    }
}
