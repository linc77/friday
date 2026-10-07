import Foundation

@main
struct SnapshotStreamTests {
    static func main() throws {
        let lines = [
            "event: snapshot", "data: {\"revision\":1,\"ideas\":[],\"projects\":[],\"memories\":[],\"tasks\":[]}", "id: 1",
            "event: heartbeat", "data: {}",
            "event: snapshot", "data: {\"revision\":2,\"ideas\":[{\"id\":\"i\",\"text\":\"line one\\nline two\",\"createdAt\":\"today\",\"taskId\":null}],\"projects\":[],\"memories\":[],\"tasks\":[]}", "id: 2",
        ]
        var decoder = SnapshotStream()
        let snapshots = try lines.compactMap { try decoder.read($0) }
        precondition(snapshots.map(\.revision) == [1, 2], "Every snapshot must arrive without blank separators")
        precondition(snapshots[1].ideas[0].text == "line one\nline two", "Embedded newlines must survive SSE transport")
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
        let blocks = MarkdownBlocks.parse("## Result\n\n- **One**\n\n```swift\nlet x = 1\n```\n\n| A | B |\n| --- | --- |\n| C | D |")
        precondition(blocks == [.heading(2, "Result"), .list("•", "**One**", 0), .code("swift", "let x = 1"), .table(["A", "B"], [["C", "D"]])], "Render headings, lists, code, and tables as native blocks")
        precondition(MarkdownBlocks.parse("```ts\nconst partial =") == [.code("ts", "const partial =")], "Streaming unfinished fences retain code formatting")
        print("Swift SSE and conversation compatibility checks passed")
    }
}
