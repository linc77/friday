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
    @Published var error: String?
    @Published var outbox: [OutboxIdea] = []
    let connection = Connection()
    private var streamTask: Task<Void, Never>?
    private var flushing = false
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
    }
    func connect() async {
        streamTask?.cancel(); connected = false
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
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        guard text.utf16.count <= 12_000 else { error = "想法太长，请缩短到 12,000 字以内再保存。"; return false }
        outbox.append(OutboxIdea(id: UUID().uuidString, text: text))
        persistOutbox(); await flushOutbox()
        return true
    }
    private func persistOutbox() { UserDefaults.standard.set(try? JSONEncoder().encode(outbox), forKey: "friday.outbox") }
    func flushOutbox() async {
        guard !flushing, connected else { return }; flushing = true; defer { flushing = false }
        while let idea = outbox.first {
            do {
                _ = try await connection.data("/api/ideas", method: "POST", body: ["id": idea.id, "text": idea.text])
                outbox.removeAll { $0.id == idea.id }; persistOutbox()
            } catch { self.error = error.localizedDescription; break }
        }
        await refresh()
    }
    func perform(_ path: String, method: String = "POST", body: [String: Any] = [:]) async -> Bool {
        do { _ = try await connection.data(path, method: method, body: method == "DELETE" ? nil : body); await refresh(); return true }
        catch { self.error = error.localizedDescription; return false }
    }
    func createTask(prompt: String, projectId: String, mode: String, ideaId: String?, requestId: String) async throws -> String {
        var body: [String: Any] = ["prompt": prompt, "mode": mode, "projectId": projectId.isEmpty ? NSNull() : projectId, "requestId": requestId, "agent": "friday"]
        if let ideaId { body["ideaId"] = ideaId }
        let response = try await connection.decode(IDResponse.self, "/api/tasks", method: "POST", body: body)
        await refresh(); return response.id
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
