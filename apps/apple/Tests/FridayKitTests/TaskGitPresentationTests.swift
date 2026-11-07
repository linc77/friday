import Foundation

@main
struct TaskGitPresentationTests {
    static func status(files: Bool = false, branch: String? = "feature", remote: String? = "origin", upstream: String? = "origin/feature", ahead: Int = 0, behind: Int = 0, delta: Int = 0, isDefault: Bool = false, pr: Bool = false, canPR: Bool = true, provider: String? = nil) -> TaskGitStatus {
        var value: [String: Any] = ["status": "repository", "cwd": "/project", "branch": branch as Any? ?? NSNull(), "head": "abc", "remote": remote as Any? ?? NSNull(),
                                    "defaultBranch": "main", "isDefaultBranch": isDefault, "upstream": upstream as Any? ?? NSNull(), "ahead": ahead, "behind": behind, "aheadOfDefault": delta, "fingerprint": "review", "canCreatePR": canPR,
                                    "files": files ? [["path": "src/file.swift", "kind": "update", "staged": false, "unstaged": true, "additions": 2, "deletions": 1, "binary": false]] : []]
        if pr { value["pullRequest"] = ["number": 42, "url": "https://github.com/fixture/repo/pull/42", "title": "Fixture", "state": "open", "base": "main", "head": branch ?? "feature"] }
        if let provider { value["sourceControl"] = ["provider": provider, "host": provider == "gitlab" ? "gitlab.com" : "github.com", "path": "fixture/project"] }
        return try! JSONDecoder().decode(TaskGitStatus.self, from: JSONSerialization.data(withJSONObject: value))
    }
    static func main() throws {
        precondition(!TaskGitPresentation.quick(nil, busy: false).enabled)
        precondition(!TaskGitPresentation.quick(status(files: true), busy: true).enabled)
        precondition(TaskGitPresentation.quick(status(files: true, remote: nil, upstream: nil), busy: false).action == "commit")
        precondition(TaskGitPresentation.quick(status(remote: nil, upstream: nil), busy: false).action == "publish_repository")
        precondition(!TaskGitPresentation.quick(status(branch: nil, remote: nil, upstream: nil), busy: false).enabled)
        precondition(TaskGitPresentation.quick(status(files: true, isDefault: true), busy: false).action == "commit_push")
        precondition(TaskGitPresentation.quick(status(files: true), busy: false).action == "commit_push_pr")
        precondition(TaskGitPresentation.quick(status(files: true, pr: true), busy: false).action == "commit_push")
        precondition(!TaskGitPresentation.quick(status(branch: nil), busy: false).enabled)
        precondition(TaskGitPresentation.quick(status(ahead: 1, isDefault: true), busy: false).action == "commit_push")
        precondition(TaskGitPresentation.quick(status(ahead: 1, pr: true), busy: false).action == "push")
        precondition(TaskGitPresentation.quick(status(ahead: 1), busy: false).action == "create_pr")
        precondition(TaskGitPresentation.quick(status(behind: 1), busy: false).action == "pull")
        precondition(!TaskGitPresentation.quick(status(ahead: 1, behind: 1), busy: false).enabled)
        precondition(TaskGitPresentation.quick(status(delta: 1), busy: false).action == "create_pr", "A pushed feature branch can still need its first PR")
        precondition(!TaskGitPresentation.quick(status(pr: true), busy: false).enabled, "An up-to-date existing PR is viewed from the menu, not published again")
        precondition(!TaskGitPresentation.quick(status(files: true, canPR: false), busy: false).enabled)
        precondition(TaskGitPresentation.quick(status(files: true, provider: "gitlab"), busy: false).title == "提交、推送并创建 MR")
        precondition(TaskGitPresentation.quick(status(delta: 1, provider: "gitlab"), busy: false).title == "创建 MR")
        precondition(TaskGitPresentation.phase("generate_pr", provider: "gitlab") == "正在生成 MR 说明")
        let operation = try JSONDecoder().decode(TaskGitOperation.self, from: Data(#"{"id":"git-op","action":"commit_push","status":"running","phase":"push","createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T10:00:03Z","commitSHA":"abc","output":["hook output"]}"#.utf8))
        precondition(operation.active && operation.commitSHA == "abc" && operation.output == ["hook output"])
        let legacyTask = #"{"id":"task","title":"Title","prompt":"Question","projectId":null,"cwd":"/project","agent":"codex","mode":"code","status":"completed","createdAt":"2026-10-17T10:00:00Z","updatedAt":"2026-10-17T12:00:00Z","durableId":1,"threadId":"thread","turnId":"turn","result":"Answer","error":null,"events":[],"approvals":[],"artifact":null}"#
        var payload = try JSONSerialization.jsonObject(with: Data(legacyTask.utf8)) as! [String: Any]
        let legacy = try JSONDecoder().decode(WorkItem.self, from: Data(legacyTask.utf8)); precondition(!legacy.gitBusy)
        payload["gitOperation"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(operation))
        let busy = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: payload))
        precondition(busy.gitBusy && !busy.active, "Git activity reserves the workspace without becoming an agent generation")
        var draft = TaskRepositoryPublishDraft()
        draft.repository = "fixture/repository"
        precondition(draft.valid(account: "fixture") && !draft.valid(account: nil))
        for invalid in ["../repo", "owner/repo/extra", "https://github.com/owner/repo", "owner/repo.git", "owner/$(command)"] {
            draft.repository = invalid; precondition(!draft.valid(account: "fixture"))
        }
        draft.provider = "gitlab"; draft.repository = "group/subgroup/project"; draft.transport = "https"; draft.visibility = "public"
        precondition(draft.valid(account: "fixture"))
        draft.remoteName = "-unsafe"; precondition(!draft.valid(account: "fixture"))
        draft.remoteName = ""; precondition(draft.valid(account: "fixture"))
        let publishBody = draft.body(review: status(remote: nil, upstream: nil), account: "fixture", requestID: "retained-receipt")
        precondition(publishBody["requestId"] as? String == "retained-receipt")
        precondition((publishBody["repositoryPublish"] as? [String: String])?["remoteName"] == "origin")
        let publication = try JSONDecoder().decode(TaskRepositoryPublication.self, from: Data(#"{"provider":"gitlab","nameWithOwner":"group/project","url":"https://gitlab.com/group/project","sshURL":"git@gitlab.com:group/project.git","httpsURL":"https://gitlab.com/group/project.git","remoteName":"origin","remoteURL":"https://gitlab.com/group/project.git","status":"remote_added"}"#.utf8))
        precondition(publication.status == "remote_added" && publication.provider == "gitlab")
        draft.provider = "bitbucket"; draft.repository = "workspace/repository"
        precondition(!draft.valid(account: "工作区账号"))
        let binding = String(repeating: "a", count: 64)
        precondition(draft.valid(account: "工作区账号", credentialFingerprint: binding))
        draft.repository = "owner/group/repository"; precondition(!draft.valid(account: "工作区账号", credentialFingerprint: binding))
        draft.repository = "workspace/repository"
        let bound = draft.body(review: status(remote: nil, upstream: nil), account: "工作区账号", requestID: "bitbucket-receipt", credentialFingerprint: binding)
        precondition((bound["repositoryPublish"] as? [String: String])?["credentialFingerprint"] == binding)
        let configuredProvider = try JSONDecoder().decode(TaskPublishProvider.self, from: Data(#"{"provider":"bitbucket","label":"Bitbucket","host":"bitbucket.org","command":"API","status":"configured","account":"Bitbucket","credentialFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8))
        precondition(configuredProvider.ready && configuredProvider.credentialFingerprint == binding)
        draft.provider = "forgejo"; draft.repository = "owner/repo"
        precondition(!draft.valid(account: "viewer", credentialFingerprint: binding))
        draft.baseURL = "https://forge.example/team"
        precondition(draft.valid(account: "viewer", credentialFingerprint: binding))
        precondition((draft.body(review: status(remote: nil, upstream: nil), account: "viewer", requestID: "forgejo", credentialFingerprint: binding)["repositoryPublish"] as? [String:String])?["baseURL"] == draft.baseURL)
        draft.provider = "azure-devops"; draft.baseURL = nil; draft.repository = "Org/My Project/repo"
        precondition(draft.valid(account: "viewer@example.com", credentialFingerprint: binding))
        draft.repository = "Org/repo"; precondition(!draft.valid(account: "viewer@example.com", credentialFingerprint: binding))
        do {
            var customDraft = TaskRepositoryPublishDraft(); customDraft.provider = "gitlab"; customDraft.host = "code.example.test:8443"; customDraft.repository = "group/sub/repo"
            let payload = customDraft.body(review: status(remote: nil, upstream: nil), account: "fixture", requestID: "custom-host")
            precondition((payload["repositoryPublish"] as? [String: String])?["host"] == "code.example.test:8443")
            let custom = try JSONDecoder().decode(SourceControlCredentialSettings.self, from: Data(#"{"version":1,"githubTokens":[],"gitlabHosts":[{"host":"code.example.test:8443","enabled":false}],"bitbucket":{"hasAccessToken":false,"email":"","hasAPIToken":false}}"#.utf8))
            precondition(custom.gitlabHosts?.first?.enabled == false)
            let found = try JSONDecoder().decode(SourceControlDiscovery.self, from: Data(#"{"providers":[],"githubHosts":[],"gitlabHosts":[{"provider":"gitlab","label":"GitLab","host":"code.example.test:8443","command":"glab","status":"ready","account":"fixture"}],"gitlabAccounts":[{"host":"code.example.test:8443","account":"fixture","authenticated":true}]}"#.utf8))
            precondition(found.gitlabHosts?.first?.id == "gitlab|code.example.test:8443" && found.gitlabAccounts?.first?.account == "fixture")
        }
        let redactedSettings = try JSONDecoder().decode(SourceControlCredentialSettings.self, from: Data(#"{"version":2,"githubTokens":[{"host":"github.com"}],"bitbucket":{"hasAccessToken":true,"email":"fixture@example.test","hasAPIToken":false}}"#.utf8))
        precondition(redactedSettings.version == 2 && redactedSettings.bitbucket.hasAccessToken && redactedSettings.githubTokens[0].host == "github.com")
        let routed = try JSONDecoder().decode(SourceControlCredentialSettings.self, from: Data(#"{"version":4,"githubTokens":[],"githubHosts":[{"host":"github.com","enabled":false,"account":"work"}],"bitbucket":{"hasAccessToken":false,"email":"","hasAPIToken":false}}"#.utf8))
        precondition(routed.githubHosts?.first?.enabled == false && routed.githubHosts?.first?.account == "work")
        let discovery = try JSONDecoder().decode(SourceControlDiscovery.self, from: Data(#"{"providers":[],"githubHosts":[],"githubAccounts":[{"host":"github.com","account":"work","active":false,"authenticated":true}],"githubAccountHint":"Update CLI"}"#.utf8))
        precondition(discovery.githubAccounts?.first?.account == "work")
        precondition(discovery.githubAccountHint == "Update CLI")
        let creationData = Data(#"{"source":{"provider":"github","host":"github.com","path":"contributor/project"},"target":{"provider":"github","host":"github.com","path":"upstream/project"},"sourceRemote":"contributor","targetRemote":"origin","sourceBranch":"main","baseBranch":"main","isCrossRepository":true,"fingerprint":"frozen","choices":[{"name":"origin","repository":"upstream/project"}]}"#.utf8)
        let creation = try JSONDecoder().decode(TaskChangeRequestCreationContext.self,from:creationData)
        precondition(creation.sourceBranch == "main" && creation.source.path != creation.target.path && creation.isCrossRepository)
        let roundTrip = try JSONDecoder().decode(TaskChangeRequestCreationContext.self,from:JSONEncoder().encode(creation))
        precondition(roundTrip.fingerprint == "frozen" && roundTrip.choices.first?.repository == "upstream/project")
        print("Git quick actions, upstream divergence, first-PR state, capability gates, operation receipts and old snapshots passed")
    }
}
