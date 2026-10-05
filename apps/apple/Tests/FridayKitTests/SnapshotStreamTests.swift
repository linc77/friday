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
        print("Swift SSE snapshot regression check passed")
    }
}
