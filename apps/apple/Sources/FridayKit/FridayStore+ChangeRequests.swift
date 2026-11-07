import Foundation

struct TaskChangeRequestRejection: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

extension FridayStore {
    func openTaskChangeRequestView(_ id: String, reference: String) async throws -> String {
        struct Opened: Decodable { let url: String }
        return try await connection.decode(Opened.self, "/api/tasks/\(id)/change-request/open", method: "POST", body: ["reference": reference]).url
    }
    func taskChangeRequestLinks(_ id: String) async throws -> TaskChangeRequestLinksResponse {
        try await connection.decode(TaskChangeRequestLinksResponse.self, "/api/tasks/\(id)/change-request/links")
    }
    func changeTaskChangeRequestLink(_ id: String, submission: TaskChangeRequestLinkSubmission) async throws -> TaskChangeRequestLinkResult {
        try await connection.decode(TaskChangeRequestLinkResult.self, "/api/tasks/\(id)/change-request/\(submission.linked ? "link" : "unlink")", method: "POST", body: submission.body)
    }
    private func changeRequestQuery(_ url: String) -> String {
        var components = URLComponents(); components.queryItems = [URLQueryItem(name: "url", value: url)]; return components.percentEncodedQuery ?? ""
    }
    func taskChangeRequest(_ id: String, url: String, refresh: Bool = false) async throws -> TaskChangeRequestDetail {
        try await connection.decode(TaskChangeRequestDetail.self, "/api/tasks/\(id)/change-request?\(changeRequestQuery(url))\(refresh ? "&refresh=true" : "")")
    }
    func taskChangeRequestChecks(_ id: String, url: String) async throws -> TaskChangeRequestChecks {
        try await connection.decode(TaskChangeRequestChecks.self, "/api/tasks/\(id)/change-request/checks?\(changeRequestQuery(url))")
    }
    func taskChangeRequestStack(_ id: String, url: String) async throws -> TaskChangeRequestStackResponse {
        try await connection.decode(TaskChangeRequestStackResponse.self, "/api/tasks/\(id)/change-request/stack?\(changeRequestQuery(url))")
    }
    func openTaskStackLayer(_ id: String, url: String, number: Int, stackNumber: Int) async throws -> String {
        try await connection.decode(TaskStackOpenResponse.self, "/api/tasks/\(id)/change-request/stack/open", method: "POST", body: ["url": url, "number": number, "stackNumber": stackNumber]).url
    }
    func taskChangeRequestFileContents(_ id: String, url: String, target: TaskChangeRequestFileTarget, side: String) async throws -> TaskChangeRequestFileContents {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "url", value: url), URLQueryItem(name: "path", value: target.path), URLQueryItem(name: "head", value: target.head), URLQueryItem(name: "side", value: side)]
        if let commit = target.commit { query.queryItems?.append(URLQueryItem(name: "commit", value: commit)) }
        if let base = target.base { query.queryItems?.append(URLQueryItem(name: "base", value: base)) }
        if let cursor = target.diffCursor { query.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        if target.usesDiffSlices { query.queryItems?.append(URLQueryItem(name: "slice", value: "true")) }
        return try await connection.decode(TaskChangeRequestFileContents.self, "/api/tasks/\(id)/change-request/file-contents?\(query.percentEncodedQuery ?? "")", timeout: 65)
    }
    func taskChangeRequestCommit(_ id: String, url: String, sha: String) async throws -> TaskChangeRequestCommitResponse {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "sha", value: sha)]
        return try await connection.decode(TaskChangeRequestCommitResponse.self, "/api/tasks/\(id)/change-request/commit?\(changeRequestQuery(url))&\(query.percentEncodedQuery ?? "")")
    }
    func taskChangeRequestActivity(_ id: String, url: String) async throws -> TaskChangeRequestActivityResponse {
        try await connection.decode(TaskChangeRequestActivityResponse.self, "/api/tasks/\(id)/change-request/activity?\(changeRequestQuery(url))")
    }
    func taskChangeRequestThreadComments(_ id: String, url: String, threadID: String, cursor: String) async throws -> TaskChangeRequestThreadComments {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "threadId", value: threadID), URLQueryItem(name: "cursor", value: cursor)]
        return try await connection.decode(TaskChangeRequestThreadComments.self, "/api/tasks/\(id)/change-request/thread-comments?\(changeRequestQuery(url))&\(query.percentEncodedQuery ?? "")")
    }
    func taskChangeRequestReviewers(_ id: String, url: String) async throws -> TaskReviewerCandidates {
        try await connection.decode(TaskReviewerCandidates.self, "/api/tasks/\(id)/change-request/reviewers?\(changeRequestQuery(url))")
    }
    func taskChangeRequestLabels(_ id: String, url: String) async throws -> TaskLabelCandidates {
        try await connection.decode(TaskLabelCandidates.self, "/api/tasks/\(id)/change-request/labels?\(changeRequestQuery(url))")
    }
    func taskChangeRequestViewedFiles(_ id: String, url: String) async throws -> TaskFilesViewedResponse {
        try await connection.decode(TaskFilesViewedResponse.self, "/api/tasks/\(id)/change-request/viewed-files?\(changeRequestQuery(url))")
    }
    func taskChangeRequestReactions(_ id: String, url: String) async throws -> TaskReviewReactions {
        try await connection.decode(TaskReviewReactions.self, "/api/tasks/\(id)/change-request/reactions?\(changeRequestQuery(url))")
    }
    func taskChangeRequestFiles(_ id: String, url: String, head: String) async throws -> TaskChangeRequestFiles {
        try await connection.decode(TaskChangeRequestFiles.self, "/api/tasks/\(id)/change-request/files?\(changeRequestQuery(url))&head=\(head)")
    }
    func taskChangeRequestDiffSlice(_ id: String, url: String, head: String, base: String?, commit: String?, cursor: String?) async throws -> TaskChangeRequestFiles {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "url", value: url), URLQueryItem(name: "head", value: head)]
        for (name, value) in [("base", base), ("commit", commit), ("cursor", cursor)] { if let value { query.queryItems?.append(URLQueryItem(name: name, value: value)) } }
        return try await connection.decode(TaskChangeRequestFiles.self, "/api/tasks/\(id)/change-request/diff?\(query.percentEncodedQuery ?? "")", timeout: 65)
    }
    func startTaskChangeRequestOperation(_ id: String, body: [String: Any]) async throws -> String {
        let route = body["stackNumber"] == nil ? "operations" : "stack/operations"
        let request = try connection.request("/api/tasks/\(id)/change-request/\(route)", method: "POST", body: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ConnectionError.message("服务暂时无法响应") }
        if !(200..<300).contains(http.statusCode) {
            let message = (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "服务暂时无法响应"
            if (400..<500).contains(http.statusCode) || http.statusCode == 503 { throw TaskChangeRequestRejection(message: message) }
            throw ConnectionError.message(message)
        }
        return try JSONDecoder().decode(IDResponse.self, from: data).id
    }
    func taskChangeRequestOperation(_ id: String, operationID: String) async throws -> TaskChangeRequestOperation {
        try await connection.decode(TaskChangeRequestOperation.self, "/api/tasks/\(id)/change-request/operations/\(operationID)")
    }
    func taskChangeRequestOperations(_ id: String, url: String) async throws -> [TaskChangeRequestOperation] {
        try await connection.decode(TaskChangeRequestOperations.self, "/api/tasks/\(id)/change-request/operations?\(changeRequestQuery(url))").operations
    }
}
