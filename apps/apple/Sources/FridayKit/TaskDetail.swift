import SwiftUI
#if os(macOS)
import AppKit
#endif

struct TaskDetail: View {
    @ReadingPreferences private var reading: ReadingStyle
    @ObservedObject var store: FridayStore
    let id: String
    var onOpenTask: ((String) -> Void)? = nil
    @State private var message = ""
    @State private var images: [IdeaImage] = []
    @State private var contexts: [TaskContextReference] = []
    @StateObject private var fileMentionBridge = TaskFileMentionBridge()
    @State private var contextInsertion: TaskContextInsertion?
    @State private var sendError: String?
    @State private var draftLoaded = false
    @State private var lastGuideBlock: String?
    @State private var lastGuideReferenceID: String?
    @State private var messageId = UUID().uuidString
    @State private var sending = false
    @State private var queueEdit: QueuedMessageEditDraft?
    @State private var resumeRequestId = UUID().uuidString
    @State private var followingEnd = true
    @State private var previousScrollTop: CGFloat?
    @State private var scrollRequest = 0
    @State private var diffSelection: TaskDiffSelection?
    @State private var diffWidth: Double = 460
    @State private var filesPanel = TaskFilesPanelState()
    @State private var activePanel = "diff"
    @State private var browserPanel=TaskBrowserPanelState()
    @State private var panelContext = ""
    @State private var terminalShown = false
    @State private var worktreeSetup: TaskWorktreeSetupSnapshot?
    @State private var rewindTarget: TaskRewindTarget?
    @State private var rewindDraft: TaskRewindDraft?
    @State private var draftContext = ""
    @State private var historyWindow = TaskHistoryWindow()
    @State private var conversationWindow = TaskConversationWindow()
    @State private var historyRetryGeneration = 0
    @State private var historyLoading = false
    @State private var historyError: String?
    @State private var historyRequest = UUID()
    @State private var historyAnchor: String?
    #if os(iOS)
    @Environment(\.fridayMobileNavigationInComposer) private var mobileHomeNavigation
    @Environment(\.fridayMobileKeyboardVisible) private var mobileKeyboardVisible
    #endif
    #if os(macOS)
    @State private var composerHeight: CGFloat = 136
    @State private var composerCollapseRequest = 0
    @State private var composerExpandRequest = 0
    @State private var composerNeedsRestore = false
    @State private var composerAtBottom = true
    #endif
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var draftMessage: Binding<String> {
        Binding(get: { message }, set: { value in
            message = value
            if !sending { messageId = UUID().uuidString; sendError = nil }
            preservePendingRewindDraft()
        })
    }
    private var draftImages: Binding<[IdeaImage]> {
        Binding(get: { images }, set: { value in
            images = value
            if !sending { messageId = UUID().uuidString; sendError = nil }
            preservePendingRewindDraft()
        })
    }
    private var draftContexts: Binding<[TaskContextReference]> {
        Binding(get: { contexts }, set: { value in
            contexts = value
            if !sending { messageId = UUID().uuidString; sendError = nil }
            preservePendingRewindDraft()
        })
    }

    private var historyScope: String { store.connectionIdentity + "\n" + id + ":" + String(store.taskHistoryGeneration) }
    private var rawTask: WorkItem? { store.snapshotIdentity == store.connectionIdentity ? store.taskDetail(id) : nil }
    private var task: WorkItem? { rawTask.map { $0.conversationHistory == nil ? historyWindow.presenting($0, scope: historyScope) : conversationWindow.presenting($0, scope: historyScope) } }
    private var hasEarlierHistory: Bool { rawTask?.conversationHistory == nil ? historyWindow.hasEarlier : conversationWindow.hasEarlier }
    private var historyAutomaticKey: String {
        let state = rawTask?.conversationHistory.map { $0.epoch + ":" + String(conversationWindow.needsAutomaticLoading) + ":" + String(historyRetryGeneration) }
            ?? ((rawTask?.history?.epoch ?? "") + ":" + String(rawTask?.history?.version ?? 0))
        return historyScope + ":" + state + ":" + String(store.connected) + ":" + (diffSelection?.eventID ?? "")
    }
    private func acceptHistory(_ task: WorkItem) {
        if task.conversationHistory == nil { historyWindow.accept(task, scope: historyScope) }
        else { conversationWindow.accept(task, scope: historyScope) }
    }

    var body: some View {
        detailContent.task(id: store.connectionIdentity + ":" + id) { await store.followTask(id) }
    }
    @ViewBuilder private var detailContent: some View {
        if let task {
            taskHistoryLifecycle(task)
            .onChange(of: diffSelection) { _, _ in savePanels() }
            .onChange(of: filesPanel) { _, _ in savePanels() }
            .onChange(of:browserPanel) {_,_ in savePanels()}
            .onChange(of:browserPanel.visible) {old,new in
                if old && !new,activePanel=="browser",let tab=browserPanel.current,tab.url != nil,
                   UserDefaults.standard.object(forKey:"friday.browser.autoFloat")==nil || UserDefaults.standard.bool(forKey:"friday.browser.autoFloat") {
                    TaskBrowserSessions.shared.float(scope:TaskBrowserSessionScope.value(owner:store.browserClientID,connection:store.connectionIdentity,task:id),id:tab.id,host:TaskBrowserPolicy.usesHost(tab,server:store.connection.server))
                }
            }
            .onChange(of: activePanel) { _, _ in savePanels() }
            .onChange(of: diffWidth) { _, _ in savePanels() }
            .onChange(of: terminalShown) { _, _ in savePanels() }
            .onChange(of: id) { _, _ in
                draftLoaded = false; sending = false; queueEdit = nil; rewindDraft = nil; rewindTarget = nil; message = ""; images = []; contexts = []; contextInsertion = nil; sendError = nil; messageId = UUID().uuidString; resumeRequestId = UUID().uuidString
                restoreDraft()
                historyRequest = UUID(); historyLoading = false; historyError = nil; historyWindow = TaskHistoryWindow()
                conversationWindow = TaskConversationWindow(); historyRetryGeneration = 0
                restorePanels()
                applyRewindEditor()
                followingEnd = true; previousScrollTop = nil
                #if os(macOS)
                composerNeedsRestore = false
                composerAtBottom = true
                #endif
            }
            #if os(iOS)
            .modifier(TaskTerminalPanelLayout(store: store, task: task, shown: $terminalShown, canAddContext: !sending && !task.sessionBusy, addContext: addTerminalContext))
            #endif
            .modifier(TaskWorkspacePanelLayout(store: store, task: task, diff: $diffSelection, files: $filesPanel, browser: $browserPanel, terminal: $terminalShown, active: $activePanel, width: $diffWidth, canAddContext: !sending && !task.sessionBusy, addContext: addTerminalContext))
            .environment(\.taskFileMentionBridge, fileMentionBridge)
            .environment(\.taskBrowserOpen,{url in
                guard panelContext==store.connection.server+"\n"+id,TaskBrowserPolicy.url(url.absoluteString) != nil else{return false};browserPanel.open(url.absoluteString,defaults:TaskBrowserPreferences.shared(server:store.connection.server).defaults);activePanel="browser";return true
            })
            .environment(\.taskCitationNavigate,{ citation in
                guard citation.environmentId==store.serviceId else { return }
                store.assistantCitationNavigation=TaskCitationNavigationRequest(citation:citation,connection:store.connectionIdentity)
            })
            .environment(\.taskCitationReveal,store.assistantCitationNavigation)
            .onChange(of:store.assistantCitationNavigation?.id) { _,_ in
                guard let request=store.assistantCitationNavigation,request.connection==store.connectionIdentity,request.citation.environmentId==store.serviceId,request.citation.threadId != id else { return };onOpenTask?(request.citation.threadId)
            }
            .environment(\.taskFileOpen, TaskFileOpenContext(root: task.cwd, open: { location in filesPanel.open(location.path, line: location.line); activePanel = "files" }))
            .environment(\.markdownMediaContext, MarkdownMediaContext.task(store: store, task: task))
            .sheet(item: $rewindTarget) { target in
                let context = store.connection.server + "\n" + task.id
                TaskRewindDialog(store: store, task: task, messageID: target.id, begin: { requestID in if draftContext == context { beginRewind(requestID) } }, end: { if draftContext == context { sending = false; applyRewindEditor() } })
            }
        } else {
            EmptyPanel(icon: "checklist", title: store.taskWasRemoved(id) ? "任务不存在" : "正在加载任务", subtitle: store.taskStreamErrors[id] ?? "连接主机后会显示最新进展。")
                .fridayPaneSurface()
                #if os(iOS)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    // The home must remain navigable before its composer is available.
                    if mobileHomeNavigation, !mobileKeyboardVisible {
                        FridayMobileNavigationBar(collapsed: .constant(false))
                    }
                }
                #endif
        }
    }

    private func taskDraftLifecycle(_ task: WorkItem) -> some View {
        taskLayout(task)
        .onReceive(NotificationCenter.default.publisher(for: TaskDraftCache.restored)) { event in
            if TaskDraftCache.isRestore(event, server: store.connection.server, context: "task:" + id), !sending { restoreDraft(force: true) }
        }
        .onChange(of: message) { _, _ in if !task.localAgent && !sending { messageId = UUID().uuidString; sendError = nil }; saveDraft() }
        .onChange(of: images) { _, _ in if !task.localAgent && !sending { messageId = UUID().uuidString; sendError = nil }; saveDraft() }
        .onChange(of: store.reviewGuideComposerHandoff?.id) { _, _ in consumeGuideHandoff() }
        .onChange(of: draftLoaded) { _, value in if value { consumeGuideHandoff() } }
        .onChange(of: sending) { _, value in if !value { consumeGuideHandoff() } }
        .onChange(of: task.sessionBusy) { _, value in if !value { consumeGuideHandoff() } }
        .onChange(of: contexts) { _, _ in saveDraft() }
        .onChange(of: contextInsertion) { _, _ in saveDraft() }
        .onAppear {
            restoreDraft(); restorePanels(); consumeGuideHandoff()
            if let saved = store.taskViewHistory(id, scope: historyScope) { historyWindow = saved.history; conversationWindow = saved.conversation }
            if let rawTask { acceptHistory(rawTask) }
            applyRewindEditor()
        }
    }

    private func taskHistoryLifecycle(_ task: WorkItem) -> some View {
        taskDraftLifecycle(task)
        .onChange(of: store.revision) { _, _ in if let rawTask { acceptHistory(rawTask) } }
        .onChange(of: store.taskContentRevision) { _, _ in if let rawTask { acceptHistory(rawTask) } }
        .task(id: historyAutomaticKey) {
            if let rawTask { acceptHistory(rawTask) }
            while historyLoading {
                guard !Task.isCancelled else { return }
                do { try await Task.sleep(for: .milliseconds(20)) } catch { return }
            }
            await loadHistory(automatic: true, throughEventID: diffSelection?.eventID)
        }
        .onChange(of: task.rewindOperation?.projectedAt) { _, _ in applyRewindEditor() }
        .onChange(of: store.connection.server) { _, _ in draftLoaded = false; sending = false; rewindTarget = nil; restoreDraft(); restorePanels(); applyRewindEditor() }
        .task(id: TaskSnooze.readIdentity(task)) { await store.markTaskRead(task) }
        .onDisappear {
            saveDraft(); savePanels(); store.saveTaskViewHistory(id, scope: historyScope, history: historyWindow, conversation: conversationWindow)
            historyRequest = UUID(); historyLoading = false
        }
    }

    private func taskLayout(_ task: WorkItem) -> some View {
        VStack(spacing: 0) {
            #if os(macOS)
            if task.localAgent { header(task) }
            #endif
            transcriptScroll(task)
                .modifier(TaskBrowserFloatingPreview(store:store,task:task,browser:$browserPanel,activePanel:$activePanel))
        }
        .background(task.localAgent ? FridayTheme.canvas : FridayTheme.conversationCanvas)
        #if os(iOS)
        .navigationTitle("Friday")
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .bottom, spacing: 0) {
            #if os(iOS)
            FridayMobileComposerDock(notice: task.localAgent ? nil : store.error) {
                if task.localAgent && !TaskProviderCatalog.order.contains(task.agent) {
                    Text(friday: "此 Agent 接入已移除，历史任务仍可查看；请使用 Codex、Claude 或 Pi 新建任务。").font(.callout).foregroundStyle(.secondary).padding()
                } else if task.subagentOrigin != nil {
                    TaskBackgroundCommandsView(store: store, task: task)
                    TaskNativeSubagentBar(store: store, task: task, openTask: { onOpenTask?($0) })
                } else if task.delegationOrigin != nil {
                    TaskDelegatedBar(store: store, task: task, openTask: { onOpenTask?($0) })
                } else if task.localAgent {
                    TaskBackgroundCommandsView(store: store, task: task)
                    AgentTaskComposer(store: store, task: task, embeddedInMobileDock: true, submissionError: sendError,
                        editingQueuedMessageId: queueEdit?.id, editQueuedMessage: editQueuedMessage, cancelQueueEdit: cancelQueueEdit, resumeTask: resumeTask, discardDraft: discardDraft,
                        message: draftMessage, images: draftImages, contexts: draftContexts, contextInsertion: $contextInsertion, sending: sending, send: sendAgentMessage)
                } else {
                    FridayMobileComposer(
                        message: $message,
                        placeholder: task.active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？",
                        sending: sending,
                        disabled: sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued",
                        send: sendMessage
                    )
                }
            }
            #endif
        }
        #if os(macOS)
        .overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                if task.localAgent {
                    if !TaskProviderCatalog.order.contains(task.agent) {
                        Text(friday: "此 Agent 接入已移除，历史任务仍可查看；请使用 Codex、Claude 或 Pi 新建任务。").font(.callout).foregroundStyle(.secondary).padding()
                    } else if task.subagentOrigin != nil {
                        TaskBackgroundCommandsView(store: store, task: task)
                        TaskNativeSubagentBar(store: store, task: task, openTask: { onOpenTask?($0) })
                    } else if task.delegationOrigin != nil {
                        TaskDelegatedBar(store: store, task: task, openTask: { onOpenTask?($0) })
                    } else {
                        TaskBackgroundCommandsView(store: store, task: task)
                        AgentTaskComposer(store: store, task: task, collapseRequest: composerCollapseRequest, expandRequest: composerExpandRequest, submissionError: sendError,
                            editingQueuedMessageId: queueEdit?.id, editQueuedMessage: editQueuedMessage, cancelQueueEdit: cancelQueueEdit, resumeTask: resumeTask, discardDraft: discardDraft,
                            message: draftMessage, images: draftImages, contexts: draftContexts, contextInsertion: $contextInsertion, sending: sending, send: sendAgentMessage)
                    }
                } else {
                    FloatingComposer(
                        conversationID: id,
                        message: $message,
                        active: task.active,
                        sending: sending,
                        disabled: sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued",
                        error: store.error,
                        collapseRequest: composerCollapseRequest,
                        expandRequest: composerExpandRequest,
                        send: sendMessage
                    )
                }
            }
            .frame(maxWidth: reading.contentWidth).padding(.horizontal, task.localAgent ? 24 : 44).padding(.top, 8).padding(.bottom, 16).frame(maxWidth: .infinity)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: TaskComposerHeightKey.self, value: geometry.size.height)
            })
        }
        .onPreferenceChange(TaskComposerHeightKey.self) { height in
            guard height > 0, abs(height - composerHeight) > 0.5 else { return }
            composerHeight = height
            if followingEnd { scrollRequest += 1 }
        }
        #endif
    }

    private func transcriptScroll(_ task: WorkItem) -> some View {
        ScrollViewReader { proxy in
            GeometryReader { viewport in
                ScrollView {
                    TaskTranscriptContent(
                        store: store, task: task, header: { header(task) },
                        hasEarlierHistory: hasEarlierHistory, historyLoading: historyLoading,
                        historyError: historyError,
                        loadEarlier: {
                            let anchor = historyAnchor ?? CodexTranscript.rows(task).first?.id
                            followingEnd = false
                            Task { @MainActor in
                                await loadHistory(automatic: false)
                                if let anchor {
                                    var transaction = Transaction()
                                    transaction.disablesAnimations = true
                                    withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) }
                                }
                            }
                        },
                        worktreeSetup: worktreeSetup, canEditMessages: !sending && queueEdit == nil,
                        openDiff: { diffSelection = $0; activePanel = "diff" },
                        editFromHere: { rewindTarget = TaskRewindTarget(id: $0) },
                        openTask: { onOpenTask?($0) },
                        hasOriginalDraft: rewindDraft?.applied == true,
                        restoreOriginalDraft: restoreRewindOriginalDraft,
                        topInset: viewport.safeAreaInsets.top, viewportHeight: viewport.size.height,
                        endSpacing: transcriptEndSpacing(task)
                    )
                    #if os(macOS)
                    .background {
                        TranscriptHistoryScrollGesture(composerHeight: composerHeight, horizontalInset: task.localAgent ? 24 : 44) {
                            followingEnd = false
                            composerNeedsRestore = true
                            composerCollapseRequest += 1
                        } scrolledDown: {
                            if composerAtBottom {
                                followingEnd = true
                                restoreComposer()
                            }
                        }
                    }
                    #endif
                }
                .coordinateSpace(name: "task-transcript")
                .scrollPosition(id: $historyAnchor, anchor: .top)
                #if os(iOS)
                .fridayMobileHomeScroll()
                .scrollDismissesKeyboard(.interactively)
                .ignoresSafeArea(.container, edges: task.localAgent ? [] : .top)
                #endif
                .modifier(TranscriptScrollObserver(interactionBegan: { followingEnd = false }) { metrics in
                    guard metrics.bottom > 0 else { return }
                    // Also cover scrollbar/keyboard movement and older systems
                    // where the native gesture bridge may not receive input.
                    if let previousScrollTop, metrics.top > previousScrollTop + 3 { followingEnd = false }
                    #if os(macOS)
                    // Wait for downward movement to the actual bottom. Shrinking
                    // the composer also changes the bottom inset; that alone
                    // must not immediately undo the user's upward-scroll fold.
                    composerAtBottom = metrics.bottom <= metrics.viewportHeight + 2
                    if composerNeedsRestore,
                       let previousScrollTop, metrics.top < previousScrollTop,
                       composerAtBottom {
                        restoreComposer()
                    }
                    #endif
                    let atEnd = metrics.bottom <= metrics.viewportHeight + 48
                    #if os(macOS)
                    if atEnd, let previousScrollTop, metrics.top < previousScrollTop { followingEnd = true }
                    #else
                    if atEnd { followingEnd = true }
                    #endif
                    previousScrollTop = metrics.top
                })
                .task(id: id) {
                    await Task.yield()
                    if let request=store.assistantCitationNavigation,request.connection==store.connectionIdentity,request.citation.threadId==id,request.citation.environmentId==store.serviceId { return }
                    if followingEnd { proxy.scrollTo("transcript-end", anchor: .bottom) }
                }
                .task(id: task.updatedAt) {
                    await Task.yield()
                    if followingEnd { proxy.scrollTo("transcript-end", anchor: .bottom) }
                }
                .onChange(of: scrollRequest) { _, _ in
                    if followingEnd { proxy.scrollTo("transcript-end", anchor: .bottom) }
                }
                .task(id:store.assistantCitationNavigation?.id) {
                    guard let request=store.assistantCitationNavigation,request.connection==store.connectionIdentity,request.citation.environmentId==store.serviceId,request.citation.threadId==id else { return }
                    followingEnd=false
                    while historyLoading && !Task.isCancelled { try? await Task.sleep(for:.milliseconds(80)) }
                    guard !Task.isCancelled else { return }
                    await loadHistory(automatic:true,throughEventID:request.citation.messageId)
                    guard !Task.isCancelled,let latest=self.task,CodexTranscript.rows(latest).contains(where: { $0.id==request.citation.messageId }) else { return }
                    await Task.yield();proxy.scrollTo(request.citation.messageId,anchor:.center)
                }
                .environment(\.markdownScrollTo, { anchor in
                    followingEnd = false
                    withAnimation(reduceMotion ? nil : FridayTheme.motion) { proxy.scrollTo(anchor, anchor: .top) }
                })
                .environment(\.markdownMediaContext, MarkdownMediaContext.task(store: store, task: task))
            }
        }
    }

    private func transcriptEndSpacing(_ task: WorkItem) -> CGFloat {
        #if os(macOS)
        composerHeight + 24
        #else
        1
        #endif
    }

    @MainActor private func loadHistory(automatic: Bool, throughEventID: String? = nil) async {
        guard !historyLoading, store.connected, let raw = rawTask, raw.localAgent else { return }
        if raw.conversationHistory != nil { await loadConversationHistory(automatic: automatic, throughEventID: throughEventID); return }
        historyWindow.accept(raw, scope: historyScope)
        let seeking = throughEventID.map { !historyWindow.contains($0, live: raw, scope: historyScope) } ?? false
        guard (seeking ? historyWindow.nextEarlier : automatic ? historyWindow.nextAutomatic : historyWindow.nextEarlier) != nil else { return }
        let scope = historyScope; let token = store.connection.token; let server = store.connection.server
        let request = UUID(); historyRequest = request; historyLoading = true; historyError = nil
        defer { if historyRequest == request { historyLoading = false } }
        do {
            while true {
                guard !Task.isCancelled, historyScope == scope, store.connection.server == server, store.connection.token == token, let live = rawTask, let epoch = live.history?.epoch else { return }
                let seeking = throughEventID.map { !historyWindow.contains($0, live: live, scope: scope) } ?? false
                guard let range = seeking ? historyWindow.nextEarlier : automatic ? historyWindow.nextAutomatic : historyWindow.nextEarlier else { return }
                let page = try await store.taskHistory(id, epoch: epoch, range: range)
                guard !Task.isCancelled, historyRequest == request, historyScope == scope, let latest = rawTask else { return }
                guard historyWindow.apply(page, live: latest, scope: scope) else { return }
                if !automatic { return }
                await Task.yield()
            }
        } catch {
            guard !Task.isCancelled, historyRequest == request, historyScope == scope else { return }
            historyError = error.localizedDescription
        }
    }

    @MainActor private func loadConversationHistory(automatic: Bool, throughEventID: String?) async {
        guard !historyLoading, store.connected, let raw = rawTask else { return }
        conversationWindow.accept(raw, scope: historyScope)
        let seeking = throughEventID.map { !conversationWindow.contains($0) } ?? false
        guard seeking && conversationWindow.hasEarlier || (automatic ? conversationWindow.needsAutomaticLoading : conversationWindow.hasEarlier || conversationWindow.needsAutomaticLoading) else { return }
        if !automatic { historyRetryGeneration += 1 }
        let scope = historyScope; let epoch = raw.conversationHistory!.epoch
        let request = UUID(); historyRequest = request; historyLoading = true; historyError = nil
        defer { if historyRequest == request { historyLoading = false } }
        do {
            while !Task.isCancelled {
                guard historyRequest == request, historyScope == scope, let live = rawTask, live.conversationHistory?.epoch == epoch else { return }
                conversationWindow.accept(live, scope: scope)
                let rangeKind = live.conversationHistory?.kind
                let seeking = throughEventID.map { !conversationWindow.contains($0) } ?? false
                let gap = automatic && !seeking && conversationWindow.gapCursor != nil
                let cursor = gap ? conversationWindow.gapCursor : (seeking || !automatic ? conversationWindow.earlierCursor : nil)
                if let cursor {
                    let page = try await store.taskConversationHistory(id, cursor: cursor, through: seeking ? throughEventID : nil)
                    guard !Task.isCancelled, historyRequest == request, historyScope == scope, let latest = rawTask, latest.conversationHistory?.epoch == epoch else { return }
                    if latest.conversationHistory?.kind != rangeKind { conversationWindow.accept(latest, scope: scope); continue }
                    if !conversationWindow.apply(page, live: latest, scope: scope, cursor: cursor, gap: gap) {
                        if gap && conversationWindow.gapCursor != cursor { continue }
                        throw ConnectionError.message("对话历史已改变，请重新加载记录")
                    }
                    if !automatic && !seeking { return }
                } else if !conversationWindow.staleEventIDs.isEmpty {
                    let page = try await store.taskHistoryEvents(live.id, ids: conversationWindow.staleEventIDs)
                    guard !Task.isCancelled, historyRequest == request, historyScope == scope, let latest = rawTask, latest.conversationHistory?.epoch == epoch else { return }
                    if !conversationWindow.apply(page, live: latest, scope: scope) { throw ConnectionError.message("历史正在更新，请稍后重试") }
                } else { return }
                await Task.yield()
            }
        } catch {
            guard !Task.isCancelled, historyRequest == request, historyScope == scope, rawTask?.conversationHistory?.epoch == epoch else { return }
            historyError = error.localizedDescription
        }
    }

    private func header(_ task: WorkItem) -> TaskDetailHeader {
        TaskDetailHeader(store: store, task: task, onOpenTask: onOpenTask,
                         worktreeSetup: $worktreeSetup, filesPanel: $filesPanel,
                         activePanel: $activePanel, terminalShown: $terminalShown,
                         browserPanel: $browserPanel, diffSelection: $diffSelection,
                         workspacePanelVisible: workspacePanelVisible,
                         toggleWorkspacePanel: toggleWorkspacePanel)
    }

    private var workspacePanelVisible: Bool {
        diffSelection != nil || filesPanel.visible || browserPanel.visible || terminalShown
    }

    private func toggleWorkspacePanel() {
        if workspacePanelVisible {
            for tab in filesPanel.tabs {
                FileEditorStore.shared.flush(FileEditorStore.key(server: store.connection.server, token: store.connection.token, cwd: task?.cwd ?? "", path: tab.path))
            }
            diffSelection = nil; filesPanel.visible = false; browserPanel.visible = false; terminalShown = false
        } else {
            switch activePanel {
            case "files": filesPanel.visible = true
            case "browser" where !browserPanel.tabs.isEmpty: browserPanel.visible = true
            case "terminal" where task?.projectId != nil: terminalShown = true
            default: diffSelection = TaskDiffSelection(); activePanel = "diff"
            }
        }
    }

    private func restorePanels() {
        panelContext = store.connection.server + "\n" + id
        let preferences = TaskDraftCache.load(TaskPanelPreferences.self, server: store.connection.server, context: "task-panel:" + id) ?? TaskPanelPreferences()
        diffSelection = preferences.diff; diffWidth = preferences.width.isFinite ? max(320, min(1600, preferences.width)) : 460; terminalShown = preferences.terminalShown == true
        filesPanel = preferences.files ?? TaskFilesPanelState(); activePanel = preferences.activePanel ?? "diff"
        browserPanel=preferences.browser ?? TaskBrowserPanelState();browserPanel.validate()
    }
    private func savePanels() {
        guard panelContext == store.connection.server + "\n" + id else { return }
        TaskDraftCache.save(TaskPanelPreferences(diff: diffSelection, width: diffWidth, terminalShown: terminalShown, files: filesPanel, activePanel: activePanel,browser:browserPanel.persisted), server: store.connection.server, context: "task-panel:" + id)
    }

    private func discardDraft() {
        guard draftLoaded, !sending, task?.localAgent == true else { return }
        let server = store.connection.server, taskID = id, context = "task:" + id
        let saved = TaskMessageDraft(message: message, images: images, requestId: messageId, queueEdit: queueEdit, rewindEdit: rewindDraft, contexts: contexts, contextInsertion: contextInsertion)
        guard saved.hasUserContent else { return }
        message = ""; images = []; contexts = []; contextInsertion = nil; queueEdit = nil; rewindDraft = nil; messageId = UUID().uuidString
        lastGuideBlock = nil; lastGuideReferenceID = nil; sendError = nil
        TaskDraftCache.save(Optional<TaskMessageDraft>.none, server: server, context: context)
        store.taskUndo.discardedDraft(store: store, key: "task-draft:" + taskID) {
            guard TaskDraftCache.load(TaskMessageDraft.self, server: server, context: context)?.hasUserContent != true else { throw ConnectionError.message("草稿已有新内容，无法恢复被丢弃的草稿。") }
            TaskDraftCache.save(saved, server: server, context: context)
            TaskDraftCache.notifyRestored(server: server, context: context)
        }
    }

    private func restoreDraft(force: Bool = false) {
        let context = store.connection.server + "\n" + id
        guard force || !draftLoaded || draftContext != context else { return }
        lastGuideBlock = nil; lastGuideReferenceID = nil
        draftContext = context; message = ""; images = []; contexts = []; contextInsertion = nil; messageId = UUID().uuidString; queueEdit = nil; rewindDraft = nil
        if task?.localAgent == true, let saved = TaskDraftCache.load(TaskMessageDraft.self, server: store.connection.server, context: "task:" + id) {
            message = saved.message; images = saved.images; messageId = saved.requestId; queueEdit = saved.queueEdit
            contexts = saved.contexts ?? []
            contextInsertion = saved.contextInsertion
            rewindDraft = saved.rewindEdit
        }
        draftLoaded = true
    }
    private func consumeGuideHandoff() {
        guard draftLoaded, !sending, task?.localAgent == true, task?.sessionBusy != true, draftContext == store.connection.server + "\n" + id,
              let value = store.reviewGuideComposerHandoff, value.taskID == id, value.identity == store.connectionIdentity else { return }
        var records = contexts
        if !records.contains(where: { $0.id == value.reference.id }) { records.append(value.reference) }
        let block = (value.question.isEmpty ? "" : value.question + "\n\n") + TaskContextDocument.token(value.reference)
        let next = TaskGuideComposerHandoff.merge(current: message, previousBlock: lastGuideBlock, newBlock: block)
        if TaskContextDocument.used(next, records: records).count > 20 {
            store.reviewGuideHandoffOutcome = .init(id: value.id, error: "每条消息最多添加 20 个上下文引用")
        } else {
            if let old = lastGuideReferenceID, old != value.reference.id, !TaskContextDocument.occurrences(next).contains(where: { $0.id == old }) { records.removeAll { $0.id == old } }
            draftContexts.wrappedValue = records; draftMessage.wrappedValue = next
            lastGuideBlock = block; lastGuideReferenceID = value.reference.id
            store.reviewGuideHandoffOutcome = .init(id: value.id, error: nil)
            #if os(macOS)
            composerExpandRequest += 1
            #endif
            saveDraft()
        }
        if store.reviewGuideComposerHandoff?.id == value.id { store.reviewGuideComposerHandoff = nil }
    }
    private func addTerminalContext(_ selection: TaskTerminalSelection) async -> Bool {
        guard !sending, task?.localAgent == true, task?.sessionBusy != true else { return false }
        let server = store.connection.server; let taskID = id; let scope = TaskContextScope(taskID: id)
        let editorIdentity = store.taskComposerIdentity(scope)
        do {
                let reference = try await store.captureTaskContext(scope: scope, input: selection.body)
                guard draftContext == server + "\n" + taskID, store.taskComposerIdentity(scope) == editorIdentity, !sending, task?.sessionBusy != true else { return false }
                let duplicate = contexts.first { $0.kind == reference.kind && $0.digest == reference.digest && $0.terminalId == reference.terminalId && $0.generation == reference.generation && $0.lineStart == reference.lineStart && $0.lineEnd == reference.lineEnd }
                guard duplicate != nil || TaskContextDocument.used(message, records: contexts).count < 20 else { throw ConnectionError.message("每条消息最多添加 20 个上下文引用") }
                if duplicate == nil { draftContexts.wrappedValue.append(reference) }
                let accepted = duplicate ?? reference
                if task?.approvals.contains(where: { $0.state == "pending" }) == true {
                    draftMessage.wrappedValue += (message.isEmpty || message.hasSuffix(" ") || message.hasSuffix("\n") ? "" : " ") + TaskContextDocument.token(accepted) + " "
                } else {
                    contextInsertion = TaskContextInsertion(reference: accepted, identity: editorIdentity, previousOccurrences: TaskContextDocument.occurrences(message).filter { $0.id == accepted.id }.count)
                }
                #if os(macOS)
                composerExpandRequest += 1
                #endif
                return true
        } catch { if draftContext == server + "\n" + taskID { sendError = error.localizedDescription }; return false }
    }
    private func saveDraft() {
        guard draftLoaded, task?.localAgent == true, draftContext == store.connection.server + "\n" + id else { return }
        let draft = TaskMessageDraft(message: message, images: images, requestId: messageId, queueEdit: queueEdit, rewindEdit: rewindDraft, contexts: contexts, contextInsertion: contextInsertion)
        TaskDraftCache.save(message.isEmpty && images.isEmpty && queueEdit == nil && rewindDraft == nil && contextInsertion == nil ? nil : draft, server: store.connection.server, context: "task:" + id)
    }

    private func beginRewind(_ requestID: String) {
        guard !sending else { return }
        rewindDraft = TaskRewindDraft(requestId: requestID, applied: false, original: TaskComposerDraftBackup(message: message, images: images, requestId: messageId, contexts: contexts, contextInsertion: contextInsertion))
        contextInsertion = nil
        sending = true; sendError = nil; saveDraft()
    }
    private func preservePendingRewindDraft() {
        guard !sending, var saved = rewindDraft, !saved.applied else { return }
        saved.original = TaskComposerDraftBackup(message: message, images: images, requestId: messageId, contexts: contexts, contextInsertion: contextInsertion)
        rewindDraft = saved
    }
    private func applyRewindEditor() {
        guard draftLoaded, var saved = rewindDraft, !saved.applied, let operation = task?.rewindOperation, operation.requestId == saved.requestId, operation.projectedAt != nil else { return }
        saved.applied = true; rewindDraft = saved
        message = operation.editor.text; images = operation.editor.images
        contexts = operation.editor.contexts ?? []; contextInsertion = nil
        messageId = UUID().uuidString; sendError = nil; queueEdit = nil; diffSelection = nil
        followingEnd = true; scrollRequest += 1
        #if os(macOS)
        composerExpandRequest += 1
        #endif
        saveDraft()
    }
    private func restoreRewindOriginalDraft() {
        guard !sending, let original = rewindDraft?.original else { return }
        rewindDraft = nil; message = original.message; images = original.images; messageId = original.requestId
        contexts = original.contexts ?? []; contextInsertion = original.contextInsertion
        sendError = nil; saveDraft()
    }

    private func sendAgentMessage(_ submission: TaskComposerSubmission) {
        sendMessage(model: submission.model, effort: submission.effort, modelOptions: submission.modelOptions, dispatch: submission.dispatch, compactBeforeSend: submission.compactBeforeSend)
    }

    private func editQueuedMessage(_ entry: QueuedTaskMessage) {
        guard !sending, entry.editable else { return }
        if queueEdit == nil { queueEdit = QueuedMessageEditDraft(id: entry.id, message: message, images: images, requestId: messageId, contexts: contexts, contextInsertion: contextInsertion) }
        else { queueEdit?.id = entry.id }
        message = entry.text; images = entry.images; messageId = UUID().uuidString; sendError = nil
        contexts = entry.contexts ?? []; contextInsertion = nil
        saveDraft()
    }

    private func cancelQueueEdit() {
        guard !sending, let saved = queueEdit else { return }
        queueEdit = nil; message = saved.message; images = saved.images; messageId = saved.requestId; sendError = nil
        contexts = saved.contexts ?? []; contextInsertion = saved.contextInsertion
        saveDraft()
    }

    private func resumeTask() {
        guard !sending, let task, !task.active, !task.gitBusy, !task.sessionBusy, task.claudeResumePendingRun == nil else { return }
        let taskId = id; let requestId = resumeRequestId
        sending = true; sendError = nil
        Task {
            defer { sending = false }
            do {
                if task.queue?.pending.contains(where: \.editable) == true {
                    _ = try await store.connection.data("/api/tasks/\(taskId)/queue/resume", method: "POST", body: ["requestId": requestId])
                    await store.refresh()
                } else {
                    try await store.sendTaskMessage(taskId: taskId, text: "继续这个任务。先检查当前状态和已有结果，避免重复已经完成的操作。", requestId: requestId, images: [], model: task.model, effort: task.reasoningEffort)
                }
                if id == taskId { resumeRequestId = UUID().uuidString; followingEnd = true; scrollRequest += 1 }
            } catch { if id == taskId { sendError = error.localizedDescription } }
        }
    }

    #if os(macOS)
    private func restoreComposer() {
        guard composerNeedsRestore else { return }
        composerNeedsRestore = false
        followingEnd = true
        composerExpandRequest += 1
    }
    #endif

    private func sendMessage() { sendMessage(model: nil, effort: nil) }

    private func sendMessage(model: String?, effort: String?, modelOptions: [ProviderOptionSelection]? = nil, dispatch: TaskComposerDispatch = .auto, compactBeforeSend: Bool = false) {
        guard !sending, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return }
        let taskId = id; let submittedMessage = message; let submittedImages = images; let references = contexts; let requestId = messageId
        let active = task?.active == true
        let queuedEdit = queueEdit
        let rewindEdit = rewindDraft?.applied == true ? rewindDraft : nil
        let server = store.connection.server
        let compactThread = compactBeforeSend ? task?.threadId : nil
        sending = true; sendError = nil
        Task {
            do {
                if let queuedEdit {
                    try await store.editQueuedMessage(taskId: taskId, messageId: queuedEdit.id, text: submittedMessage, images: submittedImages, model: model, effort: effort, modelOptions: modelOptions, contexts: references)
                } else {
                    try await store.sendTaskMessage(taskId: taskId, text: submittedMessage, requestId: requestId,
                        images: submittedImages, model: active && dispatch != .queue ? nil : model, effort: active && dispatch != .queue ? nil : effort, modelOptions: active && dispatch != .queue ? nil : modelOptions, dispatch: dispatch, contexts: references, compactThread: compactThread)
                }
                if let saved = TaskDraftCache.load(TaskMessageDraft.self, server: server, context: "task:" + taskId), saved.requestId == requestId {
                    let restored = queuedEdit.map { TaskMessageDraft(message: $0.message, images: $0.images, requestId: $0.requestId, contexts: $0.contexts, contextInsertion: $0.contextInsertion) }
                        ?? rewindEdit.map { TaskMessageDraft(message: $0.original.message, images: $0.original.images, requestId: $0.original.requestId, contexts: $0.original.contexts, contextInsertion: $0.original.contextInsertion) }
                    TaskDraftCache.save(restored, server: server, context: "task:" + taskId)
                }
                if draftContext == server + "\n" + taskId {
                    if rewindEdit == nil { rewindDraft = nil }
                    if let queuedEdit {
                        queueEdit = nil; message = queuedEdit.message; images = queuedEdit.images; messageId = queuedEdit.requestId
                        contexts = queuedEdit.contexts ?? []; contextInsertion = queuedEdit.contextInsertion
                    } else if let rewindEdit {
                        rewindDraft = nil; message = rewindEdit.original.message; images = rewindEdit.original.images; messageId = rewindEdit.original.requestId
                        contexts = rewindEdit.original.contexts ?? []; contextInsertion = rewindEdit.original.contextInsertion
                    } else {
                        if message == submittedMessage { message = "" }
                        images.removeAll { image in submittedImages.contains { $0.id == image.id } }
                        contexts.removeAll { reference in references.contains { $0.id == reference.id } }
                        messageId = UUID().uuidString
                    }
                    followingEnd = true; scrollRequest += 1
                }
            } catch {
                if draftContext == server + "\n" + taskId { sendError = error.localizedDescription; store.error = error.localizedDescription }
            }
            if draftContext == server + "\n" + taskId { sending = false }
        }
    }
}

#if os(macOS)
private struct TaskComposerHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
#endif

struct TranscriptScrollMetrics: Equatable { var top: CGFloat = 0; var bottom: CGFloat = 0; var viewportHeight: CGFloat = 0 }
struct TranscriptScrollKey: PreferenceKey {
    static let defaultValue = TranscriptScrollMetrics()
    static func reduce(value: inout TranscriptScrollMetrics, nextValue: () -> TranscriptScrollMetrics) { value = nextValue() }
}

private struct TranscriptScrollObserver: ViewModifier {
    let interactionBegan: () -> Void
    let changed: (TranscriptScrollMetrics) -> Void
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
                TranscriptScrollMetrics(top: -geometry.contentOffset.y, bottom: geometry.contentSize.height - geometry.contentOffset.y, viewportHeight: geometry.containerSize.height)
            } action: { _, metrics in changed(metrics) }
            .onScrollPhaseChange { _, phase in
                // Stop following before the first movement, including scrollbar
                // drags. Programmatic scrolling must not count as user input.
                if phase == .tracking || phase == .interacting { interactionBegan() }
            }
        } else {
            content.onPreferenceChange(TranscriptScrollKey.self, perform: changed)
        }
    }
}

#if os(macOS)
private struct FloatingComposer: View {
    @ReadingPreferences private var reading: ReadingStyle
    let conversationID: String
    @Binding var message: String
    let active: Bool
    let sending: Bool
    let disabled: Bool
    let error: String?
    let collapseRequest: Int
    let expandRequest: Int
    let send: () -> Void
    @FocusState private var focused: Bool
    @State private var expanded = true
    @State private var focusRequest = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var composerAnimation: Animation? {
        reduceMotion || !NSApp.isActive ? nil : .smooth(duration: 0.36)
    }

    var body: some View {
        TaskComposerLayout(expansion: expanded ? 1 : 0) {
            expandedContent.padding(16).fixedSize(horizontal: false, vertical: true)
        }
        .clipped().opacity(expanded ? 1 : 0)
        .disabled(!expanded).allowsHitTesting(expanded).accessibilityHidden(!expanded)
        .background {
            FridayWindowBackground(configuresWindow: false)
                .clipShape(RoundedRectangle(cornerRadius: 22))
        }
        .overlay {
            if !expanded {
                Button { setExpanded(true); focusRequest += 1 } label: {
                    Color.clear.frame(height: 44).frame(maxWidth: .infinity).contentShape(Rectangle())
                }
                .buttonStyle(FridaySymbolButtonStyle())
                .accessibilityLabel(Text(friday: "补充要求"))
                .accessibilityValue(Text(friday: "已收起"))
            }
        }
        .animation(composerAnimation, value: expanded)
        .task(id: focusRequest) {
            guard focusRequest > 0, expanded else { return }
            await Task.yield()
            guard expanded, !Task.isCancelled else { return }
            focused = true
        }
        .onChange(of: focused) { _, value in if value { setExpanded(true) } }
        .onChange(of: collapseRequest) { _, _ in setExpanded(false) }
        .onChange(of: expandRequest) { _, _ in setExpanded(true) }
        .onChange(of: conversationID) { _, _ in
            focused = false; expanded = true; focusRequest = 0
        }
    }

    private func setExpanded(_ value: Bool) {
        guard expanded != value else { return }
        if !value { focused = false }
        withAnimation(composerAnimation) { expanded = value }
    }

    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(friday: active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？", text: $message, axis: .vertical)
                .font(reading.bodyFont).lineLimit(2...5).textFieldStyle(.plain)
                .focused($focused).accessibilityLabel(Text(friday: "补充要求"))
                .onChatSubmit { if !disabled { send() } }
            HStack(spacing: 12) {
                if let error {
                    Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(2)
                }
                Spacer(minLength: 0)
                Button(action: send) {
                    FridaySymbolImage(systemName: "arrow.up").font(.system(size: 14, weight: .semibold))
                }
                .buttonStyle(AgentTaskActionButtonStyle())
                .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
                .help(Text(friday: sending ? "发送中" : "发送"))
                .keyboardShortcut(.return, modifiers: .command).disabled(disabled || !expanded)
            }
        }
    }
}
#endif

struct ApprovalCard: View {
    @ObservedObject var store: FridayStore
    let taskId: String
    let approval: Approval
    @State private var answers: [String: String] = [:]
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                FridaySymbolImage(systemName: "hand.raised.fill").foregroundStyle(.orange)
                    .frame(width: 34, height: 34).background(.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                    .fridaySymbolFeedback()
                Text(approval.title).font(.headline)
            }
            Text(approval.detail).font(.callout).lineSpacing(4).textSelection(.enabled)
            ForEach(approval.questions) { question in
                VStack(alignment: .leading, spacing: 10) {
                    Text(question.question).font(.callout.weight(.medium))
                    ForEach(question.options, id: \.answerValue) { option in
                        Button { answers[question.id] = option.answerValue } label: {
                            HStack(alignment: .top, spacing: 8) {
                                FridaySymbolImage(systemName: answers[question.id] == option.answerValue ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(option.label)
                                    if !option.description.isEmpty { Text(option.description).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 0)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(FridayButtonStyle())
                    }
                    TextField(friday: "你的回答", text: Binding(get: { answers[question.id] ?? "" }, set: { answers[question.id] = $0 }))
                        .textFieldStyle(.roundedBorder)
                }
            }
            HStack {
                Spacer()
                if approval.questions.isEmpty { Button(friday: "拒绝") { respond("decline") }.buttonStyle(FridayButtonStyle()) }
                Button(friday: approval.questions.isEmpty ? "允许本次" : "提交回答") { respond("accept") }
                    .buttonStyle(FridayButtonStyle(prominent: true))
            }
        }
        .padding(22).fridayCard()
        .overlay(RoundedRectangle(cornerRadius: FridayTheme.cornerRadius).strokeBorder(.orange.opacity(0.35)))
        .disabled(busy || !store.connected)
    }

    private func respond(_ decision: String) {
        busy = true
        Task {
            _ = await store.perform("/api/tasks/\(taskId)/approvals/\(approval.id)", body: ["decision": decision, "answers": answers.mapValues { [$0] }])
            busy = false
        }
    }
}
