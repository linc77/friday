import Foundation

enum TaskProviderCatalog {
    static let order = ["codex", "claude", "cursor", "grok", "opencode", "antigravity", "pi", "muse", "acp-registry"]
    static func name(_ provider: String) -> String {
        switch provider { case "codex": "Codex"; case "claude": "Claude"; case "cursor": "Cursor"; case "opencode": "OpenCode"; case "antigravity": "Antigravity"; case "acp-registry": "ACP Registry"; case "muse": "Muse Code"; case "pi": "Pi"; case "grok": "Grok"; case "friday": "Friday"; default: provider }
    }
    static func supportsInteractionModes(_ provider: String) -> Bool { supportsInteractionModes(provider, state: nil) }
    static func supportsInteractionModes(_ provider: String, state: CodexConnectionState?) -> Bool { ["antigravity", "acp-registry"].contains(provider) ? state?.supportsPlan == true : ["codex", "claude", "cursor", "opencode"].contains(provider) }
    static func hasUsageLimits(_ provider: String) -> Bool { ["codex", "claude", "grok", "cursor", "opencode"].contains(provider) }
}

struct ProviderInstanceInfo: Codable, Equatable, Identifiable {
    let instanceId: String; let driver: String; let displayName: String; let enabled: Bool
    var accentColor: String? = nil
    var id: String { instanceId }
    var name: String { displayName == driver ? TaskProviderCatalog.name(driver) : displayName }
    static var defaults: [Self] { TaskProviderCatalog.order.map { Self(instanceId: $0, driver: $0, displayName: TaskProviderCatalog.name($0), enabled: true) } }
}
struct ProviderInstancesResponse: Decodable { let instances: [ProviderInstanceInfo] }
extension TaskProviderCatalog {
    static func endpoint(_ provider: String, instance: String? = nil, path: String = "") -> String {
        "/api/agents/\(provider)" + path + (instance.map { "?instanceId=" + $0 } ?? "")
    }
}

struct TaskContextUsage: Codable, Equatable {
    let usedTokens: Double
    let maxTokens: Double?
    let updatedAt: String
    var model: String? = nil
    var inputTokens: Double? = nil
    var cachedInputTokens: Double? = nil
    var outputTokens: Double? = nil
    var reasoningOutputTokens: Double? = nil
    var promptCacheTtlMs: Double? = nil
    // T3 ContextWindowMeter.logic: the provider's reported TTL, or 70m
    // fallback, and at least 100k tokens. This is an offer the user can bypass.
    func offersResumeCompaction(provider: String, now: Date) -> Bool {
        guard provider == "claude", usedTokens >= 100_000, let at = CodexTranscript.date(updatedAt) else { return false }
        return now.timeIntervalSince(at) * 1_000 >= (promptCacheTtlMs ?? 70 * 60_000)
    }
    var fraction: Double? {
        guard usedTokens.isFinite, let maxTokens, maxTokens.isFinite, maxTokens > 0 else { return nil }
        return max(0, min(1, usedTokens / maxTokens))
    }
    var remainingTokens: Double? { maxTokens.map { max(0, $0 - usedTokens) } }
    var percentageText: String? {
        guard let fraction else { return nil }; let value = fraction * 100
        return (value < 10 ? String(format: "%.1f", value).replacingOccurrences(of: ".0", with: "") : String(format: "%.0f", value.rounded(.toNearestOrAwayFromZero))) + "%"
    }
    static func format(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "—" }
        if value < 1_000 { return String(format: "%.0f", value.rounded(.toNearestOrAwayFromZero)) }
        if value < 10_000 { return String(format: "%.1f", value / 1_000).replacingOccurrences(of: ".0", with: "") + "k" }
        if value < 999_500 { return String(format: "%.0f", (value / 1_000).rounded(.toNearestOrAwayFromZero)) + "k" }
        return String(format: "%.1f", value / 1_000_000).replacingOccurrences(of: ".0", with: "") + "m"
    }
}


struct TaskProviderResetSubmission: Codable {
    var providerInstanceId: String? = nil
    let provider: String; let fingerprint: String
    var requestId = UUID().uuidString
    var body: [String: Any] { var value: [String: Any] = ["provider": provider, "fingerprint": fingerprint, "requestId": requestId, "confirmed": true]; if let providerInstanceId { value["providerInstanceId"] = providerInstanceId }; return value }
}
struct TaskProviderResetReceipt: Decodable {
    let requestId: String; let status: String
    var outcome: String? = nil; var error: String? = nil; var warning: String? = nil; var limits: TaskProviderUsageLimits? = nil
}

struct TaskProviderUsageLimits: Decodable, Equatable {
    struct ResetCredits: Decodable, Equatable { let availableCount: Int; var nextExpiresAt: String? = nil; var nextCreditId: String? = nil }
    struct Window: Decodable, Identifiable, Equatable {
        let id: String; let kind: String; let label: String; let usedPercent: Double; let windowDurationMins: Double
        var resetsAt: String? = nil
        var remainingPercent: Int { Int(max(0, min(100, 100 - usedPercent)).rounded(.toNearestOrAwayFromZero)) }
    }
    struct Unavailable: Decodable, Equatable { let reason: String; var message: String? = nil }
    let checkedAt: String
    let windows: [Window]
    var unavailable: Unavailable? = nil
    var credentialFingerprint: String? = nil
    var resetCredits: ResetCredits? = nil
    var sourceLabel: String? = nil
    var available: Bool? = nil
    var offered: Bool { unavailable == nil && (!windows.isEmpty || available == true) }
}
struct TaskUsageSourceSnapshot: Decodable, Equatable, Identifiable {
    struct Account: Decodable, Equatable, Identifiable { let id: String; let driver: String; var email: String? = nil; var plan: String? = nil; var workspaceId: String? = nil; let credentialFingerprint: String; let usageLimits: TaskProviderUsageLimits }
    let id: String; let kind: String; let label: String; let checkedAt: String; let accounts: [Account]; var error: String? = nil
}
struct TaskUsageResetTarget: Codable, Equatable {
    var provider: String? = nil; var sourceId: String? = nil; var accountId: String? = nil; var creditId: String? = nil; let fingerprint: String
    var body: [String: Any] {
        var value: [String: Any] = ["fingerprint": fingerprint, "confirmed": true]
        if let provider { value["provider"] = provider }; if let sourceId { value["sourceId"] = sourceId }; if let accountId { value["accountId"] = accountId }; if let creditId { value["creditId"] = creditId }
        return value
    }
}
struct TaskUsagePool: Decodable, Identifiable {
    struct Account: Decodable, Identifiable { let key: String; let driver: String; let displayName: String; var email: String? = nil; var plan: String? = nil; var sourceLabel: String? = nil; let limits: TaskProviderUsageLimits; var redeem: TaskUsageResetTarget? = nil; var id: String { key } }
    struct Window: Decodable, Identifiable {
        struct Reset: Decodable { let accountKey: String; let at: String; let restoresPercent: Int }
        let id: String; let kind: String; let label: String; let usedPercent: Int; let remainingPercent: Int; var pace: String? = nil; let resets: [Reset]
    }
    let driver: String; let accounts: [Account]; let windows: [Window]; var id: String { driver }
}
struct TaskUsagePoolSnapshot: Decodable { let pools: [TaskUsagePool]; let notices: [String] }

struct IdeaImage: Codable, Identifiable, Equatable {
    let id: String; let name: String; let mediaType: String
}
struct Idea: Codable, Identifiable, Equatable {
    let id: String; let text: String; let createdAt: String; let taskId: String?
    var title: String? = nil
    var updatedAt: String? = nil
    var images: [IdeaImage]? = nil

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        let line = text.components(separatedBy: .newlines).first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty && !$0.hasPrefix("![") }) ?? ""
        let clean = line.replacingOccurrences(of: "^#+\\s*", with: "", options: .regularExpression)
        return clean.isEmpty ? "未命名笔记" : String(clean.prefix(80))
    }
    var preview: String {
        text.replacingOccurrences(of: "!\\[[^\\]]*\\]\\(friday-image:[a-f0-9]+\\)", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^\\)]+\\)", with: "$1", options: .regularExpression)
            .replacingOccurrences(of: "[#*`>]", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var editableText: String {
        (images ?? []).reduce(text) { result, image in
            result.replacingOccurrences(of: "!\\[[^\\]]*\\]\\(friday-image:\(image.id)\\)", with: "", options: .regularExpression)
        }.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
struct Project: Codable, Identifiable {
    let id: String; var name: String; let path: String; var context: String
    var icon: String? = nil; var color: String? = nil
    var createdAt: String? = nil; var updatedAt: String? = nil
    var isScratch: Bool? = nil
    var clone: ProjectCloneSnapshot? = nil
    var repositoryIdentity: RepositoryIdentity? = nil
    struct RepositoryIdentity: Codable {
        let canonicalKey: String; let rootPath: String; let displayName: String; let name: String
        var origin: Origin? = nil
        struct Origin: Codable { let canonicalKey: String; let displayName: String }
        var groupingKey: String { origin?.canonicalKey ?? canonicalKey }
        var groupingName: String { origin?.displayName ?? displayName }
    }
}
struct MemoryItem: Codable, Identifiable { let id: String; let text: String; let updatedAt: String }
struct AgentInfo: Codable, Identifiable { let id: String; let name: String; let installed: Bool; let executable: String?; let executableSupported: Bool; let description: String }
struct Device: Codable, Identifiable { let id: String; let name: String; let createdAt: String }
struct TaskFileChange: Codable, Identifiable, Equatable {
    var id: String { path }
    let path: String; let kind: String; let diff: String; let additions: Int; let deletions: Int
    var oldPath: String? = nil
    var truncated: Bool? = nil
}
struct TaskPlanStep: Codable, Equatable { let step: String; let status: String }
struct TaskCommandAction: Codable { let type: String; let command: String; let path: String?; let name: String?; let query: String? }
struct TaskEvent: Codable, Identifiable {
    let id: String; let kind: String; let text: String; let at: String
    let itemId: String?; let turnId: String?; let phase: String?; let status: String?
    let detail: String?; let completedAt: String?; let durationMs: Double?; let exitCode: Int?
    var changes: [TaskFileChange]? = nil
    var plan: [TaskPlanStep]? = nil
    var commandActions: [TaskCommandAction]? = nil
    var runId: String? = nil
    var revertedAt: String? = nil
    var historyDigest: String? = nil
    var historyOrder: Int? = nil
    var detailOmitted: Bool? = nil
    var detailTruncated: Bool? = nil
    var background: Bool? = nil
    var processId: String? = nil
    var subagentId: String? = nil
    var nativeTurnId: String? = nil
    init(id: String, kind: String, text: String, at: String, itemId: String? = nil, turnId: String? = nil, phase: String? = nil, status: String? = nil, detail: String? = nil, completedAt: String? = nil, durationMs: Double? = nil, exitCode: Int? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.at = at; self.itemId = itemId; self.turnId = turnId
        self.phase = phase; self.status = status; self.detail = detail; self.completedAt = completedAt; self.durationMs = durationMs; self.exitCode = exitCode
    }
}
struct TaskEventDetail: Decodable {
    let taskId: String; let epoch: String; let sequence: Int; let event: TaskEvent
}
struct TaskRunFile: Codable, Identifiable {
    var id: String { path }
    let path: String; let oldPath: String?; let kind: String
    let additions: Int?; let deletions: Int?; let binary: Bool
}
struct TaskRunCheckpoint: Codable { let status: String; let error: String? }
struct TaskWorkspacePreparation: Codable {
    let status: String; let attempt: Int; let startedAt: String; let completedAt: String?; let error: String?
    var checkoutCompletedAt: String? = nil
    var setupRunId: String? = nil
    var setupResolvedAt: String? = nil
}
struct TaskRunInheritance: Codable { let taskId: String; let runId: String }
struct TaskRun: Codable, Identifiable {
    var modelOptions: [ProviderOptionSelection]? = nil
    var nativeTurnIds: [String]? = nil
    var command: String? = nil
    var contextUsage: TaskContextUsage? = nil
    let id: String; let durableId: Int?; let messageId: String; let requestId: String; let cwd: String; let at: String; let status: String
    let completedAt: String?; let threadId: String?; let turnId: String?; let nativeHead: String?
    let mode: String; let interactionMode: String; let model: String?; let reasoningEffort: String?
    let before: TaskRunCheckpoint?; let after: TaskRunCheckpoint?; let changes: [TaskRunFile]?; let diffError: String?; let revertedAt: String?
    var startedAt: String? = nil
    var executionOrder: Int? = nil
    var executionMessagePosition: Int? = nil
    var executionExcludedAt: String? = nil
    var workspacePreparation: TaskWorkspacePreparation? = nil
    var inheritedFrom: TaskRunInheritance? = nil
    var preparationFailed: Bool { status == "failed" && revertedAt == nil && workspacePreparation?.status == "failed" }
}
struct TaskForkOrigin: Codable {
    let taskId: String; let runId: String; let title: String; let rootTaskId: String
}
struct TaskForkOperation: Codable, Identifiable {
    let id: String; let status: String; let updatedAt: String; let sourceTaskId: String; let sourceRunId: String
    let startedAt: String?; let candidateId: String?; let error: String?; let strategy: String?
    var active: Bool { status != "completed" }
    var running: Bool { ["queued", "running"].contains(status) }
}
struct TaskRewindEditor: Codable {
    var modelOptions: [ProviderOptionSelection]? = nil
    let text: String; let images: [IdeaImage]; let interactionMode: String
    let model: String?; let reasoningEffort: String?
    var contexts: [TaskContextReference]? = nil
}
struct TaskRewindOperation: Codable, Identifiable {
    let id: String; let durableId: Int; let requestId: String; let messageId: String; let runId: String
    let status: String; let phase: String; let restoreFiles: Bool; let updatedAt: String; let projectedAt: String?; let error: String?
    let editor: TaskRewindEditor; let attempt: Int
    var active: Bool { !["completed", "failed"].contains(status) }
    var running: Bool { ["queued", "running"].contains(status) }
    var needsReview: Bool { ["needs_review", "interrupted"].contains(status) }
}
struct TaskRewindOptions: Decodable {
    let fingerprint: String; let messageId: String; let runId: String; let removedTurns: Int
    let canRestore: Bool; let restoreReason: String?; let fileFingerprint: String?; let nativeReason: String?
    var additionalExecutionCount: Int? = nil
}
struct TaskRewindFileStatus: Decodable {
    let fingerprint: String; let branch: String?; let head: String?; let files: [TaskChangedFile]; let missing: Bool
}
struct TaskChangedFile: Decodable, Identifiable {
    var id: String { path }
    let path: String; let oldPath: String?; let kind: String
    let staged: Bool; let unstaged: Bool; let additions: Int?; let deletions: Int?; let binary: Bool
    let truncated: Bool?
}
struct TaskChangesSnapshot: Decodable { let status: String; let scope: String; let files: [TaskChangedFile] }
struct TaskFileDiff: Decodable {
    let path: String; let oldPath: String?; let scope: String; let patch: String; let binary: Bool; let truncated: Bool
}
struct TaskPullRequest: Codable {
    let number: Int; let url: String; let title: String; let state: String; let base: String; let head: String
    var provider: String? = nil; var host: String? = nil; var repository: String? = nil
    var snapshot: TaskPullRequestSnapshot? = nil
    var linkedAt: String? = nil; var linkSource: String? = nil; var dismissedAt: String? = nil
    var watch: TaskPullRequestWatch? = nil; var endedWatch: TaskPullRequestWatch? = nil
}
struct TaskPullRequestWatch: Codable, Equatable {
    let startedAt: String; let headSha: String?; let failedChecks: [String]; let passed: Bool
    var passedChecks: [String]? = nil
    let remarksThrough: String; let remarkIds: [String]; let conflicting: Bool; let wakes: Int
}
struct TaskMonitorNotification: Codable, Equatable { let outcome: String; let summary: String }
struct TaskPullRequestSnapshot: Codable, Equatable {
    let state: String; let title: String; let headBranch: String; let baseBranch: String; let isDraft: Bool; let updatedAt: String?; let syncedAt: String
    let closedAt: String?; let mergedAt: String?; let headSha: String?
    let author: Author?; let additions: Int?; let deletions: Int?; let changedFiles: Int?; let reviewDecision: String?; let checksState: String?; let mergeability: String?
    struct Author: Codable, Equatable { let login: String; let avatarURL: String? }
}
struct TaskChangeRequestOperation: Codable, Identifiable {
    let id: String; let url: String; let action: String; let status: String
    let createdAt: String; let updatedAt: String; let completedEffects: [String]; let error: String?; let refreshError: String?
    var resultURL: String? = nil
    var stackNumber: Int? = nil
    var active: Bool { status == "queued" || status == "running" }
}

struct TaskChangeRequestStack: Codable, Identifiable {
    let id: String; let number: Int; let url: String; let base: String; let layers: [Layer]; let syncedAt: String?
    struct Layer: Codable, Identifiable {
        let number: Int; let title: String?; let isDraft: Bool?; let headSha: String?; let headBranch: String; let state: String
        var id: Int { number }
    }
}

struct TaskReviewGuideRun: Codable, Identifiable {
    let id: String; let durableId: Int; let url: String; let headSha: String; let status: String
    let createdAt: String; let updatedAt: String; let modelSelection: TextGenerationModelSelection; let error: String?
    var active: Bool { status == "queued" || status == "running" }
}

struct TaskGitOperation: Codable, Identifiable {
    let id: String; let action: String; let status: String; let phase: String
    let createdAt: String; let updatedAt: String
    var phaseStartedAt: String? = nil
    var error: String? = nil
    var output: [String]? = nil
    var commitMessage: String? = nil
    var commitSHA: String? = nil
    var pullRequest: TaskPullRequest? = nil
    var repositoryPublication: TaskRepositoryPublication? = nil
    var changeRequestProvider: String? = nil
    var changeRequestCreation: TaskChangeRequestCreationContext? = nil
    var featureBranch: String? = nil
    var active: Bool { status == "queued" || status == "running" }
}
struct TaskRepositoryPublication: Codable {
    let provider: String; let nameWithOwner: String; let url: String
    let sshURL: String; let httpsURL: String; let remoteName: String; let remoteURL: String; let status: String
}
struct TaskPublishProvider: Decodable, Identifiable {
    let provider: String; let label: String; let host: String; let command: String
    let status: String; let account: String?; let hint: String?
    var credentialFingerprint: String? = nil
    var credentialSource: String? = nil
    var baseURL: String? = nil
    var id: String { provider + "|" + (baseURL ?? host) }
    var ready: Bool { (status == "ready" || status == "configured") && account != nil }
}
struct TaskPublishProvidersResponse: Decodable { let providers: [TaskPublishProvider] }
struct ProjectCloneSnapshot: Codable, Equatable {
    let operationId: String; let phase: String; let stage: String
    var percent: Double?; var detail: String?; var error: String?
    let remoteUrl: String; let destinationPath: String
    var blocksTasks: Bool { phase != "done" }
}
struct ProjectRepositoryOperation: Decodable, Identifiable {
    let id: String; let projectId: String; let kind: String; let requestId: String
    let status: String; let phase: String; let cwd: String; let updatedAt: String
    var error: String?; var publication: TaskRepositoryPublication?
    var active: Bool { status == "queued" || status == "running" }
}
struct ProjectRepositoryOperationResponse: Decodable { let operationId: String }
struct ProjectCloneStartResponse: Decodable { let projectId: String; let operationId: String }
struct CloneRepositoryInfo: Decodable {
    let provider: String; let nameWithOwner: String; let url: String; let httpsURL: String; let sshURL: String
}
struct SourceControlCredentialSettings: Decodable {
    struct GitHubToken: Decodable, Identifiable { let host: String; var id: String { host } }
    struct Bitbucket: Decodable { let hasAccessToken: Bool; let email: String; let hasAPIToken: Bool }
    let version: Int; let githubTokens: [GitHubToken]; let bitbucket: Bitbucket
    struct GitHubHost: Decodable { let host: String; let enabled: Bool; let account: String? }
    var githubHosts: [GitHubHost]? = nil
    struct GitLabHost: Decodable { let host: String; let enabled: Bool }
    var gitlabHosts: [GitLabHost]? = nil
    struct GitCafe: Decodable { let hasToken: Bool }
    var gitcafe: GitCafe? = nil
}
struct SourceControlGitHubAccount: Decodable { let host: String; let account: String; let active: Bool; let authenticated: Bool; let environmentVariable: String? }
struct SourceControlGitLabAccount: Decodable { let host: String; let account: String; let authenticated: Bool }
struct SourceControlDiscovery: Decodable { let providers: [TaskPublishProvider]; let githubHosts: [TaskPublishProvider]; var githubAccounts: [SourceControlGitHubAccount]? = nil; var githubAccountHint: String? = nil; var gitlabHosts: [TaskPublishProvider]? = nil; var gitlabAccounts: [SourceControlGitLabAccount]? = nil }
struct TaskChangeRequestCreationContext: Codable {
    let source: Repository; let target: Repository; let sourceRemote: String; let targetRemote: String?; let sourceBranch: String; let baseBranch: String
    let isCrossRepository: Bool; let fingerprint: String; let choices: [Choice]
    struct Repository: Codable { let provider: String; let host: String; let path: String }
    struct Choice: Codable { let name: String; let repository: String }
}
struct TaskGitStatus: Decodable {
    let status: String; let cwd: String; let branch: String?; let head: String?
    let defaultBranch: String?; let isDefaultBranch: Bool; let remote: String?; let upstream: String?
    let ahead: Int; let behind: Int; let aheadOfDefault: Int
    let files: [TaskChangedFile]; let fingerprint: String
    let pullRequest: TaskPullRequest?; let remoteError: String?; let canCreatePR: Bool?; let remoteDisplay: String?
    var root: String? = nil
    struct SourceControl: Decodable { let provider: String; let host: String; let path: String }
    var sourceControl: SourceControl? = nil
}
struct QuestionOption: Codable { let label: String; let description: String; var value: String? = nil; var answerValue: String { value ?? label } }
struct Question: Codable, Identifiable {
    let id: String; let header: String; let question: String; let options: [QuestionOption]
    var multiSelect: Bool? = nil
    var isOther: Bool? = nil
    var isSecret: Bool? = nil
}
struct Approval: Codable, Identifiable {
    struct Option: Codable, Identifiable { let decision: String; let label: String; var warning: String? = nil; var id: String { decision } }
    let id: String; let method: String; let title: String; let detail: String; let questions: [Question]; let state: String
    var decisions: [String]? = nil
    var responseStatus: String? = nil
    var options: [Option]? = nil
    var appName: String? = nil
    var canRespond: Bool { state == "pending" && responseStatus != "sending" && responseStatus != "uncertain" }
    var effectiveOptions: [Option] { options ?? (decisions ?? ["decline", "accept"]).map { Option(decision: $0, label: $0) } }
    func label(_ option: Option) -> String {
        switch option.label {
        case "accept", "Approve": return "允许本次"
        case "decline", "Decline": return "拒绝"
        case "cancel", "Cancel": return "取消本次执行"
        case "acceptForSession", "Always allow this session": return "始终允许本会话"
        case "acceptAlways", "Always allow": return "始终允许"
        default: return option.label
        }
    }
}
struct ChatMessage: Codable, Identifiable {
    let id: String; let role: String; let text: String; let at: String?; let turnId: String?
    var images: [IdeaImage]? = nil
    var contexts: [TaskContextReference]? = nil
    var delivery: String? = nil
    var runId: String? = nil
    var revertedAt: String? = nil
    var historyOrder: Int? = nil
    var creationSource: String? = nil; var notification: TaskMonitorNotification? = nil
    init(id: String, role: String, text: String, at: String? = nil, turnId: String? = nil) {
        self.id = id; self.role = role; self.text = text; self.at = at; self.turnId = turnId
    }
}
struct CodexEnvironmentVariable: Codable, Identifiable, Equatable {
    var name: String; var value: String?; var hasValue: Bool?
    var id: String { name }
}
struct CustomProviderModel: Codable, Identifiable, Equatable {
    var id: String; var name: String
}
struct AcpNativeProviderConfig: Codable, Equatable {
    var source = "registry"; var registryAgentId = ""; var commandArgs: [String] = []
    var authMethodId = ""; var distribution = "auto"; var commandOverride = ""; var harnessPath = ""
    var authMethod = "oauth-personal"; var apiKey: String? = nil; var apiKeyConfigured = false
    var gcpProject = ""; var gcpLocation = ""
}
struct AcpNativeLoginState: Decodable {
    struct Interaction: Decodable { let id: String; let type: String; let url: String?; let output: String?; let outputOffset: Int? }
    let pending: Bool
    var url: String? = nil
    var flowId: String? = nil
    var revision: Int? = nil
    var phase: String? = nil
    var methodId: String? = nil
    var interaction: Interaction? = nil
    var error: String? = nil
    func accepts(after previous: Self?) -> Bool {
        guard let previous, previous.flowId == flowId, let old = previous.revision, let next = revision else { return true }
        return next >= old
    }
}
struct AcpNativeAuthMethods: Decodable {
    struct Method: Decodable, Identifiable { let id: String; let name: String; let type: String; let description: String?; let envVarNames: [String]?; let link: String? }
    let methods: [Method]
    let defaultMethodId: String?
}
struct AcpRegistrySearchResult: Decodable {
    struct Agent: Decodable, Identifiable { let id: String; let name: String; let version: String; let description: String; let distribution: String; let integrity: String }
    let agents: [Agent]
}
struct NativeToolInstallState: Decodable {
    let operationId: String?; let tool: String; let phase: String; let downloadedBytes: Double; let totalBytes: Double?; let error: String?
    var active: Bool { ["downloading", "extracting", "verifying"].contains(phase) }
}
struct CodexProviderSettings: Codable, Equatable {
    var enabled = true; var displayName = "Codex"; var binaryPath = "codex"
    var homePath = ""; var shadowHomePath = ""; var launchArgs = ""
    var model = ""; var reasoningEffort = ""; var environment: [CodexEnvironmentVariable] = []
    var customModels: [CustomProviderModel] = []
    var permissionMode = "auto"
    var serverUrl: String? = nil
    var serverPassword: String? = nil
    var serverPasswordConfigured: Bool? = nil
    var cursorUsageKeychainEnabled: Bool? = nil
    var nativeConfig: AcpNativeProviderConfig? = nil
    init() {}
    enum CodingKeys: String, CodingKey {
        case enabled, displayName, binaryPath, homePath, shadowHomePath, launchArgs, model, reasoningEffort, environment, customModels, permissionMode, serverUrl, serverPassword, serverPasswordConfigured, cursorUsageKeychainEnabled, nativeConfig
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decode(Bool.self, forKey: .enabled)
        displayName = try values.decode(String.self, forKey: .displayName)
        binaryPath = try values.decode(String.self, forKey: .binaryPath)
        homePath = try values.decode(String.self, forKey: .homePath)
        shadowHomePath = try values.decode(String.self, forKey: .shadowHomePath)
        launchArgs = try values.decode(String.self, forKey: .launchArgs)
        model = try values.decode(String.self, forKey: .model)
        reasoningEffort = try values.decode(String.self, forKey: .reasoningEffort)
        environment = try values.decode([CodexEnvironmentVariable].self, forKey: .environment)
        customModels = try values.decodeIfPresent([CustomProviderModel].self, forKey: .customModels) ?? []
        permissionMode = try values.decodeIfPresent(String.self, forKey: .permissionMode) ?? "auto"
        serverUrl = try values.decodeIfPresent(String.self, forKey: .serverUrl)
        serverPassword = try values.decodeIfPresent(String.self, forKey: .serverPassword)
        serverPasswordConfigured = try values.decodeIfPresent(Bool.self, forKey: .serverPasswordConfigured)
        cursorUsageKeychainEnabled = try values.decodeIfPresent(Bool.self, forKey: .cursorUsageKeychainEnabled)
        nativeConfig = try values.decodeIfPresent(AcpNativeProviderConfig.self, forKey: .nativeConfig)
    }
    var body: [String: Any] {
        var body = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:]
        body["environment"] = environment.map { ["name": $0.name, "value": $0.value as Any? ?? NSNull()] }
        if serverUrl != nil { body["serverPassword"] = serverPassword as Any? ?? NSNull() }
        if let nativeConfig {
            var native = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(nativeConfig))) as? [String: Any] ?? [:]
            native["apiKey"] = nativeConfig.apiKey as Any? ?? NSNull(); body["nativeConfig"] = native
        }
        return body
    }
}
enum ProviderOptionValue: Codable, Equatable {
    case text(String), flag(Bool)
    init(from decoder: Decoder) throws { let container = try decoder.singleValueContainer(); if let value = try? container.decode(Bool.self) { self = .flag(value) } else { self = .text(try container.decode(String.self)) } }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); switch self { case .text(let value): try container.encode(value); case .flag(let value): try container.encode(value) } }
    var body: Any { switch self { case .text(let value): value; case .flag(let value): value } }
}
struct ProviderOptionSelection: Codable, Equatable, Identifiable {
    let id: String; var value: ProviderOptionValue
    var body: [String: Any] { ["id": id, "value": value.body] }
}
struct ProviderOptionDescriptor: Codable, Identifiable, Equatable {
    struct Choice: Codable, Identifiable, Equatable { let id: String; let label: String; var description: String? = nil; var isDefault: Bool? = nil }
    let id: String; let label: String; let type: String
    var description: String? = nil; var options: [Choice]? = nil; var currentValue: ProviderOptionValue? = nil
    var isReasoning: Bool { ["reasoningEffort", "reasoning", "effort", "variant", "thinkingLevel"].contains(id) }
}

struct CodexProviderModel: Decodable, Identifiable {
    let id: String; let name: String; let description: String; let isDefault: Bool
    let reasoningEfforts: [String]; let defaultReasoningEffort: String
    var isCustom: Bool? = nil; var resolvedModel: String? = nil
    var optionDescriptors: [ProviderOptionDescriptor]? = nil
    var selectionName: String { resolvedModel != nil && resolvedModel != id ? "\(name) (\(id))" : name }
}
struct CodexAccount: Decodable { let type: String; let email: String?; let plan: String? }
struct ModelConnectionState: Decodable { let provider: String; let model: String; let connected: Bool }
struct CodexConnectionState: Decodable {
    let provider: String; let displayName: String; var enabled: Bool; let model: String; var connected: Bool
    let installed: Bool; let version: String?; let account: CodexAccount?; let models: [CodexProviderModel]
    let checkedAt: String; let error: String?; let loginPending: Bool; let settings: CodexProviderSettings?
    var supportsPlan: Bool? = nil
    var supportsTextGeneration: Bool? = nil
    var supportsInvestigation: Bool? = nil
}
struct CodexLoginResponse: Decodable { let url: String }
struct TaskGitContext: Codable {
    let status: String
    var branch: String? = nil
    var head: String? = nil
    var isWorktree: Bool? = nil
}
struct TaskBranchChange: Codable {
    let requestId: String
    let branch: String
    let status: String
    var error: String? = nil
    var active: Bool { status == "queued" || status == "running" }
}
struct QueuedTaskMessage: Codable, Identifiable {
    var modelOptions: [ProviderOptionSelection]? = nil
    let id: String
    let text: String
    let images: [IdeaImage]
    var contexts: [TaskContextReference]? = nil
    let createdAt: String
    let status: String
    var model: String? = nil
    var reasoningEffort: String? = nil
    var interactionMode: String? = nil
    var error: String? = nil
    var creationSource: String? = nil; var notification: TaskMonitorNotification? = nil
    var editable: Bool { status == "queued" }
    var pending: Bool { ["queued", "dispatching", "steering"].contains(status) }
}
struct TaskMessageQueue: Codable {
    let dispatcherId: Int?
    let paused: Bool
    let messages: [QueuedTaskMessage]
    var error: String? = nil
    var pending: [QueuedTaskMessage] { messages.filter(\.pending) }
}
struct TaskTitleRegeneration: Codable { let requestId: String; let startedAt: String }
struct TaskSidebarActivity: Codable {
    let working: Bool
    let latestUserAuthoredMessageAt: String?
    let latestRunRequestedAt: String?
    let latestRunCompletedAt: String?
}
struct TaskBackgroundActivity: Codable {
    let commands: Int; let unknownCommands: Int
    var monitors: Int? = nil; var subagents: Int? = nil; var backgroundTasks: Int? = nil; var unknownTasks: Int? = nil; var waiting: Bool? = nil
    var canStop: Bool? = nil
    var total: Int { commands + (monitors ?? 0) + (subagents ?? 0) + (backgroundTasks ?? 0) }
}
struct TaskBackgroundCommand: Codable, Identifiable {
    let id: String; let sessionId: String; let threadId: String; let turnId: String; let itemId: String; let runId: String
    let command: String; let status: String; let startedAt: String; let updatedAt: String
    var processId: String? = nil
    var completedAt: String? = nil
    var exitCode: Int? = nil
    var stop: Stop? = nil
    struct Stop: Codable { let requestId: String; let durableId: Int; let status: String; var error: String? = nil }
    var canStop: Bool { status == "running" && processId != nil && stop?.status != "pending" }
}
struct TaskBackgroundStop: Codable {
    let requestId: String; let durableId: Int; let sessionId: String; let startedAt: String; let status: String
    var completedAt: String? = nil; var error: String? = nil
    var runId: String? = nil
}
struct TaskNativeBackgroundWork: Codable, Identifiable {
    var canStop: Bool? = nil
    let id: String; let provider: String; let sessionId: String; let transportId: String; let taskId: String; let generation: Int
    let kind: String; let status: String; let member: Bool; let backgrounded: Bool; let ambient: Bool
    let description: String; let startedAt: String; let updatedAt: String
    var nativeRunId: String? = nil; var completedAt: String? = nil; var parentTaskId: String? = nil; var summary: String? = nil
    var stop: TaskBackgroundCommand.Stop? = nil
    var output: Output? = nil
    struct Output: Codable { let text: String; let truncated: Bool }
    var terminal: Bool { ["completed", "failed", "stopped", "interrupted"].contains(status) }
    var visible: Bool { !ambient && backgrounded && (member && !terminal || status == "unknown" || stop?.status == "pending") }
    var outputEvent: TaskEvent { TaskEvent(id: id, kind: "command", text: description, at: startedAt, status: terminal ? "completed" : "running") }
    var label: String { switch kind { case "command": "后台命令"; case "monitor": "监视器"; case "subagent": "子 Agent"; default: "后台任务" } }
    var symbol: String { switch kind { case "command": "terminal"; case "monitor": "waveform.path"; case "subagent": "person.2"; default: "square.stack" } }
}
struct TaskSubagent: Codable, Identifiable {
    let id: String; let provider: String; let nativeId: String; let sessionId: String; let threadId: String
    let runId: String; let turnId: String; let eventId: String; let childTaskId: String
    let generation: Int; let childTurnId: String; let title: String; let prompt: String; let status: String
    let startedAt: String; let updatedAt: String
    var nativeRunId: String? = nil; var toolUseId: String? = nil; var parentSubagentId: String? = nil; var eventOwnerSubagentId: String? = nil
    var model: String? = nil; var reasoningEffort: String? = nil; var progress: String? = nil; var result: String? = nil; var completedAt: String? = nil
    var canStop: Bool? = nil; var stop: TaskBackgroundCommand.Stop? = nil
    var active: Bool { status == "running" || status == "waiting" }
    var statusText: String { Self.statusText(status) }
    static func statusText(_ status: String) -> String {
        switch status { case "running": "进行中"; case "waiting": "等你处理"; case "completed": "已完成"; case "failed": "执行失败"; case "cancelled": "已取消"; case "interrupted": "已中断"; default: "状态未确认" }
    }
}
struct TaskSubagentOrigin: Codable {
    let rootTaskId: String; let parentTaskId: String; let subagentId: String; let sessionId: String; let threadId: String; let nativeId: String
    var status: String? = nil
}
struct TaskNativeHistory: Codable {
    let status: String; let updatedAt: String
    var epoch: String? = nil
}

enum TaskDraftContent {
    static func hasUserContent(_ text: String, images: Int, contexts: Int, pendingContext: Bool = false) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || images > 0 || contexts > 0 || pendingContext
    }
}

struct TaskProviderGoal: Codable, Equatable {
    let objective: String; let status: String; let tokensUsed: Double; let timeUsedSeconds: Double; var tokenBudget: Double? = nil
    var canResume: Bool { status != "active" && status != "complete" }
    func title(working: Bool) -> String {
        switch status {
        case "active": return working ? "正在执行目标" : "目标已设定"
        case "paused": return "目标已暂停"
        case "blocked": return "目标需要处理"
        case "usage_limited": return "目标达到用量限制"
        case "budget_limited": return "目标达到 Token 预算"
        case "complete": return "目标已完成"
        default: return "目标已设定"
        }
    }
    var usage: String? {
        var parts: [String] = []
        if tokensUsed > 0 { parts.append(Self.tokens(tokensUsed) + (tokenBudget.map { " / " + Self.tokens($0) } ?? "") + " tokens") }
        if timeUsedSeconds >= 60, timeUsedSeconds < Double(Int.max / 2) {
            let seconds = Int(timeUsedSeconds), days = seconds / 86400, hours = seconds / 3600 % 24, minutes = seconds / 60 % 60
            parts.append(days > 0 ? "\(days)d \(hours)h" : hours > 0 ? "\(hours)h \(minutes)m" : "\(minutes)m")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    private static func tokens(_ value: Double) -> String {
        if value < 1000 { return String(format: "%.0f", value) }
        if value < 1_000_000 { return String(format: "%.0fk", (value / 1000).rounded()) }
        let text = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), value / 1_000_000)
        return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + "m"
    }
}
struct TaskFeedbackReceipt: Codable, Identifiable {
    let requestId: String; let taskId: String; let threadId: String; let command: String; let status: String; let createdAt: String
    var completedAt: String? = nil; var feedbackId: String? = nil; var error: String? = nil
    var id: String { requestId }
}
struct WorkItem: Codable, Identifiable {
    var modelOptions: [ProviderOptionSelection]? = nil
    var providerInstanceId: String? = nil
    var resolvedProviderInstance: String { providerInstanceId ?? agent }
    var goal: TaskProviderGoal? = nil
    var feedback: [TaskFeedbackReceipt]? = nil
    struct ArchiveCleanup: Codable { let id: String; let durableId: Int; let status: String; let startedAt: String; var completedAt: String? = nil; var error: String? = nil }
    var archiveCleanup: ArchiveCleanup? = nil
    var settleCleanup: ArchiveCleanup? = nil
    var canSettle: Bool? = nil
    var contextUsage: TaskContextUsage? = nil
    var nativeHistory: TaskNativeHistory? = nil
    var subagents: [TaskSubagent]? = nil
    var subagentOrigin: TaskSubagentOrigin? = nil
    var pendingSubagentRequest: String? = nil
    let id: String; let title: String; let prompt: String; let projectId: String?; let cwd: String
    let agent: String; let mode: String; let status: String; let createdAt: String; let updatedAt: String
    let durableId: Int?; let threadId: String?; let turnId: String?
    let result: String; let error: String?; var events: [TaskEvent]; let approvals: [Approval]; let artifact: String?
    var executionSessionId: String? = nil
    var backgroundCommands: [TaskBackgroundCommand]? = nil
    var backgroundStop: TaskBackgroundStop? = nil
    var nativeBackgroundWork: [TaskNativeBackgroundWork]? = nil
    var nativeBackgroundConnected: Bool? = nil
    var backgroundWaiting: Bool? = nil
    var backgroundActivity: TaskBackgroundActivity? = nil
    let workspaceRequest: String?; var messages: [ChatMessage]?
    let parentId: String?; let model: String?; let reasoningEffort: String?
    var git: TaskGitContext? = nil
    var branchChange: TaskBranchChange? = nil
    var pinnedAt: String? = nil
    var pinOrderKey: String? = nil
    var activeOrderKey: String? = nil
    var sidebarSettledAt: String? = nil
    var sidebarActivity: TaskSidebarActivity? = nil
    var settlementManaged: Bool? = nil
    var settledOverride: String? = nil
    var lastSnoozeWakeAt: String? = nil
    var archivedAt: String? = nil
    var settledAt: String? = nil
    var unsettledAt: String? = nil
    var snoozedUntil: String? = nil
    var snoozedAt: String? = nil
    var snoozed: Bool? = nil
    var canSnooze: Bool? = nil
    var snoozeWakeAt: String? = nil
    var seenSnoozeWakeAt: String? = nil
    var autoSettle: Bool? = nil
    var unread: Bool? = nil
    var readAt: String? = nil
    var queue: TaskMessageQueue? = nil
    var canSteer: Bool? = nil
    var interactionMode: String? = nil
    var localAgent: Bool { agent != "friday" }
    var gitOperation: TaskGitOperation? = nil
    var runs: [TaskRun]? = nil
    var currentRunId: String? = nil
    var rewindOperation: TaskRewindOperation? = nil
    var claudeResumeSessionAt: String? = nil
    var claudeResumePendingRun: String? = nil
    var terminals: [TaskTerminalSummary]? = nil
    var forkOrigin: TaskForkOrigin? = nil
    var forkOperation: TaskForkOperation? = nil
    var history: TaskHistoryInfo? = nil
    var conversationHistory: TaskConversationHistory? = nil
    var contentOmitted: Bool? = nil
    var contentVersion: String? = nil
    var contentSequence: Int? = nil
    var activityStartedAt: String? = nil
    var pullRequests: [TaskPullRequest]? = nil
    var branchPullRequest: TaskPullRequest? = nil
    var changeRequestLinksRevision: Int? = nil
    var changeRequestOperations: [TaskChangeRequestOperation]? = nil
    var changeRequestGuideRuns: [TaskReviewGuideRun]? = nil
    var changeRequestStacks: [String: TaskChangeRequestStack?]? = nil
    var titleRegeneration: TaskTitleRegeneration? = nil
    var titleGenerationSupported: Bool? = nil
    var preparationFailure: TaskRun? { runs?.first { $0.id == currentRunId && $0.preparationFailed } }
    var preparingWorkspace: TaskWorkspacePreparation? {
        guard ["queued", "running"].contains(status), let run = runs?.first(where: { $0.id == currentRunId }), let preparation = run.workspacePreparation, preparation.status == "preparing" || preparation.status == "ready" && run.startedAt == nil && run.before == nil else { return nil }
        return run.workspacePreparation
    }
    func canRetryPreparation(_ run: TaskRun) -> Bool {
        run.preparationFailed && run.before == nil && run.turnId == nil && run.inheritedFrom == nil && !active && !gitBusy && !sessionBusy && branchChange?.active != true && archivedAt == nil
    }
    var rewindBusy: Bool { rewindOperation?.active == true }
    var forkBusy: Bool { forkOperation?.active == true }
    var backgroundStopPending: Bool { backgroundStop?.status == "pending" }
    var backgroundStopAvailable: Bool {
        if let canStop = backgroundActivity?.canStop { return canStop }
        guard let source = executionSessionId else { return false }
        let commands = backgroundCommands?.contains { $0.sessionId == source && (["running", "unknown"].contains($0.status) || $0.stop?.status == "pending") } == true
        let native = nativeBackgroundWork?.contains { $0.transportId == source && $0.visible } == true
        let operation = backgroundStop.map { $0.sessionId == source && ($0.runId == nil || $0.runId == currentRunId) && ["pending", "uncertain"].contains($0.status) } == true
        return commands || native || operation
    }
    var sessionBusy: Bool { rewindBusy || forkBusy || backgroundStopPending || archiveCleanup?.status == "pending" || settleCleanup?.status == "pending" }
    var gitBusy: Bool { gitOperation?.active == true }
    var agentName: String { agent == "claude" ? "Claude Code" : TaskProviderCatalog.name(agent) }
    var conversation: [ChatMessage] {
        var history = messages?.filter { $0.revertedAt == nil } ?? [ChatMessage(id: "original-user", role: "user", text: prompt)]
        if !result.isEmpty && (history.last?.role != "assistant" || history.last?.text != result) { history.append(ChatMessage(id: "current-answer", role: "assistant", text: result)) }
        return history
    }
    var queueActive: Bool { queue?.dispatcherId != nil && queue?.paused == false }
    var activityStatus: String { queueActive && !["queued", "running", "waiting"].contains(status) ? "queued" : status }
    var active: Bool { ["queued", "running", "waiting"].contains(status) || queueActive }
    var watchingPullRequests: Bool { pullRequests?.contains { $0.watch != nil && $0.dismissedAt == nil && $0.linkSource != "stack-dismissed" } == true }
    var statusText: String {
        if settleCleanup?.status == "pending" { return "正在清理会话…" }
        if settleCleanup?.status == "interrupted" { return "会话清理待确认" }
        if let status = subagentOrigin?.status { return TaskSubagent.statusText(status) }
        if backgroundStopPending { return "正在停止后台工作…" }
        if pendingSubagentRequest != nil { return "等你处理" }
        if watchingPullRequests && !active { return "正在自动跟进" }
        if forkBusy { return forkOperation?.running == true ? "准备分叉中" : "分叉待处理" }
        if backgroundWaiting == true, !approvals.contains(where: { $0.state == "pending" }) { return "等待后台任务" }
        return switch activityStatus {
        case "queued": "排队中"
        case "running": "进行中"
        case "waiting": "等你处理"
        case "needs_project": "等你选择目录"
        case "completed": "已完成"
        case "failed": "执行失败"
        case "cancelled": "已取消"
        case "interrupted": "待恢复"
        default: status
        }
    }
}
struct TaskHistoryRecent: Codable { let id: String; let position: Int; let digest: String }
struct TaskHistoryInfo: Codable { let count: Int; let version: Int; let epoch: String; let nextCursor: String?; let coverage: String; let recent: [TaskHistoryRecent] }
struct TaskHistoryPage: Decodable {
    let taskId: String; let epoch: String; let version: Int; let count: Int; let from: Int; let to: Int
    let events: [TaskEvent]; let nextCursor: String?; let coverage: String
}
struct TaskConversationTouch: Codable { let id: String; let digest: String }
struct TaskConversationHistory: Codable {
    let epoch: String; let sequence: Int; let from: Int; let to: Int; let count: Int
    let nextCursor: String?; let hasEarlier: Bool; let touchVersion: Int; let touches: [TaskConversationTouch]
    var messageVersion: Int? = nil; var messageTouches: [String]? = nil
    var kind: String? = nil; var visibleMessageIds: [String]? = nil; var payloadBudgetExceeded: Bool? = nil
}
struct TaskConversationPage: Decodable {
    let taskId: String; let epoch: String; let sequence: Int; let from: Int; let to: Int; let count: Int
    let nextCursor: String?; let hasEarlier: Bool; let touchVersion: Int; let touches: [TaskConversationTouch]
    let messages: [ChatMessage]; let events: [TaskEvent]
    var messageVersion: Int? = nil; var messageTouches: [String]? = nil
    var kind: String? = nil; var visibleMessageIds: [String]? = nil; var payloadBudgetExceeded: Bool? = nil; var beforeCursor: String? = nil
}
struct TaskEventPage: Decodable {
    let taskId: String; let epoch: String; let sequence: Int; let events: [TaskEvent]; let missing: [String]
    var messages: [ChatMessage]? = nil
}
struct TaskServiceIdentity {
    private var connection = ""
    private var identity: String?
    func value(for connection: String) -> String? { self.connection == connection ? identity : nil }
    mutating func observe(_ supplied: String?, connection: String, authoritative: Bool) {
        if self.connection != connection { identity = nil }; self.connection = connection
        if let supplied, supplied.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil { identity = supplied }
        else if authoritative { identity = nil }
    }
}
struct Snapshot: Decodable {
    let revision: Int; let ideas: [Idea]; let projects: [Project]; let memories: [MemoryItem]; let tasks: [WorkItem]
    let agents: [AgentInfo]?; let devices: [Device]?; let deviceId: String?
    var serviceId: String? = nil
    var notesVersion: Int? = nil
    var taskStreamSession: String? = nil
    var taskStreamSerial: Int? = nil
    var textGenerationSettingsVersion: Int? = nil
    var taskSidebarOrderingSupported: Bool? = nil
    var taskExistingWorkspaceSupported: Bool? = nil
    var taskComposerCommandsSupported: Bool? = nil
    var taskArchiveLifecycleSupported: Bool? = nil
    var providerResetCreditsSupported: Bool? = nil
    var providerConfigurationVersions: [String: Int]? = nil
    var providerUsageSnapshots: [String: TaskProviderUsageLimits]? = nil
    var usageLimitSources: [TaskUsageSourceSnapshot]? = nil
    var usageLimitSourcesSupported: Bool? = nil
    var taskSidebarWorkingSupported: Bool? = nil
    var taskSidebarProjectScopesSupported: Bool? = nil
    var taskScratchWorkspaceSupported: Bool? = nil
    var scratchWorkspaceRoot: String? = nil
    var namedProjectCreationSupported: Bool? = nil
    var newProjectsRoot: String? = nil
    var projectRepositoryOperationsSupported: Bool? = nil
    var projectRepositoryOperations: [ProjectRepositoryOperation]? = nil
    var taskAutoSettlementSupported: Bool? = nil
    var taskBackgroundCommandsSupported: Bool? = nil
    var taskNativeBackgroundSupported: Bool? = nil
    var taskBackgroundSettlementSupported: Bool? = nil
    var taskSettlementSettingsVersion: Int? = nil
    var sourceControlPreferencesVersion: Int? = nil
}

struct TextGenerationModelSelection: Codable, Equatable {
    var modelOptions: [ProviderOptionSelection]? = nil
    var providerInstanceId: String? = nil
    var agent: String; var model: String; var reasoningEffort: String
    var body: [String: Any] { var value: [String: Any] = ["agent": agent, "model": model, "reasoningEffort": reasoningEffort]; if let providerInstanceId { value["providerInstanceId"] = providerInstanceId }; if let modelOptions { value["modelOptions"] = modelOptions.map(\.body) }; return value }
}
struct SourceControlWritingStyle: Codable, Equatable {
    var mode: String; var customInstructions: String; var followChangeRequestTemplates: Bool
    static let standard = SourceControlWritingStyle(mode: "repo_conventions", customInstructions: "", followChangeRequestTemplates: true)
    var body: [String: Any] { ["mode": mode, "customInstructions": customInstructions, "followChangeRequestTemplates": followChangeRequestTemplates] }
}
struct TextGenerationScope: Decodable {
    let textGenerationModelSelection: TextGenerationModelSelection?
    let sourceControlWriterModelSelection: TextGenerationModelSelection?
    let hasSourceControlWriterOverride: Bool
    let reviewGuidesEnabled: Bool?; let reviewGuideModelSelection: TextGenerationModelSelection?; let reviewGuideInstructions: String?; let hasReviewGuideOverride: Bool
    let sourceControlWritingStyle: SourceControlWritingStyle?
    private enum CodingKeys: String, CodingKey { case textGenerationModelSelection, sourceControlWriterModelSelection, sourceControlWritingStyle, reviewGuidesEnabled, reviewGuideModelSelection, reviewGuideInstructions }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        textGenerationModelSelection = try values.decodeIfPresent(TextGenerationModelSelection.self, forKey: .textGenerationModelSelection)
        sourceControlWriterModelSelection = try values.decodeIfPresent(TextGenerationModelSelection.self, forKey: .sourceControlWriterModelSelection)
        hasSourceControlWriterOverride = values.contains(.sourceControlWriterModelSelection)
        hasReviewGuideOverride = values.contains(.reviewGuideModelSelection)
        reviewGuidesEnabled = try values.decodeIfPresent(Bool.self, forKey: .reviewGuidesEnabled)
        reviewGuideModelSelection = try values.decodeIfPresent(TextGenerationModelSelection.self, forKey: .reviewGuideModelSelection)
        reviewGuideInstructions = try values.decodeIfPresent(String.self, forKey: .reviewGuideInstructions)
        sourceControlWritingStyle = try values.decodeIfPresent(SourceControlWritingStyle.self, forKey: .sourceControlWritingStyle)
    }
}
struct TextGenerationEffectiveSettings: Decodable {
    let reviewGuidesEnabled: Bool?; let reviewGuideModelSelection: TextGenerationModelSelection?; let reviewGuideInstructions: String?
    let textGenerationModelSelection: TextGenerationModelSelection
    let sourceControlWriterModelSelection: TextGenerationModelSelection
    let sourceControlWritingStyle: SourceControlWritingStyle?
}
protocol ScopedSettingsSnapshot { var version: Int { get }; var projectId: String? { get } }
struct SourceControlPreferenceScope: Decodable { let removeAgentCreditsOnMerge: Bool?; let newWorktreesStartFromOrigin: Bool?; let worktreeSubmodules: String? }
struct SourceControlPreferencesSnapshot: Decodable, ScopedSettingsSnapshot {
    let version: Int; let projectId: String?
    let defaults: SourceControlPreferenceScope; let overrides: SourceControlPreferenceScope; let effective: SourceControlPreferenceScope; let source: String
    var sources: [String: String]? = nil
}
struct TextGenerationSettingsSnapshot: Decodable, ScopedSettingsSnapshot {
    let version: Int; let projectId: String?
    let defaults: TextGenerationScope; let overrides: TextGenerationScope; let effective: TextGenerationEffectiveSettings
    let sources: [String: String]; let enabled: [String: Bool]
}
struct TaskSettlementScope: Decodable {
    let sidebarAutoSettleAfterDays: Double?
    let sidebarAutoSettleOnMerge: Bool?; let sidebarAutoSettleKeepPullRequests: Bool?
    let hasDaysOverride: Bool
    private enum CodingKeys: String, CodingKey { case sidebarAutoSettleAfterDays, sidebarAutoSettleOnMerge, sidebarAutoSettleKeepPullRequests }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        sidebarAutoSettleAfterDays = try values.decodeIfPresent(Double.self, forKey: .sidebarAutoSettleAfterDays)
        hasDaysOverride = values.contains(.sidebarAutoSettleAfterDays)
        sidebarAutoSettleOnMerge = try values.decodeIfPresent(Bool.self, forKey: .sidebarAutoSettleOnMerge)
        sidebarAutoSettleKeepPullRequests = try values.decodeIfPresent(Bool.self, forKey: .sidebarAutoSettleKeepPullRequests)
    }
}
struct TaskSettlementSettingsSnapshot: Decodable, ScopedSettingsSnapshot {
    let version: Int; let projectId: String?
    let defaults: TaskSettlementScope; let overrides: TaskSettlementScope; let effective: TaskSettlementScope; let source: String
    var sources: [String: String]? = nil
}
struct OutboxIdea: Codable, Identifiable, Equatable {
    let id: String; var text: String
    var title: String? = nil
    var createdAt: String? = nil
    var images: [IdeaImage]? = nil
    var expectedUpdatedAt: String? = nil
    var editId: String? = nil
    var taskId: String? = nil
    var note: Idea { Idea(id: id, text: text, createdAt: createdAt ?? "", taskId: taskId, title: title, updatedAt: expectedUpdatedAt, images: images) }
}
struct PairingCode: Decodable { let code: String; let expiresAt: String }
struct PairedDevice: Decodable { let id: String; let token: String }
struct IDResponse: Decodable { let id: String }
struct APIError: Decodable { let error: String; var reason: String? = nil; var retryAt: Double? = nil }

struct TaskSourceLineRange: Equatable, Codable {
    let start: Int; let end: Int
    init(_ start: Int, _ end: Int) { self.start = max(1, min(start, end)); self.end = max(self.start, max(start, end)) }
    var label: String { start == end ? "L\(start)" : "L\(start) to L\(end)" }
}
struct TaskFileReviewDraft: Codable, Equatable {
    let commentID: String
    let scope: String; let target: String; let workspaceRoot: String; let workspaceVersion: String
    let path: String; let range: TaskSourceLineRange; let comment: String; let contents: String
    var diffReview: TaskDiffReviewMetadata? = nil
}
struct TaskDiffReviewPoint: Codable, Equatable { let line: Int; let side: String }
struct TaskDiffReviewSelection: Codable, Equatable {
    let start: Int; let side: String; let end: Int; let endSide: String
    var first: TaskDiffReviewPoint { TaskDiffReviewPoint(line: start, side: side) }
    var last: TaskDiffReviewPoint { TaskDiffReviewPoint(line: end, side: endSide) }
}
struct TaskDiffReviewMetadata: Codable, Equatable {
    let sectionID: String; let sectionTitle: String; let startIndex: Int; let endIndex: Int
    let rangeLabel: String; let selection: TaskDiffReviewSelection
    var contextLabel: String {
        guard rangeLabel.hasPrefix("+") || rangeLabel.hasPrefix("-") else { return rangeLabel }
        let label = rangeLabel.replacingOccurrences(of: #"[+-](\d+)"#, with: "L$1", options: .regularExpression)
        return label + (rangeLabel.hasPrefix("-") ? " (before)" : "")
    }
}
struct TaskContextReference: Codable, Equatable, Identifiable {
    let id: String; let kind: String; let label: String; let capturedAt: String; let digest: String; let byteLength: Int
    let path: String?; let terminalId: String?; let terminalLabel: String?; let generation: Int?
    let lineStart: Int?; let lineEnd: Int?; let truncated: Bool?
    var reviewDraft: TaskFileReviewDraft? = nil
    var annotationDraft: TaskBrowserAnnotationDraft? = nil
    var symbol: String { kind == "review-guide" ? "map" : kind == "preview-annotation" ? "cursorarrow.click" : kind == "review-comment" ? "text.bubble" : kind == "terminal" ? "terminal" : kind == "directory" ? "folder" : kind == "code" ? "chevron.left.forwardslash.chevron.right" : "doc.text" }
}
struct TaskBrowserElementSource:Codable,Equatable {
    var functionName:String?;var fileName:String?;var lineNumber:Int?;var columnNumber:Int?
}
struct TaskBrowserElementDetails:Codable,Equatable {
    var pageUrl:String;var pageTitle:String?;var tagName:String;var selector:String?
    var htmlPreview:String;var componentName:String?;var source:TaskBrowserElementSource?;var styles:String
}
struct TaskBrowserStyleChange:Codable,Equatable {
    var targetId:String;var selector:String?;var property:String;var previousValue:String;var value:String
}
struct TaskBrowserAnnotationRecord:Codable,Equatable {
    var version=1
    var annotationId:String;var pageUrl:String;var pageTitle:String?;var comment:String
    var elements:[TaskBrowserElementDetails];var elementIds:[String];var styleChangeDetails:[TaskBrowserStyleChange]
    var regionCount:Int;var strokeCount:Int
    var screenshotImageId:String?=nil
}
struct TaskBrowserAnnotationDraft:Codable,Equatable {
    let record:TaskBrowserAnnotationRecord
    let target:String;let scope:String;let workspaceRoot:String
}
struct TaskBrowserAnnotationPoint:Codable,Equatable {var x:Double;var y:Double}
struct TaskBrowserAnnotationRect:Codable,Equatable {var x:Double;var y:Double;var width:Double;var height:Double}
struct TaskBrowserAnnotationElement:Codable,Equatable {
    var id:String;var element:TaskBrowserElementDetails;var rect:TaskBrowserAnnotationRect
}
struct TaskBrowserAnnotationRegion:Codable,Equatable {var id:String;var rect:TaskBrowserAnnotationRect}
struct TaskBrowserAnnotationStroke:Codable,Equatable {
    var id:String;var color:String;var width:Double;var points:[TaskBrowserAnnotationPoint];var bounds:TaskBrowserAnnotationRect
}
struct TaskContextSnapshot: Codable { let reference: TaskContextReference; let cwd: String; let text: String }
struct TaskMentionQuery: Codable, Equatable {
    let text: String; let range: NSRange; let source: String
    var kind: String? = nil
}
struct TaskContextInsertion: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var reference: TaskContextReference? = nil
    var citation: TaskAssistantCitation? = nil
    var alreadyInserted: Bool? = nil
    var caret: Int? = nil
    var replacing: TaskMentionQuery? = nil
    var focus = false
    var identity = ""
    var previousOccurrences = 0
    var additional: [TaskContextReference]? = nil
    var atEnd: Bool? = nil
    var plainText: String? = nil
}
struct TaskAssistantCitation: Codable, Equatable {
    var version = 1
    let environmentId: String; let threadId: String; let messageId: String
    let text: String; let start: Int; let end: Int; let prefix: String; let suffix: String
    var comment: String? = nil
}
struct TaskFileEntry: Decodable, Equatable, Identifiable {
    let path: String; let name: String; let kind: String
    var ignored: Bool? = nil
    var detail: String? = nil
    var id: String { path }
    var symbol: String { kind == "directory" ? "folder" : kind == "skill" ? "sparkles" : ["builtin", "provider-command"].contains(kind) ? "terminal" : "doc.text" }
}
struct TaskFileListing: Decodable { let entries: [TaskFileEntry]; let truncated: Bool }
struct TaskFilePreview: Decodable {
    let path: String; let text: String; let lineStart: Int; let lineEnd: Int; let truncated: Bool; let version: String
}

struct TaskTerminalSummary: Codable, Equatable, Identifiable {
    let id: String; let taskId: String; let generation: Int; let cwd: String; let shell: String; let label: String; let title: String; let status: String
    let pid: Int?; let cols: Int; let rows: Int; let sequence: Int; let baseSequence: Int; let hasRunningSubprocess: Bool
    let createdAt: String; let updatedAt: String; let exitCode: Int?; let exitSignal: Int?; let error: String?; let historyTruncated: Bool?
    var canType: Bool { status == "running" }
    var canRestart: Bool { !["starting", "closing"].contains(status) }
}
struct TaskTerminalEvent: Decodable {
    let type: String; let generation: Int; let sequence: Int
    let terminal: TaskTerminalSummary?; let history: String?; let data: String?; let truncated: Bool?
}
