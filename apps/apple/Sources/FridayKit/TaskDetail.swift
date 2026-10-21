import SwiftUI

struct TaskDetail: View {
    @ObservedObject var store: FridayStore
    let id: String
    var onOpenTask: ((String) -> Void)? = nil
    @State private var message = ""
    @State private var images: [IdeaImage] = []
    @State private var contexts: [TaskContextReference] = []
    @StateObject private var fileMentionBridge = TaskFileMentionBridge()
    @State private var contextInsertion: TaskContextInsertion?
    @State private var interactionMode = "default"
    @State private var sendError: String?
    @State private var draftLoaded = false
    @State private var lastGuideBlock: String?
    @State private var lastGuideReferenceID: String?
    @State private var messageId = UUID().uuidString
    @State private var sending = false
    @State private var queueEdit: QueuedMessageEditDraft?
    @State private var resumeRequestId = UUID().uuidString
    @State private var followingEnd = true
    @State private var atEnd = true
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
    private var draftInteractionMode: Binding<String> {
        Binding(get: { interactionMode }, set: { value in
            interactionMode = value
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
                followingEnd = true; atEnd = true; previousScrollTop = nil
                #if os(macOS)
                composerNeedsRestore = false
                composerAtBottom = true
                #endif
            }
            .modifier(TaskTerminalPanelLayout(store: store, task: task, shown: $terminalShown, canAddContext: !sending && !task.sessionBusy, addContext: addTerminalContext))
            .modifier(TaskWorkspacePanelLayout(store: store, task: task, diff: $diffSelection, files: $filesPanel,browser:$browserPanel, active: $activePanel, width: $diffWidth))
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
                #if os(iOS)
                .safeAreaInset(edge: .bottom, spacing: 0) { FridayMobileDock { EmptyView() } }
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
        .onChange(of: interactionMode) { _, _ in saveDraft() }
        .onChange(of: task.interactionMode) { _, mode in
            if message.isEmpty && images.isEmpty && queueEdit == nil && !sending { interactionMode = mode ?? "default" }
        }
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
            header(task)
            #endif
            transcriptScroll(task)
                .modifier(TaskBrowserFloatingPreview(store:store,task:task,browser:$browserPanel,activePanel:$activePanel))
        }
        .background(FridayTheme.canvas)
        #if os(iOS)
        .navigationTitle("Friday")
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .bottom, spacing: 0) {
            #if os(iOS)
            FridayMobileDock {
                if task.subagentOrigin != nil {
                    TaskBackgroundCommandsView(store: store, task: task)
                    TaskNativeSubagentBar(store: store, task: task, openTask: { onOpenTask?($0) })
                } else if task.localAgent {
                    TaskBackgroundCommandsView(store: store, task: task)
                    AgentTaskComposer(store: store, task: task, embeddedInMobileDock: true, submissionError: sendError,
                        editingQueuedMessageId: queueEdit?.id, editQueuedMessage: editQueuedMessage, cancelQueueEdit: cancelQueueEdit, resumeTask: resumeTask, discardDraft: discardDraft,
                        message: draftMessage, images: draftImages, contexts: draftContexts, contextInsertion: $contextInsertion, interactionMode: draftInteractionMode, sending: sending, send: sendAgentMessage)
                } else {
                    FridayMobileComposer(
                        message: $message,
                        placeholder: task.active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？",
                        sending: sending,
                        disabled: sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued",
                        send: sendMessage
                    )
                    if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(2) }
                }
            }
            #else
            if !task.localAgent {
                FloatingComposer(
                    message: $message,
                    active: task.active,
                    sending: sending,
                    disabled: sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task.status == "queued",
                    error: store.error,
                    send: sendMessage
                )
                .frame(maxWidth: FridayTheme.contentWidth)
                .padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 20)
                .frame(maxWidth: .infinity)
            }
            #endif
        }
        #if os(macOS)
        .overlay(alignment: .bottom) {
            if task.localAgent {
                VStack(spacing: 0) {
                    if task.subagentOrigin != nil {
                        TaskBackgroundCommandsView(store: store, task: task)
                        TaskNativeSubagentBar(store: store, task: task, openTask: { onOpenTask?($0) })
                    } else {
                        TaskBackgroundCommandsView(store: store, task: task)
                        AgentTaskComposer(store: store, task: task, collapseRequest: composerCollapseRequest, expandRequest: composerExpandRequest, submissionError: sendError,
                            editingQueuedMessageId: queueEdit?.id, editQueuedMessage: editQueuedMessage, cancelQueueEdit: cancelQueueEdit, resumeTask: resumeTask, discardDraft: discardDraft,
                            message: draftMessage, images: draftImages, contexts: draftContexts, contextInsertion: $contextInsertion, interactionMode: draftInteractionMode, sending: sending, send: sendAgentMessage)
                    }
                }
                    .frame(maxWidth: FridayTheme.contentWidth).padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 16).frame(maxWidth: .infinity)
                    .background(GeometryReader { geometry in
                        Color.clear.preference(key: TaskComposerHeightKey.self, value: geometry.size.height)
                    })
            }
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
                    LazyVStack(alignment: .leading, spacing: 24) {
                        #if os(iOS)
                        header(task)
                        #endif
                        if task.localAgent {
                            if hasEarlierHistory || historyError != nil {
                                VStack(alignment: .leading, spacing: 8) {
                                    Button {
                                        let anchor = historyAnchor ?? CodexTranscript.rows(task).first?.id
                                        followingEnd = false
                                        Task { @MainActor in
                                            await loadHistory(automatic: false)
                                            if let anchor { var transaction = Transaction(); transaction.disablesAnimations = true; withTransaction(transaction) { proxy.scrollTo(anchor, anchor: .top) } }
                                        }
                                    } label: { FridaySymbolLabel(friday: historyLoading ? "正在加载历史…" : "加载更早的记录", systemImage: "clock.arrow.circlepath") }
                                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption).disabled(historyLoading || !store.connected)
                                    if let historyError { Text(fridayString: historyError).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                            TaskForkStatusView(store: store, task: task, openTask: { onOpenTask?($0) })
                                .id(store.connection.server + ":fork:" + task.id)
                            CodexTimeline(store: store, task: task, worktreeSetup: worktreeSetup, canOpenLocalFiles: store.deviceId == "owner", openDiff: { diffSelection = $0; activePanel = "diff" }, canEditMessages: !sending && queueEdit == nil, editFromHere: { rewindTarget = TaskRewindTarget(id: $0) }, openTask: { onOpenTask?($0) })
                            TaskRewindStatusView(store: store, task: task, hasOriginalDraft: rewindDraft?.applied == true,
                                restoreOriginalDraft: restoreRewindOriginalDraft, openChanges: { diffSelection = TaskDiffSelection(path: $0); activePanel = "diff" })
                                .id("rewind-status-" + task.id + ":" + (task.rewindOperation?.id ?? ""))
                        } else {
                            ForEach(task.conversation) { message in conversationMessage(message, task: task) }
                        }
                        delegatedTasks(task)
                        if task.status == "needs_project" { WorkspaceChoice(store: store, task: task).id(task.durableId) }
                        ForEach(task.localAgent ? [] : task.approvals.filter { $0.state == "pending" }) { approval in
                            ApprovalCard(store: store, taskId: id, approval: approval)
                                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
                        }
                        if let error = task.error, task.preparationFailure == nil {
                            FridaySymbolLabel(friday: error, systemImage: "exclamationmark.circle")
                                .fridaySymbolFeedback()
                                .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                                .padding(18).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                        }
                        #if os(macOS)
                        // The end anchor includes the floating composer's space so
                        // following a reply never places it underneath the input.
                        Color.clear.frame(height: task.localAgent ? composerHeight + 24 : 1).id("transcript-end")
                        #else
                        Color.clear.frame(height: 1).id("transcript-end")
                        #endif
                    }
                    .scrollTargetLayout()
                    // Animate only approval insertion/removal, never the streamed result.
                    .animation(reduceMotion ? nil : FridayTheme.motion, value: task.approvals.filter { $0.state == "pending" }.map(\.id))
                    .padding(.horizontal, 24)
                    #if os(iOS)
                    .padding(.bottom, 24)
                    .padding(.top, task.localAgent ? 24 : viewport.safeAreaInsets.top + 24)
                    #else
                    .padding(.bottom, task.localAgent ? 0 : 24)
                    .padding(.top, 24)
                    #endif
                    .frame(maxWidth: FridayTheme.contentWidth + 48).frame(maxWidth: .infinity)
                    .background(GeometryReader { geometry in
                        let frame = geometry.frame(in: .named("task-transcript"))
                        Color.clear.preference(key: TranscriptScrollKey.self, value: TranscriptScrollMetrics(top: frame.minY, bottom: frame.maxY, viewportHeight: viewport.size.height))
                    })
                    #if os(macOS)
                    .background {
                        if task.localAgent {
                            TranscriptHistoryScrollGesture(composerHeight: composerHeight) {
                                followingEnd = false
                                composerNeedsRestore = true
                                composerCollapseRequest += 1
                            } scrolledDown: {
                                if composerAtBottom { restoreComposer() }
                            }
                        }
                    }
                    #endif
                }
                .coordinateSpace(name: "task-transcript")
                .scrollPosition(id: $historyAnchor, anchor: .top)
                #if os(iOS)
                .scrollDismissesKeyboard(.interactively)
                .ignoresSafeArea(.container, edges: task.localAgent ? [] : .top)
                #endif
                .modifier(TranscriptScrollObserver { metrics in
                    guard metrics.bottom > 0 else { return }
                    if let previousScrollTop, metrics.top > previousScrollTop + 3 { followingEnd = false }
                    #if os(macOS)
                    // Wait for downward movement to the actual bottom. Shrinking
                    // the composer also changes the bottom inset; that alone
                    // must not immediately undo the user's upward-scroll fold.
                    composerAtBottom = metrics.bottom <= metrics.viewportHeight + 2
                    if task.localAgent, composerNeedsRestore,
                       let previousScrollTop, metrics.top < previousScrollTop,
                       composerAtBottom {
                        restoreComposer()
                    }
                    #endif
                    previousScrollTop = metrics.top
                    atEnd = metrics.bottom <= metrics.viewportHeight + 48
                    if atEnd { followingEnd = true }
                })
                .overlay(alignment: .bottom) {
                    if !atEnd {
                        Button {
                            followingEnd = true
                            #if os(macOS)
                            if task.localAgent { restoreComposer() }
                            #endif
                            withAnimation(reduceMotion ? nil : FridayTheme.motion) { proxy.scrollTo("transcript-end", anchor: .bottom) }
                        } label: { FridaySymbolLabel(friday: "回到最新", systemImage: "arrow.down") }
                            .buttonStyle(FridayButtonStyle(compact: true)).font(.caption)
                            #if os(macOS)
                            .padding(.bottom, task.localAgent ? composerHeight + 10 : 10)
                            #else
                            .padding(.bottom, 10)
                            #endif
                    }
                }
                .task(id: id) {
                    await Task.yield()
                    if let request=store.assistantCitationNavigation,request.connection==store.connectionIdentity,request.citation.threadId==id,request.citation.environmentId==store.serviceId { return }
                    proxy.scrollTo("transcript-end", anchor: .bottom)
                }
                .task(id: task.updatedAt) {
                    await Task.yield()
                    if followingEnd { proxy.scrollTo("transcript-end", anchor: .bottom) }
                }
                .onChange(of: scrollRequest) { _, _ in proxy.scrollTo("transcript-end", anchor: .bottom) }
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

    private func header(_ task: WorkItem) -> some View {
        HStack(alignment: task.localAgent ? .center : .top, spacing: 14) {
            if task.localAgent {
                Text(store.projects.first { $0.id == task.projectId }?.name ?? task.agentName)
                    .font(.callout).foregroundStyle(.secondary).lineLimit(1)
                Text("/").foregroundStyle(.tertiary)
                #if os(macOS)
                if task.subagentOrigin != nil { Text(task.title).font(.callout.weight(.medium)).lineLimit(1).textSelection(.enabled) }
                else { TaskHeaderTitle(store: store, task: task) }
                #else
                if task.subagentOrigin != nil { Text(task.title).font(.callout.weight(.medium)).lineLimit(1) }
                else { HStack(spacing: 6) {
                    Text(task.title).font(.callout.weight(.medium)).lineLimit(1)
                        .opacity(task.titleRegeneration == nil ? 1 : 0.55)
                    FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9)).foregroundStyle(.secondary)
                }.taskActions(store: store, task: task, opensMenu: true) }
                #endif
                Spacer(minLength: 8)
                if task.projectId != nil && task.subagentOrigin == nil { TaskProjectScriptsControl(store: store, task: task, updateSetup: { worktreeSetup = $0 }) }
                TaskRelationshipsControl(store: store, task: task, canNavigate: onOpenTask != nil, openTask: { onOpenTask?($0) })
                TaskOpenInControl(store: store, task: task, enableShortcut: true)
                Button { if filesPanel.visible && activePanel == "files" { filesPanel.visible = false } else { filesPanel.visible = true; activePanel = "files" } } label: {
                    FridaySymbolImage(systemName: "folder").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(filesPanel.visible && activePanel == "files" ? FridayTheme.accent : .secondary)
                    .disabled(!store.connected).accessibilityLabel(Text(friday: "工作区文件"))
                if task.git?.status == "repository" { TaskGitActionsControl(store: store, task: task) }
                Button { terminalShown.toggle() } label: {
                    FridaySymbolImage(systemName: "terminal").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .foregroundStyle(terminalShown ? FridayTheme.accent : .secondary)
                    .disabled(task.projectId == nil)
                    .keyboardShortcut("j", modifiers: .command)
                    .accessibilityLabel(Text(friday: terminalShown ? "收起终端" : "显示终端"))
                    .help(Text(friday: "终端 · ⌘J"))
                Button {if browserPanel.visible && activePanel=="browser" {browserPanel.visible=false} else {browserPanel.visible=true;if browserPanel.tabs.isEmpty {browserPanel.open()};activePanel="browser"}} label: {
                    FridaySymbolImage(systemName:"globe").font(.system(size:15)).frame(width:24,height:24)
                }.buttonStyle(FridaySymbolButtonStyle()).foregroundStyle(browserPanel.visible && activePanel=="browser" ? FridayTheme.accent:.secondary).accessibilityLabel(Text(friday:"网页预览"))
                Button { if activePanel != "diff" { diffSelection = diffSelection ?? TaskDiffSelection(); activePanel = "diff" } else { diffSelection = diffSelection == nil ? TaskDiffSelection() : nil } } label: {
                    FridaySymbolImage(systemName: "sidebar.right").font(.system(size: 15)).frame(width: 24, height: 24)
                }.buttonStyle(FridaySymbolButtonStyle())
                    .foregroundStyle(diffSelection == nil ? .secondary : FridayTheme.accent)
                    .accessibilityLabel(Text(friday: diffSelection == nil ? "显示改动面板" : "关闭改动面板"))
                    .help(Text(friday: "文件改动与 Diff"))
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Friday").font(.caption).foregroundStyle(.secondary)
                    Text(task.title).font(.title3.weight(.semibold)).lineLimit(3).textSelection(.enabled)
                }
                Spacer(minLength: 8)
            }
        }
        #if os(iOS)
        .padding(.bottom, 8)
        #else
        .padding(.horizontal, 26).padding(.top, 24).padding(.bottom, 10)
        #endif
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

    @ViewBuilder private func conversationMessage(_ message: ChatMessage, task: WorkItem) -> some View {
        if message.role == "user" {
            HStack {
                Spacer(minLength: 36)
                Text(message.text).font(.body).lineSpacing(5).textSelection(.enabled)
                    .padding(18)
                    .background(FridayTheme.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
            }
        } else {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 9) {
                    if task.localAgent {
                        FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback().font(.subheadline).foregroundStyle(.secondary)
                    } else { FridayMark(size: 30) }
                    Text(task.agentName).font(.subheadline.weight(.semibold))
                }
                Text(.init(message.text)).font(.body).lineSpacing(6)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.padding(task.localAgent ? 4 : 24).background(task.localAgent ? Color.clear : FridayTheme.surface, in: RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
        }
    }

    @ViewBuilder private func delegatedTasks(_ task: WorkItem) -> some View {
        ForEach(store.tasks.filter { $0.parentId == task.id }) { child in
            Button { onOpenTask?(child.id) } label: {
                HStack(spacing: 12) {
                    FridaySymbolImage(systemName: "terminal").fridaySymbolFeedback()
                    VStack(alignment: .leading, spacing: 4) {
                        Text(child.title).lineLimit(2)
                        Text(child.agentName).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    StatusBadge(task: child)
                    FridaySymbolImage(systemName: "chevron.right").fridaySymbolFeedback()
                }.padding(16)
            }.buttonStyle(FridayButtonStyle()).accessibilityLabel(Text(friday: "打开任务"))
        }
    }

    private func discardDraft() {
        guard draftLoaded, !sending, task?.localAgent == true else { return }
        let server = store.connection.server, taskID = id, context = "task:" + id
        let saved = TaskMessageDraft(message: message, images: images, requestId: messageId, queueEdit: queueEdit, interactionMode: interactionMode, rewindEdit: rewindDraft, contexts: contexts, contextInsertion: contextInsertion)
        guard saved.hasUserContent else { return }
        message = ""; images = []; contexts = []; contextInsertion = nil; queueEdit = nil; rewindDraft = nil; messageId = UUID().uuidString
        interactionMode = task?.interactionMode ?? "default"; lastGuideBlock = nil; lastGuideReferenceID = nil; sendError = nil
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
        interactionMode = task?.interactionMode ?? "default"
        if task?.localAgent == true, let saved = TaskDraftCache.load(TaskMessageDraft.self, server: store.connection.server, context: "task:" + id) {
            message = saved.message; images = saved.images; messageId = saved.requestId; queueEdit = saved.queueEdit
            contexts = saved.contexts ?? []
            contextInsertion = saved.contextInsertion
            rewindDraft = saved.rewindEdit
            interactionMode = saved.interactionMode ?? interactionMode
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
        let draft = TaskMessageDraft(message: message, images: images, requestId: messageId, queueEdit: queueEdit, interactionMode: interactionMode, rewindEdit: rewindDraft, contexts: contexts, contextInsertion: contextInsertion)
        TaskDraftCache.save(message.isEmpty && images.isEmpty && queueEdit == nil && rewindDraft == nil && contextInsertion == nil && interactionMode == (task?.interactionMode ?? "default") ? nil : draft, server: store.connection.server, context: "task:" + id)
    }

    private func beginRewind(_ requestID: String) {
        guard !sending else { return }
        rewindDraft = TaskRewindDraft(requestId: requestID, applied: false, original: TaskComposerDraftBackup(message: message, images: images, requestId: messageId, interactionMode: interactionMode, contexts: contexts, contextInsertion: contextInsertion))
        contextInsertion = nil
        sending = true; sendError = nil; saveDraft()
    }
    private func preservePendingRewindDraft() {
        guard !sending, var saved = rewindDraft, !saved.applied else { return }
        saved.original = TaskComposerDraftBackup(message: message, images: images, requestId: messageId, interactionMode: interactionMode, contexts: contexts, contextInsertion: contextInsertion)
        rewindDraft = saved
    }
    private func applyRewindEditor() {
        guard draftLoaded, var saved = rewindDraft, !saved.applied, let operation = task?.rewindOperation, operation.requestId == saved.requestId, operation.projectedAt != nil else { return }
        saved.applied = true; rewindDraft = saved
        message = operation.editor.text; images = operation.editor.images; interactionMode = operation.editor.interactionMode
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
        interactionMode = original.interactionMode ?? task?.interactionMode ?? "default"; sendError = nil; saveDraft()
    }

    private func sendAgentMessage(_ submission: TaskComposerSubmission) {
        if let eventID = submission.planEventID { followUpPlan(submission, eventID: eventID) }
        else { sendMessage(model: submission.model, effort: submission.effort, dispatch: submission.dispatch, interactionMode: submission.interactionMode, compactBeforeSend: submission.compactBeforeSend) }
    }

    private func followUpPlan(_ submission: TaskComposerSubmission, eventID: String) {
        guard !sending else { return }
        let taskID = id; let requestID = messageId; let text = message; let attachments = images; let references = contexts; let server = store.connection.server
        sending = true; sendError = nil
        Task {
            defer { sending = false }
            do {
                let created = try await store.followUpPlan(taskID, eventID: eventID, text: text, images: attachments, requestID: requestID,
                                                         newThread: submission.implementInNewThread, model: submission.model, effort: submission.effort, contexts: references)
                if let saved = TaskDraftCache.load(TaskMessageDraft.self, server: server, context: "task:" + taskID), saved.requestId == requestID {
                    TaskDraftCache.save(Optional<TaskMessageDraft>.none, server: server, context: "task:" + taskID)
                }
                if id == taskID {
                    if message == text { message = "" }
                    images.removeAll { image in attachments.contains { $0.id == image.id } }
                    contexts.removeAll { reference in references.contains { $0.id == reference.id } }
                    if !submission.implementInNewThread { interactionMode = submission.interactionMode }
                    messageId = UUID().uuidString; followingEnd = true; scrollRequest += 1
                    if created != taskID { onOpenTask?(created) }
                }
            } catch { if id == taskID { sendError = error.localizedDescription } }
        }
    }

    private func editQueuedMessage(_ entry: QueuedTaskMessage) {
        guard !sending, entry.editable else { return }
        if queueEdit == nil { queueEdit = QueuedMessageEditDraft(id: entry.id, message: message, images: images, requestId: messageId, interactionMode: interactionMode, contexts: contexts, contextInsertion: contextInsertion) }
        else { queueEdit?.id = entry.id }
        message = entry.text; images = entry.images; messageId = UUID().uuidString; sendError = nil
        contexts = entry.contexts ?? []; contextInsertion = nil
        interactionMode = entry.interactionMode ?? task?.interactionMode ?? "default"
        saveDraft()
    }

    private func cancelQueueEdit() {
        guard !sending, let saved = queueEdit else { return }
        queueEdit = nil; message = saved.message; images = saved.images; messageId = saved.requestId; sendError = nil
        contexts = saved.contexts ?? []; contextInsertion = saved.contextInsertion
        interactionMode = saved.interactionMode ?? task?.interactionMode ?? "default"
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

    private func sendMessage(model: String?, effort: String?, dispatch: TaskComposerDispatch = .auto, interactionMode: String? = nil, compactBeforeSend: Bool = false) {
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
                    try await store.editQueuedMessage(taskId: taskId, messageId: queuedEdit.id, text: submittedMessage, images: submittedImages, model: model, effort: effort, interactionMode: interactionMode, contexts: references)
                } else {
                    try await store.sendTaskMessage(taskId: taskId, text: submittedMessage, requestId: requestId,
                        images: submittedImages, model: active && dispatch != .queue ? nil : model, effort: active && dispatch != .queue ? nil : effort, dispatch: dispatch, interactionMode: interactionMode, contexts: references, compactThread: compactThread)
                }
                if let saved = TaskDraftCache.load(TaskMessageDraft.self, server: server, context: "task:" + taskId), saved.requestId == requestId {
                    let restored = queuedEdit.map { TaskMessageDraft(message: $0.message, images: $0.images, requestId: $0.requestId, interactionMode: $0.interactionMode, contexts: $0.contexts, contextInsertion: $0.contextInsertion) }
                        ?? rewindEdit.map { TaskMessageDraft(message: $0.original.message, images: $0.original.images, requestId: $0.original.requestId, interactionMode: $0.original.interactionMode, contexts: $0.original.contexts, contextInsertion: $0.original.contextInsertion) }
                    TaskDraftCache.save(restored, server: server, context: "task:" + taskId)
                }
                if draftContext == server + "\n" + taskId {
                    if rewindEdit == nil { rewindDraft = nil }
                    if let queuedEdit {
                        queueEdit = nil; message = queuedEdit.message; images = queuedEdit.images; messageId = queuedEdit.requestId
                        contexts = queuedEdit.contexts ?? []; contextInsertion = queuedEdit.contextInsertion
                        self.interactionMode = queuedEdit.interactionMode ?? task?.interactionMode ?? "default"
                    } else if let rewindEdit {
                        rewindDraft = nil; message = rewindEdit.original.message; images = rewindEdit.original.images; messageId = rewindEdit.original.requestId
                        contexts = rewindEdit.original.contexts ?? []; contextInsertion = rewindEdit.original.contextInsertion
                        self.interactionMode = rewindEdit.original.interactionMode ?? task?.interactionMode ?? "default"
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

private struct TranscriptScrollMetrics: Equatable { var top: CGFloat = 0; var bottom: CGFloat = 0; var viewportHeight: CGFloat = 0 }
private struct TranscriptScrollKey: PreferenceKey {
    static let defaultValue = TranscriptScrollMetrics()
    static func reduce(value: inout TranscriptScrollMetrics, nextValue: () -> TranscriptScrollMetrics) { value = nextValue() }
}

private struct TranscriptScrollObserver: ViewModifier {
    let changed: (TranscriptScrollMetrics) -> Void
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollGeometryChange(for: TranscriptScrollMetrics.self) { geometry in
                TranscriptScrollMetrics(top: -geometry.contentOffset.y, bottom: geometry.contentSize.height - geometry.contentOffset.y, viewportHeight: geometry.containerSize.height)
            } action: { _, metrics in changed(metrics) }
        } else {
            content.onPreferenceChange(TranscriptScrollKey.self, perform: changed)
        }
    }
}

private struct FloatingComposer: View {
    @Binding var message: String
    let active: Bool
    let sending: Bool
    let disabled: Bool
    let error: String?
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField(friday: active ? "补充要求，或告诉 Friday 更多背景…" : "基于这个结果，接着做什么？", text: $message, axis: .vertical)
                .font(.body).lineLimit(2...5).textFieldStyle(.plain)
                .focused($focused).accessibilityLabel(Text(friday: "补充要求"))
                .onChatSubmit { if !disabled { send() } }
            HStack(spacing: 12) {
                if let error {
                    Text(fridayString: error).font(.caption).foregroundStyle(.orange).lineLimit(2)
                }
                Spacer(minLength: 0)
                Button(action: send) {
                    FridaySymbolLabel(friday: sending ? "发送中" : "发送", systemImage: "arrow.up")
                }
                .buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                .keyboardShortcut(.return, modifiers: .command).disabled(disabled)
            }
        }
        .padding(18).fridayFloatingSurface()
        .overlay {
            RoundedRectangle(cornerRadius: FridayTheme.cornerRadius)
                .strokeBorder(FridayTheme.accent.opacity(focused ? 0.35 : 0), lineWidth: 1)
                .allowsHitTesting(false)
        }
    }
}

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
