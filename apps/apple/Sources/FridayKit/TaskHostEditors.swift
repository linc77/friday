import Foundation
import Combine

struct TaskHostEditor: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let label: String
    var symbol: String { id == "file-manager" ? "folder" : "chevron.left.forwardslash.chevron.right" }
    static func preferred(_ stored: String, in editors: [Self]) -> Self? { editors.first { $0.id == stored } ?? editors.first }
}
struct TaskHostEditorSnapshot: Decodable, Sendable {
    let workspaceRoot: String
    let platform: String
    let revealSupported: Bool
    let editors: [TaskHostEditor]
}
struct TaskHostEditorAction: Sendable {
    let path: String
    let editor: String
    var reveal = false
    var line: Int? = nil
    var column: Int? = nil
}
struct TaskHostEditorTransport: Sendable {
    let load: @Sendable () async throws -> TaskHostEditorSnapshot
    let open: @Sendable (TaskHostEditorAction) async throws -> Void
    @MainActor static func task(store: FridayStore, task: WorkItem) throws -> Self {
        let root = task.cwd, scope = TaskContextScope(taskID: task.id)
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "workspaceRoot", value: root)]
        let list = try store.connection.request("/api/task-files/editors?" + scope.query + "&" + (query.percentEncodedQuery ?? ""))
        let template = try store.connection.request("/api/task-files/open")
        return Self(load: {
            let snapshot = try JSONDecoder().decode(TaskHostEditorSnapshot.self, from: await send(list))
            guard snapshot.workspaceRoot == root else { throw ConnectionError.message("文件所属工作区已改变，请重新打开文件") }
            return snapshot
        }, open: { action in
            var request = template; request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body: [String: Any] = ["scope": scope.body, "workspaceRoot": root, "path": action.path, "editor": action.editor, "reveal": action.reveal]
            if let line = action.line { body["line"] = line }; if let column = action.column { body["column"] = column }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            struct Reply: Decodable { let opened: Bool; let workspaceRoot: String; let editor: String }
            let reply = try JSONDecoder().decode(Reply.self, from: await send(request))
            guard reply.opened, reply.workspaceRoot == root, reply.editor == action.editor else { throw ConnectionError.message("主机未确认打开文件，请检查后重试") }
        })
    }
    private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }
    private static func send(_ request: URLRequest) async throws -> Data {
        let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = request; request.timeoutInterval = 15
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "无法读取主机打开方式")
        }
        return data
    }
}

@MainActor final class TaskHostEditorModel: ObservableObject {
    @Published private(set) var snapshot: TaskHostEditorSnapshot?
    @Published private(set) var loading = false
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    private var identity = ""
    private var epoch = UUID()
    private var transport: TaskHostEditorTransport?
    func load(identity: String, root: String, transport: TaskHostEditorTransport) async {
        let token = UUID(); epoch = token; self.identity = identity; self.transport = transport
        snapshot = nil; error = nil; loading = true; busy = false
        do {
            let value = try await transport.load()
            guard !Task.isCancelled, epoch == token else { return }
            guard value.workspaceRoot == root else { throw ConnectionError.message("文件所属工作区已改变，请重新打开文件") }
            snapshot = value
        } catch { if !Task.isCancelled, epoch == token { self.error = error.localizedDescription } }
        if epoch == token { loading = false }
    }
    @discardableResult func open(_ action: TaskHostEditorAction, identity: String) -> Task<Void, Never>? {
        guard self.identity == identity, snapshot?.editors.contains(where: { $0.id == action.editor }) == true, !busy, let transport else { return nil }
        let token = epoch; busy = true; error = nil
        return Task {
            do { try await transport.open(action) }
            catch { if epoch == token { self.error = error.localizedDescription } }
            if epoch == token { busy = false }
        }
    }
}
