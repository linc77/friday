import Foundation

struct TaskTerminalSelection {
    let terminalID: String; let generation: Int; let lineStart: Int; let lineEnd: Int; let text: String
    var body: [String: Any] { ["kind": "terminal", "terminalId": terminalID, "generation": generation, "lineStart": lineStart, "lineEnd": lineEnd, "text": text] }
}

enum TaskTerminalProtocolError: LocalizedError {
    case oversizedFrame, invalidCursor, missingSnapshot, outputGap, invalidData
    var errorDescription: String? { "终端输出不同步，正在重新加载。" }
}

struct TaskTerminalStream {
    private var event = ""
    mutating func read(_ line: String) throws -> TaskTerminalEvent? {
        if line.hasPrefix("event:") { event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        if line.hasPrefix("data:") {
            // AsyncBytes.lines omits SSE blank lines; each Friday frame is one JSON line.
            let value = line.dropFirst(5).drop(while: { $0 == " " })
            guard value.utf8.count <= 16 * 1024 * 1024 else { throw TaskTerminalProtocolError.oversizedFrame }
            defer { event = "" }
            if event == "terminal" { return try JSONDecoder().decode(TaskTerminalEvent.self, from: Data(value.utf8)) }
        }
        return nil
    }
}

struct TaskTerminalCursor {
    enum Action: Equatable { case ignore, snapshot, resetMetadata, metadata, output, clear, closed }
    private(set) var generation: Int?
    private(set) var sequence = 0
    mutating func invalidate() { generation = nil; sequence = 0 }
    mutating func apply(_ event: TaskTerminalEvent) throws -> Action {
        guard event.generation > 0, event.sequence >= 0 else { throw TaskTerminalProtocolError.invalidCursor }
        if let generation, event.generation < generation { return .ignore }
        if event.type == "snapshot" {
            guard let terminal = event.terminal, terminal.generation == event.generation, terminal.sequence == event.sequence else { throw TaskTerminalProtocolError.missingSnapshot }
            generation = event.generation; sequence = event.sequence; return .snapshot
        }
        if event.type == "metadata" {
            guard event.terminal?.generation == event.generation else { throw TaskTerminalProtocolError.missingSnapshot }
            if generation != event.generation { generation = event.generation; sequence = 0; return .resetMetadata }
            return .metadata // Metadata's cursor must not skip a pending output replay.
        }
        guard generation == event.generation else { throw TaskTerminalProtocolError.missingSnapshot }
        if event.type == "closed" { return .closed }
        guard event.sequence > sequence else { return .ignore }
        guard event.sequence == sequence + 1 else { throw TaskTerminalProtocolError.outputGap }
        switch event.type {
        case "output": sequence = event.sequence; return .output
        case "clear": sequence = event.sequence; return .clear
        default: return .ignore
        }
    }
}
