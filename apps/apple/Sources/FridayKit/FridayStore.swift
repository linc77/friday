import Foundation
import SwiftUI

@MainActor
final class FridayStore: ObservableObject {
    @Published var ideas: [Idea] = []
    @Published var projects: [Project] = []
    @Published var tasks: [WorkItem] = []
    @Published var memories: [MemoryItem] = []
    @Published var agents: [AgentInfo] = []
    @Published var devices: [Device] = []
    @Published var deviceId = ""
    @Published var connected = false
    @Published var notesSupported = false
    @Published var error: String?
    @Published var outbox: [OutboxIdea] = []
    @Published var delegatingIdeas: Set<String> = []
    let connection = Connection()
    private var streamTask: Task<Void, Never>?
    private var noteSyncTask: Task<Void, Never>?
    private var flushing = false
    var notes: [Idea] {
        let pendingIDs = Set(outbox.map(\.id))
        return (outbox.map(\.note) + ideas.filter { !pendingIDs.contains($0.id) })
            .sorted { ($0.updatedAt ?? $0.createdAt) > ($1.updatedAt ?? $1.createdAt) }
    }
    init() {
        if let data = UserDefaults.standard.data(forKey: "friday.outbox"), let pending = try? JSONDecoder().decode([OutboxIdea].self, from: data) { outbox = pending }
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
    func apply(_ state: Snapshot) {
        ideas = state.ideas; tasks = state.tasks; projects = state.projects; memories = state.memories
        if let agents = state.agents { self.agents = agents }
        if let devices = state.devices { self.devices = devices }
        if let id = state.deviceId { deviceId = id }
        if let version = state.notesVersion { notesSupported = version >= 1 }
        else if state.deviceId != nil { notesSupported = false }
    }
    func connect() async {
        streamTask?.cancel(); connected = false; notesSupported = false
        #if os(macOS)
        if connection.token.isEmpty {
            let fresh = Connection(); if fresh.server == connection.server { connection.token = fresh.token }
        }
        #endif
        streamTask = Task {
            while !Task.isCancelled {
                do {
                    let snapshot = try await connection.decode(Snapshot.self, "/api/state")
                    if Task.isCancelled { return }
                    apply(snapshot); connected = true; error = nil
                    await flushOutbox()
                    var request = try connection.request("/api/events"); request.timeoutInterval = 86_400
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message("连接授权已失效，请重新配对") }
                    var decoder = SnapshotStream()
                    for try await line in bytes.lines {
                        if Task.isCancelled { return }
                        if let snapshot = try decoder.read(line) { apply(snapshot) }
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
        do { apply(try await connection.decode(Snapshot.self, "/api/state")); error = nil }
        catch { self.error = error.localizedDescription }
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
    func createTask(prompt: String, ideaId: String? = nil, requestId: String, projectId: String? = nil, agent: String = "friday", model: String? = nil, reasoningEffort: String? = nil) async throws -> String {
        var body: [String: Any] = ["prompt": prompt, "requestId": requestId]
        body["agent"] = agent
        if agent == "codex" || agent == "claude" { body["mode"] = "code" }
        if let projectId { body["projectId"] = projectId }
        if let model { body["model"] = model }; if let reasoningEffort { body["reasoningEffort"] = reasoningEffort }
        if let ideaId { body["ideaId"] = ideaId }
        let response = try await connection.decode(IDResponse.self, "/api/tasks", method: "POST", body: body)
        await refresh(); return response.id
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
