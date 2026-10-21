import Foundation

@main
struct TaskTerminalProtocolTests {
    static func event(_ json: String) throws -> TaskTerminalEvent { try JSONDecoder().decode(TaskTerminalEvent.self, from: Data(json.utf8)) }
    static func check(_ value: @autoclosure () throws -> Bool, _ message: String = "") throws { let result = try value(); precondition(result, message) }
    static func main() throws {
        var stream = TaskTerminalStream()
        try check(try stream.read("event: ping") == nil)
        try check(try stream.read("data: {}") == nil)
        try check(try stream.read("") == nil)
        _ = try stream.read("id: 1:1"); _ = try stream.read("event: terminal")
        let parsed = try stream.read(#"data: {"type":"output","generation":1,"sequence":1,"data":"5L2g"}"#)!
        precondition(parsed.data == "5L2g")
        var cursor = TaskTerminalCursor()
        let snapshot = try event(#"{"type":"snapshot","generation":1,"sequence":0,"history":"","terminal":{"id":"term","taskId":"task","generation":1,"cwd":"/project","shell":"/bin/sh","label":"Terminal","title":"sh","status":"running","pid":123,"cols":120,"rows":30,"sequence":0,"baseSequence":1,"hasRunningSubprocess":false,"createdAt":"","updatedAt":""}}"#)
        try check(try cursor.apply(snapshot) == .snapshot)
        try check(try cursor.apply(parsed) == .output)
        try check(try cursor.apply(parsed) == .ignore, "A reconnect must not feed the same VT bytes twice")
        let metadata = try event(#"{"type":"metadata","generation":1,"sequence":10,"terminal":{"id":"term","taskId":"task","generation":1,"cwd":"/project","shell":"/bin/sh","label":"Terminal","title":"sh","status":"running","pid":123,"cols":120,"rows":30,"sequence":10,"baseSequence":1,"hasRunningSubprocess":false,"createdAt":"","updatedAt":""}}"#)
        try check(try cursor.apply(metadata) == .metadata)
        precondition(cursor.sequence == 1, "Metadata must not skip pending output replay")
        try check(try cursor.apply(event(#"{"type":"clear","generation":1,"sequence":2}"#)) == .clear)
        try check(try cursor.apply(event(#"{"type":"closed","generation":1,"sequence":2}"#)) == .closed, "Close is meaningful even without new output")
        do { _ = try cursor.apply(event(#"{"type":"output","generation":1,"sequence":4,"data":"YQ=="}"#)); preconditionFailure("A gap must trigger a fresh snapshot") } catch TaskTerminalProtocolError.outputGap {}
        cursor.invalidate(); precondition(cursor.generation == nil && cursor.sequence == 0)
        let next = #"{"type":"snapshot","generation":2,"sequence":0,"history":"","terminal":{"id":"term","taskId":"task","generation":2,"cwd":"/project","shell":"/bin/sh","label":"Terminal","title":"sh","status":"running","pid":234,"cols":120,"rows":30,"sequence":0,"baseSequence":1,"hasRunningSubprocess":false,"createdAt":"","updatedAt":""}}"#
        try check(try cursor.apply(event(next)) == .snapshot)
        try check(try cursor.apply(parsed) == .ignore, "Old-generation events may not reset or write into a new terminal")
        let data = try JSONDecoder().decode(TaskTerminalEvent.self, from: Data(#"{"type":"output","generation":2,"sequence":1,"data":"5aW9"}"#.utf8))
        precondition(String(data: Data(base64Encoded: parsed.data!)! + Data(base64Encoded: data.data!)!, encoding: .utf8) == "你好")
        print("Task terminal protocol checks passed")
    }
}
