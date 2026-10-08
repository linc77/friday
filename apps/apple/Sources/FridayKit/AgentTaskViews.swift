import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NewAgentTaskView: View {
    @ObservedObject var store: FridayStore
    var project: Project? = nil
    var onSelectProject: (Project) -> Void = { _ in }
    let onCreated: (String) -> Void
    @Binding var drafts: [String: AgentTaskDraft]
    @State private var sending = false
    @State private var error: String?
    @StateObject private var workspaceState = TaskWorkspaceState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var draftKey: String { project?.id ?? "" }
    private var gitPath: String { "/api/projects/\(draftKey)/git" }
    private var workspaceTransition: Animation? {
        reduceMotion || scenePhase != .active ? nil : .easeInOut(duration: 0.24)
    }
    private var showsExecutionLocation: Bool {
        project != nil && workspaceState.options(for: gitPath)?.git.status == "repository"
    }
    private var workspaceReady: Bool {
        workspaceState.isReady(for: gitPath) && workspaceState.options(for: gitPath).map { workspace.wrappedValue.isValid(in: $0) } == true
    }
    private var workspace: Binding<TaskWorkspaceSelection> {
        Binding(get: {
            (drafts[draftKey]?.workspace ?? TaskWorkspaceSelection()).resolved(in: workspaceState.options(for: gitPath))
        }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.workspace = value
        })
    }
    private var message: Binding<String> {
        Binding(get: { drafts[draftKey]?.message ?? "" }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.message = value
        })
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                taskForm(availableWidth: min(geometry.size.width - 56, FridayTheme.contentWidth))
                    .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56)
                    .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                    .animation(workspaceTransition, value: draftKey)
                    .animation(workspaceTransition, value: showsExecutionLocation)
            }.scrollBounceBehavior(.basedOnSize)
        }
        .background(FridayTheme.canvas)
        .task(id: "\(draftKey):\(store.connected)") {
            guard project != nil else { return }
            await workspaceState.refresh(store: store, path: gitPath)
        }
    }

    private func taskForm(availableWidth: CGFloat) -> some View {
        let columnCount = max(1, min(store.projects.count, Int((availableWidth + 12) / 232)))
        return VStack(spacing: 28) {
            VStack(spacing: 12) {
                if let project {
                    Text(friday: "在 \(project.name) 中开始新任务").font(.system(size: 28, weight: .medium))
                    Text(friday: "选择模型，把任务交给 Claude Code 或 Codex。")
                        .font(.callout).foregroundStyle(.secondary)
                    if let options = workspaceState.options(for: gitPath), options.git.status == "repository" {
                        TaskExecutionLocationPicker(selection: workspace, options: options)
                            .padding(.top, 6).disabled(sending || !store.connected)
                            .transition(.opacity)
                    }
                } else {
                    Text(friday: "从一个 Workspace 开始").font(.system(size: 28, weight: .medium))
                    Text(fridayString: store.projects.isEmpty
                        ? "先添加一个 Workspace，再把任务交给 Agent。"
                        : "选择下方的 Workspace，再把任务交给 Agent。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity)
                .id(draftKey).transition(.opacity)
            if project == nil && !store.projects.isEmpty {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: columnCount), spacing: 12) {
                    ForEach(store.projects) { project in
                        Button { onSelectProject(project) } label: {
                            HStack(spacing: 12) {
                                WorkspaceIcon(name: project.name, icon: project.icon, color: project.color, size: 32)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(project.name).font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(.primary).lineLimit(1)
                                    Text(project.path).font(.caption).foregroundStyle(.secondary)
                                        .lineLimit(1).truncationMode(.middle)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                FridaySymbolImage(systemName: "chevron.right")
                                    .font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }.padding(16).frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
                        }.buttonStyle(NewTaskWorkspaceCardStyle())
                            .accessibilityLabel(Text(project.name))
                            .accessibilityHint(Text(friday: "在此 Workspace 中开始新任务"))
                            .help(project.path)
                    }
                }.transition(.opacity)
            }
            if let error = error ?? workspaceState.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            else if let options = workspaceState.options(for: gitPath), !workspace.wrappedValue.isValid(in: options) {
                Text(friday: "所选分支不可用，请重新选择。").font(.caption).foregroundStyle(.orange)
            }
            AgentTaskComposer(store: store, projectPath: project?.path, projectId: project?.id, workspace: workspace,
                workspaceState: workspaceState, workspaceReady: workspaceReady, requiresProject: true, message: message, sending: sending, send: send)
        }
    }

    private func send(_ provider: String, _ model: String, _ effort: String) {
        guard let project, !sending else { return }
        let draft = drafts[project.id] ?? AgentTaskDraft()
        guard !draft.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let executionWorkspace = workspace.wrappedValue
        drafts[project.id] = draft
        sending = true; error = nil
        Task {
            do {
                let id = try await store.createTask(prompt: draft.message, requestId: draft.requestId, projectId: project.id, agent: provider, model: model, reasoningEffort: effort, workspace: executionWorkspace)
                drafts[project.id] = nil; onCreated(id)
            } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}

private struct NewTaskWorkspaceCardStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        NewTaskWorkspaceCardBody(configuration: configuration)
    }
}

private struct NewTaskWorkspaceCardBody: View {
    let configuration: ButtonStyleConfiguration
    @State private var hovering = false
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        configuration.label
            .fridayCard(radius: 14, highlighted: hovering && isEnabled && scenePhase == .active)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(RoundedRectangle(cornerRadius: 14))
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
            .onHover { hovering = $0 }
            .onChange(of: scenePhase) { _, phase in if phase != .active { hovering = false } }
    }
}

struct AgentTaskDraft {
    var message = ""
    var workspace = TaskWorkspaceSelection()
    let requestId = UUID().uuidString
}

struct AgentTaskComposer: View {
    @ObservedObject var store: FridayStore
    var task: WorkItem? = nil
    var projectPath: String? = nil
    var projectId: String? = nil
    var workspace: Binding<TaskWorkspaceSelection>? = nil
    var workspaceState: TaskWorkspaceState? = nil
    var workspaceReady = true
    var requiresProject = false
    var embeddedInMobileDock = false
    @Binding var message: String
    let sending: Bool
    let send: (String, String, String) -> Void
    @State private var states: [String: CodexConnectionState] = [:]
    @State private var provider = "codex"
    @State private var showModels = false
    @State private var model = ""
    @State private var effort = ""
    @State private var error: String?
    @State private var switchingBranch = false
    @FocusState private var focused: Bool
    @Environment(\.locale) private var locale
    private var state: CodexConnectionState? { states[provider] }
    private var providerName: String { provider == "claude" ? "Claude" : "Codex" }
    private var connectionError: String? { error ?? (state?.enabled == false ? "已停用" : state?.error) }
    private var active: Bool { task?.active == true }
    private var disabled: Bool { sending || switchingBranch || task?.branchChange?.active == true || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task?.status == "queued" || (requiresProject && projectPath == nil) || !workspaceReady || (!active && state?.connected != true) }
    private var selectedModel: CodexProviderModel? { state?.models.first { $0.id == (model.isEmpty ? state?.model : model) } }
    private var showsBranchControl: Bool {
        if let task { return task.git?.status == "repository" }
        guard let projectId else { return false }
        return workspaceState?.options(for: "/api/projects/\(projectId)/git")?.git.status == "repository"
    }
    private var placeholder: String {
        if requiresProject && projectPath == nil {
            return store.projects.isEmpty ? "先添加一个 Workspace…" : "先选择上方的 Workspace…"
        }
        return active ? "补充任务要求…" : "这个任务要完成什么…"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 16) {
                TextField(friday: placeholder, text: $message, axis: .vertical)
                    .font(.body).lineLimit((embeddedInMobileDock ? 1 : (task == nil ? 3 : 2))...6).textFieldStyle(.plain).focused($focused)
                    .disabled(sending || (requiresProject && projectPath == nil))
                    .accessibilityLabel(Text(friday: "任务要求"))
                    .onChatSubmit { if !disabled { send(provider, model, effort) } }
                Button { send(provider, model, effort) } label: {
                    FridaySymbolImage(systemName: "arrow.up").fridaySymbolFeedback()
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
                    .keyboardShortcut(.return, modifiers: .command).disabled(disabled)
            }
            if let connectionError { Text(fridayString: connectionError).font(.caption).foregroundStyle(.orange).lineLimit(2) }
            HStack(spacing: 12) {
                modelControls
                Divider().frame(height: 16)
                TaskReasoningEffortControl(selection: $effort, efforts: selectedModel?.reasoningEfforts ?? [],
                    defaultEffort: selectedModel?.defaultReasoningEffort ?? "")
                    .disabled(active || sending)
                Spacer(minLength: 0)
            }.font(.callout).foregroundStyle(.secondary)
        }
        .modifier(AgentTaskComposerSurface(embeddedInMobileDock: embeddedInMobileDock, focused: focused))
        #if os(macOS)
        .onChange(of: projectId) { _, id in
            if requiresProject && id != nil { focused = true }
        }
        #endif
        #if os(iOS)
        .onDisappear { focused = false }
        #endif
        .task(id: task?.id) { provider = task?.agent ?? "codex"; model = task?.model ?? ""; effort = task?.reasoningEffort ?? "" }
        .task(id: store.connected) {
            guard store.connected else { return }
            for value in ["codex", "claude"] {
                do { states[value] = try await store.connection.decode(CodexConnectionState.self, "/api/agents/\(value)") }
                catch { if value == provider { self.error = error.localizedDescription } }
            }
            if task == nil && states[provider]?.connected != true && states["claude"]?.connected == true { provider = "claude"; model = ""; effort = ""; error = nil }
        }
    }

    private var modelControls: some View {
        HStack(spacing: 12) {
            if showsBranchControl {
                branchControl
                Divider().frame(height: 16)
            }
            Button { showModels.toggle() } label: {
                HStack(spacing: 5) {
                    AgentProviderIcon(provider: provider, size: 14)
                    Text(selectedModel?.selectionName ?? (model.isEmpty ? providerName : model)).lineLimit(1)
                }
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(active || sending).accessibilityLabel(Text(friday: "任务模型"))
                .popover(isPresented: $showModels) {
                    TaskModelPicker(server: store.connection.server, states: states, lockedProvider: task?.agent, provider: provider, model: selectedModel?.id ?? model) { choice in
                        provider = choice.provider; model = choice.model.id; effort = ""; showModels = false
                    }.environment(\.locale, locale)
                }
        }
    }

    @ViewBuilder private var branchControl: some View {
        if let task {
            ExistingTaskBranchControl(store: store, task: task, submitting: $switchingBranch).id(task.id).disabled(sending)
        } else if let projectId, let workspace, let workspaceState {
            NewTaskBranchControl(store: store, state: workspaceState, projectId: projectId, selection: workspace)
                .id(projectId).disabled(sending || !store.connected)
        }
    }
}

private struct AgentTaskComposerSurface: ViewModifier {
    let embeddedInMobileDock: Bool
    let focused: Bool

    @ViewBuilder func body(content: Content) -> some View {
        if embeddedInMobileDock {
            content.padding(8)
        } else {
            content.padding(16).fridayCard(highlighted: focused)
        }
    }
}
