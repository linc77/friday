import Foundation

struct TaskOutputScope: Equatable {
    let connection: String; let taskID: String; let eventID: String; let epoch: String
    var native = false
    var key: String { [connection, taskID, eventID, epoch, String(native)].joined(separator: "\n") }
    var path: String {
        let component = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return "/api/tasks/" + (taskID.addingPercentEncoding(withAllowedCharacters: component) ?? "") + (native ? "/background/" : "/history/items/") + (eventID.addingPercentEncoding(withAllowedCharacters: component) ?? "") + (native ? "?sessionId=" : "?epoch=") + epoch
    }
    var streamPath: String { native ? path.replacingOccurrences(of: "?sessionId=", with: "/output?sessionId=") : path.replacingOccurrences(of: "?epoch=", with: "/output?epoch=") }
    func accepts(_ frame: TaskCommandOutputFrame) -> Bool { frame.taskId == taskID && frame.eventId == eventID && frame.epoch == epoch }
    func detail(_ value: TaskEventDetail, event: TaskEvent) -> TaskEvent? {
        guard value.taskId == taskID, value.epoch == epoch, value.event.id == eventID, value.event.kind == event.kind, value.event.revertedAt == nil else { return nil }
        if event.status != "running", let digest = event.historyDigest, value.event.historyDigest != digest { return nil }
        return value.event
    }
}
struct TaskCommandOutputFrame: Decodable {
    let taskId: String; let eventId: String; let epoch: String; let text: String; let truncated: Bool; let running: Bool
}
enum TaskOutputError: LocalizedError, Equatable {
    case oversizedFrame, historyChanged, missingFinalOutput
    var errorDescription: String? {
        switch self {
        case .oversizedFrame: "输出数据过大，请重新展开执行项。"
        case .historyChanged: "任务历史已改变，请重新展开执行项。"
        case .missingFinalOutput: "输出连接已中断，正在重新连接。"
        }
    }
}
struct TaskOutputStream {
    private var name = ""
    mutating func read(_ line: String) throws -> TaskCommandOutputFrame? {
        if line.hasPrefix("event:") { name = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces) }
        if line.hasPrefix("data:") {
            let value = line.dropFirst(5).drop(while: { $0 == " " })
            guard value.utf8.count <= 1024 * 1024 else { throw TaskOutputError.oversizedFrame }
            // The service emits one JSON data line per frame. AsyncBytes.lines
            // omits empty lines, so a blank-line dispatch would never run.
            defer { name = "" }
            let data = Data(value.utf8)
            if name == "error", let error = try? JSONDecoder().decode(APIError.self, from: data) { throw OutputMessage(message: error.error) }
            if name == "output" { return try JSONDecoder().decode(TaskCommandOutputFrame.self, from: data) }
        }
        return nil
    }
    private struct OutputMessage: LocalizedError { let message: String; var errorDescription: String? { message } }
}

enum TaskOutputColor: Equatable { case indexed(Int), rgb(Int, Int, Int) }
struct TaskOutputStyle: Equatable {
    var foreground: TaskOutputColor?; var background: TaskOutputColor?
    var bold = false; var dim = false; var italic = false; var underline = false; var strike = false; var inverse = false
}
struct TaskOutputSpan { let text: String; let style: TaskOutputStyle }
enum TaskOutputText {
    // The server normalizes cursor movement and emits only SGR controls. Keep
    // plain text and colours separate so copy/selection never contains ANSI.
    static func spans(_ text: String) -> [TaskOutputSpan] {
        let pattern = try! NSRegularExpression(pattern: "\u{1b}\\[([0-9;]*)m")
        let value = text as NSString; let matches = pattern.matches(in: text, range: NSRange(location: 0, length: value.length))
        var output: [TaskOutputSpan] = []; var start = 0; var style = TaskOutputStyle()
        for match in matches {
            if match.range.location > start { output.append(TaskOutputSpan(text: value.substring(with: NSRange(location: start, length: match.range.location - start)), style: output.count < 2048 ? style : TaskOutputStyle())) }
            let parameters = value.substring(with: match.range(at: 1)).split(separator: ";", omittingEmptySubsequences: false).map { Int($0) ?? 0 }
            var index = 0
            while index < parameters.count {
                let code = parameters[index]
                switch code {
                case 0: style = TaskOutputStyle()
                case 1: style.bold = true
                case 2: style.dim = true
                case 3: style.italic = true
                case 4: style.underline = true
                case 7: style.inverse = true
                case 9: style.strike = true
                case 22: style.bold = false; style.dim = false
                case 23: style.italic = false
                case 24: style.underline = false
                case 27: style.inverse = false
                case 29: style.strike = false
                case 30...37: style.foreground = .indexed(code - 30)
                case 40...47: style.background = .indexed(code - 40)
                case 90...97: style.foreground = .indexed(code - 90 + 8)
                case 100...107: style.background = .indexed(code - 100 + 8)
                case 39: style.foreground = nil
                case 49: style.background = nil
                case 38, 48:
                    var color: TaskOutputColor?
                    if index + 2 < parameters.count, parameters[index + 1] == 5 { color = .indexed(parameters[index + 2]); index += 2 }
                    else if index + 4 < parameters.count, parameters[index + 1] == 2 { color = .rgb(parameters[index + 2], parameters[index + 3], parameters[index + 4]); index += 4 }
                    if let color { if code == 38 { style.foreground = color } else { style.background = color } }
                default: break
                }
                index += 1
            }
            start = NSMaxRange(match.range)
        }
        if start < value.length { output.append(TaskOutputSpan(text: value.substring(from: start), style: output.count < 2048 ? style : TaskOutputStyle())) }
        return output
    }
    static func plain(_ text: String) -> String { spans(text).map(\.text).joined() }
}
