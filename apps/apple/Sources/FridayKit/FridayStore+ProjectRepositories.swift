import Foundation

extension FridayStore {
    private func projectRepositoryIdentity() throws -> String {
        let identity = connectionIdentity
        guard connected, snapshotIdentity == identity, projectRepositoryOperationsSupported else { throw ConnectionError.message("主机尚未就绪，请连接后重试项目操作") }
        return identity
    }
    func projectRepositoryProviders() async throws -> [TaskPublishProvider] {
        let identity = try projectRepositoryIdentity()
        let result = try await connection.decode(TaskPublishProvidersResponse.self, "/api/project-repositories/providers")
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        return result.providers
    }
    func lookupCloneRepository(_ body: [String: Any]) async throws -> CloneRepositoryInfo {
        let identity = try projectRepositoryIdentity()
        let result = try await connection.decode(CloneRepositoryInfo.self, "/api/project-repositories/lookup", method: "POST", body: body)
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        return result
    }
    func cloneProject(_ body: [String: Any]) async throws -> Project {
        let identity = try projectRepositoryIdentity()
        let result = try await connection.decode(ProjectCloneStartResponse.self, "/api/projects/clone", method: "POST", body: body)
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        guard let project = projects.first(where: { $0.id == result.projectId }) else { throw ConnectionError.message("克隆已开始，等待 Workspace 同步后再打开") }
        return project
    }
    func publishNewProject(_ project: Project, provider: TaskPublishProvider, requestID: String) async throws {
        guard let account = provider.account, provider.status == "ready", ["github", "gitlab", "forgejo", "gitcafe"].contains(provider.provider) else { throw ConnectionError.message("请刷新仓库平台的登录状态") }
        let folder = project.path.replacingOccurrences(of: "\\", with: "/").split(separator: "/").last.map(String.init) ?? ""
        var body: [String: Any] = ["requestId": requestID, "provider": provider.provider, "host": provider.host, "account": account, "repository": account + "/" + folder, "visibility": "private", "protocol": "ssh", "remoteName": "origin"]
        if let fingerprint = provider.credentialFingerprint { body["credentialFingerprint"] = fingerprint }
        if let base = provider.baseURL { body["baseURL"] = base }
        let identity = try projectRepositoryIdentity()
        _ = try await connection.decode(ProjectRepositoryOperationResponse.self, "/api/projects/\(project.id)/publish", method: "POST", body: body)
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
    }
    func cancelProjectClone(_ project: Project) async throws {
        guard let clone = project.clone else { return }
        let identity = try projectRepositoryIdentity()
        _ = try await connection.data("/api/projects/\(project.id)/repository-operations/\(clone.operationId)/cancel", method: "POST", body: [:])
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
    }
    func retryProjectClone(_ project: Project, requestID: String) async throws {
        guard let clone = project.clone else { return }
        let identity = try projectRepositoryIdentity()
        _ = try await connection.decode(ProjectRepositoryOperationResponse.self, "/api/projects/\(project.id)/clone/\(clone.operationId)/retry", method: "POST", body: ["requestId": requestID])
        guard identity == connectionIdentity else { throw ConnectionError.message("主机连接已切换") }
        await refresh()
    }
}
