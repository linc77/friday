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
        print("Swift SSE and conversation compatibility checks passed")
    }
}
