import Foundation

extension FridayStore {
    func uploadTaskAttachment(scope: TaskContextScope, bytes: Data, name: String, mediaType: String, id: String) async throws -> TaskContextReference {
        let server = connection.server, token = connection.token
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "id", value: id), URLQueryItem(name: "name", value: name)]
        let response = try await connection.upload("/api/task-contexts/attachments?\(scope.query)&\(query.percentEncodedQuery ?? "")", bytes: bytes, mediaType: mediaType)
        let reference = try JSONDecoder().decode(TaskContextReference.self, from: response)
        guard connection.server == server, connection.token == token else { throw ConnectionError.message("主机连接已切换") }
        struct Captured: Decodable { let snapshot: TaskContextSnapshot }
        if let captured = try? JSONDecoder().decode(Captured.self, from: response) { TaskContextCache.save(captured.snapshot, server: server, token: token) }
        return reference
    }
    func captureTaskContext(scope: TaskContextScope, input: [String: Any]) async throws -> TaskContextReference {
        let server = connection.server; let token = connection.token
        var body = input; body["scope"] = scope.body
        if body["id"] == nil { body["id"] = UUID().uuidString }
        let path=body["kind"] as? String == "preview-annotation" ? "/api/task-contexts/browser-annotation":"/api/task-contexts"
        let response = try await connection.data(path, method: "POST", body: body)
        let reference = try JSONDecoder().decode(TaskContextReference.self, from: response)
        guard connection.server == server, connection.token == token else { throw ConnectionError.message("主机连接已切换") }
        // Cache an immutable copy for previews while the client is offline.
        struct Captured: Decodable { let snapshot: TaskContextSnapshot? }
        if let captured = try? JSONDecoder().decode(Captured.self, from: response), let snapshot = captured.snapshot { TaskContextCache.save(snapshot, server: server, token: token) }
        return reference
    }
    func taskContext(_ reference: TaskContextReference, scope: TaskContextScope) async throws -> TaskContextSnapshot {
        if let draft=reference.annotationDraft {
            guard annotationDraftAllowed(draft,scope:scope) else{throw ConnectionError.message("批注不属于当前输入框")}
            let data=try JSONEncoder().encode(draft.record)
            return TaskContextSnapshot(reference:reference,cwd:draft.workspaceRoot,text:String(decoding:data,as:UTF8.self))
        }
        if let draft = reference.reviewDraft {
            guard reviewDraftAllowed(draft, scope: scope) else { throw ConnectionError.message("批注不属于当前输入框") }
            return TaskContextSnapshot(reference: reference, cwd: draft.workspaceRoot, text: draft.preview)
        }
        let server = connection.server; let token = connection.token
        if let cached = TaskContextCache.load(id: reference.id, server: server, token: token), cached.reference.digest == reference.digest { return cached }
        let value = try await connection.decode(TaskContextSnapshot.self, "/api/task-contexts/\(reference.id)?\(scope.query)")
        guard connection.server == server, connection.token == token, value.reference.digest == reference.digest else { throw ConnectionError.message("上下文引用已改变，请重新打开") }
        TaskContextCache.save(value, server: server, token: token); return value
    }
    func materializeTaskContexts(text: String, contexts: [TaskContextReference], scope: TaskContextScope) async throws -> [TaskContextReference] {
        let identity = connectionIdentity
        var result: [TaskContextReference] = []
        for reference in TaskContextDocument.used(text, records: contexts) {
            guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
            if let draft=reference.annotationDraft {
                guard annotationDraftAllowed(draft,scope:scope) else{throw ConnectionError.message("批注不属于当前输入框")}
                var input=draft.body;input["id"]=reference.id;result.append(try await captureTaskContext(scope:scope,input:input))
            } else if let draft = reference.reviewDraft {
                guard reviewDraftAllowed(draft, scope: scope) else { throw ConnectionError.message("批注不属于当前输入框") }
                var input = draft.body; input["id"] = reference.id
                result.append(try await captureTaskContext(scope: scope, input: input))
            } else { result.append(reference) }
        }
        guard connectionIdentity == identity else { throw ConnectionError.message("主机连接已切换") }
        return result
    }
    func taskComposerIdentity(_ scope: TaskContextScope) -> String { connectionIdentity + "\n" + (taskStreamSession ?? "legacy") + "\n" + scope.identity }
    private func reviewDraftAllowed(_ draft: TaskFileReviewDraft, scope: TaskContextScope) -> Bool {
        (draft.target.hasPrefix(taskComposerIdentity(scope) + "\nqueue:") || draft.target.hasPrefix(connection.server + "\n" + scope.identity + "\nqueue:")) && draft.scope == TaskFileMentionPayload.scope(server: connection.server, token: connection.token, cwd: draft.workspaceRoot, serviceId: serviceId)
    }
    private func annotationDraftAllowed(_ draft:TaskBrowserAnnotationDraft,scope:TaskContextScope)->Bool {
        (draft.target.hasPrefix(taskComposerIdentity(scope)+"\nqueue:") || draft.target.hasPrefix(connection.server+"\n"+scope.identity+"\nqueue:")) && draft.scope==TaskFileMentionPayload.scope(server:connection.server,token:connection.token,cwd:draft.workspaceRoot,serviceId:serviceId)
    }
}
