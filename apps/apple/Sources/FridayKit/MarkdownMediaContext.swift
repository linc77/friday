import SwiftUI

struct MarkdownMediaContext {
    let id: String
    var revision: String = ""
    var workspaceRoot: String? = nil
    let request: @MainActor (String) throws -> URLRequest
    var assetRequest: (@MainActor (String) throws -> URLRequest)? = nil
    var githubRequest: (@MainActor (URL) throws -> URLRequest)? = nil
    @MainActor private static func githubRequest(store: FridayStore, taskID: String) -> @MainActor (URL) throws -> URLRequest {
        let initial = try? store.connection.request("/api/task-media/github/asset-url", method: "POST")
        return { source in
            guard GitHubMediaPolicy.supports(source), var request = initial else { throw TaskMediaExportError.unavailable }
            request.httpShouldHandleCookies = false; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["taskId": taskID, "url": source.absoluteString]); return request
        }
    }
    @MainActor static func githubTask(store: FridayStore, taskID: String) -> Self {
        Self(id: store.connectionIdentity + ":github:" + taskID, request: { _ in throw TaskMediaExportError.unavailable }, githubRequest: githubRequest(store: store, taskID: taskID))
    }
    @MainActor func githubAssetURL(_ source: URL, refresh: Bool = false) async throws -> URL {
        guard let request = try githubRequest?(source) else { throw TaskMediaExportError.unavailable }
        return try await GitHubMediaAssetLoader.shared.load(request, source: source, scope: id, refresh: refresh)
    }
    @MainActor func githubImage(_ source: URL, refresh: Bool) async throws -> MarkdownMediaBytes {
        for attempt in 0...1 {
            let asset = try await githubAssetURL(source, refresh: refresh || attempt > 0)
            do { return try await MarkdownMediaLoader.shared.load(URLRequest(url: asset), scope: id, authenticated: true, refresh: refresh || attempt > 0) }
            catch { if attempt > 0 || Task.isCancelled { throw error } }
        }
        throw TaskMediaExportError.unavailable
    }
    @MainActor static func task(store: FridayStore, task: WorkItem) -> Self {
        let image = try? store.connection.request(MarkdownMediaSource.route(taskID: task.id, path: "") ?? "/invalid-media")
        let asset = try? store.connection.request("/api/task-files/asset-url", method: "POST")
        let id = store.connectionIdentity + ":" + task.id + ":" + task.cwd
        return Self(id: id, revision: (task.runs?.last?.id ?? "") + ":" + (task.runs?.last?.status ?? task.status), workspaceRoot: task.cwd, request: { path in
            guard var request = image, let url = request.url, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
            parts.queryItems = [URLQueryItem(name: "path", value: path)]; request.url = parts.url; return request
        }, assetRequest: { path in
            guard var request = asset else { throw URLError(.badURL) }; request.httpShouldHandleCookies = false
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["scope": ["taskId": task.id], "workspaceRoot": task.cwd, "path": path, "kind": "media"])
            return request
        }, githubRequest: githubRequest(store: store, taskID: task.id))
    }
    @MainActor static func assetURL(_ request: URLRequest, root: String?) async throws -> URL {
        let (data, response) = try await URLSession.shared.data(for: request, delegate: TaskMediaNoRedirect.shared)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? TaskMediaExportError.unavailable.localizedDescription) }
        let asset = try JSONDecoder().decode(TaskFileAssetURL.self, from: data)
        guard let root, asset.workspaceRoot == root, asset.url.hasPrefix("/file-assets/"), let base = request.url,
              let url = URL(string: asset.url, relativeTo: base)?.absoluteURL, url.scheme == base.scheme, url.host == base.host, url.port == base.port else { throw TaskMediaExportError.unavailable }
        return url
    }
}
private struct MarkdownMediaContextKey: EnvironmentKey { static let defaultValue: MarkdownMediaContext? = nil }
private struct MarkdownImageExpandKey: EnvironmentKey { static let defaultValue: ((MarkdownImage) -> Void)? = nil }
extension EnvironmentValues {
    var markdownMediaContext: MarkdownMediaContext? { get { self[MarkdownMediaContextKey.self] } set { self[MarkdownMediaContextKey.self] = newValue } }
    var markdownExpandImage: ((MarkdownImage) -> Void)? { get { self[MarkdownImageExpandKey.self] } set { self[MarkdownImageExpandKey.self] = newValue } }
}

private actor GitHubMediaAssetLoader {
    static let shared = GitHubMediaAssetLoader()
    private struct Entry { let url: URL; let expires: Date }
    private struct Receipt: Decodable { let url: String; let expiresAt: String; let source: String }
    private var cached: [String: Entry] = [:], order: [String] = []
    private var pending: [String: Task<Entry, Error>] = [:]
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private func fetch(_ request: URLRequest, source: URL) async throws -> Entry {
        if active < 8 { active += 1 } else { await withCheckedContinuation { waiting.append($0) } }
        defer { if waiting.isEmpty { active -= 1 } else { waiting.removeFirst().resume() } }
        let (data, response) = try await URLSession.shared.data(for: request, delegate: TaskMediaNoRedirect.shared)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? TaskMediaExportError.unavailable.localizedDescription) }
        let value = try JSONDecoder().decode(Receipt.self, from: data)
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard value.source == source.absoluteString, value.url.hasPrefix("/file-assets/github/"), let base = request.url,
              let url = URL(string: value.url, relativeTo: base)?.absoluteURL, url.scheme == base.scheme, url.host == base.host, url.port == base.port, url.user == nil, url.password == nil,
              let expires = formatter.date(from: value.expiresAt) ?? ISO8601DateFormatter().date(from: value.expiresAt) else { throw TaskMediaExportError.invalidResponse }
        return Entry(url: url, expires: expires)
    }
    func load(_ request: URLRequest, source: URL, scope: String, refresh: Bool) async throws -> URL {
        let key = scope + "\n" + source.absoluteString
        if !refresh, let saved = cached[key], saved.expires.timeIntervalSinceNow > 30 { return saved.url }
        if let task = pending[key] { return try await task.value.url }
        let task = Task { try await fetch(request, source: source) }; pending[key] = task
        do {
            let value = try await task.value; pending[key] = nil; cached[key] = value
            order.removeAll { $0 == key }; order.append(key)
            while order.count > 128 { cached.removeValue(forKey: order.removeFirst()) }
            return value.url
        } catch { pending[key] = nil; throw error }
    }
}
