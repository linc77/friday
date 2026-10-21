import Foundation

struct TaskGitQuickAction {
    let title: String; let action: String?; let enabled: Bool
    var openPR = false
    var hint: String? = nil
}

// T3 Code's GitActionsControl: current changes, divergence, upstream and PR
// state determine the primary action. Menu actions remain independently usable.
enum TaskGitPresentation {
    static func title(_ action: String, provider: String? = nil) -> String {
        if provider == "gitlab" {
            switch action { case "create_pr": return "推送并创建 MR"; case "commit_push_pr": return "提交、推送并创建 MR"; default: break }
        }
        return titleDefault(action)
    }
    private static func titleDefault(_ action: String) -> String {
        switch action {
        case "commit": "提交"
        case "push": "推送"
        case "pull": "拉取"
        case "create_pr": "推送并创建 PR"
        case "commit_push": "提交并推送"
        case "commit_push_pr": "提交、推送并创建 PR"
        case "publish_repository": "发布新仓库"
        default: "Git"
        }
    }
    static func phase(_ phase: String, provider: String? = nil) -> String {
        if provider == "gitlab" {
            switch phase { case "generate_pr": return "正在生成 MR 说明"; case "pr": return "正在创建 MR"; default: break }
        }
        return phaseDefault(phase)
    }
    private static func phaseDefault(_ phase: String) -> String {
        switch phase {
        case "queued": "等待 Git 操作"
        case "generate_commit": "正在生成提交说明"
        case "branch": "正在创建分支"
        case "commit": "正在提交"
        case "push": "正在推送"
        case "prepare_pr": "正在读取 PR／MR 目标分支"
        case "generate_pr": "正在生成 PR 说明"
        case "pr": "正在创建 PR"
        case "pull": "正在拉取"
        case "create_repository": "正在创建远端仓库"
        case "add_remote": "正在添加远端"
        case "publish_push": "正在首次推送"
        default: "正在执行 Git 操作"
        }
    }
    static func publishes(_ action: String) -> Bool { ["push", "create_pr", "commit_push", "commit_push_pr"].contains(action) }
    static func commits(_ action: String) -> Bool { ["commit", "commit_push", "commit_push_pr"].contains(action) }
    static func createsPR(_ action: String) -> Bool { action == "create_pr" || action == "commit_push_pr" }
    static func quick(_ status: TaskGitStatus?, busy: Bool) -> TaskGitQuickAction {
        guard !busy else { return TaskGitQuickAction(title: "提交", action: nil, enabled: false, hint: "Git 操作正在进行") }
        guard let status, status.status == "repository" else { return TaskGitQuickAction(title: "提交", action: nil, enabled: false, hint: "正在读取 Git 状态") }
        guard status.branch != nil else { return TaskGitQuickAction(title: "提交", action: nil, enabled: false, hint: "请先创建并切换到一个本地分支") }
        let hasPR = status.pullRequest?.state == "open"
        let provider = status.sourceControl?.provider
        if !status.files.isEmpty {
            if status.remote == nil { return TaskGitQuickAction(title: title("commit"), action: "commit", enabled: true) }
            let action = hasPR || status.isDefaultBranch ? "commit_push" : "commit_push_pr"
            return TaskGitQuickAction(title: title(action, provider: provider), action: action, enabled: !createsPR(action) || status.canCreatePR == true, hint: createsPR(action) && status.canCreatePR != true ? "请检查仓库平台认证和登录状态" : nil)
        }
        if status.upstream == nil {
            guard status.remote != nil else { return TaskGitQuickAction(title: "发布新仓库", action: "publish_repository", enabled: true) }
            guard status.ahead > 0 else { return TaskGitQuickAction(title: hasPR ? "提交" : "推送", action: nil, enabled: false, hint: "分支已是最新状态") }
            let action = status.isDefaultBranch ? "commit_push" : hasPR ? "push" : "create_pr"
            return TaskGitQuickAction(title: action == "commit_push" ? "推送" : title(action, provider: provider), action: action, enabled: !createsPR(action) || status.canCreatePR == true, hint: createsPR(action) && status.canCreatePR != true ? "请检查仓库平台认证和登录状态" : nil)
        }
        if status.ahead > 0 && status.behind > 0 { return TaskGitQuickAction(title: "同步分支", action: nil, enabled: false, hint: "分支已分叉，请先合并或变基") }
        if status.behind > 0 { return TaskGitQuickAction(title: "拉取", action: "pull", enabled: true) }
        if status.ahead > 0 {
            let action = status.isDefaultBranch ? "commit_push" : hasPR ? "push" : "create_pr"
            return TaskGitQuickAction(title: action == "commit_push" ? "推送" : title(action, provider: provider), action: action, enabled: !createsPR(action) || status.canCreatePR == true, hint: createsPR(action) && status.canCreatePR != true ? "请检查仓库平台认证和登录状态" : nil)
        }
        if !hasPR && !status.isDefaultBranch && status.aheadOfDefault > 0 {
            return TaskGitQuickAction(title: provider == "gitlab" ? "创建 MR" : "创建 PR", action: "create_pr", enabled: status.canCreatePR == true, hint: status.canCreatePR == true ? nil : "请检查仓库平台认证和登录状态")
        }
        return TaskGitQuickAction(title: "提交", action: nil, enabled: false, hint: "分支已是最新状态")
    }
}

struct TaskRepositoryPublishDraft {
    var provider = "github"
    var host: String? = nil
    var baseURL: String? = nil
    var repository = ""
    var visibility = "private"
    var remoteName = "origin"
    var transport = "ssh"
    func valid(account: String?, credentialFingerprint: String? = nil) -> Bool {
        guard let account, !account.isEmpty, ["github", "gitlab", "bitbucket", "forgejo", "gitcafe", "azure-devops"].contains(provider), ["private", "public"].contains(visibility), ["ssh", "https"].contains(transport) else { return false }
        if ["bitbucket", "forgejo", "gitcafe", "azure-devops"].contains(provider), credentialFingerprint?.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) == nil { return false }
        if provider == "forgejo", baseURL == nil { return false }
        let parts = repository.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "/")
        if provider == "azure-devops" {
            guard parts.count == 3, parts[0].range(of: #"^[A-Za-z0-9][A-Za-z0-9_-]*$"#, options: .regularExpression) != nil,
                  parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\") && $0.rangeOfCharacter(from: .controlCharacters) == nil }) else { return false }
        } else {
            guard parts.count >= 2, provider == "gitlab" || parts.count == 2 else { return false }
            guard parts.allSatisfy({ $0.range(of: #"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"#, options: .regularExpression) != nil && $0 != "." && $0 != ".." && !$0.hasSuffix(".git") }) else { return false }
        }
        let remote = remoteName.trimmingCharacters(in: .whitespacesAndNewlines)
        return repository.count <= 500 && (remote.isEmpty || remote.range(of: #"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$"#, options: .regularExpression) != nil && remote != "HEAD" && !remote.hasSuffix(".") && !remote.contains(".."))
    }
    func body(review: TaskGitStatus, account: String, requestID: String, credentialFingerprint: String? = nil) -> [String: Any] {
        let remote = remoteName.trimmingCharacters(in: .whitespacesAndNewlines)
        var publication = ["provider": provider, "repository": repository.trimmingCharacters(in: .whitespacesAndNewlines), "visibility": visibility,
                           "remoteName": remote.isEmpty ? "origin" : remote, "protocol": transport, "account": account]
        if let host { publication["host"] = host }
        if let baseURL { publication["baseURL"] = baseURL }
        if let credentialFingerprint { publication["credentialFingerprint"] = credentialFingerprint }
        return ["requestId": requestID, "action": "publish_repository", "fingerprint": review.fingerprint, "repositoryPublish": publication]
    }
}
