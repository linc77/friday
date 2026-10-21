import Foundation

enum TaskMediaAction: String, CaseIterable { case copyFullPath, copyRelativePath, copyURL, openFile, save, copyImage }
enum TaskMediaActionKind { case image, video }
enum TaskMediaReference: Equatable {
    case file(path: String, relative: String?)
    case remote(URL)
    var tooltip: String { switch self { case .file(let path, _): path; case .remote(let url): url.absoluteString } }
    func text(for action: TaskMediaAction) -> String? {
        switch (self, action) {
        case (.file(let path, _), .copyFullPath): path
        case (.file(_, let relative), .copyRelativePath): relative
        case (.remote(let url), .copyURL): url.absoluteString
        default: nil
        }
    }
    static func file(_ path: String, root: String?) -> Self {
        let full = URL(fileURLWithPath: path).standardizedFileURL.path
        let base = root.map { URL(fileURLWithPath: $0).standardizedFileURL.path }
        let relative = base.flatMap { base -> String? in
            let prefix = base == "/" ? "/" : base + "/"
            return full.hasPrefix(prefix) ? String(full.dropFirst(prefix.count)) : nil
        }
        return .file(path: full, relative: relative?.isEmpty == false ? relative : nil)
    }
}
struct TaskMediaActionSource {
    let kind: TaskMediaActionKind; let reference: TaskMediaReference; let name: String
    let prepare: (@MainActor () async throws -> TaskMediaExportRequest)?
    var openFile: (@MainActor () -> Void)? = nil
    var actions: [TaskMediaAction] {
        var result = [TaskMediaAction.copyFullPath, .copyRelativePath, .copyURL].filter { reference.text(for: $0) != nil }
        if openFile != nil { result.append(.openFile) }; result.append(.save); if kind == .image { result.append(.copyImage) }; return result
    }
    @MainActor static func workspace(store: FridayStore, task: WorkItem, path: String, kind: TaskMediaActionKind) -> Self {
        let template = try? store.connection.request("/api/task-files/asset-url", method: "POST")
        return workspace(request: template, taskID: task.id, cwd: task.cwd, path: path, kind: kind)
    }
    @MainActor static func workspace(request: URLRequest?, taskID: String, cwd: String, path: String, kind: TaskMediaActionKind) -> Self {
        let full = TaskHostPath.absolute(path, root: cwd)
        return Self(kind: kind, reference: .file(full, root: cwd), name: URL(fileURLWithPath: path).lastPathComponent, prepare: request.map { request in
            return {
                var input = request; input.httpShouldHandleCookies = false; input.setValue("application/json", forHTTPHeaderField: "Content-Type")
                input.httpBody = try JSONSerialization.data(withJSONObject: ["scope": ["taskId": taskID], "path": path, "workspaceRoot": cwd])
                let (data, response) = try await URLSession.shared.data(for: input, delegate: TaskMediaNoRedirect.shared)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? TaskMediaExportError.unavailable.localizedDescription) }
                let asset = try JSONDecoder().decode(TaskFileAssetURL.self, from: data)
                guard asset.workspaceRoot == cwd else { throw ConnectionError.message("媒体来源无法确认，请更新服务并重新打开文件") }
                guard asset.url.hasPrefix("/file-assets/"), let base = request.url, let url = URL(string: asset.url, relativeTo: base)?.absoluteURL,
                      url.scheme == base.scheme, url.host == base.host, url.port == base.port else { throw TaskMediaExportError.unavailable }
                return TaskMediaExportRequest(request: URLRequest(url: url), publicRedirects: false)
            }
        })
    }
    @MainActor static func image(_ image: MarkdownImage, workspace: String?, context: MarkdownMediaContext?) -> Self? {
        let selected = MarkdownImageGallery.previewImage(image)
        switch MarkdownMediaSource.classify(selected.source, workspacePath: workspace) {
        case .remote(let url):
            if GitHubMediaPolicy.supports(url), let context, context.githubRequest != nil {
                return Self(kind: .image, reference: .remote(url), name: url.lastPathComponent.isEmpty ? "image" : url.lastPathComponent,
                    prepare: { TaskMediaExportRequest(request: URLRequest(url: try await context.githubAssetURL(url, refresh: true)), publicRedirects: false) })
            }
            return Self(kind: .image, reference: .remote(url), name: url.lastPathComponent.isEmpty ? "image" : url.lastPathComponent,
                prepare: { TaskMediaExportRequest(request: URLRequest(url: url), publicRedirects: true) })
        case .hostFile(let path):
            let request = try? context?.request(path)
            return Self(kind: .image, reference: .file(path, root: context?.workspaceRoot ?? workspace), name: URL(fileURLWithPath: path).lastPathComponent,
                prepare: request.map { frozen in { TaskMediaExportRequest(request: frozen, publicRedirects: false) } })
        case .blocked: return nil
        }
    }
}
enum TaskMediaExportError: LocalizedError {
    case unavailable, invalidResponse, invalidFile
    var errorDescription: String? {
        switch self {
        case .unavailable: "媒体文件暂时无法读取，请重新连接后重试"
        case .invalidResponse: "媒体下载失败，请重试"
        case .invalidFile: "链接未返回完整媒体文件，请重新加载后重试"
        }
    }
}
struct TaskMediaExportRequest: @unchecked Sendable { let request: URLRequest; let publicRedirects: Bool }
final class TaskMediaNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    static let shared = TaskMediaNoRedirect()
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
