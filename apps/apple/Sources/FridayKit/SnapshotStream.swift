import Foundation

// Friday emits each snapshot as one JSON data line. AsyncBytes.lines omits empty
// lines, so dispatch on that data line rather than waiting for an SSE blank line.
struct SnapshotStream {
    private var event = ""
    mutating func read(_ line: String) throws -> Snapshot? {
        if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces); return nil }
        guard event == "snapshot", line.hasPrefix("data:") else { return nil }
        event = ""
        return try JSONDecoder().decode(Snapshot.self, from: Data(line.dropFirst(5).utf8))
    }
}
