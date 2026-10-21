import Foundation
import SwiftUI

@MainActor
final class FridayStore: ObservableObject {
    @Published var ideas: [Idea] = []
    @Published var projects: [Project] = []
    @Published var tasks: [WorkItem] = [] { didSet { observeGuideRuns() } }
    @Published var reviewGuideNotices: [TaskGuideNotice] = []
    @Published var changeRequestDraftHandoff: TaskChangeRequestDraftHandoff?
    @Published var reviewGuideComposerHandoff: TaskGuideComposerHandoff?
    @Published var reviewGuideHandoffOutcome: TaskGuideHandoffOutcome?
    @Published var reviewGuideOpenRequest: TaskGuideOpenRequest?
    var presentedReviewGuideURL: String?
    private var guideNoticeTracker = TaskGuideNoticeTracker()
    private var guideNoticeScope = ""
    private func observeGuideRuns() {
        let scope = connectionIdentity
        if guideNoticeScope != scope { guideNoticeScope = scope; reviewGuideNotices = []; reviewGuideOpenRequest = nil; presentedReviewGuideURL = nil; reviewGuideComposerHandoff = nil; reviewGuideHandoffOutcome = nil }
        let notices = guideNoticeTracker.observe(tasks: tasks, scope: scope)
        var activeURLs = Set<String>()
        for task in tasks { for run in task.changeRequestGuideRuns ?? [] where run.active { activeURLs.insert(run.url) } }
        let taskIDs = Set(tasks.map(\.id))
        reviewGuideNotices.removeAll { activeURLs.contains($0.url) || !taskIDs.contains($0.taskID) }
        reviewGuideNotices.append(contentsOf: notices.filter { $0.url != presentedReviewGuideURL })
        if reviewGuideNotices.count > 10 { reviewGuideNotices.removeFirst(reviewGuideNotices.count - 10) }
    }
    @Published var revision = 0
    @Published private(set) var textGenerationSettingsVersion: Int?
    @Published private(set) var taskSidebarOrderingSupported = false
    @Published private(set) var taskExistingWorkspaceSupported = false
    @Published private(set) var taskComposerCommandsSupported = false
    @Published private(set) var taskArchiveLifecycleSupported = false
    @Published private(set) var providerResetCreditsSupported = false
    @Published private(set) var providerConfigurationVersions: [String: Int] = [:]
    @Published private(set) var providerUsageSnapshots: [String: TaskProviderUsageLimits] = [:]
    @Published private(set) var usageLimitSources: [TaskUsageSourceSnapshot] = []
    @Published private(set) var usageLimitSourcesSupported = false
    @Published private(set) var taskSidebarWorkingSupported = false
    @Published private(set) var taskSidebarProjectScopesSupported = false
    @Published private(set) var taskScratchWorkspaceSupported = false
    @Published private(set) var scratchWorkspaceRoot: String?
    @Published private(set) var namedProjectCreationSupported = false
    @Published private(set) var newProjectsRoot: String?
    @Published private(set) var projectRepositoryOperationsSupported = false
    @Published private(set) var projectRepositoryOperations: [ProjectRepositoryOperation] = []
    @Published private(set) var taskAutoSettlementSupported = false
    @Published private(set) var taskBackgroundCommandsSupported = false
    @Published private(set) var taskNativeBackgroundSupported = false
    @Published private(set) var taskBackgroundSettlementSupported = false
    @Published private(set) var taskSettlementSettingsVersion: Int?
    @Published private(set) var sourceControlPreferencesVersion: Int?
    @Published var sidebarWorkingShelfEnabled = false {
        didSet {
            guard oldValue != sidebarWorkingShelfEnabled else { return }
            UserDefaults.standard.set(sidebarWorkingShelfEnabled, forKey: FridayPreferenceKeys.workingShelfEnabled)
            observeSidebarActivity()
        }
    }
    @Published private(set) var sidebarInboxReturns = TaskInboxReturnTracker()
    private var sidebarPreferenceObserver: NSObjectProtocol?
    @Published private(set) var snapshotIdentity = ""
    var connectionIdentity: String { connection.server + "\n" + String(connection.token.hashValue) }
    @Published private var serviceIdentity = TaskServiceIdentity()
    @Published var assistantCitationNavigation: TaskCitationNavigationRequest?
    var serviceId: String? { serviceIdentity.value(for: connectionIdentity) }
    @Published var memories: [MemoryItem] = []
    @Published var agents: [AgentInfo] = []
    @Published var devices: [Device] = []
    @Published var deviceId = ""
    @Published var connected = false
    @Published var notesSupported = false
    @Published private(set) var taskContentRevision = 0
    @Published private(set) var taskHistoryGeneration = 0
    @Published private(set) var taskStreamErrors: [String: String] = [:]
    @Published var error: String?
    @Published var outbox: [OutboxIdea] = []
    @Published var delegatingIdeas: Set<String> = []
    let connection = Connection()
    let taskUndo = TaskActionUndo()
    let terminalSessions = TaskTerminalSessions()
    let browserClientID=UUID()
    private var streamTask: Task<Void, Never>?
    private var taskStreamState = TaskStreamState()
    var taskStreamSession: String? { taskStreamState.session }
    private var taskViewHistories = TaskViewHistoryCache()
    private var taskLeases: [String: Set<UUID>] = [:]
    private var taskStreams: [String: (token: UUID, task: Task<Void, Never>)] = [:]
    private var noteSyncTask: Task<Void, Never>?
    private var flushing = false
    var notes: [Idea] {
        let pendingIDs = Set(outbox.map(\.id))
        return (outbox.map(\.note) + ideas.filter { !pendingIDs.contains($0.id) })
            .sorted { ($0.updatedAt ?? $0.createdAt) > ($1.updatedAt ?? $1.createdAt) }
    }
    init() {
        if let data = UserDefaults.standard.data(forKey: "friday.outbox"), let pending = try? JSONDecoder().decode([OutboxIdea].self, from: data) { outbox = pending }
        sidebarWorkingShelfEnabled = UserDefaults.standard.bool(forKey: FridayPreferenceKeys.workingShelfEnabled)
        sidebarPreferenceObserver = NotificationCenter.default.addObserver(forName: UserDefaults.didChangeNotification, object: UserDefaults.standard, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let enabled = UserDefaults.standard.bool(forKey: FridayPreferenceKeys.workingShelfEnabled)
                if enabled != self.sidebarWorkingShelfEnabled { self.sidebarWorkingShelfEnabled = enabled }
            }
        }
    }
    deinit {
        if let sidebarPreferenceObserver {NotificationCenter.default.removeObserver(sidebarPreferenceObserver)}
        let owner=browserClientID
        Task { @MainActor in TaskBrowserSessions.shared.close(owner:owner) }
    }
    private func observeSidebarActivity() {
        let context = connectionIdentity + "\n" + (taskStreamSession ?? "legacy")
        sidebarInboxReturns.observe(sidebarWorkingShelfEnabled && snapshotIdentity == connectionIdentity ? tasks : nil, context: context, now: .now)
    }
    func importSharedIdeas() async {
        #if os(iOS)
        guard let group = Bundle.main.object(forInfoDictionaryKey: "FridayAppGroup") as? String,
              let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return }
        let directory = root.appendingPathComponent("Ideas", isDirectory: true)
        for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "json" {
            guard let data = try? Data(contentsOf: url), let idea = try? JSONDecoder().decode(OutboxIdea.self, from: data) else { continue }
            if !outbox.contains(where: { $0.id == idea.id }) { outbox.append(idea) }
            persistOutbox()
            try? FileManager.default.removeItem(at: url)
        }
        await flushOutbox()
        #endif
    }
    func apply(_ state: Snapshot, sourceSession: String? = nil) {
        let identity = connectionIdentity
        if snapshotIdentity == identity, taskStreamState.session != sourceSession, taskStreamState.session != state.taskStreamSession { return }
        let previousSession = taskStreamState.session
        let previousHistoryGeneration = taskStreamState.historyGeneration
        guard taskStreamState.accept(state, scope: identity) else { return }
        if previousSession != taskStreamState.session { stopTaskStreams() }
        if snapshotIdentity != identity || previousHistoryGeneration != taskStreamState.historyGeneration { taskViewHistories = TaskViewHistoryCache() }
        snapshotIdentity = identity
        ideas = state.ideas; tasks = state.tasks; projects = state.projects; memories = state.memories
        TaskBrowserSessions.shared.reconcile(owner:browserClientID,connection:identity,taskIDs:Set(tasks.map(\.id)))
        taskViewHistories.retain(Set(tasks.map(\.id)))
        revision = state.revision
        textGenerationSettingsVersion = state.textGenerationSettingsVersion
        taskSidebarOrderingSupported = state.taskSidebarOrderingSupported == true
        taskExistingWorkspaceSupported = state.taskExistingWorkspaceSupported == true
        taskComposerCommandsSupported = state.taskComposerCommandsSupported == true
        taskArchiveLifecycleSupported = state.taskArchiveLifecycleSupported == true
        providerResetCreditsSupported = state.providerResetCreditsSupported == true
        providerConfigurationVersions = state.providerConfigurationVersions ?? [:]
        providerUsageSnapshots = state.providerUsageSnapshots ?? [:]
        usageLimitSources = state.usageLimitSources ?? []
        usageLimitSourcesSupported = state.usageLimitSourcesSupported == true
        taskSidebarWorkingSupported = state.taskSidebarWorkingSupported == true
        taskSidebarProjectScopesSupported = state.taskSidebarProjectScopesSupported == true
        taskScratchWorkspaceSupported = state.taskScratchWorkspaceSupported == true
        scratchWorkspaceRoot = state.scratchWorkspaceRoot
        namedProjectCreationSupported = state.namedProjectCreationSupported == true
        newProjectsRoot = state.newProjectsRoot
        projectRepositoryOperationsSupported = state.projectRepositoryOperationsSupported == true
        projectRepositoryOperations = state.projectRepositoryOperations ?? []
        taskAutoSettlementSupported = state.taskAutoSettlementSupported == true
        taskBackgroundCommandsSupported = state.taskBackgroundCommandsSupported == true
        taskNativeBackgroundSupported = state.taskNativeBackgroundSupported == true
        taskBackgroundSettlementSupported = state.taskBackgroundSettlementSupported == true
        taskSettlementSettingsVersion = state.taskSettlementSettingsVersion
        sourceControlPreferencesVersion = state.sourceControlPreferencesVersion
        observeSidebarActivity()
        if let agents = state.agents { self.agents = agents }
        if let devices = state.devices { self.devices = devices }
        if let id = state.deviceId { deviceId = id }
        serviceIdentity.observe(state.serviceId, connection: identity, authoritative: state.deviceId != nil)
        if let version = state.notesVersion { notesSupported = version >= 1 }
        else if state.deviceId != nil { notesSupported = false }
        taskHistoryGeneration = taskStreamState.historyGeneration
        taskStreamState.limitDetails(keeping: Set(taskLeases.keys))
        reconcileTaskStreams()
    }
    func connect() async {
        TaskBrowserSessions.shared.reconcile(owner:browserClientID,connection:connectionIdentity)
        streamTask?.cancel(); stopTaskStreams(); connected = false; notesSupported = false
        #if os(macOS)
        if connection.token.isEmpty {
            let fresh = Connection(); if fresh.server == connection.server { connection.token = fresh.token }
        }
        #endif
        streamTask = Task {
            while !Task.isCancelled {
                #if os(macOS)
                if connection.token.isEmpty {
                    let fresh = Connection(); if fresh.server == connection.server { connection.token = fresh.token }
                }
                #endif
                do {
                    let identity = connectionIdentity; let source = taskStreamState.session
                    let snapshot = try await overviewSnapshot()
                    if Task.isCancelled || connectionIdentity != identity { return }
                    apply(snapshot, sourceSession: source); connected = true; error = nil
                    await flushOutbox()
                    guard connectionIdentity == identity else { return }
                    var request = try connection.request(snapshot.taskStreamSession == nil ? "/api/events?history=turns&compactItems=1&itemHistory=1" : "/api/overview/events"); request.timeoutInterval = 86_400
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message("连接授权已失效，请重新配对") }
                    var decoder = TaskWorkspaceStream()
                    for try await line in bytes.lines {
                        if Task.isCancelled || connectionIdentity != identity { return }
                        if let update = try decoder.read(line) {
                            switch update {
                            case .snapshot(let state): apply(state, sourceSession: snapshot.taskStreamSession)
                            case .summaries(let patch):
                                if let changed = taskStreamState.apply(patch, to: tasks, scope: identity) { tasks = changed; revision = patch.sequence; observeSidebarActivity(); taskViewHistories.retain(Set(tasks.map(\.id))); reconcileTaskStreams() }
                                else { throw ConnectionError.message("任务列表已改变，正在重新加载。") }
                            }
                        }
                    }
                    connected = false
                } catch {
                    if Task.isCancelled { return }
                    connected = false; self.error = error.localizedDescription
                }
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }
    func refresh() async {
        let server = connection.server; let token = connection.token; let source = taskStreamState.session
        do {
            let state = try await overviewSnapshot()
            guard connection.server == server, connection.token == token else { return }; apply(state, sourceSession: source); error = nil
        } catch { if connection.server == server, connection.token == token { self.error = error.localizedDescription } }
    }
    private func overviewSnapshot() async throws -> Snapshot {
        let (data, response) = try await URLSession.shared.data(for: connection.request("/api/overview"))
        if (response as? HTTPURLResponse)?.statusCode == 404 { return try await connection.decode(Snapshot.self, "/api/state?history=turns&compactItems=1&itemHistory=1") }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "服务暂时无法响应") }
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }
    func taskDetail(_ id: String) -> WorkItem? { taskStreamState.task(id, summaries: tasks, scope: connectionIdentity) }
    func taskViewHistory(_ id: String, scope: String) -> TaskViewHistoryCache.Entry? {
        guard let task = taskDetail(id) else { return nil }; return taskViewHistories.load(task: task, scope: scope)
    }
    func saveTaskViewHistory(_ id: String, scope: String, history: TaskHistoryWindow, conversation: TaskConversationWindow) {
        guard let task = taskDetail(id), tasks.first(where: { $0.id == id })?.history?.epoch == (task.conversationHistory?.epoch ?? task.history?.epoch) else { return }
        taskViewHistories.save(task: task, scope: scope, history: history, conversation: conversation)
    }
    func taskWasRemoved(_ id: String) -> Bool { taskStreamState.isRemoved(id) || snapshotIdentity == connectionIdentity && connected && !tasks.contains { $0.id == id } }
    // Each visible window owns a lease. Detaching one window never cancels
    // another viewer or any Durable task, queue or provider process.
    func followTask(_ id: String) async {
        let lease = UUID(); taskLeases[id, default: []].insert(lease); taskStreamState.touch(id); reconcileTaskStreams()
        defer {
            taskLeases[id]?.remove(lease)
            if taskLeases[id]?.isEmpty == true { taskLeases.removeValue(forKey: id); taskStreams.removeValue(forKey: id)?.task.cancel() }
            taskStreamState.limitDetails(keeping: Set(taskLeases.keys))
        }
        while !Task.isCancelled { do { try await Task.sleep(for: .seconds(60)) } catch { return } }
    }
    private func stopTaskStreams() { for stream in taskStreams.values { stream.task.cancel() }; taskStreams = [:] }
    private func reconcileTaskStreams() {
        let available = Set(tasks.filter { $0.contentOmitted == true }.map(\.id))
        for id in Array(taskStreams.keys) where !available.contains(id) || taskLeases[id]?.isEmpty != false { taskStreams.removeValue(forKey: id)?.task.cancel() }
        guard let session = taskStreamState.session else { return }
        for id in taskLeases.keys where available.contains(id) && taskStreams[id] == nil {
            let token = UUID(); let identity = connectionIdentity
            let task = Task { await runTaskStream(id, token: token, identity: identity, session: session) }
            taskStreams[id] = (token, task)
        }
    }
    private func runTaskStream(_ id: String, token: UUID, identity: String, session: String) async {
        let component = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~")); let encoded = id.addingPercentEncoding(withAllowedCharacters: component) ?? id
        let route = "/api/tasks/" + encoded
        func current() -> Bool { !Task.isCancelled && connectionIdentity == identity && taskStreamState.session == session && taskStreams[id]?.token == token && tasks.contains { $0.id == id } }
        defer { if taskStreams[id]?.token == token { taskStreams.removeValue(forKey: id) } }
        while current() {
            if !connected { do { try await Task.sleep(for: .seconds(1)); continue } catch { return } }
            do {
                let (data, snapshotResponse) = try await URLSession.shared.data(for: connection.request(route + "/snapshot?itemHistory=1"))
                guard current() else { return }
                let status = (snapshotResponse as? HTTPURLResponse)?.statusCode
                if status == 404, let removal = try? JSONDecoder().decode(TaskDetailRemoval.self, from: data), taskStreamState.accept(removal, for: id, scope: identity) { taskStreamErrors.removeValue(forKey: id); taskContentRevision += 1; return }
                guard status == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "任务进展暂时无法加载") }
                let frame = try JSONDecoder().decode(TaskDetailSnapshot.self, from: data)
                if taskStreamState.accept(frame, for: id, summaries: tasks, scope: identity) { taskStreamState.limitDetails(keeping: Set(taskLeases.keys)); taskContentRevision += 1; taskStreamErrors.removeValue(forKey: id) }
                var query = URLComponents(); query.queryItems = [URLQueryItem(name: "session", value: session), URLQueryItem(name: "itemHistory", value: "1")]
                if let version = taskStreamState.version(id) { query.queryItems?.append(URLQueryItem(name: "version", value: version)) }
                var request = try connection.request(route + "/events?" + (query.percentEncodedQuery ?? "")); request.timeoutInterval = 30
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message("任务进展暂时无法加载") }
                var decoder = TaskDetailStream()
                for try await line in bytes.lines {
                    guard current() else { return }
                    if let update = try decoder.read(line) {
                        switch update {
                        case .snapshot(let frame): if taskStreamState.accept(frame, for: id, summaries: tasks, scope: identity) { taskStreamState.limitDetails(keeping: Set(taskLeases.keys)); taskContentRevision += 1; taskStreamErrors.removeValue(forKey: id) }
                        case .removed(let removal): if taskStreamState.accept(removal, for: id, scope: identity) { taskStreamErrors.removeValue(forKey: id); taskContentRevision += 1; return }
                        }
                    }
                }
            } catch { if current() { taskStreamErrors[id] = error.localizedDescription } }
            guard current() else { return }
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
        }
    }
    @discardableResult
    func saveIdea(_ text: String) async -> Bool {
        await saveNote(id: UUID().uuidString, title: "", text: text, images: [], createdAt: ISO8601DateFormatter().string(from: Date()), expectedUpdatedAt: nil)
    }
    @discardableResult
    func saveNote(id: String, title: String, text: String, images: [IdeaImage], createdAt: String, expectedUpdatedAt: String?, taskId: String? = nil) async -> Bool {
        guard enqueueNote(id: id, title: title, text: text, images: images, createdAt: createdAt, expectedUpdatedAt: expectedUpdatedAt, taskId: taskId) else { return false }
        await flushOutbox()
        return true
    }
    @discardableResult
    func enqueueNote(id: String, title: String, text: String, images: [IdeaImage], createdAt: String, expectedUpdatedAt: String?, taskId: String? = nil) -> Bool {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty else { return false }
        guard title.utf16.count <= 200, text.utf16.count <= 100_000, images.count <= 20 else { error = "标题最多 200 字，笔记最多 100,000 字和 20 张图片。"; return false }
        let previous = outbox.first { $0.id == id }
        // Preserve the server version on which an unsent offline edit was based.
        let version = previous != nil ? previous?.expectedUpdatedAt : expectedUpdatedAt
        let note = OutboxIdea(id: id, text: text, title: title, createdAt: createdAt, images: images, expectedUpdatedAt: version, editId: UUID().uuidString, taskId: taskId)
        if let index = outbox.firstIndex(where: { $0.id == id }) { outbox[index] = note } else { outbox.append(note) }
        // Capture edits before any asynchronous work so leaving the editor or
        // quitting the client cannot interrupt the local save.
        persistOutbox()
        return true
    }
    func scheduleNoteSync(immediately: Bool = false) {
        noteSyncTask?.cancel()
        noteSyncTask = Task {
            if !immediately {
                do { try await Task.sleep(for: .milliseconds(650)) } catch { return }
            }
            guard !Task.isCancelled else { return }
            // Later keystrokes may cancel the debounce, never an active upload.
            noteSyncTask = nil
            await flushOutbox()
        }
    }
    private func persistOutbox() { UserDefaults.standard.set(try? JSONEncoder().encode(outbox), forKey: "friday.outbox") }
    func persistPendingNotes() { persistOutbox() }
    func flushOutbox() async {
        guard !flushing, connected else { return }
        guard notesSupported else {
            if !outbox.isEmpty { error = "请先更新 Friday 主机以支持笔记。内容已保存在本机，更新后会继续同步。" }
            return
        }
        flushing = true; defer { flushing = false }
        var syncError: String?
        while let idea = outbox.first {
            do {
                for image in idea.images ?? [] {
                    // Content IDs make uploading cached images safe to retry.
                    if let data = IdeaImageCache.localData(image.id) {
                        _ = try await connection.data("/api/idea-images", method: "POST", body: ["id": image.id, "name": image.name, "data": data.base64EncodedString()])
                    }
                }
                var body: [String: Any] = ["id": idea.id, "text": idea.text, "title": idea.title ?? "", "images": (idea.images ?? []).map { ["id": $0.id, "name": $0.name, "mediaType": $0.mediaType] }]
                if let date = idea.createdAt { body["createdAt"] = date }
                if let version = idea.expectedUpdatedAt { body["expectedUpdatedAt"] = version; body["editId"] = idea.editId ?? idea.id }
                let path = idea.expectedUpdatedAt == nil ? "/api/ideas" : "/api/ideas/\(idea.id)"
                let saved = try await connection.decode(Idea.self, path, method: idea.expectedUpdatedAt == nil ? "POST" : "PUT", body: body)
                if let index = ideas.firstIndex(where: { $0.id == saved.id }) { ideas[index] = saved } else { ideas.insert(saved, at: 0) }
                if let index = outbox.firstIndex(where: { $0.id == idea.id }) {
                    let sameContent = saved.text == idea.text.trimmingCharacters(in: .whitespacesAndNewlines)
                        && (saved.title ?? "") == (idea.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        && (saved.images ?? []) == (idea.images ?? [])
                    if outbox[index] == idea && sameContent { outbox.remove(at: index) }
                    else {
                        // A create may already exist after a lost response. Retain any later
                        // offline changes, then update the version actually acknowledged.
                        outbox[index].expectedUpdatedAt = saved.updatedAt ?? saved.createdAt
                    }
                }
                persistOutbox()
            } catch { syncError = error.localizedDescription; break }
        }
        await refresh()
        if let syncError { error = syncError }
    }
    func deleteNote(_ idea: Idea) async -> Bool {
        if ideas.contains(where: { $0.id == idea.id }) {
            guard connected else { error = "连接主机后才能删除已同步的笔记。"; return false }
            guard await perform("/api/ideas/\(idea.id)", method: "DELETE") else { return false }
        }
        outbox.removeAll { $0.id == idea.id }; persistOutbox()
        return true
    }
    func imageData(_ id: String) async throws -> Data {
        if let data = IdeaImageCache.localData(id) { return data }
        let data = try await connection.data("/api/idea-images/\(id)")
        try IdeaImageCache.store(data, id: id)
        return data
    }
    func perform(_ path: String, method: String = "POST", body: [String: Any] = [:]) async -> Bool {
        do { _ = try await connection.data(path, method: method, body: method == "DELETE" ? nil : body); await refresh(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func uploadTaskImages(_ images: [IdeaImage]) async throws {
        for image in images {
            guard let data = IdeaImageCache.localData(image.id) else {
                // Queued messages can be edited on another paired device.
                // Existing host attachments do not require a local re-upload.
                _ = try await imageData(image.id)
                continue
            }
            _ = try await connection.data("/api/idea-images", method: "POST", body: ["id": image.id, "name": image.name, "data": data.base64EncodedString()])
        }
    }
    func updateTask(_ id: String, changes: [String: Any]) async throws {
        _ = try await connection.data("/api/tasks/\(id)", method: "PATCH", body: changes)
        await refresh()
    }
    func searchTasks(_ query: String) async throws -> TaskSearchResponse {
        var parameters = URLComponents(); parameters.queryItems = [URLQueryItem(name: "query", value: query)]
        let (data, response) = try await URLSession.shared.data(for: connection.request("/api/tasks/search?" + (parameters.percentEncodedQuery ?? "")))
        if (response as? HTTPURLResponse)?.statusCode == 404 { throw ConnectionError.message("当前主机不支持消息搜索") }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "任务消息搜索暂时不可用，请稍后重试")
        }
        return try JSONDecoder().decode(TaskSearchResponse.self, from: data)
    }
    func taskChanges(_ id: String, scope: String) async throws -> TaskChangesSnapshot {
        try await connection.decode(TaskChangesSnapshot.self, "/api/tasks/\(id)/changes?scope=\(scope)")
    }
    func taskGitStatus(_ id: String, refresh: Bool = false) async throws -> TaskGitStatus {
        try await connection.decode(TaskGitStatus.self, "/api/tasks/\(id)/git/status\(refresh ? "?refresh=true" : "")")
    }
    func startTaskGitOperation(_ id: String, body: [String: Any]) async throws -> String {
        let result = try await connection.decode(IDResponse.self, "/api/tasks/\(id)/git/operations", method: "POST", body: body)
        await self.refresh(); return result.id
    }
    func taskPublishProviders(_ id: String) async throws -> [TaskPublishProvider] {
        try await connection.decode(TaskPublishProvidersResponse.self, "/api/tasks/\(id)/git/publish-providers").providers
    }
    func taskGitOperation(_ id: String, operationID: String) async throws -> TaskGitOperation {
        try await connection.decode(TaskGitOperation.self, "/api/tasks/\(id)/git/operations/\(operationID)")
    }
    func sourceControlSettings() async throws -> SourceControlCredentialSettings {
        try await connection.decode(SourceControlCredentialSettings.self, "/api/source-control/settings")
    }
    func saveSourceControlSettings(_ body: [String: Any]) async throws -> SourceControlCredentialSettings {
        try await connection.decode(SourceControlCredentialSettings.self, "/api/source-control/settings", method: "PATCH", body: body)
    }
    func sourceControlDiscovery() async throws -> SourceControlDiscovery {
        try await connection.decode(SourceControlDiscovery.self, "/api/source-control/discovery")
    }
    func taskDiff(_ id: String, path: String, scope: String, runID: String? = nil) async throws -> TaskFileDiff {
        var query = URLComponents()
        query.queryItems = [URLQueryItem(name: "path", value: path), URLQueryItem(name: "scope", value: scope)]
        let encoded = (query.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let route = runID.map { "/api/tasks/\(id)/runs/\($0)/diff" } ?? "/api/tasks/\(id)/diff"
        return try await connection.decode(TaskFileDiff.self, "\(route)?\(encoded)")
    }
    func taskRewindOptions(_ id: String, messageID: String) async throws -> TaskRewindOptions {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "messageId", value: messageID)]
        let encoded = (query.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return try await connection.decode(TaskRewindOptions.self, "/api/tasks/\(id)/rewind/options?\(encoded)")
    }
    func taskHistory(_ id: String, epoch: String, range: TaskHistoryRange) async throws -> TaskHistoryPage {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "beforePosition", value: String(range.upper)), URLQueryItem(name: "limit", value: String(range.limit)), URLQueryItem(name: "compactItems", value: "1")]
        return try await connection.decode(TaskHistoryPage.self, "/api/tasks/\(id)/history?\(query.percentEncodedQuery ?? "")")
    }
    func taskConversationHistory(_ id: String, cursor: String, through: String? = nil) async throws -> TaskConversationPage {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "before", value: cursor), URLQueryItem(name: "compactItems", value: "1")]
        if let through { query.queryItems?.append(URLQueryItem(name: "through", value: through)) }
        return try await connection.decode(TaskConversationPage.self, "/api/tasks/\(id)/conversation-history?\(query.percentEncodedQuery ?? "")")
    }
    func taskHistoryEvents(_ id: String, ids: [String]) async throws -> TaskEventPage {
        try await connection.decode(TaskEventPage.self, "/api/tasks/\(id)/history/events", method: "POST", body: ["ids": ids, "compactItems": true])
    }
    func forkTask(_ id: String, runID: String, requestID: String) async throws -> String {
        let response = try await connection.decode(IDResponse.self, "/api/tasks/\(id)/fork", method: "POST", body: ["requestId": requestID, "runId": runID])
        await refresh(); return response.id
    }
    func resolveTaskFork(_ id: String, requestID: String, action: String) async throws {
        _ = try await connection.data("/api/tasks/\(id)/fork/resolve", method: "POST", body: ["requestId": requestID, "action": action])
        await refresh()
    }
    func rewindTask(_ id: String, requestID: String, options: TaskRewindOptions, restoreFiles: Bool, newSession: Bool = false) async throws {
        var body: [String: Any] = ["requestId": requestID, "messageId": options.messageId, "fingerprint": options.fingerprint, "restoreFiles": restoreFiles, "newSession": newSession]
        if let fingerprint = options.fileFingerprint { body["fileFingerprint"] = fingerprint }
        _ = try await connection.decode(IDResponse.self, "/api/tasks/\(id)/rewind", method: "POST", body: body)
        await refresh()
    }
    func resolveTaskRewind(_ id: String, operationID: String, requestID: String, action: String, fileFingerprint: String? = nil) async throws {
        var body: [String: Any] = ["requestId": requestID, "action": action]
        if let fileFingerprint { body["fileFingerprint"] = fileFingerprint }
        _ = try await connection.data("/api/tasks/\(id)/rewind/\(operationID)/resolve", method: "POST", body: body)
        await refresh()
    }
    func taskRewindFileReview(_ id: String, operationID: String) async throws -> TaskRewindFileStatus {
        try await connection.decode(TaskRewindFileStatus.self, "/api/tasks/\(id)/rewind/\(operationID)/files")
    }
    func saveTaskPlan(_ id: String, eventID: String, path: String) async throws {
        _ = try await connection.data("/api/tasks/\(id)/plan/save", method: "POST", body: ["eventId": eventID, "path": path])
    }
    func followUpPlan(_ id: String, eventID: String, text: String, images: [IdeaImage], requestID: String, newThread: Bool, model: String, effort: String, contexts: [TaskContextReference] = []) async throws -> String {
        let identity = connectionIdentity
        let references = try await materializeTaskContexts(text: text, contexts: contexts, scope: TaskContextScope(taskID: id))
        try await uploadTaskImages(images)
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        let result = try await connection.decode(IDResponse.self, "/api/tasks/\(id)/plan/follow-up", method: "POST", body: [
            "eventId": eventID, "text": text, "images": images.map { ["id": $0.id, "name": $0.name, "mediaType": $0.mediaType] },
            "requestId": requestID, "newThread": newThread, "model": model, "reasoningEffort": effort,
            "contextIds": references.map(\.id),
        ])
        await refresh(); return result.id
    }
    func markTaskRead(_ task: WorkItem) async {
        await acknowledgeTaskRead(task, includingOutput: true)
    }
    func acknowledgeTaskWake(_ task: WorkItem) async {
        await acknowledgeTaskRead(task, includingOutput: false)
    }
    private func acknowledgeTaskRead(_ task: WorkItem, includingOutput: Bool) async {
        guard let changes = TaskSnooze.readChange(task, includingOutput: includingOutput) else { return }
        let identity = connectionIdentity; let service = taskStreamSession; let transport = connection
        do {
            _ = try await transport.data("/api/tasks/\(task.id)", method: "PATCH", body: changes)
            guard identity == connectionIdentity, service == taskStreamSession else { return }
            await refresh()
        } catch { if identity == connectionIdentity, service == taskStreamSession { self.error = error.localizedDescription } }
    }
    func sendTaskMessage(taskId: String, text: String, requestId: String, images: [IdeaImage], model: String?, effort: String?, dispatch: TaskComposerDispatch = .auto, interactionMode: String? = nil, contexts: [TaskContextReference] = [], compactThread: String? = nil) async throws {
        let identity = connectionIdentity
        let references = try await materializeTaskContexts(text: text, contexts: contexts, scope: TaskContextScope(taskID: taskId))
        try await uploadTaskImages(images)
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        var body: [String: Any] = ["text": text, "requestId": requestId, "dispatchMode": dispatch.rawValue]
        if let compactThread { body["compactBeforeSend"] = true; body["threadId"] = compactThread }
        body["contextIds"] = references.map(\.id)
        if !images.isEmpty { body["images"] = images.map { ["id": $0.id, "name": $0.name, "mediaType": $0.mediaType] } }
        if let model { body["model"] = model }; if let effort { body["reasoningEffort"] = effort }
        if let interactionMode { body["interactionMode"] = interactionMode }
        _ = try await connection.data("/api/tasks/\(taskId)/message", method: "POST", body: body)
        await refresh()
    }
    func editQueuedMessage(taskId: String, messageId: String, text: String, images: [IdeaImage], model: String?, effort: String?, interactionMode: String? = nil, contexts: [TaskContextReference] = []) async throws {
        let identity = connectionIdentity
        let references = try await materializeTaskContexts(text: text, contexts: contexts, scope: TaskContextScope(taskID: taskId))
        try await uploadTaskImages(images)
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        var body: [String: Any] = ["text": text, "images": images.map { ["id": $0.id, "name": $0.name, "mediaType": $0.mediaType] }]
        body["contextIds"] = references.map(\.id)
        if let model { body["model"] = model }; if let effort { body["reasoningEffort"] = effort }
        if let interactionMode { body["interactionMode"] = interactionMode }
        _ = try await connection.data("/api/tasks/\(taskId)/queue/\(messageId)", method: "PATCH", body: body)
        await refresh()
    }
    func ensureScratchProject() async throws -> Project {
        let identity = connectionIdentity
        guard taskScratchWorkspaceSupported, scratchWorkspaceRoot != nil, connected, snapshotIdentity == identity else { throw ConnectionError.message("此主机暂不支持无项目任务") }
        let project = try await connection.decode(Project.self, "/api/projects/scratch", method: "POST", body: [:])
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        return projects.first { $0.id == project.id } ?? project
    }
    func registerProject(name: String, path: String) async throws -> Project {
        let identity = connectionIdentity
        guard connected, snapshotIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        if let project = projects.first(where: { $0.path == path }) { return project }
        let project = try await connection.decode(Project.self, "/api/projects", method: "POST", body: ["name": name, "path": path])
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        return project
    }
    func createNamedProject(name: String, requestID: String) async throws -> NamedProjectCreationResult {
        try await managedProjectRequest("/api/projects/managed", method: "POST", body: ["name": name, "requestId": requestID])
    }
    func namedProjectCreationStatus(_ requestID: String, cancel: Bool = false) async throws -> NamedProjectCreationResult {
        guard requestID.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ConnectionError.message("项目创建请求无效") }
        return try await managedProjectRequest("/api/projects/managed/" + requestID + (cancel ? "/cancel" : ""), method: cancel ? "POST" : "GET", body: cancel ? [:] : nil)
    }
    private func managedProjectRequest(_ path: String, method: String, body: [String: Any]?) async throws -> NamedProjectCreationResult {
        let identity = connectionIdentity
        guard connected, namedProjectCreationSupported, snapshotIdentity == identity else { throw ConnectionError.message("此主机暂不支持新建项目") }
        let result = try await connection.decode(NamedProjectCreationResult.self, path, method: method, body: body)
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        if result.status == "created" {
            await refresh()
            guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
            guard let project = result.project, projects.contains(where: { $0.id == project.id }) else { throw ConnectionError.message("项目已创建，等待 Workspace 同步后再打开") }
        }
        return result
    }
    func createTask(prompt: String, ideaId: String? = nil, requestId: String, projectId: String? = nil, agent: String = "friday", model: String? = nil, reasoningEffort: String? = nil, interactionMode: String? = nil, workspace: TaskWorkspaceSelection? = nil, images: [IdeaImage] = [], contexts: [TaskContextReference] = []) async throws -> String {
        let identity = connectionIdentity
        let references = try await materializeTaskContexts(text: prompt, contexts: contexts, scope: TaskContextScope(projectID: projectId, preparationID: workspace?.preparationId))
        try await uploadTaskImages(images)
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        var body: [String: Any] = ["prompt": prompt, "requestId": requestId]
        body["contextIds"] = references.map(\.id)
        if !images.isEmpty { body["images"] = images.map { ["id": $0.id, "name": $0.name, "mediaType": $0.mediaType] } }
        body["agent"] = agent
        if agent == "codex" || agent == "claude" { body["mode"] = "code" }
        if let projectId { body["projectId"] = projectId }
        if let model { body["model"] = model }; if let reasoningEffort { body["reasoningEffort"] = reasoningEffort }
        if let interactionMode { body["interactionMode"] = interactionMode }
        if let ideaId { body["ideaId"] = ideaId }
        if let workspace { body["workspace"] = workspace.body }
        let response = try await connection.decode(IDResponse.self, "/api/tasks", method: "POST", body: body)
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        return response.id
    }
    func delegate(_ idea: Idea) async -> String? {
        if let taskId = idea.taskId { return taskId }
        guard !delegatingIdeas.contains(idea.id) else { return nil }
        delegatingIdeas.insert(idea.id); defer { delegatingIdeas.remove(idea.id) }
        let content = [idea.title ?? "", idea.text].filter { !$0.isEmpty }.joined(separator: "\n\n")
        let prompt = content.utf16.count <= 12_000 && !content.isEmpty ? content : "请查看 workspace 中 ID 为 \(idea.id) 的笔记，并根据其中的内容帮我推进。"
        do { return try await createTask(prompt: prompt, ideaId: idea.id, requestId: "idea-" + idea.id) }
        catch { self.error = error.localizedDescription; return nil }
    }
    func pair(server: String, code: String, name: String) async throws {
        let oldServer = connection.server; let oldToken = connection.token
        streamTask?.cancel(); connected = false
        do {
            connection.server = server.trimmingCharacters(in: .whitespacesAndNewlines)
            let device = try await connection.decode(PairedDevice.self, "/pair", method: "POST", body: ["code": code, "name": name])
            try SecureToken.save(device.token, for: connection.server)
            connection.token = device.token; UserDefaults.standard.set(connection.server, forKey: "friday.server")
            await connect()
        } catch { connection.server = oldServer; connection.token = oldToken; await connect(); throw error }
    }
}
