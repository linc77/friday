import Foundation

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
struct Project: Codable, Identifiable { let id: String; var name: String; let path: String; var context: String }
struct MemoryItem: Codable, Identifiable { let id: String; let text: String; let updatedAt: String }
struct AgentInfo: Codable, Identifiable { let id: String; let name: String; let installed: Bool; let executable: String?; let executableSupported: Bool; let description: String }
struct Device: Codable, Identifiable { let id: String; let name: String; let createdAt: String }
struct TaskEvent: Codable, Identifiable {
    let id: String; let kind: String; let text: String; let at: String
    let itemId: String?; let turnId: String?; let phase: String?; let status: String?
    let detail: String?; let completedAt: String?; let durationMs: Double?; let exitCode: Int?
    init(id: String, kind: String, text: String, at: String, itemId: String? = nil, turnId: String? = nil, phase: String? = nil, status: String? = nil, detail: String? = nil, completedAt: String? = nil, durationMs: Double? = nil, exitCode: Int? = nil) {
        self.id = id; self.kind = kind; self.text = text; self.at = at; self.itemId = itemId; self.turnId = turnId
        self.phase = phase; self.status = status; self.detail = detail; self.completedAt = completedAt; self.durationMs = durationMs; self.exitCode = exitCode
    }
}
struct QuestionOption: Codable { let label: String; let description: String }
struct Question: Codable, Identifiable { let id: String; let header: String; let question: String; let options: [QuestionOption] }
struct Approval: Codable, Identifiable { let id: String; let method: String; let title: String; let detail: String; let questions: [Question]; let state: String }
struct ChatMessage: Codable, Identifiable {
    let id: String; let role: String; let text: String; let at: String?; let turnId: String?
    init(id: String, role: String, text: String, at: String? = nil, turnId: String? = nil) {
        self.id = id; self.role = role; self.text = text; self.at = at; self.turnId = turnId
    }
}
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
    var notesVersion: Int? = nil
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
struct APIError: Decodable { let error: String }
