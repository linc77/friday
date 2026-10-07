import Foundation

struct Idea: Codable, Identifiable { let id: String; let text: String; let createdAt: String; let taskId: String? }
struct Project: Codable, Identifiable { let id: String; var name: String; let path: String; var context: String }
struct MemoryItem: Codable, Identifiable { let id: String; let text: String; let updatedAt: String }
struct AgentInfo: Codable, Identifiable { let id: String; let name: String; let installed: Bool; let executable: String?; let executableSupported: Bool; let description: String }
struct Device: Codable, Identifiable { let id: String; let name: String; let createdAt: String }
struct TaskEvent: Codable, Identifiable { let id: String; let kind: String; let text: String; let at: String }
struct QuestionOption: Codable { let label: String; let description: String }
struct Question: Codable, Identifiable { let id: String; let header: String; let question: String; let options: [QuestionOption] }
struct Approval: Codable, Identifiable { let id: String; let method: String; let title: String; let detail: String; let questions: [Question]; let state: String }
struct ChatMessage: Codable, Identifiable { let id: String; let role: String; let text: String }
struct CodexEnvironmentVariable: Codable, Identifiable, Equatable {
    var name: String; var value: String?; var hasValue: Bool?
    var id: String { name }
}
struct CodexProviderSettings: Codable, Equatable {
    var enabled = true; var displayName = "Codex"; var binaryPath = "codex"
    var homePath = ""; var shadowHomePath = ""; var launchArgs = ""
    var model = ""; var reasoningEffort = ""; var environment: [CodexEnvironmentVariable] = []
    var body: [String: Any] {
        var body = (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:]
        body["environment"] = environment.map { ["name": $0.name, "value": $0.value as Any? ?? NSNull()] }
        return body
    }
}
struct CodexProviderModel: Decodable, Identifiable {
    let id: String; let name: String; let description: String; let isDefault: Bool
    let reasoningEfforts: [String]; let defaultReasoningEffort: String
}
struct CodexAccount: Decodable { let type: String; let email: String?; let plan: String? }
struct ModelConnectionState: Decodable { let provider: String; let model: String; let connected: Bool }
struct CodexConnectionState: Decodable {
    let provider: String; let displayName: String; let enabled: Bool; let model: String; let connected: Bool
    let installed: Bool; let version: String?; let account: CodexAccount?; let models: [CodexProviderModel]
    let checkedAt: String; let error: String?; let loginPending: Bool; let settings: CodexProviderSettings?
}
struct CodexLoginResponse: Decodable { let url: String }
struct WorkItem: Codable, Identifiable {
    let id: String; let title: String; let prompt: String; let projectId: String?; let cwd: String
    let agent: String; let mode: String; let status: String; let createdAt: String; let updatedAt: String
    let durableId: Int?; let threadId: String?; let turnId: String?
    let result: String; let error: String?; let events: [TaskEvent]; let approvals: [Approval]; let artifact: String?
    let workspaceRequest: String?; let messages: [ChatMessage]?
    let parentId: String?; let model: String?; let reasoningEffort: String?
    var localAgent: Bool { agent != "friday" }
    var agentName: String { agent == "codex" ? "Codex" : "Friday" }
    var conversation: [ChatMessage] {
        var history = messages ?? [ChatMessage(id: "original-user", role: "user", text: prompt)]
        if !result.isEmpty && (history.last?.role != "assistant" || history.last?.text != result) { history.append(ChatMessage(id: "current-answer", role: "assistant", text: result)) }
        return history
    }
    var active: Bool { ["queued", "running", "waiting"].contains(status) }
    var statusText: String {
        switch status {
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
struct Snapshot: Decodable {
    let revision: Int; let ideas: [Idea]; let projects: [Project]; let memories: [MemoryItem]; let tasks: [WorkItem]
    let agents: [AgentInfo]?; let devices: [Device]?; let deviceId: String?
}
struct OutboxIdea: Codable, Identifiable { let id: String; let text: String }
struct PairingCode: Decodable { let code: String; let expiresAt: String }
struct PairedDevice: Decodable { let id: String; let token: String }
struct IDResponse: Decodable { let id: String }
struct APIError: Decodable { let error: String }
