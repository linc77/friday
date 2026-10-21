import Foundation
import Combine
import CryptoKit

struct FileSaveAttempt: Codable, Sendable, Equatable { let id: String; let revision: Int; let contents: String }
struct FileSaveReply: Decodable, Sendable {
    let status: String; let requestId: String
    var version: String? = nil; var workspaceVersion: String? = nil; var byteLength: Int? = nil; var error: String? = nil
}
struct FileEditorDraft: Codable, Sendable {
    let editorId: String; let revision: Int; let confirmedRevision: Int; let stamp: Int; let contents: String; let workspaceVersion: String; let pending: FileSaveAttempt?
}
protocol FileEditorDraftCaching: Sendable {
    func load(_ key: String) async -> FileEditorDraft?
    func save(_ value: FileEditorDraft, key: String) async
    func clear(_ key: String, editorId: String, through revision: Int) async
}
actor FileEditorDraftCache: FileEditorDraftCaching {
    static let shared = FileEditorDraftCache()
    private var cleared: [String: Int] = [:]
    private let directory: URL?
    init(directory: URL? = nil) { self.directory = directory }
    private func url(_ key: String) throws -> URL {
        guard key.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil else { throw URLError(.badURL) }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let root = directory ?? base.appendingPathComponent("Friday/FileEdits/" + (Bundle.main.bundleIdentifier ?? "Friday"), isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        return root.appendingPathComponent(key + ".json")
    }
    func load(_ key: String) -> FileEditorDraft? { guard let file = try? url(key), let data = try? Data(contentsOf: file) else { return nil }; return try? JSONDecoder().decode(FileEditorDraft.self, from: data) }
    func save(_ value: FileEditorDraft, key: String) {
        let tombstone = key + ":" + value.editorId
        guard value.revision > (cleared[tombstone] ?? -1), let file = try? url(key) else { return }
        if let current = load(key), current.editorId == value.editorId, current.stamp > value.stamp { return }
        do { let data = try JSONEncoder().encode(value); try data.write(to: file, options: [.atomic, .completeFileProtectionUnlessOpen]); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) } catch {}
    }
    func clear(_ key: String, editorId: String, through revision: Int) {
        let tombstone = key + ":" + editorId; cleared[tombstone] = max(cleared[tombstone] ?? -1, revision)
        guard let value = load(key), value.editorId == editorId, value.revision <= revision, let file = try? url(key) else { return }; try? FileManager.default.removeItem(at: file)
    }
}

private final class FileEditorRedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = FileEditorRedirectPolicy()
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
@MainActor struct FileEditorTransport {
    var save: (FileSaveAttempt, String, String) async throws -> FileSaveReply
    var status: (String) async throws -> FileSaveReply
    var read: () async throws -> TaskFileDocument
    var canPersist: () -> Bool
    static func captured(store: FridayStore, taskID: String, path: String) throws -> Self {
        let scope = TaskContextScope(taskID: taskID)
        let writeTemplate = try store.connection.request("/api/task-files/document", method: "PUT")
        let statusTemplate = try store.connection.request("/api/task-files/saves/")
        let readTemplate = try store.connection.request(TaskFileNavigation.route("document", taskID: taskID, path: path))
        func data(_ request: URLRequest) async throws -> Data {
            var input = request; input.httpShouldHandleCookies = false
            let (data, response) = try await URLSession.shared.data(for: input, delegate: FileEditorRedirectPolicy.shared)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "文件保存失败，编辑内容已保留") }; return data
        }
        return Self(save: { attempt, editorID, workspace in
            var request = writeTemplate; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": attempt.id, "editorId": editorID, "revision": attempt.revision, "contents": attempt.contents, "workspaceVersion": workspace, "scope": scope.body, "path": path])
            return try JSONDecoder().decode(FileSaveReply.self, from: await data(request))
        }, status: { id in
            var request = statusTemplate, components = URLComponents(url: statusTemplate.url!.appendingPathComponent(id), resolvingAgainstBaseURL: false)
            components?.percentEncodedQuery = scope.query; request.url = components?.url
            return try JSONDecoder().decode(FileSaveReply.self, from: await data(request))
        }, read: { try JSONDecoder().decode(TaskFileDocument.self, from: await data(readTemplate)) }, canPersist: { true })
    }
}

/// One coordinator per service/account/workspace/file, shared by native windows.
/// Same 500 ms debounce and trailing-save behavior as T3's FileSaveCoordinator.
@MainActor final class FileEditSession: ObservableObject {
    let key: String
    @Published private(set) var document: TaskFileDocument
    @Published private(set) var contents: String
    @Published private(set) var phase = "saved"
    @Published private(set) var error: String?
    private(set) var editorId: String
    private(set) var revision: Int
    private var confirmedRevision: Int
    private var stamp: Int
    private var workspaceVersion: String
    private var latestRemote: TaskFileDocument
    private var pending: FileSaveAttempt?
    private var saving = false
    private var epoch = UUID()
    private var saveTimer: Task<Void, Never>?
    private var draftTimer: Task<Void, Never>?
    private var lastChange = Date.distantPast
    private var flushRequested = false
    private var transport: FileEditorTransport
    private let cache: any FileEditorDraftCaching
    private let debounce: TimeInterval
    var isDirty: Bool { revision > confirmedRevision }
    var isSaving: Bool { saving }
    var rootMatches: Bool { latestRemote.workspaceVersion == workspaceVersion }
    var canEdit: Bool { document.writeSupported == true && document.contents != nil && !document.truncated }
    var pendingInTab: Bool { isDirty || saving }
    var revisionForRead: Int? { isDirty || saving ? nil : revision }
    init(key: String, document: TaskFileDocument, draft: FileEditorDraft?, transport: FileEditorTransport, cache: any FileEditorDraftCaching = FileEditorDraftCache.shared, debounce: TimeInterval = 0.5) {
        self.key = key; self.document = document; latestRemote = document; self.transport = transport; self.cache = cache; self.debounce = debounce
        contents = draft?.contents ?? document.contents ?? ""; editorId = draft?.editorId ?? UUID().uuidString; revision = draft?.revision ?? 0
        confirmedRevision = draft?.confirmedRevision ?? 0; stamp = draft?.stamp ?? 0; workspaceVersion = draft?.workspaceVersion ?? document.workspaceVersion ?? ""; pending = draft?.pending
        if draft != nil { phase = "pending" }
        if !rootMatches, isDirty { phase = "failed"; error = "工作区已改变，编辑内容已保留" }
    }
    func resume() { if isDirty && rootMatches { schedule(0) } }
    func rebind(_ transport: FileEditorTransport) { self.transport = transport }
    func accept(_ remote: TaskFileDocument, readRevision: Int?) {
        if isDirty || saving {
            latestRemote = remote
            if !rootMatches { saveTimer?.cancel(); phase = "failed"; error = "工作区已改变，编辑内容已保留" }; return
        }
        guard readRevision == revision || readRevision == nil && revision == 0 else { return }
        latestRemote = remote
        document = remote; contents = remote.contents ?? ""; workspaceVersion = remote.workspaceVersion ?? ""
    }
    func change(_ text: String) {
        guard canEdit, text != contents else { return }; contents = text; revision += 1; stamp += 1; lastChange = .now; phase = "pending"; error = nil
        draftTimer?.cancel(); draftTimer = Task { [weak self] in try? await Task.sleep(for: .milliseconds(150)); if !Task.isCancelled { await self?.persistDraft() } }
        schedule(debounce)
    }
    func setTaskChecked(at offset: Int, checked: Bool, source: String) {
        guard source == contents, let text = TaskFileNavigation.settingTaskChecked(in: source, markerOffset: offset, checked: checked) else { return }
        change(text)
    }
    func flush() { flushRequested = true; saveTimer?.cancel(); Task { await persistLatest() } }
    func retry() { guard isDirty else { return }; revision += 1; stamp += 1; pending = nil; error = nil; phase = "pending"; flush() }
    func reconcile() { guard isDirty else { return }; saveTimer?.cancel(); Task { await persistLatest() } }
    func readReplacedWorkspace() async {
        guard !rootMatches, !saving else { return }
        let oldEditor = editorId, oldRevision = revision
        epoch = UUID(); saveTimer?.cancel(); draftTimer?.cancel()
        document = latestRemote; contents = latestRemote.contents ?? ""; workspaceVersion = latestRemote.workspaceVersion ?? ""
        editorId = UUID().uuidString; revision = 0; confirmedRevision = 0; stamp = 0; pending = nil; error = nil; phase = "saved"
        await cache.clear(key, editorId: oldEditor, through: oldRevision)
    }
    private func schedule(_ delay: TimeInterval) {
        saveTimer?.cancel(); saveTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, delay)))
            if !Task.isCancelled { self?.saveTimer = nil; await self?.persistLatest() }
        }
    }
    private func persistDraft() async {
        guard isDirty else { return }
        await cache.save(FileEditorDraft(editorId: editorId, revision: revision, confirmedRevision: confirmedRevision, stamp: stamp, contents: contents, workspaceVersion: workspaceVersion, pending: pending), key: key)
    }
    private func persistLatest() async {
        guard !saving, isDirty else { return }
        guard canEdit, rootMatches, transport.canPersist() else { await persistDraft(); return }
        guard contents.utf8.count <= 1024 * 1024, !contents.contains("\0") else { phase = "failed"; error = "文件最多 1 MiB，编辑内容已保留"; await persistDraft(); return }
        let attempt = pending ?? FileSaveAttempt(id: UUID().uuidString, revision: revision, contents: contents)
        let requestTransport = transport, generation = epoch, existing = pending != nil, requestEditorID = editorId, requestWorkspace = workspaceVersion
        pending = attempt; saving = true; phase = "saving"; error = nil; stamp += 1; await persistDraft()
        guard generation == epoch, rootMatches, requestTransport.canPersist() else { saving = false; if isDirty, rootMatches { schedule(0) }; return }
        var reply: FileSaveReply?
        do {
            if existing { reply = try await requestTransport.status(attempt.id) }
            if reply == nil || reply?.status == "missing" { reply = try await requestTransport.save(attempt, requestEditorID, requestWorkspace) }
        } catch {
            do { reply = try await requestTransport.status(attempt.id) } catch { self.error = error.localizedDescription }
        }
        guard generation == epoch else { saving = false; if isDirty, rootMatches { schedule(0) }; return }
        if let reply, reply.requestId == attempt.id, reply.status == "saved", reply.workspaceVersion == workspaceVersion, rootMatches, let version = reply.version {
            confirmedRevision = max(confirmedRevision, attempt.revision); pending = nil; stamp += 1
            document = document.saved(contents: attempt.contents, version: version); phase = isDirty ? "pending" : "saved"
            if !isDirty { draftTimer?.cancel(); await cache.clear(key, editorId: editorId, through: revision) }
            else { await persistDraft() }
            let confirmed = confirmedRevision
            Task { [weak self] in
                guard let remote = try? await requestTransport.read(), let self, self.epoch == generation, self.confirmedRevision == confirmed,
                      self.document.version == version, self.workspaceVersion == requestWorkspace, self.rootMatches else { return }
                self.accept(remote, readRevision: confirmed)
            }
        } else {
            phase = reply?.status == "unconfirmed" || reply?.status == "missing" || reply == nil ? "unconfirmed" : "failed"
            if error == nil { error = reply?.error ?? "文件保存失败，编辑内容已保留" }; stamp += 1; await persistDraft()
        }
        saving = false
        if revision > attempt.revision, rootMatches {
            pending = nil; stamp += 1; schedule(flushRequested ? 0 : max(0, debounce - Date().timeIntervalSince(lastChange)))
        } else { flushRequested = false }
    }
}

@MainActor final class FileEditorStore: ObservableObject {
    static let shared = FileEditorStore()
    private var sessions: [String: FileEditSession] = [:]
    private var observations: [String: AnyCancellable] = [:]
    private let cache: any FileEditorDraftCaching
    init(cache: any FileEditorDraftCaching = FileEditorDraftCache.shared) { self.cache = cache }
    static func key(server: String, token: String, cwd: String, path: String) -> String {
        let auth = SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
        return SHA256.hash(data: Data([server, auth, cwd, path].joined(separator: "\0").utf8)).map { String(format: "%02x", $0) }.joined()
    }
    func current(_ key: String) -> FileEditSession? { sessions[key] }
    func open(key: String, document: TaskFileDocument, transport: FileEditorTransport, readRevision: Int?) async -> FileEditSession {
        if let current = sessions[key] { current.rebind(transport); current.accept(document, readRevision: readRevision); return current }
        let draft = await cache.load(key)
        if let current = sessions[key] { current.rebind(transport); current.accept(document, readRevision: readRevision); return current }
        let current = FileEditSession(key: key, document: document, draft: draft, transport: transport, cache: cache)
        sessions[key] = current; observations[key] = current.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }; objectWillChange.send(); current.resume(); return current
    }
    func flush(_ key: String) { sessions[key]?.flush() }
}
