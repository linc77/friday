import Foundation

struct TaskWorktreeSetupSnapshot: Decodable, Equatable {
    let threadId: String; let runId: String; let attempt: Int; let phase: String
    let startedAt: String; let endedAt: String?; let branch: String?; let baseRef: String?; let worktreePath: String?
    struct Script: Decodable, Equatable { let runId: String; let name: String; let command: String; let terminalId: String }
    struct Stage: Decodable, Equatable, Identifiable {
        let id: String; let status: String; let startedAt: String?; let endedAt: String?; let percent: Int?; let detail: String?; let tail: [String]
        var label: String { switch id { case "fetch": "获取基准分支"; case "checkout": "检出文件"; case "submodules": "初始化子模块"; case "setup-script": "运行初始化脚本"; case "agent": "启动 Agent"; default: id } }
        var symbol: String { switch status { case "done": "checkmark.circle"; case "failed": "exclamationmark.circle"; case "skipped": "minus.circle"; case "warning": "exclamationmark.triangle"; default: "circle.dashed" } }
    }
    let setupScript: Script?; let stages: [Stage]; let error: String?
    var sequence: Int
    var active: Bool { phase == "running" }
    var handedOff: Bool { stages.contains { $0.id == "agent" && $0.status == "done" } }
    var canCancel: Bool { active && !handedOff }
    func belongs(to task: WorkItem) -> Bool {
        threadId == task.id && (active || runId == task.currentRunId) && task.runs?.contains(where: { $0.id == runId && $0.revertedAt == nil && $0.workspacePreparation?.attempt == attempt }) == true
    }
    func samePresentation(as other: Self) -> Bool {
        var lhs = self, rhs = other; lhs.sequence = 0; rhs.sequence = 0; return lhs == rhs
    }
}
