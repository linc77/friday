import Foundation
extension FridayStore {
    func taskReviewGuide(_ id: String, url: String) async throws -> TaskReviewGuideResponse {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "url", value: url)]
        return try await connection.decode(TaskReviewGuideResponse.self, "/api/tasks/\(id)/change-request/guide?\(query.percentEncodedQuery ?? "")")
    }
    func taskReviewGuideStatus(_ id: String, url: String) async throws -> TaskReviewGuideStatusResponse {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "url", value: url)]
        return try await connection.decode(TaskReviewGuideStatusResponse.self, "/api/tasks/\(id)/change-request/guide/status?\(query.percentEncodedQuery ?? "")")
    }
    func generateTaskReviewGuide(_ id: String, url: String, head: String, requestID: String) async throws -> String {
        var request = try connection.request("/api/tasks/\(id)/change-request/guide", method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["url": url, "expectedHeadSha": head, "requestId": requestID])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ConnectionError.message("服务暂时无法响应") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data).error) ?? "服务暂时无法响应"
            if (400..<500).contains(http.statusCode) || http.statusCode == 503 { throw TaskChangeRequestRejection(message: message) }
            throw ConnectionError.message(message)
        }
        return try JSONDecoder().decode(IDResponse.self, from: data).id
    }
    func captureReviewGuideContext(_ id: String, url: String, guide: TaskReviewGuide, stop: Int) async throws -> TaskContextReference {
        try await connection.decode(TaskContextReference.self, "/api/tasks/\(id)/change-request/guide/context", method: "POST", body: ["url": url, "headSha": guide.headSha, "generatedAt": guide.generatedAt, "stop": stop])
    }
    func cancelTaskReviewGuide(_ id: String, url: String, runID: String) async throws {
        _ = try await connection.data("/api/tasks/\(id)/change-request/guide/cancel", method: "POST", body: ["url": url, "id": runID])
    }
}
