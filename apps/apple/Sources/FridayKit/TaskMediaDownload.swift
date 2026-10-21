import Foundation
import UniformTypeIdentifiers

struct TaskMediaDownloadedFile: Sendable {
    let directory: URL; let url: URL; let mimeType: String
    func remove() { try? FileManager.default.removeItem(at: directory) }
}
/// Full files go to disk, without the image preview's in-memory size limit.
final class TaskMediaDownload: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<TaskMediaDownloadedFile, Error>?
    private var task: URLSessionDownloadTask?, session: URLSession?
    private var result: Result<TaskMediaDownloadedFile, Error>?
    private var root: URL?
    private var parent = FileManager.default.temporaryDirectory
    private var publicRedirects = false, redirects = 0
    private var progress: @Sendable (Double?) -> Void = { _ in }
    static func load(_ input: TaskMediaExportRequest, temporaryDirectory: URL? = nil, progress: @escaping @Sendable (Double?) -> Void = { _ in }) async throws -> TaskMediaDownloadedFile {
        let download = TaskMediaDownload(); download.publicRedirects = input.publicRedirects; download.progress = progress
        if let temporaryDirectory { download.parent = temporaryDirectory }
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { download.start(input.request, continuation: $0) }
        }, onCancel: { download.finish(.failure(CancellationError())) })
    }
    private func start(_ original: URLRequest, continuation: CheckedContinuation<TaskMediaDownloadedFile, Error>) {
        lock.lock()
        if let result { lock.unlock(); continuation.resume(with: result); return }
        self.continuation = continuation
        do {
            guard Self.validURL(original.url) else { throw TaskMediaExportError.unavailable }
            let root = parent.appendingPathComponent("friday-media-export-" + UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]); self.root = root
            var request = original; request.httpShouldHandleCookies = false; request.cachePolicy = .reloadIgnoringLocalCacheData
            let config = URLSessionConfiguration.ephemeral; config.httpCookieStorage = nil; config.urlCache = nil; config.urlCredentialStorage = nil
            config.timeoutIntervalForRequest = 60
            let session = URLSession(configuration: config, delegate: self, delegateQueue: nil); self.session = session
            let task = session.downloadTask(with: request); self.task = task; lock.unlock(); task.resume()
        } catch { lock.unlock(); finish(.failure(error)) }
    }
    private static func validURL(_ url: URL?) -> Bool {
        guard let url else { return false }; return ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil && url.user == nil && url.password == nil
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock(); redirects += 1; let allowed = publicRedirects && redirects <= 20 && result == nil; lock.unlock()
        guard allowed, Self.validURL(request.url), response.url?.scheme != "https" || request.url?.scheme == "https" else { completionHandler(nil); return }
        var next = request; next.httpShouldHandleCookies = false; next.setValue(nil, forHTTPHeaderField: "Authorization"); next.setValue(nil, forHTTPHeaderField: "Cookie")
        completionHandler(next)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        progress(totalBytesExpectedToWrite > 0 ? min(1, Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)) : nil)
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        lock.lock()
        guard result == nil, let root else { lock.unlock(); return }
        do {
            guard let response = downloadTask.response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else { throw TaskMediaExportError.invalidResponse }
            let mime = response.mimeType?.lowercased() ?? "application/octet-stream"
            guard mime != "text/html" else { throw TaskMediaExportError.invalidFile }
            let size = (try FileManager.default.attributesOfItem(atPath: location.path)[.size] as? NSNumber)?.int64Value
            let encoding = response.value(forHTTPHeaderField: "Content-Encoding")?.lowercased()
            guard let size, encoding != nil && encoding != "identity" || response.expectedContentLength < 0 || size == response.expectedContentLength else { throw TaskMediaExportError.invalidFile }
            let url = root.appendingPathComponent("original")
            try FileManager.default.moveItem(at: location, to: url); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            let file = TaskMediaDownloadedFile(directory: root, url: url, mimeType: mime); lock.unlock(); finish(.success(file))
        } catch { lock.unlock(); finish(.failure(error)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) }
    }
    private func finish(_ value: Result<TaskMediaDownloadedFile, Error>) {
        lock.lock()
        guard result == nil else { lock.unlock(); if case .success(let file) = value { file.remove() }; return }
        result = value; let continuation = continuation; self.continuation = nil
        let session = session; self.session = nil; self.task = nil; let root = root; self.root = nil; lock.unlock()
        session?.invalidateAndCancel()
        if case .failure = value, let root { try? FileManager.default.removeItem(at: root) }
        continuation?.resume(with: value)
    }
}

enum TaskMediaExportFile {
    static func name(_ name: String, mimeType: String) -> String {
        let leaf = name.split(separator: "/", omittingEmptySubsequences: true).last.map(String.init) ?? "media"
        let clean = leaf.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }.map(String.init).joined()
        let name = clean.isEmpty || clean == "." || clean == ".." ? "media" : clean
        if URL(fileURLWithPath: name).pathExtension.isEmpty, let suffix = UTType(mimeType: mimeType)?.preferredFilenameExtension { return name + "." + suffix }
        return name
    }
    static func install(_ file: TaskMediaDownloadedFile, at destination: URL) throws {
        guard destination.isFileURL else { throw TaskMediaExportError.invalidFile }
        let access = destination.startAccessingSecurityScopedResource(); defer { if access { destination.stopAccessingSecurityScopedResource() } }
        let manager = FileManager.default, staging = destination.deletingLastPathComponent().appendingPathComponent(".friday-export-" + UUID().uuidString)
        defer { try? manager.removeItem(at: staging) }
        try manager.copyItem(at: file.url, to: staging)
        if manager.fileExists(atPath: destination.path) { _ = try manager.replaceItemAt(destination, withItemAt: staging) }
        else { try manager.moveItem(at: staging, to: destination) }
    }
}
