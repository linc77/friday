import Foundation

@main struct ProjectScriptTests {
    static func main() throws {
        let decoder = JSONDecoder()
        let configured = try decoder.decode(ProjectScriptSettingsSnapshot.self, from: Data(#"{"version":3,"projectId":"p","defaults":[],"scripts":[{"id":"setup","name":"初始化","command":"printf ready","icon":"configure","runOnWorktreeCreate":true,"async":false},{"id":"dev","name":"Dev","command":"pnpm dev","icon":"play","runOnWorktreeCreate":false,"previewUrl":"http://localhost:3000","autoOpenPreview":true},{"id":"cleanup","name":"Cleanup","command":"true","icon":"lint","runOnWorktreeCreate":false,"runOnSettle":true}],"source":"project"}"#.utf8))
        precondition(configured.scripts[0].async == false)
        precondition(configured.scripts[1].async == nil, "Missing async retains T3's default of asynchronous setup")
        precondition(ProjectScript.primary(configured.scripts)?.id == "dev")
        precondition(ProjectScript.primary([configured.scripts[0], configured.scripts[2]])?.id == "setup")
        precondition(ProjectScript.primary([configured.scripts[2]]) == nil)
        precondition(ProjectScript.primary(configured.scripts, preferred: "cleanup")?.id == "cleanup")
        precondition(ProjectScript.primary(configured.scripts, preferred: "deleted")?.id == "dev")
        var roles = configured.scripts
        ProjectScript.claimRole("dev", setup: true, enabled: true, in: &roles)
        precondition(!roles[0].runOnWorktreeCreate && roles[1].runOnWorktreeCreate && roles[2].runOnSettle == true)
        ProjectScript.claimRole("dev", setup: false, enabled: true, in: &roles)
        precondition(roles[1].runOnSettle == true && roles[2].runOnSettle == false)
        let shortcut = ProjectScriptShortcut("control+option+mod+shift+k")!
        precondition(shortcut.label == "⌃⌥⇧⌘K" && shortcut.matches(key: "k", command: true, control: true, shift: true, option: true))
        precondition(!shortcut.matches(key: "k", command: true, control: false, shift: true, option: true))
        precondition(!shortcut.matches(key: "k", command: true, control: true, shift: true, option: true, repeating: true))
        precondition(ProjectScriptShortcut("mod++")?.key == "+" && ProjectScriptShortcut("cmd+esc")?.key == "escape")
        precondition(ProjectScriptShortcut("mod+k+j") == nil && ProjectScriptShortcut("mod+space")?.key == " ")
        for number in 1...24 {
            let scalar = String(UnicodeScalar(0xf704 + number - 1)!)
            precondition(ProjectScriptShortcut.keyName(scalar) == "f\(number)")
            precondition(ProjectScriptShortcut.captured(key: scalar, command: false, control: false, shift: false, option: false) == "f\(number)")
        }
        precondition(ProjectScriptShortcut.captured(key: "k", command: false, control: false, shift: true, option: false) == nil)
        precondition(ProjectScriptShortcut.captured(key: "\u{f702}", command: true, control: false, shift: false, option: true) == "meta+alt+arrowleft")
        let roundTrip = try decoder.decode(ProjectScript.self, from: JSONEncoder().encode(configured.scripts[1]))
        precondition(roundTrip == configured.scripts[1] && roundTrip.autoOpenPreview == true)
        precondition(configured.scripts[0].body["async"] as? Bool == false && configured.scripts[1].body["async"] == nil)
        let receipt = try decoder.decode(ProjectScriptRunReceipt.self, from: Data(#"{"run":{"id":"r","projectId":"p","preparationId":"prepared","requestId":"nonce","script":{"id":"s","name":"Setup","command":"true","icon":"play","runOnWorktreeCreate":true},"trigger":"setup","cwd":"/project/worktree","terminalOwner":"script-r","terminalId":"script-r","status":"queued"}}"#.utf8))
        precondition(receipt.run.active && receipt.run.taskId == nil && receipt.terminal == nil)
        precondition(receipt.run.preparationId == "prepared")
        let pending = PendingProjectScript(scriptId: "dev", requestId: "original-nonce")
        let recovered = try decoder.decode(PendingProjectScript.self, from: JSONEncoder().encode(pending))
        precondition(recovered.requestId == pending.requestId)
        let oldSnapshot = try decoder.decode(TaskProjectScriptsSnapshot.self, from: Data(#"{"scripts":[],"runs":[]}"#.utf8))
        precondition(oldSnapshot.worktreeSetup == nil)
        let setupData: [String: Any] = ["threadId":"task", "runId":"run", "attempt":2, "phase":"running", "startedAt":"2026-10-20T00:00:00Z", "sequence":7,
            "stages":[["id":"setup-script", "status":"running", "tail":["ready"]], ["id":"agent", "status":"pending", "tail":[]]]]
        let setup = try decoder.decode(TaskWorktreeSetupSnapshot.self, from: JSONSerialization.data(withJSONObject: setupData))
        precondition(setup.active && setup.canCancel && !setup.handedOff)
        var reordered = setup; reordered.sequence = 9; precondition(setup.samePresentation(as: reordered))
        var handedOff = setupData; handedOff["stages"] = [["id":"agent", "status":"done", "tail":[]]]
        let background = try decoder.decode(TaskWorktreeSetupSnapshot.self, from: JSONSerialization.data(withJSONObject: handedOff))
        precondition(background.handedOff && !background.canCancel && !setup.samePresentation(as: background))
        var gitStages = setupData; gitStages["stages"] = [["id":"fetch", "status":"running", "tail":[]], ["id":"submodules", "status":"warning", "detail":"partial checkout", "tail":[]]]
        let gitPreparation = try decoder.decode(TaskWorktreeSetupSnapshot.self, from: JSONSerialization.data(withJSONObject: gitStages))
        precondition(gitPreparation.stages[0].label == "获取基准分支" && gitPreparation.stages[1].label == "初始化子模块" && gitPreparation.stages[1].symbol == "exclamationmark.triangle")
        var taskData: [String: Any] = ["id":"task", "title":"Synthetic", "prompt":"", "cwd":"/synthetic", "agent":"codex", "mode":"code", "status":"running", "createdAt":"2026-10-20", "updatedAt":"2026-10-20", "result":"", "events":[], "approvals":[], "currentRunId":"run",
            "runs":[["id":"run", "messageId":"message", "requestId":"request", "cwd":"/synthetic", "at":"2026-10-20", "status":"running", "mode":"code", "interactionMode":"default", "workspacePreparation":["status":"ready", "attempt":2, "startedAt":"2026-10-20", "setupRunId":"script"]]]]
        let task = try decoder.decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: taskData))
        precondition(setup.belongs(to: task) && task.preparingWorkspace != nil)
        taskData["id"] = "foreign"
        let foreign = try decoder.decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: taskData))
        precondition(!setup.belongs(to: foreign))
        print("Project script inheritance DTO, primary selection, optional async, preview, draft receipts and pending nonce checks passed")
    }
}
