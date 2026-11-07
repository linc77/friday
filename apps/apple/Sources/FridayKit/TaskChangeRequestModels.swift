import Foundation

struct TaskChangeRequestLinksResponse: Decodable {
    let revision: Int; let links: [TaskPullRequest]; let branch: TaskPullRequest?
}
struct TaskChangeRequestLinkResult: Decodable { let revision: Int; let url: String; let linked: Bool }
struct TaskChangeRequestWatchResult: Decodable { let revision: Int; let url: String; let watching: Bool }
struct TaskChangeRequestLinkSubmission {
    let reference: String; let revision: Int; let linked: Bool
    var requestID = UUID().uuidString
    var watching: Bool? = nil
    var action: String { watching != nil ? "watch" : linked ? "link" : "unlink" }
    var body: [String: Any] {
        var value: [String: Any] = ["reference": reference, "expectedRevision": revision, "requestId": requestID]
        if let watching { value["watching"] = watching }
        return value
    }
}

struct TaskChangeRequestDetail: Decodable {
    let pullRequest: TaskPullRequest; let body: String; let author: String; let createdAt: String; let updatedAt: String
    let stackRebase: Bool?
    let reviewGuidesEnabled: Bool?
    let mergedAt: String?; let closedAt: String?; let authorAvatarURL: String?
    let isDraft: Bool; let headSha: String; let baseSha: String?; let mergeability: String; let mergeQueue: Bool?
    let autoMergeEnabled: Bool?; let autoMergeMethod: String?; let behindBy: Int?; let updateMethods: [String]?
    var workflowApprovalsRequired: Int?; var workflowApprovalsUnavailable: Bool?
    let branch: Branch?
    struct Branch: Decodable { let repository: String?; let owner: String?; let isCrossRepository: Bool?; let exists: Bool?; let canDelete: Bool }
    let additions: Int?; let deletions: Int?; let changedFiles: Int?
    let actions: [String]; let mergeMethods: [String]; let verdicts: [String]; let canComment: Bool
    let reviewers: [String]; let labels: [String]; var checks: [Check]; var checksUnavailable: Bool?
    let management: Management?
    var baseComparison: String? = nil
    var checksState: String? = nil
    var capabilities: Capabilities? = nil
    var stale: Bool? = nil
    var retryAt: Double? = nil
    struct Capabilities: Decodable { let inlineReviews: Bool; let commitDiff: Bool; let fileContents: Bool; let reviewerCandidates: Bool; let stacks: Bool; let replyToThreads: Bool }
    struct Management: Decodable {
        let viewer: String?; let canEdit: Bool; let canResolve: Bool; let canRequestReviewers: Bool; let canSetLabels: Bool
        let canReact: Bool?; let viewedFiles: String?
    }
    struct Check: Decodable { let name: String; let state: String; let url: String? }
    var term: String { pullRequest.provider == "gitlab" ? "MR" : "PR" }
}
struct TaskChangeRequestChecks: Decodable {
    let state: String; let headSha: String; let updatedAt: String?; let isDraft: Bool?; let mergeability: String?
    let checks: [TaskChangeRequestDetail.Check]; let checksState: String?; let checksUnavailable: Bool?
    let workflowApprovalsRequired: Int?; let workflowApprovalsUnavailable: Bool?
}
struct TaskChangeRequestActivityResponse: Decodable {
    let items: [Item]; let truncated: Bool
    var threads: [Thread]? = nil
    var reactions: [TaskReviewReaction]? = nil
    var commits: [TaskChangeRequestCommit]? = nil
    var commitsTruncated: Bool? = nil
    var commitsUnavailable: Bool? = nil
    var dismissalsTruncated: Bool? = nil
    struct Item: Decodable, Identifiable {
        let id: String; let kind: String; let author: String; let body: String; let createdAt: String
        let state: String?; let path: String?; let line: Int?; let url: String?
        let authorAvatarURL: String?; let editedAt: String?; let reviewedHeadSha: String?; let dismissalMessage: String?
        let sourceID: String?; let commentKind: String?; let canEdit: Bool?
        let reactions: [TaskReviewReaction]?
    }
    struct Thread: Codable, Identifiable {
        let id: String; let path: String; let line: Int?; let side: String; let isResolved: Bool; let isOutdated: Bool; let canResolve: Bool?
        var comments: [Comment]; let commentCount: Int; var nextCursor: String?
    }
    struct Comment: Codable, Identifiable {
        let id: String; let author: String; let body: String; let createdAt: String; let editedAt: String?; let url: String?; let canEdit: Bool?; let commentKind: String
        let reactions: [TaskReviewReaction]?
    }
    mutating func appendThreadPage(_ page: TaskChangeRequestThreadComments, threadID: String, cursor: String) -> Bool {
        guard let index = threads?.firstIndex(where: { $0.id == threadID }), threads?[index].nextCursor == cursor else { return false }
        var seen = Set(threads?[index].comments.map(\.id) ?? [])
        threads?[index].comments.append(contentsOf: page.comments.filter { seen.insert($0.id).inserted })
        threads?[index].nextCursor = page.nextCursor; return true
    }
}
struct TaskChangeRequestThreadComments: Decodable { let comments: [TaskChangeRequestActivityResponse.Comment]; let nextCursor: String? }
struct TaskReviewerCandidates: Decodable {
    let candidates: [Candidate]; let truncated: Bool
    struct Candidate: Decodable, Identifiable { let id: String; let kind: String; let login: String; let name: String?; let isRequested: Bool; var key: String { kind + ":" + id } }
}
struct TaskLabelCandidates: Decodable {
    let candidates: [Candidate]; let truncated: Bool
    struct Candidate: Decodable, Identifiable { let name: String; let color: String?; let description: String?; let isApplied: Bool; var id: String { name } }
}
struct TaskChangeRequestFiles: Decodable, Equatable {
    let headSha: String; var files: [File]; var truncated: Bool
    var baseSha: String? = nil
    var scopeCommit: String? = nil
    var requestHeadSha: String? = nil
    var cursor: String? = nil
    var nextCursor: String? = nil
    var omittedFileStats: [OmittedFileStat]? = nil
    var consumedCursors: Set<String>? = nil
    struct OmittedFileStat: Decodable, Equatable { let path: String; let additions: Int; let deletions: Int }
    struct File: Decodable, Identifiable, Equatable {
        let path: String; let oldPath: String?; let status: String; let additions: Int; let deletions: Int
        let patch: String; let unavailable: Bool
        var omissionReason: String? = nil
        var noHunks: Bool? = nil
        var diffCursor: String? = nil
        var id: String { path }
    }
}
struct TaskChangeRequestOperations: Decodable { let operations: [TaskChangeRequestOperation] }
struct TaskChangeRequestPosition: Codable, Equatable {
    var usesOldSide: Bool { kind == "deleted" || kind == "context" && side == "left" }
    var selectedLine: Int? { usesOldSide ? oldLine : newLine }
    let kind: String; var newLine: Int? = nil; var oldLine: Int? = nil; var side: String? = nil
}
struct TaskRemoteReviewDraft: Equatable, Identifiable {
    let id: UUID; let path: String; let oldPath: String?; let position: TaskChangeRequestPosition
    let selection: TaskDiffReviewSelection; let headSha: String; let body: String
    var baseSha: String? = nil
    var networkValue: [String: Any] {
        var positionValue: [String: Any] = ["kind": position.kind]
        if let line = position.newLine { positionValue["newLine"] = line }
        if let line = position.oldLine { positionValue["oldLine"] = line }
        if let side = position.side { positionValue["side"] = side }
        var value: [String: Any] = ["path": path, "body": body, "position": positionValue]
        if let oldPath { value["oldPath"] = oldPath }; return value
    }
}
struct TaskChangeRequestDraft {
    var summary = ""; var comment = ""; var verdict = "comment"; var comments: [TaskRemoteReviewDraft] = []
    var editors: [String: TaskChangeRequestEditorDraft] = [:]
    mutating func reconcile(_ sent: TaskChangeRequestSubmission) {
        if sent.action == "comment", comment == sent.draft.comment { comment = "" }
        if sent.action == "review" {
            if summary == sent.draft.summary { summary = "" }
            comments.removeAll { value in sent.draft.comments.contains(value) }
        }
        if let key = sent.editorKey {
            if editors[key] == sent.draft.editors[key] { editors.removeValue(forKey: key) }
            else if sent.action == "edit_request", var current = editors[key] {
                if let title = sent.collaboration?.title { current.originalTitle = title }
                if let body = sent.collaboration?.body { current.originalBody = body }
                editors[key] = current
            }
        }
    }
}
struct TaskChangeRequestEditorDraft: Equatable {
    var title = ""; var body = ""; var originalTitle: String? = nil; var originalBody: String? = nil
    var changeRequestFields: TaskChangeRequestCollaboration { TaskChangeRequestCollaboration(title: title != originalTitle ? title : nil, body: body != originalBody ? body : nil) }
}
struct TaskChangeRequestCollaboration: Equatable {
    var title: String? = nil; var body: String? = nil; var threadID: String? = nil; var commentID: String? = nil; var commentKind: String? = nil
    var resolved: Bool? = nil; var reviewers: [Reviewer]? = nil; var requested: Bool? = nil; var labels: [String]? = nil; var applied: Bool? = nil
    var subjectID: String? = nil; var content: String? = nil; var reacted: Bool? = nil; var files: [TaskViewedFilePress]? = nil
    struct Reviewer: Equatable { let id: String; let kind: String }
    var networkValue: [String: Any] {
        var value: [String: Any] = [:]
        if let title { value["title"] = title }; if let body { value["body"] = body }
        if let threadID { value["threadId"] = threadID }; if let commentID { value["commentId"] = commentID }; if let commentKind { value["commentKind"] = commentKind }
        if let resolved { value["resolved"] = resolved }; if let requested { value["requested"] = requested }; if let labels { value["labels"] = labels }; if let applied { value["applied"] = applied }
        if let reviewers { value["reviewers"] = reviewers.map { ["id": $0.id, "kind": $0.kind] } }
        if let subjectID { value["subjectId"] = subjectID }; if let content { value["content"] = content }; if let reacted { value["reacted"] = reacted }
        if let files { value["files"] = files.map { ["path": $0.path, "viewed": $0.viewed] as [String: Any] } }; return value
    }
}
struct TaskChangeRequestSubmission {
    var requestID = UUID().uuidString
    let url: String; let headSha: String; let action: String; let mergeMethod: String?; let draft: TaskChangeRequestDraft
    var collaboration: TaskChangeRequestCollaboration? = nil
    var editorKey: String? = nil
    var viewedBatch: TaskViewedFileBatch? = nil
    var updateMethod: String? = nil
    var expectedBaseSha: String? = nil
    var expectedWorkflowSource: [String: String]? = nil
    var stackNumber: Int? = nil
    var targetNumber: Int? = nil
    var expectedStackHeads: [TaskStackHead]? = nil
    var body: [String: Any] {
        var body: [String: Any] = ["requestId": requestID, "url": url, "action": action, "expectedHeadSha": headSha]
        if action == "comment" { body["body"] = draft.comment }
        if action == "review" { body["body"] = draft.summary; body["verdict"] = draft.verdict; body["comments"] = draft.comments.map(\.networkValue) }
        if let expectedBaseSha { body["expectedBaseSha"] = expectedBaseSha }
        if let mergeMethod { body["mergeMethod"] = mergeMethod }
        if let updateMethod { body["updateMethod"] = updateMethod }
        if let expectedWorkflowSource { body["expectedWorkflowSource"] = expectedWorkflowSource }
        if let stackNumber { body["stackNumber"] = stackNumber }; if let targetNumber { body["targetNumber"] = targetNumber }
        if let expectedStackHeads { body["expectedStackHeads"] = expectedStackHeads.map { ["number": $0.number, "headSha": $0.headSha] as [String: Any] } }
        if let collaboration { body.merge(collaboration.networkValue) { _, new in new } }; return body
    }
}

// A single presentation mapping keeps advanced operations out of the close-PR fallback.
struct TaskChangeRequestConfirmation {
    let action: String
    var mergeMethod: String? = nil
    var headSha: String? = nil
    var workflowSource: [String: String]? = nil
    var title: String {
        switch action {
        case "merge": return "确认合并此 PR／MR？"
        case "enable-auto-merge": return "开启自动合并？"
        case "revert": return "创建回退 PR？"
        case "delete-branch": return "删除远端源分支？"
        case "approve-workflows": return "批准此版本的 Fork 工作流？"
        default: return "确认平台操作？"
        }
    }
    var message: String {
        switch action {
        case "enable-auto-merge": return "条件满足后平台会自动合并；当前已满足条件时会立即合并。"
        case "revert": return "平台将创建一个回退此合并的新 PR，供你继续审查。"
        case "delete-branch": return "仅删除此 PR 的远端源分支。本地分支和工作区保留。源分支已有新提交时不会删除。"
        case "approve-workflows": return "允许当前 Fork 代码在目标仓库运行待批准的工作流。代码或来源变化后需要重新确认。"
        default: return ""
        }
    }
    static func label(_ action: String) -> String {
        switch action {
        case "merge": return "合并"
        case "ready": return "标记为待审查"
        case "draft": return "转为草稿"
        case "reopen": return "重新打开"
        case "close": return "关闭 PR／MR"
        case "enable-auto-merge": return "开启自动合并"
        case "disable-auto-merge": return "取消自动合并"
        case "update-branch": return "更新源分支"
        case "revert": return "创建回退 PR"
        case "delete-branch": return "删除远端源分支"
        case "approve-workflows": return "批准 Fork 工作流"
        default: return action
        }
    }
}
