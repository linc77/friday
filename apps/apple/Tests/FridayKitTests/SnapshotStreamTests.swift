import Foundation

@main
struct SnapshotStreamTests {
    static func main() throws {
        let legacyProvider = CodexProviderSettings()
        let legacySettings = try JSONDecoder().decode(CodexProviderSettings.self, from: JSONEncoder().encode(legacyProvider))
        precondition(legacySettings.serverUrl == nil && legacySettings.body["serverPassword"] == nil, "Existing providers retain their original settings payload")
        var remoteSettings = legacyProvider
        remoteSettings.serverUrl = "http://127.0.0.1:4096"; remoteSettings.serverPasswordConfigured = true
        let masked = try JSONDecoder().decode(CodexProviderSettings.self, from: JSONEncoder().encode(remoteSettings))
        precondition(masked.serverPasswordConfigured == true && masked.body["serverPassword"] is NSNull, "Masked server passwords must be sent as null to preserve the host secret")
        remoteSettings.serverPassword = "synthetic-secret"
        precondition(remoteSettings.body["serverPassword"] as? String == "synthetic-secret", "An explicitly edited server password must reach the host")
        var nativeSettings = legacyProvider; nativeSettings.nativeConfig = AcpNativeProviderConfig(); nativeSettings.nativeConfig?.apiKeyConfigured = true
        let nativeBody = nativeSettings.body["nativeConfig"] as? [String: Any]
        precondition(nativeBody?["apiKey"] is NSNull, "A redacted native API key must preserve the host secret")
        nativeSettings.nativeConfig?.apiKey = ""
        precondition((nativeSettings.body["nativeConfig"] as? [String: Any])?["apiKey"] as? String == "", "An explicit native key clear must remain distinct from a masked key")
        precondition(TaskProviderCatalog.order == ["codex", "claude", "cursor", "grok", "opencode", "antigravity", "pi", "muse", "acp-registry"], "Implemented drivers follow the fixed T3 builtin order")
        precondition(TaskProviderCatalog.supportsInteractionModes("cursor") && TaskProviderCatalog.supportsInteractionModes("opencode") && !TaskProviderCatalog.supportsInteractionModes("muse"), "Only native mode-capable providers offer Plan")
        let lines = [
            "event: snapshot", "data: {\"revision\":1,\"ideas\":[],\"projects\":[],\"memories\":[],\"tasks\":[]}", "id: 1",
            "event: heartbeat", "data: {}",
            "event: snapshot", "data: {\"revision\":2,\"ideas\":[{\"id\":\"i\",\"text\":\"line one\\nline two\",\"createdAt\":\"today\",\"taskId\":null}],\"projects\":[],\"memories\":[],\"tasks\":[]}", "id: 2",
        ]
        var decoder = SnapshotStream()
        let snapshots = try lines.compactMap { try decoder.read($0) }
        precondition(snapshots.map(\.revision) == [1, 2], "Every snapshot must arrive without blank separators")
        precondition(snapshots[1].ideas[0].text == "line one\nline two", "Embedded newlines must survive SSE transport")
        precondition(snapshots[1].ideas[0].images == nil, "Older notes without image metadata must decode")
        let pending = try JSONDecoder().decode(OutboxIdea.self, from: Data(#"{"id":"offline","text":"以前的离线想法"}"#.utf8))
        precondition(pending.note.text == "以前的离线想法" && pending.expectedUpdatedAt == nil, "Old offline captures must remain create operations")
        let imageID = String(repeating: "a", count: 64)
        let rich = OutboxIdea(id: "diary", text: "## 今天\n\n![照片](friday-image:\(imageID))\n\n[资料](https://example.com)", title: "日记", createdAt: "2026-10-07T08:56:00Z", images: [IdeaImage(id: imageID, name: "照片", mediaType: "image/png")], expectedUpdatedAt: "2026-10-07T09:00:00Z", editId: "edit")
        let restored = try JSONDecoder().decode(OutboxIdea.self, from: JSONEncoder().encode(rich))
        precondition(restored == rich && restored.note.displayTitle == "日记", "Offline edits retain title, images, capture time and conflict version")
        precondition(!restored.note.preview.contains("friday-image:"), "Card previews must not expose attachment IDs")
        precondition(!restored.note.preview.contains("](https:") && !restored.note.editableText.contains("friday-image:"), "Previews and editing show content without internal attachment references")
        let legacy = #"{"id":"old","title":"Old conversation","prompt":"Question","projectId":null,"cwd":"/tmp","agent":"codex","mode":"research","status":"completed","createdAt":"","updatedAt":"","durableId":1,"threadId":"thread","turnId":"turn","result":"Answer","error":null,"events":[],"approvals":[],"artifact":null}"#
        let oldTask = try JSONDecoder().decode(WorkItem.self, from: Data(legacy.utf8))
        precondition(oldTask.conversation.map(\.text) == ["Question", "Answer"], "Old saved tasks must still render")
        var current = try JSONSerialization.jsonObject(with: Data(legacy.utf8)) as! [String: Any]
        current["messages"] = [["id": "u", "role": "user", "text": "Question"], ["id": "a", "role": "assistant", "text": "Answer"]]
        let completed = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: current))
        precondition(completed.conversation.count == 2, "Final output must not duplicate the stored reply")
        current["messages"] = [["id": "u", "role": "user", "text": "Question"], ["id": "a", "role": "assistant", "text": "Answer"], ["id": "u2", "role": "user", "text": "Continue"]]
        current["result"] = "Streaming reply"
        let running = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: current))
        precondition(running.conversation.map(\.text) == ["Question", "Answer", "Continue", "Streaming reply"], "Keep previous replies while the next answer streams")
        current["messages"] = [
            ["id": "u", "role": "user", "text": "Question", "at": "2026-10-07T10:00:00.000Z", "turnId": "t"],
            ["id": "a", "role": "assistant", "text": "Final answer", "at": "2026-10-07T10:00:04.000Z", "turnId": "t"],
        ]
        current["result"] = "Final answer"
        current["events"] = [
            ["id": "turn", "itemId": "turn", "turnId": "t", "kind": "turn", "text": "", "at": "2026-10-07T10:00:00.000Z", "durationMs": 38000],
            ["id": "commentary", "itemId": "c", "turnId": "t", "kind": "message", "phase": "commentary", "text": "Inspecting", "at": "2026-10-07T10:00:01.000Z"],
            ["id": "cmd", "itemId": "cmd", "turnId": "t", "kind": "command", "text": "pwd", "at": "2026-10-07T10:00:02.000Z", "status": "completed", "detail": "/tmp"],
            ["id": "final", "itemId": "f", "turnId": "t", "kind": "message", "phase": "final_answer", "text": "Final answer", "at": "2026-10-07T10:00:03.000Z"],
        ]
        let structured = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: current))
        let rows = CodexTranscript.rows(structured)
        precondition(rows.count == 3, "Transcript must contain user, work fold, and exactly one final reply")
        guard case .user("Question") = rows[0].content, case .work(let work) = rows[1].content, case .reply("Final answer") = rows[2].content else { preconditionFailure("Preserve chronological transcript order") }
        precondition(work.map(\.kind) == ["message", "command"], "Commentary stays inside the work fold")
        precondition(CodexTranscript.duration(work, task: structured) == 38, "Use turn duration rather than the last command")
        current["messages"] = [["id": "u", "role": "user", "text": "Question"], ["id": "a", "role": "assistant", "text": "Final answer"]]
        current["createdAt"] = "2026-10-07T10:00:00.000Z"; current["updatedAt"] = "2026-10-07T10:00:04.000Z"
        current["events"] = [
            ["id": "user", "kind": "user", "text": "Question", "at": "2026-10-07T10:00:00.000Z"],
            ["id": "start", "kind": "command", "text": "正在执行：pwd", "at": "2026-10-07T10:00:01.000Z"],
            ["id": "done", "kind": "command", "text": "pwd\n/tmp\n退出码：0", "at": "2026-10-07T10:00:02.000Z"],
        ]
        let legacyTranscript = CodexTranscript.rows(try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: current)))
        precondition(legacyTranscript.count == 3, "Legacy logs belong between the request and its answer")
        guard case .work(let legacyWork) = legacyTranscript[1].content else { preconditionFailure("Legacy work fold missing") }
        precondition(legacyWork.count == 1, "Legacy command start/completion pairs count once")
        current["messages"] = [["id": "image-only", "role": "user", "text": "", "images": [["id": imageID, "name": "参考.png", "mediaType": "image/png"]], "delivery": "uncertain"]]
        current["result"] = ""; current["events"] = []
        let imageTask = try JSONDecoder().decode(WorkItem.self, from: JSONSerialization.data(withJSONObject: current))
        precondition(imageTask.messages?.first?.images?.first?.id == imageID, "Task image metadata must decode after reconnecting")
        precondition(imageTask.messages?.first?.delivery == "uncertain", "Lost live-message receipts must remain visible")
        let imageRows = CodexTranscript.rows(imageTask)
        precondition(imageRows.count == 1 && imageRows[0].id == "image-only", "Image-only user messages must not disappear from the timeline")
        precondition(oldTask.conversation.first?.images == nil, "Legacy task messages remain compatible")
        print("Swift SSE and conversation compatibility checks passed")
    }
}
