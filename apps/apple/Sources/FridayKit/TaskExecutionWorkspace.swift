import Foundation

struct TaskWorkspaceSelection: Equatable, Codable {
    var mode = "checkout"
    var branch: String? = nil
    var title: String { mode == "worktree" ? "New Worktree" : "当前工作区" }
    mutating func selectMode(_ value: String) {
        mode = value
        if value == "checkout", branch?.hasPrefix("refs/remotes/") == true { branch = nil }
    }
    var body: [String: Any] {
        var value: [String: Any] = ["mode": mode]
        if let branch { value["branch"] = branch }
        return value
    }
    func branchName(in options: TaskWorkspaceOptions?) -> String {
        if let branch { return options?.branches.first { $0.ref == branch }?.name ?? branch.replacingOccurrences(of: "refs/heads/", with: "").replacingOccurrences(of: "refs/remotes/", with: "") }
        return TaskRowPresentation.branch(options?.git)
    }
    func resolved(in options: TaskWorkspaceOptions?) -> Self {
        // A saved Git choice must not block a draft once its directory is no
        // longer a repository and the controls for that choice are hidden.
        options?.git.status == "not_repository" ? Self() : self
    }
    func isValid(in options: TaskWorkspaceOptions) -> Bool {
        if options.git.status == "not_repository" { return mode == "checkout" && branch == nil }
        guard options.git.status == "repository", mode != "worktree" || options.hasCommit else { return false }
        guard let branch else { return true }
        return options.branches.contains { $0.ref == branch && (mode == "worktree" || !$0.remote) }
    }
}

struct TaskWorkspaceOptions: Decodable {
    struct Branch: Decodable, Identifiable {
        let ref: String; let name: String; let remote: Bool
        var id: String { ref }
    }
    let git: TaskGitContext
    let branches: [Branch]
    let hasCommit: Bool

    func validationMessage(for selection: TaskWorkspaceSelection) -> String? {
        let selection = selection.resolved(in: self)
        guard !selection.isValid(in: self) else { return nil }
        guard git.status == "repository" else {
            return "无法读取 Workspace 信息，请确认目录可用后重试。"
        }
        if selection.mode == "worktree" && !hasCommit {
            return "首次提交后可创建 New Worktree。"
        }
        return "所选分支不可用，请重新选择。"
    }
}
