import Foundation

struct ProjectScript: Codable, Equatable, Identifiable {
    var id: String = UUID().uuidString
    var name = ""
    var command = ""
    var icon = "play"
    var runOnWorktreeCreate = false
    var runOnSettle: Bool? = nil
    var async: Bool? = nil
    var previewUrl: String? = nil
    var autoOpenPreview: Bool? = nil
    var symbol: String {
        switch icon { case "test": "checkmark.circle"; case "lint": "checklist"; case "configure": "gearshape"; case "build": "hammer"; case "debug": "ladybug"; default: "play" }
    }
    var valid: Bool { !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: [String: Any] { (try? JSONSerialization.jsonObject(with: JSONEncoder().encode(self))) as? [String: Any] ?? [:] }
    static func primary(_ scripts: [Self], preferred: String? = nil) -> Self? { scripts.first { $0.id == preferred } ?? scripts.first { !$0.runOnWorktreeCreate && $0.runOnSettle != true } ?? scripts.first { $0.runOnSettle != true } }
    static func claimRole(_ id: String, setup: Bool, enabled: Bool, in scripts: inout [Self]) {
        for index in scripts.indices {
            if scripts[index].id == id { if setup { scripts[index].runOnWorktreeCreate = enabled } else { scripts[index].runOnSettle = enabled } }
            else if enabled { if setup { scripts[index].runOnWorktreeCreate = false } else { scripts[index].runOnSettle = false } }
        }
    }
}
struct ProjectScriptSettingsSnapshot: Decodable {
    let version: Int; let projectId: String?; let defaults: [ProjectScript]; let scripts: [ProjectScript]; let source: String
    let keybindings: [String: String]?
}
struct ProjectScriptRun: Decodable, Equatable, Identifiable {
    let id: String; let projectId: String; let taskId: String?; let preparationId: String?
    let requestId: String; let script: ProjectScript; let trigger: String; let cwd: String
    let terminalOwner: String; let terminalId: String; let generation: Int?; let status: String
    let startedAt: String?; let exitCode: Int?; let error: String?
    let progress: String?
    var active: Bool { status == "queued" || status == "running" }
    var label: String { switch status { case "queued": "等待脚本"; case "running": "脚本运行中"; case "completed": "脚本已完成"; case "failed": "脚本失败"; case "cancelled": "脚本已停止"; default: "脚本结果待确认" } }
}
struct TaskProjectScriptsSnapshot: Decodable { let scripts: [ProjectScript]; let runs: [ProjectScriptRun]; let keybindings: [String: String]?; let worktreeSetup: TaskWorktreeSetupSnapshot? }
struct ProjectScriptRunReceipt: Decodable { let run: ProjectScriptRun; let terminal: TaskTerminalSummary? }
struct ProjectScriptRunsSnapshot: Decodable { let runs: [ProjectScriptRun] }
struct ProjectScriptIdentifier: Decodable, Identifiable { let id: String }
struct ProjectScriptImport: Decodable { let scripts: [ProjectScript] }
struct PendingProjectScript: Codable { let scriptId: String; let requestId: String }
