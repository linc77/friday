import Foundation

enum MarkdownMediaSource: Hashable, Sendable {
    case remote(URL), hostFile(String), blocked
    static func classify(_ raw: String, workspacePath: String?) -> Self {
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("<"), value.hasSuffix(">") { value = String(value.dropFirst().dropLast()) }
        guard !value.isEmpty, !value.hasPrefix("#"), !value.hasPrefix("?"), !value.hasPrefix("~"),
              !value.unicodeScalars.contains(where: { [.control, .format].contains($0.properties.generalCategory) }) else { return .blocked }
        if value.hasPrefix("//") { value = "https:" + value }
        if let url = MarkdownLinkPolicy.remoteImage(value) { return .remote(url) }
        if value.lowercased().hasPrefix("file:") {
            guard let url = URL(string: value), url.scheme?.lowercased() == "file", [nil, "", "localhost"].contains(url.host?.lowercased()), !url.path.isEmpty else { return .blocked }
            let path = url.path
            guard !path.unicodeScalars.contains(where: { [.control, .format].contains($0.properties.generalCategory) }) else { return .blocked }
            return .hostFile(path)
        }
        let encoded = String(value.prefix { $0 != "?" && $0 != "#" })
        let path = encoded.removingPercentEncoding ?? encoded
        guard !path.isEmpty, !path.hasPrefix("~"), path.range(of: #"^[A-Za-z][A-Za-z0-9+.-]*:"#, options: .regularExpression) == nil,
              !path.unicodeScalars.contains(where: { [.control, .format].contains($0.properties.generalCategory) }) else { return .blocked }
        if path.hasPrefix("/") { return .hostFile(path) }
        guard let workspacePath, workspacePath.hasPrefix("/") else { return .blocked }
        return .hostFile(URL(fileURLWithPath: workspacePath, isDirectory: true).appendingPathComponent(path.replacingOccurrences(of: "\\", with: "/")).standardizedFileURL.path)
    }
    static func route(taskID: String, path: String) -> String? {
        guard let id = taskID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) else { return nil }
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "path", value: path)]
        guard let encoded = query.percentEncodedQuery else { return nil }
        return "/api/tasks/" + id + "/media?" + encoded
    }
}

struct MarkdownMediaBytes: Sendable { let data: Data; let mimeType: String? }

/// A request gets a private, memory-only session. Credentials never follow a
/// redirect; public images have neither Friday headers nor cookie storage.
final class MarkdownImageDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    static let maximumBytes = 64 * 1024 * 1024
    private let lock = NSLock()
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var continuation: CheckedContinuation<MarkdownMediaBytes, Error>?
    private var result: Result<MarkdownMediaBytes, Error>?
    private var data = Data()
    private var mimeType: String?
    private var authenticated = false

    static func load(_ request: URLRequest, authenticated: Bool) async throws -> MarkdownMediaBytes {
        let download = MarkdownImageDownload(); download.authenticated = authenticated
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in download.start(request, continuation: continuation) }
        }, onCancel: { download.finish(.failure(CancellationError())) })
    }
    private func start(_ original: URLRequest, continuation: CheckedContinuation<MarkdownMediaBytes, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return }
        self.continuation = continuation
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForResource = 60
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        var request = original; request.cachePolicy = .reloadIgnoringLocalCacheData; request.timeoutInterval = 30; request.httpShouldHandleCookies = false
        if !authenticated { request.setValue(nil, forHTTPHeaderField: "Authorization"); request.setValue(nil, forHTTPHeaderField: "Proxy-Authorization") }
        request.setValue(nil, forHTTPHeaderField: "Cookie")
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        self.session = session; let task = session.dataTask(with: request); self.task = task
        lock.unlock(); task.resume()
    }
    private func finish(_ result: Result<MarkdownMediaBytes, Error>) {
        lock.lock(); guard self.result == nil else { lock.unlock(); return }; self.result = result
        let continuation = continuation, task = task, session = session
        self.continuation = nil; self.task = nil; self.session = nil
        lock.unlock(); task?.cancel(); session?.invalidateAndCancel(); continuation?.resume(with: result)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, response.expectedContentLength <= Int64(Self.maximumBytes) else {
            completionHandler(.cancel); finish(.failure(URLError(.cannotDecodeContentData))); return
        }
        mimeType = response.mimeType?.lowercased(); completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive bytes: Data) {
        guard bytes.count <= Self.maximumBytes - data.count else { finish(.failure(URLError(.dataLengthExceedsMaximum))); return }; data.append(bytes)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
        else if data.isEmpty { finish(.failure(URLError(.zeroByteResource))) }
        else { finish(.success(MarkdownMediaBytes(data: data, mimeType: mimeType))) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard !authenticated, let raw = request.url?.absoluteString, let url = MarkdownLinkPolicy.remoteImage(raw) else { completionHandler(nil); finish(.failure(URLError(.redirectToNonExistentLocation))); return }
        var clean = URLRequest(url: url); clean.httpShouldHandleCookies = false; clean.setValue("image/*", forHTTPHeaderField: "Accept"); completionHandler(clean)
    }
}

actor MarkdownMediaLoader {
    static let shared = MarkdownMediaLoader()
    private struct Key: Hashable { let scope: String; let url: URL }
    private var cached: [Key: MarkdownMediaBytes] = [:]
    private var stamps: [Key: Date] = [:]
    private var order: [Key] = []
    private var pending: [Key: Task<MarkdownMediaBytes, Error>] = [:]
    private var bytes = 0
    private var active = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private func download(_ request: URLRequest, authenticated: Bool) async throws -> MarkdownMediaBytes {
        if active < 8 { active += 1 } else { await withCheckedContinuation { waiting.append($0) } }
        defer { if waiting.isEmpty { active -= 1 } else { waiting.removeFirst().resume() } }
        return try await MarkdownImageDownload.load(request, authenticated: authenticated)
    }
    func load(_ request: URLRequest, scope: String, authenticated: Bool, refresh: Bool = false) async throws -> MarkdownMediaBytes {
        guard let url = request.url else { throw URLError(.badURL) }
        let key = Key(scope: scope, url: url)
        if !refresh, let saved = cached[key], Date().timeIntervalSince(stamps[key] ?? .distantPast) < (authenticated ? 15 : 120) { order.removeAll { $0 == key }; order.append(key); return saved }
        if let task = pending[key] { return try await task.value }
        let task = Task { try await download(request, authenticated: authenticated) }; pending[key] = task
        do {
            let value = try await task.value; pending[key] = nil
            if let previous = cached.removeValue(forKey: key) { bytes -= previous.data.count }; order.removeAll { $0 == key }
            cached[key] = value; stamps[key] = Date(); bytes += value.data.count; order.append(key)
            while order.count > 64 || bytes > 64 * 1024 * 1024 { let removedKey = order.removeFirst(); stamps[removedKey] = nil; if let removed = cached.removeValue(forKey: removedKey) { bytes -= removed.data.count } }
            return value
        } catch { pending[key] = nil; throw error }
    }
}

// Matches T3 shared/githubMedia.ts. The server canonicalizes the actual fetch
// URL; UI references keep the original URL for copy and open actions.
enum GitHubMediaPolicy {
    static func supports(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return false }
        if ["raw.githubusercontent.com", "media.githubusercontent.com"].contains(host) { return true }
        guard ["github.com", "www.github.com"].contains(host) else { return false }
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        return [#"^/user-attachments/assets/[A-Za-z0-9_-]+$"#, #"^/[^/]+/[^/]+/assets/[0-9]+/[A-Za-z0-9_-]+$"#, #"^/[^/]+/[^/]+/(?:raw|blob)/.*[^/]$"#]
            .contains { path.range(of: $0, options: .regularExpression) != nil }
    }
}
