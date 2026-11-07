import Foundation

@main struct TextGenerationSettingsStateTests {
    static func require(_ value: Bool, _ message: String = "") { Swift.precondition(value, message) }
    static func snapshot(version: Int = 1, project: String? = nil, override: [String: Any] = [:]) throws -> TextGenerationSettingsSnapshot {
        let model: [String: Any] = ["agent": "codex", "model": "gpt-6-luna", "reasoningEffort": "low"]
        let body: [String: Any] = ["version": version, "projectId": project as Any? ?? NSNull(), "defaults": ["textGenerationModelSelection": model, "sourceControlWriterModelSelection": NSNull()],
            "overrides": override, "effective": ["textGenerationModelSelection": model, "sourceControlWriterModelSelection": model, "sourceControlWritingStyle": SourceControlWritingStyle.standard.body],
            "sources": ["textGenerationModelSelection": "host", "sourceControlWriterModelSelection": "text_generation"], "enabled": ["codex": true, "claude": true]]
        return try JSONDecoder().decode(TextGenerationSettingsSnapshot.self, from: JSONSerialization.data(withJSONObject: body))
    }
    static func main() throws {
        var state = TextGenerationSettingsState()
        let first = state.begin(identity: "one:service", projectID: nil)
        require(state.beginSave() == nil, "An unloaded settings version cannot be written")
        require(state.accept(try snapshot(), token: first, identity: "one:service"))
        require(!state.shouldReload(0) && !state.shouldReload(1) && state.shouldReload(2), "Only a newer announced version triggers a reload")
        let save = state.beginSave()!; require(state.beginSave() == nil, "Duplicate autosave cannot share the same version")
        require(!state.shouldReload(2), "An announced update waits until the owned save settles")
        let project = state.begin(identity: "one:service", projectID: "workspace")
        require(!state.accept(try snapshot(version: 2), token: save, identity: "one:service"), "A host save cannot replace a Workspace draft")
        require(state.accept(try snapshot(project: "workspace", override: ["sourceControlWriterModelSelection": NSNull()]), token: project, identity: "one:service"))
        require(state.beginSave(ownerToken: first) == nil, "A retired host control cannot save into a Workspace with the same version")
        require(state.snapshot!.overrides.hasSourceControlWriterOverride && state.snapshot!.overrides.sourceControlWriterModelSelection == nil,
            "Explicitly following text generation differs from inheriting the host's source control override")
        require(!state.accept(try snapshot(version: 0, project: "workspace"), token: project, identity: "one:service"), "Late settings versions cannot roll back a scope")
        let old = state.beginSave()!
        let returning = state.begin(identity: "one:service", projectID: nil)
        require(!state.finish(old, identity: "one:service")); require(!state.accept(try snapshot(), token: first, identity: "one:service"))
        let restarted = state.begin(identity: "one:new-service", projectID: nil)
        require(!state.accept(try snapshot(version: 99), token: returning, identity: "one:service"))
        require(state.accept(try snapshot(version: 0), token: restarted, identity: "one:new-service"), "A fresh service scope can start at a restored version")
        require(!state.snapshot!.overrides.hasSourceControlWriterOverride)
        let account = state.begin(identity: "two:service", projectID: nil)
        require(!state.finish(restarted, identity: "one:new-service")); require(state.finish(account, identity: "two:service"))
        let selection = try snapshot().effective.textGenerationModelSelection
        let encoded = try JSONSerialization.data(withJSONObject: selection.body)
        require(try JSONDecoder().decode(TextGenerationModelSelection.self, from: encoded) == selection)
        let style = SourceControlWritingStyle(mode: "custom", customInstructions: "中文说明\nKeep `code` and template sections.", followChangeRequestTemplates: false)
        let styled = try snapshot(override: ["sourceControlWritingStyle": style.body])
        require(styled.overrides.sourceControlWritingStyle == style)
        require(styled.effective.sourceControlWritingStyle == .standard)
        require(try JSONDecoder().decode(SourceControlWritingStyle.self, from: JSONSerialization.data(withJSONObject: style.body)) == style)
        let mergeBody: [String: Any] = ["version": 2, "projectId": "workspace", "defaults": ["removeAgentCreditsOnMerge": true], "overrides": ["removeAgentCreditsOnMerge": false], "effective": ["removeAgentCreditsOnMerge": false], "source": "workspace"]
        let merge = try JSONDecoder().decode(SourceControlPreferencesSnapshot.self, from: JSONSerialization.data(withJSONObject: mergeBody))
        require(merge.overrides.removeAgentCreditsOnMerge == false && merge.effective.removeAgentCreditsOnMerge == false)
        var mergeState = ScopedSettingsState<SourceControlPreferencesSnapshot>()
        let mergeToken = mergeState.begin(identity: "host:one", projectID: "workspace")
        require(mergeState.accept(merge, token: mergeToken, identity: "host:one"))
        let obsolete = mergeState.beginSave()!; _ = mergeState.begin(identity: "host:two", projectID: nil)
        require(!mergeState.accept(merge, token: obsolete, identity: "host:two"), "A late merge preference write cannot cross connections or scopes")
        print("Text generation scope/null inheritance, autosave versions, stale callbacks, account and service incarnation guards passed")
    }
}
