import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import PhotosUI
#endif
#if os(macOS)
import AppKit
#endif

struct NewAgentTaskView: View {
    @ObservedObject var store: FridayStore
    var project: Project? = nil
    var onSelectProject: (Project) -> Void = { _ in }
    let onCreated: (String) -> Void
    @Binding var drafts: [String: AgentTaskDraft]
    @State private var showChangeRequestCheckout = false
    @State private var showWorkspaceAdd = false
    @State private var scratchRequest: UUID?
    @State private var submissionRequest: UUID?
    @State private var sending = false
    @State private var error: String?
    @StateObject private var workspaceState = TaskWorkspaceState()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var draftKey: String { project?.id ?? "" }
    private var ordinaryProjects: [Project] { store.projects.filter { $0.isScratch != true } }
    private var offersScratch: Bool { store.taskScratchWorkspaceSupported && store.scratchWorkspaceRoot != nil && store.snapshotIdentity == store.connectionIdentity }
    private var gitPath: String { "/api/projects/\(draftKey)/git" }
    private var workspaceTransition: Animation? {
        reduceMotion || scenePhase != .active ? nil : .easeInOut(duration: 0.24)
    }
    private var showsExecutionLocation: Bool {
        project != nil && project?.clone?.blocksTasks != true && project?.isScratch != true && workspaceState.options(for: gitPath)?.git.status == "repository"
    }
    private var workspaceReady: Bool {
        if project?.clone?.blocksTasks == true { return false }
        if workspace.wrappedValue.reuseTaskId != nil { return store.connected && store.snapshotIdentity == store.connectionIdentity && store.taskExistingWorkspaceSupported }
        if project?.isScratch == true { return offersScratch }
        return workspace.wrappedValue.preparationId != nil && store.connected || workspaceState.isReady(for: gitPath) && workspaceState.options(for: gitPath).map { workspace.wrappedValue.isValid(in: $0) } == true
    }
    private var workspaceError: String? {
        if project?.clone?.blocksTasks == true { return nil }
        if workspace.wrappedValue.reuseTaskId != nil, !store.taskExistingWorkspaceSupported { return "主机尚不支持复用任务工作区，请更新主机或清除检出选择。" }
        guard workspace.wrappedValue.preparationId == nil, workspace.wrappedValue.reuseTaskId == nil, project != nil, project?.isScratch != true, !workspaceState.loading else { return nil }
        return workspaceState.error ?? workspaceState.options(for: gitPath)?.validationMessage(for: workspace.wrappedValue)
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
            if !sending { drafts[draftKey]?.requestId = UUID().uuidString }
        })
    }

    private var images: Binding<[IdeaImage]> {
        Binding(get: { drafts[draftKey]?.images ?? [] }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.images = value
            if !sending { drafts[draftKey]?.requestId = UUID().uuidString }
        })
    }
    private var contexts: Binding<[TaskContextReference]> {
        Binding(get: { drafts[draftKey]?.contexts ?? [] }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.contexts = value
            if !sending { drafts[draftKey]?.requestId = UUID().uuidString }
        })
    }
    private var contextInsertion: Binding<TaskContextInsertion?> {
        Binding(get: { drafts[draftKey]?.contextInsertion }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }; drafts[draftKey]?.contextInsertion = value
        })
    }
    private var interactionMode: Binding<String> {
        Binding(get: { drafts[draftKey]?.interactionMode ?? "default" }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.interactionMode = value
            if !sending { drafts[draftKey]?.requestId = UUID().uuidString }
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
        .sheet(isPresented: $showWorkspaceAdd) { WorkspaceAddView(store: store, onAdded: onSelectProject) }
        .sheet(isPresented: $showChangeRequestCheckout) {
            if let project { TaskChangeRequestCheckoutDialog(store: store, project: project) { result in
                workspace.wrappedValue = result.selection; drafts[draftKey]?.requestId = UUID().uuidString; showChangeRequestCheckout = false
            } }
        }
        .onChange(of: store.connectionIdentity) { _, _ in scratchRequest = nil; submissionRequest = nil; sending = false; error = nil }
        .task(id: "\(draftKey):\(store.connected):\(store.connectionIdentity):\(store.sourceControlPreferencesVersion ?? 0):\(project?.clone?.phase ?? "")") {
            guard project != nil, project?.clone?.blocksTasks != true, project?.isScratch != true else { return }
            await workspaceState.refresh(store: store, path: gitPath)
        }
    }

    private func taskForm(availableWidth: CGFloat) -> some View {
        let columnCount = max(1, min(ordinaryProjects.count + (offersScratch ? 1 : 0), Int((availableWidth + 12) / 232)))
        return VStack(spacing: 28) {
            VStack(spacing: 12) {
                if project?.isScratch == true {
                    Text(friday: workspace.wrappedValue.reuseTaskId == nil ? "开始一个无项目任务" : "在当前分支开始新任务").font(.system(size: 28, weight: .medium))
                    Text(friday: workspace.wrappedValue.reuseTaskId == nil ? "默认使用独立目录，文件保留在主机上。" : "使用已选择的任务目录，建立独立会话。").font(.callout).foregroundStyle(.secondary)
                    if workspace.wrappedValue.reuseTaskId != nil {
                        Text(workspace.wrappedValue.preparedBranch ?? "").font(.system(.callout, design: .monospaced))
                        Button(friday: "清除检出选择") { workspace.wrappedValue = TaskWorkspaceSelection(); drafts[draftKey]?.requestId = UUID().uuidString }.buttonStyle(FridaySymbolButtonStyle())
                    }
                } else if let project {
                    Text(friday: "在 \(project.name) 中开始新任务").font(.system(size: 28, weight: .medium))
                    Text(fridayString: workspaceState.options(for: gitPath)?.git.status == "not_repository"
                        ? "选择模型，任务将在当前目录执行。"
                        : "选择模型，把任务交给 Claude Code 或 Codex。")
                        .font(.callout).foregroundStyle(.secondary)
                    if !showsExecutionLocation {
                        Text(project.path).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            .help(project.path)
                    }
                    if let options = workspaceState.options(for: gitPath), options.git.status == "repository" {
                        VStack(spacing: 10) {
                            if let path = workspace.wrappedValue.preparedPath {
                                Text(workspace.wrappedValue.preparedBranch ?? "PR／MR").font(.system(.callout, design: .monospaced))
                                Text(path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                if workspace.wrappedValue.preparedOnHead == false { Text(friday: "保留了已有 Worktree 的本地状态，尚未对齐 PR／MR 最新提交").font(.caption).foregroundStyle(.orange) }
                                if let preparation = workspace.wrappedValue.preparationId { PreparedProjectScriptControl(store: store, projectID: project.id, preparationID: preparation) }
                                Button(friday: "清除检出选择") { workspace.wrappedValue = TaskWorkspaceSelection(); drafts[draftKey]?.requestId = UUID().uuidString }
                                    .buttonStyle(FridaySymbolButtonStyle())
                            } else { TaskExecutionLocationPicker(selection: workspace, options: options) }
                            Button { showChangeRequestCheckout = true } label: { FridaySymbolLabel(friday: "从 PR／MR 开始", systemImage: "arrow.triangle.pull") }
                                .buttonStyle(FridaySymbolButtonStyle())
                        }.padding(.top, 6).disabled(sending || !store.connected).transition(.opacity)
                    }
                } else {
                    Text(friday: offersScratch ? "从一个任务开始" : "从一个 Workspace 开始").font(.system(size: 28, weight: .medium))
                    Text(fridayString: offersScratch ? "选择一个 Workspace，或直接创建无项目任务。" : store.projects.isEmpty
                        ? "先添加一个 Workspace，再把任务交给 Agent。"
                        : "选择下方的 Workspace，再把任务交给 Agent。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }.multilineTextAlignment(.center).frame(maxWidth: .infinity)
                .id(draftKey).transition(.opacity)
            if project == nil && (!ordinaryProjects.isEmpty || offersScratch) {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: columnCount), spacing: 12) {
                    if offersScratch { scratchCard }
                    ForEach(ordinaryProjects) { project in
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
                }.disabled(sending || scratchRequest != nil).transition(.opacity)
            }
            if project == nil {
                Button { showWorkspaceAdd = true } label: { FridaySymbolLabel(friday: "添加 Workspace", systemImage: "folder.badge.plus") }
                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(sending || scratchRequest != nil || !store.connected)
            }
            if let project { ProjectCloneControl(store: store, project: project).id(project.id) }
            if scratchRequest != nil { Text(friday: "正在准备无项目任务…").font(.caption).foregroundStyle(.secondary) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            else if let workspaceError {
                HStack(spacing: 8) {
                    Text(fridayString: workspaceError).foregroundStyle(.orange).textSelection(.enabled)
                    if workspaceState.error != nil || workspaceState.options(for: gitPath)?.git.status != "repository" {
                        Button { Task { await workspaceState.refresh(store: store, path: gitPath) } } label: {
                            Text(friday: "重试")
                        }.buttonStyle(FridaySymbolButtonStyle()).fixedSize().disabled(sending || !store.connected)
                    }
                }.font(.caption).multilineTextAlignment(.center)
            }
            AgentTaskComposer(store: store, projectPath: workspace.wrappedValue.preparedPath ?? project?.path, projectId: project?.id, projectPreparationId: workspace.wrappedValue.preparationId, workspace: workspace,
                workspaceState: workspaceState, workspaceReady: workspaceReady, requiresProject: true, discardDraft: discardDraft, message: message, images: images, contexts: contexts, contextInsertion: contextInsertion, interactionMode: interactionMode, sending: sending, send: send)
        }
    }

    private var scratchCard: some View {
        Button(action: selectScratch) {
            HStack(spacing: 12) {
                FridaySymbolImage(systemName: "ellipsis.message").font(.system(size: 28)).foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 5) {
                    Text(friday: "无项目").font(.system(size: 14, weight: .medium))
                    Text(friday: "在独立目录中开始，不需要选择已有 Workspace。").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                FridaySymbolImage(systemName: "chevron.right").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
            }.padding(16).frame(maxWidth: .infinity, minHeight: 76, alignment: .leading)
        }.buttonStyle(NewTaskWorkspaceCardStyle()).disabled(!store.connected && !store.projects.contains { $0.isScratch == true })
            .accessibilityLabel(Text(friday: "无项目"))
    }
    private func selectScratch() {
        guard scratchRequest == nil, !sending else { return }
        if !store.connected, let saved = store.projects.first(where: { $0.isScratch == true }) { onSelectProject(saved); return }
        let identity = store.connectionIdentity, request = UUID(); scratchRequest = request; error = nil
        Task { @MainActor in
            defer { if scratchRequest == request { scratchRequest = nil } }
            do {
                let project = try await store.ensureScratchProject()
                guard identity == store.connectionIdentity, scratchRequest == request else { return }
                onSelectProject(project)
            } catch { if identity == store.connectionIdentity, scratchRequest == request { self.error = error.localizedDescription } }
        }
    }

    private func discardDraft() {
        guard !sending, let saved = drafts[draftKey], saved.hasUserContent else { return }
        let binding = $drafts, key = draftKey; binding.wrappedValue[key] = nil
        store.taskUndo.discardedDraft(store: store, key: "project-draft:" + key) {
            guard binding.wrappedValue[key]?.hasUserContent != true else { throw ConnectionError.message("草稿已有新内容，无法恢复被丢弃的草稿。") }
            binding.wrappedValue[key] = saved
        }
    }

    private func send(_ submission: TaskComposerSubmission) {
        guard let project, !sending else { return }
        let draft = drafts[project.id] ?? AgentTaskDraft()
        guard !draft.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.images.isEmpty else { return }
        let executionWorkspace = workspace.wrappedValue
        drafts[project.id] = draft
        let identity = store.connectionIdentity, request = UUID(); submissionRequest = request
        sending = true; error = nil
        Task { @MainActor in
            defer { if submissionRequest == request { sending = false; submissionRequest = nil } }
            do {
                let id = try await store.createTask(prompt: draft.message, requestId: draft.requestId, projectId: project.id, agent: submission.provider, model: submission.model, reasoningEffort: submission.effort, interactionMode: submission.interactionMode, workspace: project.isScratch == true && executionWorkspace.reuseTaskId == nil ? nil : executionWorkspace, images: draft.images, contexts: draft.contexts ?? [])
                guard identity == store.connectionIdentity, submissionRequest == request else { return }
                drafts[project.id] = nil; onCreated(id)
            } catch { if identity == store.connectionIdentity, submissionRequest == request { self.error = error.localizedDescription } }
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

struct AgentTaskDraft: Codable, Equatable {
    var message = ""
    var images: [IdeaImage] = []
    var workspace = TaskWorkspaceSelection()
    var requestId = UUID().uuidString
    var interactionMode: String? = nil
    var contexts: [TaskContextReference]? = nil
    var contextInsertion: TaskContextInsertion? = nil
    var hasUserContent: Bool { TaskDraftContent.hasUserContent(message, images: images.count, contexts: contexts?.count ?? 0, pendingContext: contextInsertion != nil) }
}

struct AgentTaskComposer: View {
    @ObservedObject var store: FridayStore
    var task: WorkItem? = nil
    var projectPath: String? = nil
    var projectId: String? = nil
    var projectPreparationId: String? = nil
    var workspace: Binding<TaskWorkspaceSelection>? = nil
    var workspaceState: TaskWorkspaceState? = nil
    var workspaceReady = true
    var requiresProject = false
    var embeddedInMobileDock = false
    var collapseRequest = 0
    var expandRequest = 0
    var submissionError: String? = nil
    var editingQueuedMessageId: String? = nil
    var editQueuedMessage: (QueuedTaskMessage) -> Void = { _ in }
    var cancelQueueEdit: () -> Void = {}
    var resumeTask: (() -> Void)? = nil
    var discardDraft: (() -> Void)? = nil
    @Binding var message: String
    @Binding var images: [IdeaImage]
    @Binding var contexts: [TaskContextReference]
    @Binding var contextInsertion: TaskContextInsertion?
    @Binding var interactionMode: String
    let sending: Bool
    let send: (TaskComposerSubmission) -> Void
    @AppStorage("friday.tasks.followUpBehavior") private var followUpBehavior = "queue"
    @State private var alternateDown = false
    @State private var beforeQueueEdit: (String, String)?
    @State private var states: [String: CodexConnectionState] = [:]
    @State private var provider = "codex"
    @State private var showModels = false
    @State private var model = ""
    @State private var effort = ""
    @State private var error: String?
    @State private var switchingBranch = false
    @State private var stoppingTaskId: String?
    @State private var stoppingRequest: UUID?
    @State private var expanded = true
    @State private var showImageImporter = false
    @State private var importerContext = ""
    @State private var importing = false
    @State private var dropTargeted = false
    @State private var previewContext: TaskContextReference?
    @State private var showContextPicker = false
    @State private var mention: TaskMentionQuery?
    @State private var suppressedMention: TaskMentionQuery?
    @State private var suggestions: [TaskFileEntry] = []
    @State private var selectedSuggestion = 0
    @State private var loadingSuggestions = false
    @StateObject private var commandCatalog = TaskComposerCapabilities()
    @StateObject private var compaction = TaskCompactionState()
    @StateObject private var providerUsage = TaskProviderUsageState()
    @StateObject private var codexCommands = TaskCodexCommandState()
    @StateObject private var pooledUsage = TaskPooledUsageState()
    @State private var showingUsageLimits = false
    @State private var contextNow = Date()
    @State private var fullHistoryScopes: Set<String> = []
    @State private var resumeCompactionDismissed = false
    @State private var compactionPreferenceIdentity = ""
    @AppStorage("friday.composer.showSkillsInSlashMenu") private var showSkillsInSlashMenu = true
    @State private var capturingContext = false
    @State private var fileMentionOwner = UUID()
    @State private var fileMentionRequest: UUID?
    @State private var citationCaret: NSRange?
    @Environment(\.taskFileMentionBridge) private var fileMentionBridge
    @State private var editorIdentity = ""
    @State private var restoreContextPickerFocus = false
    #if os(iOS)
    @State private var photoItems: [PhotosPickerItem] = []
    #endif
    #if os(macOS)
    @State private var focusRequest = 0
    #endif
    // The AppKit/UIKit editor owns native focus and reports it through callbacks.
    @State private var focused = false
    @Environment(\.locale) private var locale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var state: CodexConnectionState? { states[provider] }
    private var providerName: String { TaskProviderCatalog.name(provider) }
    private var connectionError: String? { error ?? compaction.failure ?? submissionError ?? commandCatalog.failure ?? (TaskContextDocument.missing(message, records: contexts) ? "引用内容未加载，请删除后重新添加。" : nil) ?? (state?.enabled == false ? "已停用" : state?.error) }
    private var active: Bool { task?.active == true }
    private var stopping: Bool { stoppingTaskId != nil && stoppingTaskId == task?.id || task?.backgroundStopPending == true }
    private var backgroundStopAvailable: Bool { store.taskBackgroundSettlementSupported && task?.backgroundStopAvailable == true }
    private var draftEmpty: Bool { message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty }
    private var contextID: String { task?.id ?? projectId ?? "" }
    private var contextScope: TaskContextScope { task.map { TaskContextScope(taskID: $0.id) } ?? (workspace?.wrappedValue.reuseTaskId).map { TaskContextScope(taskID: $0) } ?? TaskContextScope(projectID: projectId, preparationID: projectPreparationId) }
    private var fullEditorIdentity: String { store.taskComposerIdentity(contextScope) }
    private var commandIdentity: String { fullEditorIdentity + "\n" + provider + "\n" + (task?.threadId ?? "") + "\n" + (workspace?.wrappedValue.reuseTaskId ?? "") + "\n" + String(store.providerConfigurationVersions[provider] ?? 0) }
    private var usageLimitsKey: String { commandIdentity + "\n" + model + "\n" + (task?.currentRunId ?? "") + "\n" + (task?.status ?? "") }
    private var usageLimitsAvailable: Bool { (providerUsage.limits?.offered == true || !store.usageLimitSources.isEmpty) && images.isEmpty && TaskContextDocument.used(message, records: contexts).isEmpty }
    private var commandScope: [String: Any] {
        if task == nil, let reuse = workspace?.wrappedValue.reuseTaskId, let projectId { return ["projectId": projectId, "reuseTaskId": reuse] }
        return contextScope.body
    }
    private var compactingContext: Bool { task.map { task in task.active && task.runs?.first(where: { $0.id == task.currentRunId })?.command == "compact" } ?? false }
    private var canCompactContext: Bool {
        guard let task else { return false }
        return store.taskComposerCommandsSupported && store.connected && task.threadId != nil && task.subagentOrigin == nil && !task.active && !task.gitBusy && !task.sessionBusy && task.archivedAt == nil
            && task.branchChange?.active != true && task.queue?.pending.isEmpty != false && !sending && !compaction.busy && editingQueuedMessageId == nil
    }
    private var resumeCompactionTokens: Double? {
        guard canCompactContext, proposedPlan == nil, !resumeCompactionDismissed, compactionPreferenceIdentity == compactionPreferenceScope, commandCatalog.catalog?.commands.contains(where: { $0.name == "compact" }) == true,
              let usage = task?.contextUsage, usage.offersResumeCompaction(provider: provider, now: contextNow) else { return nil }
        return usage.usedTokens
    }
    private var compactsBeforeSend: Bool { resumeCompactionTokens != nil && !fullHistoryScopes.contains(commandIdentity) }
    private var compactionPreferenceScope: String {
        let home: String = state?.settings?.homePath ?? ""
        return ["resume-compaction", provider, home, store.connection.token].joined(separator: ":")
    }
    private var fileMentionScope: String { TaskFileMentionPayload.scope(server: store.connection.server, token: store.connection.token, cwd: task?.cwd ?? projectPath ?? "", serviceId: store.serviceId) }
    private var fileMentionsEnabled: Bool { !sending && !importing && !capturingContext && contextInsertion == nil && !stopping && !switchingBranch && task?.sessionBusy != true && store.connected && !contextScope.body.isEmpty && (task?.cwd ?? projectPath) != nil }
    private var reviewTarget: String { fullEditorIdentity + "\nqueue:" + (editingQueuedMessageId ?? "") }
    private var reviewEnabled: Bool { !sending && !importing && !stopping && !switchingBranch && task?.sessionBusy != true && store.connected && !contextScope.body.isEmpty && (task?.cwd ?? projectPath) != nil }
    private var fileMentionContext: TaskFileMentionContext { TaskFileMentionContext(scope: fileMentionScope, enabled: fileMentionsEnabled, insert: captureFileMentions, reviewTarget: reviewTarget, reviewEnabled: reviewEnabled, reviewRecords: contexts.filter { $0.kind == "review-comment" }, review: updateFileReview,citations:citationComposer,browserAnnotations:browserAnnotationComposer) }
    private var browserAnnotationComposer:TaskBrowserAnnotationComposer {
        let target=reviewTarget,scope=fileMentionScope,root=task?.cwd ?? projectPath ?? ""
        func current()->Bool {fileMentionBridge?.context?.browserAnnotations?.target==target && fileMentionBridge?.context?.scope==scope && fileMentionBridge?.context?.browserAnnotations?.enabled==true}
        return TaskBrowserAnnotationComposer(enabled:fileMentionsEnabled,target:target,scope:scope,workspaceRoot:root,current:current,attach:{record,png,sendNow in
            guard current(),editorIdentity==fullEditorIdentity,TaskContextDocument.used(message,records:contexts).count<20 else{return TaskBrowserAnnotationAttachment(accepted:false)}
            let image=png.flatMap {try? IdeaImageCache.importImage($0,name:"preview-annotation-"+record.annotationId+".png")}
            guard let edit=TaskBrowserAnnotationDraftEdit.make(record:record,image:image,text:message,contexts:contexts,images:images,target:target,scope:scope,workspaceRoot:root,identity:fullEditorIdentity,send:sendNow) else{return TaskBrowserAnnotationAttachment(accepted:false)}
            message=edit.text;contexts=edit.contexts;images=edit.images;contextInsertion=edit.insertion;expanded=true
            if sendNow {submit(alternate:false)}
            return TaskBrowserAnnotationAttachment(accepted:true,warning:edit.screenshotAttached ? nil:"已添加批注，截图未能附加")
        })
    }
    private var citationIdentity:String { reviewTarget + "\n" + fileMentionScope }
    private var citationComposer:TaskCitationComposer {
        let identity=citationIdentity, target=reviewTarget, scope=fileMentionScope
        func current() -> Bool { fileMentionBridge?.context?.reviewTarget == target && fileMentionBridge?.context?.scope == scope && fileMentionBridge?.context?.citations?.enabled == true }
        return TaskCitationComposer(enabled:reviewEnabled,insert:{ citation in
            guard current(),let edit=TaskCitationDraftEdit.insert(citation,in:message,selection:citationCaret ?? NSRange(location:message.utf16.count,length:0)) else { return nil }
            message=edit.text;citationCaret=NSRange(location:edit.caret,length:0);expanded=true
            contextInsertion=TaskContextInsertion(citation:citation,alreadyInserted:true,caret:edit.caret,focus:false,identity:fullEditorIdentity)
            return TaskCitationEditingTarget(identity:identity,range:edit.range,citation:citation)
        },edit:{ citation,range in
            guard current(),NSMaxRange(range)<=message.utf16.count,(message as NSString).substring(with:range).utf16.elementsEqual(citation.token.utf16) else { return nil }
            return TaskCitationEditingTarget(identity:identity,range:range,citation:citation)
        },replace:{ target,comment in
            guard current(),let edit=TaskCitationDraftEdit.replace(target,comment:comment,in:message,identity:identity) else { return nil }
            message=edit.text;var updated=target;updated.range=edit.range;updated.citation=target.citation.withComment(comment);citationCaret=NSRange(location:edit.caret,length:0);return updated
        },finish:{ target,sendNow in
            guard current(),target.identity==identity else { return }
            contextInsertion=TaskContextInsertion(citation:target.citation,alreadyInserted:true,caret:NSMaxRange(target.range),focus:true,identity:fullEditorIdentity)
            if sendNow { submit(alternate:false) }
        },navigate:{ citation in
            store.assistantCitationNavigation=TaskCitationNavigationRequest(citation:citation,connection:store.connectionIdentity)
        })
    }
    private var fileMentionRegistration: String { fullEditorIdentity + fileMentionScope + String(fileMentionsEnabled) + String(reviewEnabled) + (editingQueuedMessageId ?? "") + contexts.filter { $0.kind == "review-comment" }.map(\.id).joined(separator: ":") }
    private var showsStop: Bool { (active || backgroundStopAvailable || task?.watchingPullRequests == true) && draftEmpty && editingQueuedMessageId == nil }
    private var canResume: Bool { task.map { !$0.active && !$0.sessionBusy && $0.preparationFailure == nil && $0.claudeResumePendingRun == nil && (["failed", "cancelled", "interrupted"].contains($0.status) || ($0.queue?.paused == true && $0.queue?.pending.isEmpty == false)) } ?? false }
    private var canSteer: Bool { active && task?.status != "queued" && interactionMode == (task?.interactionMode ?? "default") && (task?.canSteer ?? (task?.turnId != nil)) }
    private var dispatchMode: TaskComposerDispatch { TaskComposerDispatch.resolve(running: active, canSteer: canSteer, preference: followUpBehavior, alternate: alternateDown) }
    private var editingAvailable: Bool { editingQueuedMessageId == nil || task?.queue?.messages.first(where: { $0.id == editingQueuedMessageId })?.editable == true }
    private var proposedPlan: TaskEvent? { TaskExecutionPresentation.currentPlan(task, mode: interactionMode, editing: editingQueuedMessageId != nil) }
    private var disabled: Bool { sending || compaction.busy || compactingContext || importing || capturingContext || contextInsertion != nil || TaskContextDocument.missing(message, records: contexts) || stopping || switchingBranch || task?.gitBusy == true || task?.sessionBusy == true || task?.claudeResumePendingRun != nil || task?.branchChange?.active == true || !store.connected || (draftEmpty && proposedPlan == nil) || !editingAvailable || (requiresProject && projectPath == nil) || !workspaceReady || (!active && state?.connected != true) }
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
    private var placeholder: String {
        if requiresProject && projectPath == nil {
            return store.projects.isEmpty ? "先添加一个 Workspace…" : "先选择上方的 Workspace…"
        }
        if proposedPlan != nil { return "补充意见以细化方案，或直接实施…" }
        if interactionMode == "plan" { return "先研究什么，再提出方案…" }
        return active ? "补充任务要求…" : "这个任务要完成什么…"
    }

    private var interactionObservers: some View {
        contextualComposer
        #if os(macOS)
        .modifier(TaskComposerModifierKeys(alternate: $alternateDown))
        #endif
        #if os(iOS)
        .fileImporter(isPresented: $showImageImporter, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): importFiles(urls, context: importerContext)
            case .failure(let failure): error = failure.localizedDescription
            }
        }
        #endif
        .onDrop(of: [TaskFileMentionTransfer.contentType.identifier, UTType.image.identifier, UTType.fileURL.identifier], isTargeted: $dropTargeted) { providers in
            let mentions = providers.filter { $0.hasItemConformingToTypeIdentifier(TaskFileMentionTransfer.type) }
            if !mentions.isEmpty { return receiveFileMentionProviders(mentions) }
            guard !sending, !importing, !compact, !requiresProject || projectId != nil else { return false }
            importProviders(providers); return true
        }
        .onChange(of: fileMentionRegistration, initial: true) { _, _ in fileMentionBridge?.register(fileMentionContext, owner: fileMentionOwner) }
        .onDisappear { fileMentionBridge?.clear(owner: fileMentionOwner) }
        .onChange(of: fileMentionScope) { _, _ in if fileMentionRequest != nil { fileMentionRequest = nil; capturingContext = false } }
        .onChange(of: contextID) { _, _ in
            citationCaret=nil
            importing = false; dropTargeted = false; error = nil
            beforeQueueEdit = nil; alternateDown = false
        }
        .onChange(of: editingQueuedMessageId) { _, id in
            if let id, let entry = task?.queue?.messages.first(where: { $0.id == id }) {
                if beforeQueueEdit == nil { beforeQueueEdit = (model, effort) }
                model = entry.model ?? task?.model ?? ""; effort = entry.reasoningEffort ?? task?.reasoningEffort ?? ""
                #if os(macOS)
                setExpanded(true); focusRequest += 1
                #endif
            } else if let saved = beforeQueueEdit { model = saved.0; effort = saved.1; beforeQueueEdit = nil }
        }
        .onChange(of: task?.approvals.first { $0.state == "pending" }?.id) { _, id in
            if id != nil { expanded = true; focused = false }
        }
        .overlay {
            if dropTargeted {
                RoundedRectangle(cornerRadius: 22).strokeBorder(FridayTheme.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .allowsHitTesting(false)
            }
        }
        #if os(iOS)
        .onChange(of: photoItems) { _, items in
            let context = contextID
            guard !items.isEmpty else { return }
            importing = true
            Task { @MainActor in
                for item in items {
                    do {
                        if let data = try await item.loadTransferable(type: Data.self), context == contextID {
                            try addImage(data, name: "照片.png")
                        }
                    } catch { if context == contextID { self.error = error.localizedDescription } }
                }
                if context == contextID { importing = false; photoItems = [] }
            }
        }
        #endif
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
            if requiresProject && projectId != nil { focusRequest += 1 }
        }
        #endif
        #if os(iOS)
        .onDisappear { focused = false }
        #endif
        .task(id: task?.id) {
            stoppingTaskId = nil; stoppingRequest = nil; error = nil
            let queued = task?.queue?.messages.first { $0.id == editingQueuedMessageId }
            provider = task?.agent ?? "codex"; model = queued?.model ?? task?.model ?? ""; effort = queued?.reasoningEffort ?? task?.reasoningEffort ?? ""
        }
    }

    private var providerStatusKey: String { store.connectionIdentity + ":" + (store.taskStreamSession ?? "") + ":" + String(store.connected) + ":" + TaskProviderCatalog.order.map { $0 + ":" + String(store.providerConfigurationVersions[$0] ?? 0) }.joined(separator: "|") + ":" + store.agents.filter(\.executableSupported).map(\.id).joined(separator: "|") }

    var body: some View {
        interactionObservers
        .task(id: providerStatusKey) {
            states = [:]
            guard store.connected else { return }
            let connection = store.connection, account = store.connectionIdentity, service = store.taskStreamSession
            for value in TaskProviderCatalog.order.filter({ value in ["codex", "claude"].contains(value) || store.agents.contains(where: { $0.id == value && $0.executableSupported }) }) {
                do {
                    let state = try await connection.decode(CodexConnectionState.self, "/api/agents/\(value)")
                    guard !Task.isCancelled, store.connectionIdentity == account, store.taskStreamSession == service else { return }
                    states[value] = state
                } catch { if !Task.isCancelled, store.connectionIdentity == account, store.taskStreamSession == service, value == provider { self.error = error.localizedDescription } }
            }
            if task == nil && states[provider]?.connected != true, let available = TaskProviderCatalog.order.first(where: { states[$0]?.connected == true }) { provider = available; model = ""; effort = ""; if !TaskProviderCatalog.supportsInteractionModes(provider, state: states[provider]) { interactionMode = "default" }; error = nil }
        }
        .onChange(of: store.connectionIdentity) { _, _ in stoppingTaskId = nil; stoppingRequest = nil; error = nil }
    }

    private var suggestionRequestKey: String { commandIdentity + "|" + (mention.map { "\($0.range.location):\($0.source)" } ?? "") + "|" + (commandCatalog.catalog?.checkedAt ?? "") + "|" + String(showSkillsInSlashMenu) + String(usageLimitsAvailable) }
    private var contextualComposer: some View {
        composerSurface
        .onAppear { editorIdentity = fullEditorIdentity; recoverKnownContexts() }
        .onChange(of: fullEditorIdentity) { _, identity in
            editorIdentity = identity; mention = nil; suppressedMention = nil; suggestions = []; loadingSuggestions = false; capturingContext = false; fileMentionRequest = nil; previewContext = nil; showContextPicker = false
        }
        .onChange(of: message) { _, _ in recoverKnownContexts() }
        .popover(item: $previewContext) { reference in TaskContextPreview(store: store, reference: reference, scope: contextScope) }
        .sheet(isPresented: $showContextPicker, onDismiss: {
            if restoreContextPickerFocus {
                restoreContextPickerFocus = false
                #if os(macOS)
                setExpanded(true); focusRequest += 1
                #endif
            }
        }) {
            let identity = fullEditorIdentity
            TaskFileReferencePicker(store: store, scope: contextScope) { reference in
                if editorIdentity == identity { addReference(reference, replacing: nil); restoreContextPickerFocus = true }
            }.id(identity)
        }
        .task(id: suggestionRequestKey) {
            guard let mention else { suggestions = []; loadingSuggestions = false; return }
            if mention.kind != nil {
                let compactAllowed = canCompactContext && message.trimmingCharacters(in: .whitespacesAndNewlines) == mention.source && images.isEmpty && TaskContextDocument.used(message, records: contexts).isEmpty
                suggestions = TaskComposerCommands.options(mention, catalog: commandCatalog.catalog, showSkills: showSkillsInSlashMenu, compactAvailable: compactAllowed, usageLimitsAvailable: usageLimitsAvailable, provider: provider)
                selectedSuggestion = 0; loadingSuggestions = false; return
            }
            let identity = fullEditorIdentity; loadingSuggestions = true; selectedSuggestion = 0
            do {
                try await Task.sleep(for: .milliseconds(120))
                let query = mention.text.addingPercentEncoding(withAllowedCharacters: .urlQueryValueAllowed) ?? ""
                let result = try await store.connection.decode(TaskFileListing.self, "/api/task-files?\(contextScope.query)&search=\(query)")
                if !Task.isCancelled && editorIdentity == identity { suggestions = result.entries; loadingSuggestions = false }
            } catch { if !Task.isCancelled && editorIdentity == identity { suggestions = []; loadingSuggestions = false; self.error = error.localizedDescription } }
        }
        .task(id: commandIdentity + String(store.connected) + String(store.taskComposerCommandsSupported)) {
            await commandCatalog.refresh(store: store, scope: commandScope, provider: provider, identity: commandIdentity)
        }
        .onChange(of: commandIdentity) { _, _ in commandCatalog.reset(); compaction.reset(); providerUsage.reset(); showingUsageLimits = false }
        .task(id: store.connectionIdentity + (task?.id ?? "") + (task?.threadId ?? "")) {
            codexCommands.reset(); if let task { codexCommands.recover(store: store, task: task) }
        }
        .onChange(of: usageLimitsKey) { _, _ in showingUsageLimits = false }
        .onChange(of: store.providerUsageSnapshots[provider]) { _, value in if let value { providerUsage.accept(value, identity: commandIdentity) } }
        .onChange(of: store.connectionIdentity) { _, _ in pooledUsage.reset() }
        .onChange(of: store.usageLimitSources) { _, _ in if showingUsageLimits { Task { await pooledUsage.refresh(store: store) } } }
        .task(id: compactionPreferenceScope) {
            resumeCompactionDismissed = TaskDraftCache.load(Bool.self, server: store.connection.server, context: compactionPreferenceScope) ?? false
            compactionPreferenceIdentity = compactionPreferenceScope
        }
        .task(id: commandIdentity + String(store.connected) + String(store.taskComposerCommandsSupported)) {
            guard !commandScope.isEmpty else { return }
            guard TaskProviderCatalog.hasUsageLimits(provider) else { providerUsage.reset(); return }
            await providerUsage.refresh(store: store, provider: provider, taskID: task?.id, identity: commandIdentity)
        }
        .task(id: commandIdentity + (task?.contextUsage?.updatedAt ?? "")) {
            contextNow = Date()
            guard provider == "claude", (task?.contextUsage?.usedTokens ?? 0) >= 100_000 else { return }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
                contextNow = Date()
            }
        }
    }

    @ViewBuilder private var composerSurface: some View {
        #if os(macOS)
        TaskComposerLayout(expansion: compact ? 0 : 1) {
            expandedContent.padding(16).fixedSize(horizontal: false, vertical: true)
        }
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
            .animation(composerAnimation, value: images.isEmpty)
        #else
        expandedContent.modifier(AgentTaskComposerSurface(embeddedInMobileDock: embeddedInMobileDock, focused: focused))
        #endif
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if provider == "codex", let task {
                if let goal = task.goal { TaskGoalBanner(goal: goal, working: task.active, disabled: !store.connected || codexCommands.busy,
                    resume: { runGoalCommand("/goal resume", task: task) }, clear: { runGoalCommand("/goal clear", task: task) }) }
                TaskFeedbackBanner(state: codexCommands, retry: { if let command = codexCommands.pending?.command { submitFeedback(command, task: task) } })
            }
            if showingUsageLimits, store.connected {
                if !store.usageLimitSources.isEmpty {
                    TaskPooledUsagePanel(state: pooledUsage, owner: store.deviceId == "owner", connected: store.connected,
                        reload: { reloadUsageLimits(force: true) }, close: { showingUsageLimits = false }, consume: { target in Task { await pooledUsage.consume(store: store, target: target) } })
                } else {
                TaskProviderUsagePanel(provider: providerName, limits: providerUsage.limits, loading: providerUsage.loading, failure: providerUsage.failure,
                    reload: { reloadUsageLimits(force: true) }, close: { showingUsageLimits = false },
                    canReset: store.connected && store.deviceId == "owner" && store.providerResetCreditsSupported && ((providerUsage.limits?.resetCredits?.availableCount ?? 0) > 0 || providerUsage.resetPending != nil),
                    resetting: providerUsage.resetting, resetStatus: providerUsage.resetStatus, hasPendingReset: providerUsage.resetPending != nil,
                    consume: { fingerprint in Task { await providerUsage.consume(store: store, provider: provider, fingerprint: fingerprint, identity: commandIdentity) } })
                }
            }
            if let task {
                TaskQueuedMessages(store: store, task: task, editingId: editingQueuedMessageId, edit: editQueuedMessage, resume: { resumeTask?() })
            }
            if editingQueuedMessageId != nil {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "pencil")
                    Text(friday: editingAvailable ? "正在编辑排队消息" : "这条消息已开始发送，修改内容仍保留在输入框中。")
                    Spacer(minLength: 4)
                    Button(action: cancelQueueEdit) { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "取消编辑"))
                }.font(.caption).foregroundStyle(editingAvailable ? Color.secondary : Color.orange)
            }
            if let proposedPlan {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "list.bullet.clipboard").foregroundStyle(.secondary)
                    Text(friday: "方案已就绪").foregroundStyle(.secondary)
                    if let title = TaskExecutionPresentation.planTitle(proposedPlan.text) { Text(verbatim: title).lineLimit(1).truncationMode(.middle) }
                    Spacer(minLength: 0)
                }.font(.caption)
            }
            if let task, let approval = task.approvals.first(where: { $0.state == "pending" }) {
                TaskPendingAction(store: store, task: task, approval: approval, stop: stop).id(approval.id)
            } else {
            if !images.isEmpty {
                TaskImageRail(store: store, images: images, remove: { id in images.removeAll { $0.id == id } }, disabled: sending || importing)
            }
            TaskPromptEditor(text: $message, placeholder: placeholder,
                enabled: !compact && !sending && (!requiresProject || projectPath != nil), focused: focused,
                minimumHeight: embeddedInMobileDock ? 28 : task == nil ? 60 : 40,
                focusChanged: { focused = $0 }, submit: { submit(alternate: false) }, importProviders: importProviders,
                alternateSubmit: { submit(alternate: true) }, identity: fullEditorIdentity, contexts: contexts, skills: commandCatalog.catalog?.skills ?? [], insertion: contextInsertion,
                inserted: { contextInsertion = nil }, openContext: openContext,
                mention: mention, mentionChanged: { query in mention = query == suppressedMention ? nil : query; if query == nil { suppressedMention = nil } },
                suggestions: suggestions, selectedSuggestion: selectedSuggestion, loadingSuggestions: loadingSuggestions,
                moveSuggestion: { moveSuggestion($0) }, chooseSuggestion: chooseSuggestion, dismissSuggestions: { suppressedMention = mention; mention = nil }, chooseEntry: captureEntry, fileMentions: fileMentionContext,selectionChanged:{ citationCaret=$0 })
            HStack(spacing: 12) {
                Button { interactionMode = interactionMode == "plan" ? "default" : "plan" } label: {
                    FridaySymbolImage(systemName: interactionMode == "plan" ? "list.bullet.clipboard.fill" : "list.bullet.clipboard")
                        .font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(interactionMode == "plan" ? FridayTheme.accent : .secondary)
                    .disabled(sending || importing || !TaskProviderCatalog.supportsInteractionModes(provider, state: states[provider]))
                    .accessibilityLabel(Text(friday: "切换计划模式"))
                    .accessibilityValue(Text(friday: interactionMode == "plan" ? "计划模式" : "普通模式"))
                    .help(Text(friday: interactionMode == "plan" ? "计划模式" : "普通模式"))
                modelControls
                Divider().frame(height: 16)
                TaskReasoningEffortControl(selection: $effort, efforts: selectedModel?.reasoningEfforts ?? [],
                    defaultEffort: selectedModel?.defaultReasoningEffort ?? "")
                    .disabled(sending)
                Spacer(minLength: 0)
                if task?.contextUsage != nil || compaction.pending != nil || canCompactContext {
                    TaskContextWindowControl(usage: task?.contextUsage, compacting: compaction.busy || compactingContext,
                        canCompact: canCompactContext, canRetry: compaction.pending != nil && store.connected, failure: compaction.failure,
                        showResumePreference: provider == "claude", resumeSuggestionsEnabled: !resumeCompactionDismissed, toggleResumeSuggestions: {
                            resumeCompactionDismissed.toggle()
                            TaskDraftCache.save(resumeCompactionDismissed, server: store.connection.server, context: compactionPreferenceScope)
                        },
                        compact: { compactContext() }, reload: { Task { await commandCatalog.refresh(store: store, scope: commandScope, provider: provider, identity: commandIdentity, reload: true) } })
                }
                if providerUsage.limits?.offered == true {
                    Button { showingUsageLimits.toggle(); if showingUsageLimits { reloadUsageLimits() } } label: {
                        FridaySymbolImage(systemName: "chart.bar").frame(width: 24, height: 24)
                    }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "账号配额")).accessibilityLabel(Text(friday: "账号配额"))
                }
                Button { mention = nil; showContextPicker = true } label: {
                    FridaySymbolImage(systemName: "at").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "引用文件、目录或代码"))
                    .accessibilityLabel(Text(friday: "引用文件、目录或代码"))
                    .disabled(sending || capturingContext || !store.connected || contextScope.body.isEmpty || TaskContextDocument.used(message, records: contexts).count >= 20)
                if importing { ProgressView().controlSize(.small).accessibilityLabel(Text(friday: "正在添加图片")) }
                attachmentButton
                if let discardDraft, TaskDraftContent.hasUserContent(message, images: images.count, contexts: contexts.count, pendingContext: contextInsertion != nil) {
                    Button(action: discardDraft) { FridaySymbolImage(systemName: "trash").frame(width: 24, height: 24) }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "丢弃草稿"))
                        .help(Text(friday: "丢弃草稿，五秒内可撤销"))
                        .disabled(sending || importing || capturingContext)
                }
                if let tokens = resumeCompactionTokens, !draftEmpty {
                    Button {
                        if fullHistoryScopes.contains(commandIdentity) { fullHistoryScopes.remove(commandIdentity) }
                        else { fullHistoryScopes.insert(commandIdentity) }
                    } label: {
                        Text(friday: compactsBeforeSend ? "压缩" : "完整历史") + Text(" " + TaskContextUsage.format(tokens))
                    }.buttonStyle(FridayButtonStyle(compact: true))
                        .foregroundStyle(compactsBeforeSend ? Color.orange : .secondary)
                        .help(Text(friday: compactsBeforeSend ? "下次先压缩再发送；点击保留完整历史" : "下次保留完整历史；点击先压缩再发送"))
                        .accessibilityValue(Text(friday: compactsBeforeSend ? "压缩后发送" : "保留完整历史"))
                }
                primaryAction
            }.font(.callout).foregroundStyle(.secondary)
            #if os(iOS)
            TaskUndoNotice(store: store, state: store.taskUndo)
            #endif
            if let connectionError { Text(fridayString: connectionError).font(.caption).foregroundStyle(.orange).lineLimit(3) }
            }
        }
    }

    private var attachmentButton: some View {
        Group {
            #if os(iOS)
            Menu {
                PhotosPicker(selection: $photoItems, maxSelectionCount: max(1, 20 - images.count), matching: .images) {
                    FridaySymbolLabel(friday: "照片图库", systemImage: "photo")
                }
                Button { importerContext = contextID; showImageImporter = true } label: {
                    FridaySymbolLabel(friday: "选择图片文件", systemImage: "folder")
                }
            } label: { FridaySymbolImage(systemName: "paperclip").frame(width: 28, height: 28) }
            #else
            Button(action: chooseImageFiles) {
                FridaySymbolImage(systemName: "paperclip").font(.system(size: 16)).frame(width: 28, height: 28)
            }.help(Text(friday: "添加图片，也可以粘贴或拖入"))
            #endif
        }.buttonStyle(FridaySymbolButtonStyle())
            .disabled(sending || importing || showImageImporter || compact || images.count >= 20 || (requiresProject && projectPath == nil))
            .accessibilityLabel(Text(friday: "添加图片"))
    }

    @ViewBuilder private var primaryAction: some View {
        if proposedPlan != nil {
            HStack(spacing: 1) {
                Button { submit(alternate: false) } label: {
                    if sending { ProgressView().controlSize(.small) }
                    else { Text(friday: draftEmpty ? "实施" : "细化") }
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .disabled(disabled || compact).keyboardShortcut(.return, modifiers: .command)
                if draftEmpty {
                    Menu {
                        Button(friday: "在新任务中实施", systemImage: "plus.bubble") { submit(alternate: false, newThread: true) }
                    } label: { FridaySymbolImage(systemName: "chevron.down").font(.system(size: 10)).frame(width: 18, height: 28) }
                        .menuStyle(.borderlessButton).fixedSize().fridayInteractiveCursor()
                        .disabled(disabled || compact).accessibilityLabel(Text(friday: "实施选项"))
                }
            }
        } else if showsStop {
            Button(action: stop) {
                FridaySymbolImage(systemName: "stop.fill").font(.system(size: 8, weight: .medium))
            }.buttonStyle(AgentTaskActionButtonStyle(destructive: true))
                .accessibilityLabel(Text(friday: stopping ? "正在停止" : "停止"))
                .help(Text(friday: "停止"))
                .disabled(stopping || !store.connected || compact)
        } else if draftEmpty && canResume && editingQueuedMessageId == nil {
            Button { resumeTask?() } label: {
                if sending { ProgressView().controlSize(.small) }
                else { FridaySymbolImage(systemName: "play.fill").font(.system(size: 13)) }
            }.buttonStyle(AgentTaskActionButtonStyle()).accessibilityLabel(Text(friday: "继续任务"))
                .help(Text(friday: "继续任务")).disabled(sending || task?.gitBusy == true || !store.connected || compact)
        } else {
            Button {
                #if os(macOS)
                submit(alternate: !NSEvent.modifierFlags.intersection([.command, .control]).isEmpty)
                #else
                submit(alternate: alternateDown)
                #endif
            } label: {
                if sending { ProgressView().controlSize(.small) }
                else { FridaySymbolImage(systemName: editingQueuedMessageId != nil ? "checkmark" : dispatchMode == .queue ? "text.badge.plus" : dispatchMode == .steer ? "arrow.turn.up.right" : "arrow.up").font(.system(size: 14, weight: .semibold)) }
            }.buttonStyle(AgentTaskActionButtonStyle())
                .accessibilityLabel(Text(friday: sending ? "发送中" : editingQueuedMessageId != nil ? "保存排队消息" : compactsBeforeSend ? "压缩后发送" : dispatchMode == .queue ? "加入队列" : dispatchMode == .steer ? "补充任务要求" : "发送"))
                .help(Text(friday: compactsBeforeSend ? "下次先压缩再发送；点击保留完整历史" : active ? (dispatchMode == .queue ? "加入队列；按住 ⌘ 或 Control 立即补充。" : "立即补充；按住 ⌘ 或 Control 加入队列。") : "发送"))
                .keyboardShortcut(.return, modifiers: .command).disabled(disabled || compact)
                .contextMenu {
                    Button { followUpBehavior = "queue" } label: { FridaySymbolLabel(friday: "运行中默认排队", systemImage: followUpBehavior == "queue" ? "checkmark" : "circle") }
                    Button { followUpBehavior = "steer" } label: { FridaySymbolLabel(friday: "运行中默认立即补充", systemImage: followUpBehavior == "steer" ? "checkmark" : "circle") }
                }
        }
    }

    private func submit(alternate: Bool, newThread: Bool = false) {
        guard !disabled, !compact else { return }
        if provider == "codex", images.isEmpty, contexts.isEmpty, contextInsertion == nil, let command = TaskComposerCommands.feedback(message) {
            guard let task, task.threadId != nil, commandCatalog.catalog?.commands.contains(where: { $0.name == "feedback" }) == true else { error = "请先开始一条 Codex 会话后提交反馈"; return }
            guard !codexCommands.busy, codexCommands.pending == nil else { error = "请先检查上次反馈的提交结果。"; return }
            message = ""; mention = nil; submitFeedback(command, task: task); return
        }
        if TaskProviderCatalog.supportsInteractionModes(provider, state: states[provider]), let mode = TaskComposerCommands.standaloneMode(message), images.isEmpty, contexts.isEmpty, contextInsertion == nil {
            interactionMode = mode; message = ""; mention = nil; return
        }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/usage-limits", usageLimitsAvailable {
            message = ""; mention = nil; showingUsageLimits = true; reloadUsageLimits(); return
        }
        if message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "/compact", images.isEmpty, TaskContextDocument.used(message, records: contexts).isEmpty {
            guard canCompactContext else { error = "请先等待已有会话空闲，再压缩上下文。"; return }
            compactContext(clearDraft: true); return
        }
        send(TaskComposerSubmission(provider: provider, model: model, effort: effort,
            dispatch: TaskComposerDispatch.resolve(running: active, canSteer: canSteer, preference: followUpBehavior, alternate: alternate),
            interactionMode: !TaskProviderCatalog.supportsInteractionModes(provider, state: states[provider]) || proposedPlan != nil && draftEmpty ? "default" : interactionMode, planEventID: proposedPlan?.id, implementInNewThread: newThread, compactBeforeSend: compactsBeforeSend))
    }
    private func reloadUsageLimits(force: Bool = false) {
        guard TaskProviderCatalog.hasUsageLimits(provider) else { return }
        Task {
            await providerUsage.refresh(store: store, provider: provider, taskID: task?.id, identity: commandIdentity, reload: force)
            if !store.usageLimitSources.isEmpty { await pooledUsage.refresh(store: store, force: force) }
        }
    }
    private func submitFeedback(_ command: String, task: WorkItem) { Task { await codexCommands.feedback(store: store, task: task, command: command) } }
    private func runGoalCommand(_ command: String, task: WorkItem) { Task { await codexCommands.goal(store: store, task: task, command: command, model: model, effort: effort, mode: interactionMode) } }
    private func compactContext(clearDraft: Bool = false) {
        guard let task, canCompactContext || compaction.pending != nil else { return }
        let draft = message, identity = commandIdentity
        compaction.start(store: store, task: task, scope: identity) {
            if clearDraft, commandIdentity == identity, message == draft { message = ""; mention = nil }
        }
    }
    private func recoverKnownContexts() {
        guard let task else { return }
        let known = (task.messages ?? []).flatMap { $0.contexts ?? [] } + (task.queue?.messages ?? []).flatMap { $0.contexts ?? [] } + (task.rewindOperation?.editor.contexts ?? [])
        for occurrence in TaskContextDocument.occurrences(message) where !contexts.contains(where: { $0.id == occurrence.id }) {
            if let reference = known.first(where: { $0.id == occurrence.id && $0.kind == occurrence.kind }) { contexts.append(reference) }
        }
    }
    private func openContext(_ id: String) {
        if let reference = contexts.first(where: { $0.id == id }) { mention = nil; previewContext = reference }
        else { error = "引用内容未加载，请删除后重新添加。" }
    }
    private func moveSuggestion(_ delta: Int) {
        guard !suggestions.isEmpty else { return }; selectedSuggestion = (selectedSuggestion + delta + suggestions.count) % suggestions.count
    }
    private func chooseSuggestion() { guard suggestions.indices.contains(selectedSuggestion), !loadingSuggestions else { return }; captureEntry(suggestions[selectedSuggestion]) }
    private func receiveFileMentionProviders(_ providers: [NSItemProvider]) -> Bool {
        guard fileMentionsEnabled, providers.count <= 20 else { return false }
        let scope = fileMentionScope, identity = fullEditorIdentity, queueID = editingQueuedMessageId, request = UUID()
        fileMentionRequest = request; capturingContext = true
        Task { @MainActor in
            defer { if fileMentionRequest == request { fileMentionRequest = nil; capturingContext = false } }
            var payloads: [TaskFileMentionPayload] = []
            for provider in providers {
                let data: Data? = await withCheckedContinuation { continuation in
                    _ = provider.loadDataRepresentation(forTypeIdentifier: TaskFileMentionTransfer.type) { data, _ in continuation.resume(returning: data) }
                }
                guard fileMentionRequest == request, fileMentionScope == scope, fullEditorIdentity == identity, editingQueuedMessageId == queueID, let data, let payload = TaskFileMentionPayload.decode(data) else { return }; payloads.append(payload)
            }
            guard let combined = TaskFileMentionPayload.combine(payloads), let data = combined.data else { return }
            fileMentionRequest = nil; capturingContext = false
            if !fileMentionContext.receive(data) { error = "输入框尚未准备好接收引用" }
        }
        return true
    }
    private func captureFileMentions(_ payload: TaskFileMentionPayload) -> Bool {
        guard fileMentionsEnabled, editorIdentity == fullEditorIdentity, payload.scope == fileMentionScope, !payload.entries.isEmpty, payload.entries.count <= 20, payload.entries.allSatisfy(\.valid) else { return false }
        let identity = editorIdentity, source = fileMentionScope, scope = contextScope, queueID = editingQueuedMessageId, request = UUID()
        capturingContext = true; fileMentionRequest = request; error = nil; mention = nil
        Task { @MainActor in
            defer { if fileMentionRequest == request { fileMentionRequest = nil; capturingContext = false } }
            do {
                var references: [TaskContextReference] = []
                for entry in payload.entries {
                    guard fileMentionRequest == request, editorIdentity == identity, fileMentionScope == source, editingQueuedMessageId == queueID, !sending else { return }
                    references.append(try await store.captureTaskContext(scope: scope, input: ["kind": entry.kind, "path": entry.path]))
                }
                guard fileMentionRequest == request, editorIdentity == identity, fileMentionScope == source, editingQueuedMessageId == queueID, !sending else { return }
                guard let batch = TaskContextDocument.batch(references, text: message, records: contexts, identity: fullEditorIdentity) else { throw ConnectionError.message("每条消息最多添加 20 个上下文引用") }
                contexts = batch.records; contextInsertion = batch.insertion
                #if os(macOS)
                setExpanded(true)
                #endif
            } catch { if fileMentionRequest == request, editorIdentity == identity, fileMentionScope == source { self.error = error.localizedDescription } }
        }
        return true
    }
    private func captureEntry(_ entry: TaskFileEntry) {
        guard !capturingContext, !sending else { return }
        if ["skill", "builtin", "provider-command"].contains(entry.kind) {
            guard let query = mention, NSMaxRange(query.range) <= (message as NSString).length, (message as NSString).substring(with: query.range) == query.source else { return }
            let name = String(entry.path.split(separator: ":", maxSplits: 1).last ?? "")
            var insertion = TaskContextInsertion(replacing: query, focus: true, identity: fullEditorIdentity)
            if entry.kind == "provider-command", name == "usage-limits", usageLimitsAvailable {
                insertion.plainText = ""; showingUsageLimits = true; reloadUsageLimits()
            } else if entry.kind == "builtin" {
                insertion.plainText = ""
                if name == "model" { insertion.focus = false; showModels = true }
                else { interactionMode = name == "plan" ? "plan" : "default" }
            } else { insertion.plainText = (entry.kind == "skill" ? "$" : "/") + name + " " }
            contextInsertion = insertion; mention = nil; return
        }
        let replacement = mention; let identity = editorIdentity; let scope = contextScope
        capturingContext = true; error = nil; mention = nil
        Task { @MainActor in
            defer { if editorIdentity == identity { capturingContext = false } }
            do {
                let reference = try await store.captureTaskContext(scope: scope, input: ["kind": entry.kind, "path": entry.path])
                guard editorIdentity == identity, !sending else { return }; addReference(reference, replacing: replacement)
            } catch { if editorIdentity == identity { self.error = error.localizedDescription } }
        }
    }
    private func updateFileReview(_ mutation: TaskFileReviewMutation) -> Bool {
        guard reviewEnabled, editorIdentity == fullEditorIdentity,
              let result = TaskFileReviewDocument.update(mutation, text: message, records: contexts, scope: fileMentionScope, target: reviewTarget) else { return false }
        contexts = result.records; message = result.text
        if let reference = result.insert {
            contextInsertion = TaskContextInsertion(reference: reference, focus: false, identity: fullEditorIdentity, previousOccurrences: 0)
            #if os(macOS)
            setExpanded(true)
            #endif
        }
        return true
    }
    private func addReference(_ reference: TaskContextReference, replacing: TaskMentionQuery?) {
        let duplicate = contexts.first { $0.kind == reference.kind && $0.path == reference.path && $0.digest == reference.digest && $0.lineStart == reference.lineStart && $0.lineEnd == reference.lineEnd }
        guard duplicate != nil || TaskContextDocument.used(message, records: contexts).count < 20 else { error = "每条消息最多添加 20 个上下文引用"; return }
        if duplicate == nil { contexts.append(reference) }
        let accepted = duplicate ?? reference
        contextInsertion = TaskContextInsertion(reference: accepted, replacing: replacing, focus: true, identity: fullEditorIdentity, previousOccurrences: TaskContextDocument.occurrences(message).filter { $0.id == accepted.id }.count)
        #if os(macOS)
        setExpanded(true)
        #endif
    }

    private func addImage(_ data: Data, name: String) throws {
        let image = try IdeaImageCache.importImage(data, name: name)
        guard !images.contains(where: { $0.id == image.id }) else { return }
        guard images.count < 20 else { throw ConnectionError.message("最多添加 20 张图片。") }
        images.append(image)
    }
    private func importFiles(_ urls: [URL], context: String) {
        guard context == contextID, !sending else { return }
        error = nil
        for url in urls {
            do { let (data, name) = try TaskImageImport.read(url); try addImage(data, name: name) }
            catch { self.error = error.localizedDescription }
        }
        #if os(macOS)
        setExpanded(true); focusRequest += 1
        #endif
    }
    private func importProviders(_ providers: [NSItemProvider]) {
        guard !sending, !importing, !requiresProject || projectId != nil else { return }
        let context = contextID; importing = true; error = nil
        Task { @MainActor in
            for provider in providers.prefix(20) {
                do {
                    let (data, name) = try await TaskImageImport.data(from: provider)
                    guard context == contextID else { return }
                    try addImage(data, name: name)
                } catch { if context == contextID { self.error = error.localizedDescription } }
            }
            guard context == contextID else { return }
            importing = false
            #if os(macOS)
            setExpanded(true); focusRequest += 1
            #endif
        }
    }

    #if os(macOS)
    private func chooseImageFiles() {
        guard !showImageImporter else { return }
        let context = contextID
        let panel = NSOpenPanel()
        panel.canChooseFiles = true; panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true; panel.allowedContentTypes = [.image]
        showImageImporter = true
        let completion: (NSApplication.ModalResponse) -> Void = { response in
            showImageImporter = false
            if response == .OK { importFiles(panel.urls, context: context) }
        }
        if let window = NSApp.keyWindow { panel.beginSheetModal(for: window, completionHandler: completion) }
        else { panel.begin(completionHandler: completion) }
    }

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
            }.buttonStyle(FridaySymbolButtonStyle()).disabled(sending).accessibilityLabel(Text(friday: "任务模型"))
                .popover(isPresented: $showModels) {
                    TaskModelPicker(server: store.connection.server, scope: store.connectionIdentity, states: states, lockedProvider: task?.agent, provider: provider, model: selectedModel?.id ?? model) { choice in
                        provider = choice.provider; model = choice.model.id; effort = ""; if !TaskProviderCatalog.supportsInteractionModes(provider, state: states[provider]) { interactionMode = "default" }; showModels = false
                    }.environment(\.locale, locale)
                }
        }
    }

    @ViewBuilder private var branchControl: some View {
        if let task {
            ExistingTaskBranchControl(store: store, task: task, submitting: $switchingBranch).id(task.id).disabled(sending || task.gitBusy || task.sessionBusy)
        } else if let projectId, let workspace, let workspaceState, workspace.wrappedValue.preparationId == nil, workspace.wrappedValue.reuseTaskId == nil {
            NewTaskBranchControl(store: store, state: workspaceState, projectId: projectId, selection: workspace)
                .id(projectId).disabled(sending || !store.connected)
        }
    }

    private func stop() {
        guard let task, task.active || backgroundStopAvailable || task.watchingPullRequests, !stopping, store.connected else { return }
        let taskId = task.id; let identity = store.connectionIdentity; let transport = store.connection; let request = UUID()
        var body: [String: Any] = [:]
        if let run = task.currentRunId { body["runId"] = run }
        if let session = task.executionSessionId { body["sessionId"] = session }
        stoppingTaskId = taskId; stoppingRequest = request
        Task {
            defer { if stoppingRequest == request { stoppingTaskId = nil; stoppingRequest = nil } }
            do {
                _ = try await transport.data("/api/tasks/\(taskId)/cancel", method: "POST", body: body)
                guard store.connectionIdentity == identity, stoppingRequest == request else { return }; await store.refresh()
            } catch { if store.connectionIdentity == identity, stoppingRequest == request { self.error = error.localizedDescription } }
        }
    }
}

struct AgentTaskActionButtonStyle: ButtonStyle {
    var destructive = false

    func makeBody(configuration: Configuration) -> some View {
        AgentTaskActionButtonBody(configuration: configuration, destructive: destructive)
    }
}

private struct AgentTaskActionButtonBody: View {
    let configuration: ButtonStyleConfiguration
    let destructive: Bool
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled

    private var background: Color { destructive ? Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255) : FridayTheme.accent }

    var body: some View {
        configuration.label
            .foregroundStyle(destructive ? Color.white : FridayTheme.onAccent)
            .frame(width: 32, height: 32)
            .background(background.opacity(destructive && !hovering ? 0.9 : 1), in: Circle())
            .overlay(Circle().strokeBorder(Color.white.opacity(isEnabled ? 0.12 : 0), lineWidth: 1))
            .shadow(color: background.opacity(isEnabled && !configuration.isPressed ? 0.24 : 0), radius: 1, y: 1)
            .opacity(isEnabled ? 1 : 0.64)
            .contentShape(Circle())
            .fridaySymbolFeedback(active: configuration.isPressed)
            .fridayInteractiveCursor()
            .onHover { hovering = $0 }
    }
}

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
