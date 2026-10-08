import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NewAgentTaskView: View {
    @ObservedObject var store: FridayStore
    var project: Project? = nil
    let onCreated: (String) -> Void
    @Binding var drafts: [String: AgentTaskDraft]
    @State private var sending = false
    @State private var error: String?
    @StateObject private var workspaceState = TaskWorkspaceState()

    private var draftKey: String { project?.id ?? "" }
    private var gitPath: String { "/api/projects/\(draftKey)/git" }
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
        VStack(spacing: 28) {
            VStack(spacing: 12) {
                if let project {
                    Text(friday: "在 \(project.name) 中开始新任务").font(.system(size: 28, weight: .medium))
                    Text(friday: "选择模型，把任务交给 Claude Code 或 Codex。")
                        .font(.callout).foregroundStyle(.secondary)
                    if let options = workspaceState.options(for: gitPath), options.git.status == "repository" {
                        TaskExecutionLocationPicker(selection: workspace, options: options)
                            .padding(.top, 6).disabled(sending || !store.connected)
                    }
                } else {
                    Text(friday: "从一个 Workspace 开始").font(.system(size: 28, weight: .medium))
                    Text(friday: "在任务侧栏选择 Workspace，再把任务交给 Agent。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity)
            if let error = error ?? workspaceState.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            else if let options = workspaceState.options(for: gitPath), !workspace.wrappedValue.isValid(in: options) {
                Text(friday: "所选分支不可用，请重新选择。").font(.caption).foregroundStyle(.orange)
            }
            AgentTaskComposer(store: store, projectPath: project?.path, projectId: project?.id, workspace: workspace,
                workspaceState: workspaceState, workspaceReady: workspaceReady, requiresProject: true, message: message, sending: sending, send: send)
        }
        .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FridayTheme.canvas)
        .task(id: "\(draftKey):\(store.connected)") {
            guard project != nil else { return }
            await workspaceState.refresh(store: store, path: gitPath)
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
    var collapseRequest = 0
    var expandRequest = 0
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
    @State private var expanded = true
    #if os(macOS)
    @State private var expandedHeight: CGFloat = 112
    @State private var focusRequest = 0
    #endif
    @FocusState private var focused: Bool
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var state: CodexConnectionState? { states[provider] }
    private var providerName: String { provider == "claude" ? "Claude" : "Codex" }
    private var connectionError: String? { error ?? (state?.enabled == false ? "已停用" : state?.error) }
    private var active: Bool { task?.active == true }
    private var disabled: Bool { sending || switchingBranch || task?.branchChange?.active == true || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task?.status == "queued" || (requiresProject && projectPath == nil) || !workspaceReady || (!active && state?.connected != true) }
    private var selectedModel: CodexProviderModel? { state?.models.first { $0.id == (model.isEmpty ? state?.model : model) } }
    private var compact: Bool {
        #if os(macOS)
        !expanded
        #else
        false
        #endif
    }
    private var showsBranchControl: Bool {
        if let task { return task.git?.status == "repository" }
        guard let projectId else { return false }
        return workspaceState?.options(for: "/api/projects/\(projectId)/git")?.git.status == "repository"
    }

    var body: some View {
        composerSurface
        #if os(macOS)
        .task(id: focusRequest) {
            guard focusRequest > 0, expanded else { return }
            await Task.yield()
            guard expanded, !Task.isCancelled else { return }
            focused = true
        }
        .onChange(of: focused) { _, focused in if focused { setExpanded(true) } }
        .onChange(of: collapseRequest) { _, _ in setExpanded(false) }
        .onChange(of: expandRequest) { _, _ in setExpanded(true) }
        .onChange(of: task?.id ?? projectId) { _, _ in
            focused = false; expanded = true; showModels = false; focusRequest = 0
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

    @ViewBuilder private var composerSurface: some View {
        #if os(macOS)
        // Keep the editor and toolbar mounted at their natural height. Animate
        // one numeric outer height instead of switching between zero and nil.
        expandedContent.padding(16).fixedSize(horizontal: false, vertical: true)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: AgentComposerExpandedHeightKey.self, value: geometry.size.height)
            })
            .frame(height: compact ? 44 : expandedHeight, alignment: .bottom)
            .clipped().opacity(compact ? 0 : 1)
            .disabled(compact).allowsHitTesting(!compact).accessibilityHidden(compact)
            .modifier(AgentTaskComposerSurface(embeddedInMobileDock: false, focused: focused))
            .overlay {
                if compact {
                    Button { setExpanded(true); focusRequest += 1 } label: {
                        Color.clear.frame(height: 44).frame(maxWidth: .infinity).contentShape(Rectangle())
                    }
                    .buttonStyle(FridaySymbolButtonStyle())
                    .disabled(sending || (requiresProject && projectPath == nil))
                    .accessibilityLabel(Text(friday: "任务要求"))
                    .accessibilityValue(Text(friday: "已收起"))
                }
            }
            .animation(composerAnimation, value: expanded)
            .animation(composerAnimation, value: expandedHeight)
            .onPreferenceChange(AgentComposerExpandedHeightKey.self) { height in
                if height > 44, abs(height - expandedHeight) > 0.5 { expandedHeight = height }
            }
        #else
        expandedContent.modifier(AgentTaskComposerSurface(embeddedInMobileDock: embeddedInMobileDock, focused: focused))
        #endif
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 16) {
                TextField(friday: active ? "补充任务要求…" : "这个任务要完成什么…", text: $message, axis: .vertical)
                    .font(.body).lineLimit((embeddedInMobileDock ? 1 : (task == nil ? 3 : 2))...6).textFieldStyle(.plain).focused($focused)
                    .disabled(compact || sending || (requiresProject && projectPath == nil))
                    .accessibilityLabel(Text(friday: "任务要求"))
                    .onChatSubmit { if !disabled { send(provider, model, effort) } }
                Button { send(provider, model, effort) } label: {
                    FridaySymbolImage(systemName: "arrow.up").fridaySymbolFeedback()
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
                    .keyboardShortcut(.return, modifiers: .command).disabled(disabled || compact)
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
    }

    #if os(macOS)
    private var composerAnimation: Animation? {
        reduceMotion || !NSApp.isActive ? nil : .smooth(duration: 0.36)
    }

    private func setExpanded(_ value: Bool) {
        guard expanded != value else { return }
        if !value { focused = false; showModels = false }
        withAnimation(composerAnimation) { expanded = value }
    }
    #endif

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

#if os(macOS)
private struct AgentComposerExpandedHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
#endif

private struct AgentTaskComposerSurface: ViewModifier {
    let embeddedInMobileDock: Bool
    let focused: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Namespace private var glassNamespace

    @ViewBuilder func body(content: Content) -> some View {
        if embeddedInMobileDock {
            content.padding(8)
        } else {
            #if os(macOS)
            if reduceTransparency || contrast == .increased {
                content.fridayCard(radius: 22, highlighted: focused)
            } else {
                #if compiler(>=6.2)
                if #available(macOS 26.0, *) {
                    GlassEffectContainer(spacing: 0) {
                        content
                            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22))
                            .glassEffectID("task-composer", in: glassNamespace)
                    }
                } else {
                    materialSurface(content)
                }
                #else
                materialSurface(content)
                #endif
            }
            #else
            content.padding(16).fridayCard(highlighted: focused)
            #endif
        }
    }

    #if os(macOS)
    private func materialSurface(_ content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
            .overlay {
                RoundedRectangle(cornerRadius: 22)
                    .strokeBorder(focused ? FridayTheme.accent.opacity(0.35) : .primary.opacity(0.07))
                    .allowsHitTesting(false)
            }
            .shadow(color: .black.opacity(0.035), radius: 12, x: 0, y: 4)
    }
    #endif
}
