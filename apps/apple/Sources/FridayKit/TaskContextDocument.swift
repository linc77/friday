import Foundation

struct TaskContextScope: Equatable {
    var taskID: String? = nil
    var projectID: String? = nil
    var preparationID: String? = nil
    var body: [String: Any] {
        if let taskID { return ["taskId": taskID] }
        guard let projectID else { return [:] }
        var value = ["projectId": projectID]; if let preparationID { value["preparationId"] = preparationID }; return value
    }
    var query: String {
        var components = URLComponents(); components.queryItems = body.map { URLQueryItem(name: $0.key, value: $0.value as? String) }
        return components.percentEncodedQuery ?? ""
    }
    var identity: String { taskID.map { "task:" + $0 } ?? "project:" + (projectID ?? "") + ":preparation:" + (preparationID ?? "") }
}
struct TaskContextOccurrence: Equatable {
    let id: String; let kind: String; let label: String; let range: NSRange
}
enum TaskContextDocument {
    private static let regex = try! NSRegularExpression(pattern: #"\[([^\]\n]{0,512})\]\(friday-context://v1/([a-z][a-z0-9-]{0,39})/([a-z0-9_-]{1,128})\)"#, options: [.caseInsensitive])
    static func occurrences(_ text: String) -> [TaskContextOccurrence] {
        let source = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: source.length)).map { match in
            TaskContextOccurrence(id: source.substring(with: match.range(at: 3)), kind: source.substring(with: match.range(at: 2)), label: source.substring(with: match.range(at: 1)), range: match.range)
        }
    }
    static func label(_ value: String) -> String {
        String(value.replacingOccurrences(of: #"[\[\]\\\r\n]"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces).prefix(200))
    }
    static func token(_ reference: TaskContextReference) -> String { "[\(label(reference.label))](friday-context://v1/\(reference.kind)/\(reference.id))" }
    static func referenceID(_ url: URL) -> String? {
        guard url.scheme == "friday-context", url.host == "v1" else { return nil }
        let path = url.path.split(separator: "/"); guard path.count == 2 else { return nil }; return String(path[1])
    }
    static func used(_ text: String, records: [TaskContextReference]) -> [TaskContextReference] {
        var seen = Set<String>(); return occurrences(text).compactMap { occurrence in
            guard seen.insert(occurrence.id).inserted else { return nil }; return records.first { $0.id == occurrence.id && $0.kind == occurrence.kind }
        }
    }
    static func missing(_ text: String, records: [TaskContextReference]) -> Bool { occurrences(text).contains { occurrence in !records.contains { $0.id == occurrence.id && $0.kind == occurrence.kind } } }
    static func plain(_ text: String) -> String {
        let result = NSMutableString(string: text)
        for occurrence in occurrences(text).reversed() { result.replaceCharacters(in: occurrence.range, with: "@" + occurrence.label) }; return result as String
    }
    static func modelOffset(_ offset: Int, in text: String) -> Int {
        var removed = 0
        for occurrence in occurrences(text) {
            let start = occurrence.range.location - removed
            if offset <= start { break }; removed += occurrence.range.length - 1
        }
        return min((text as NSString).length, max(0, offset + removed))
    }
    static func viewOffset(_ offset: Int, in text: String) -> Int {
        var removed = 0
        for occurrence in occurrences(text) {
            if offset <= occurrence.range.location { break }
            if offset < NSMaxRange(occurrence.range) { return occurrence.range.location - removed + 1 }
            removed += occurrence.range.length - 1
        }
        return max(0, min((text as NSString).length, offset) - removed)
    }
    static func mention(in text: String, at offset: Int) -> TaskMentionQuery? {
        let source = text as NSString; guard offset >= 0, offset <= source.length else { return nil }
        if occurrences(text).contains(where: { NSLocationInRange(max(0, offset - 1), $0.range) }) { return nil }
        let prefix = source.substring(to: offset) as NSString
        guard let match = prefix.range(of: #"(?:^|\s)@([^\s@]{0,200})$"#, options: .regularExpression).nonEmpty else { return TaskComposerCommands.trigger(text, at: offset) }
        let matched = prefix.substring(with: match); let at = (matched as NSString).range(of: "@")
        let range = NSRange(location: match.location + at.location, length: match.length - at.location)
        let token = source.substring(with: range); return TaskMentionQuery(text: String(token.dropFirst()), range: range, source: token)
    }
    static func insertionRange(_ request: TaskContextInsertion, text: String, caret: NSRange) -> NSRange {
        let source = text as NSString
        if request.atEnd == true { return NSRange(location: source.length, length: 0) }
        if let replacement = request.replacing, replacement.range.location >= 0, NSMaxRange(replacement.range) <= source.length, source.substring(with: replacement.range) == replacement.source { return replacement.range }
        return NSRange(location: min(source.length, max(0, caret.location)), length: max(0, min(caret.length, source.length - min(source.length, max(0, caret.location)))))
    }
    static func insertionText(_ request: TaskContextInsertion, text: String) -> String {
        let boundary = request.atEnd == true && !text.isEmpty && text.last?.isWhitespace != true ? " " : ""
        if let plainText = request.plainText { return boundary + plainText }
        if let citation = request.citation { return boundary + citation.token + " " }
        return boundary + ([request.reference].compactMap { $0 } + (request.additional ?? [])).map(token).joined(separator: " ") + " "
    }
    static func batch(_ incoming: [TaskContextReference], text: String, records: [TaskContextReference], identity: String) -> (records: [TaskContextReference], insertion: TaskContextInsertion)? {
        guard !incoming.isEmpty else { return nil }; var merged = records, accepted: [TaskContextReference] = []
        for reference in incoming {
            let duplicate = merged.first { $0.kind == reference.kind && $0.path == reference.path && $0.digest == reference.digest && $0.lineStart == reference.lineStart && $0.lineEnd == reference.lineEnd }
            if let duplicate { accepted.append(duplicate) } else { merged.append(reference); accepted.append(reference) }
        }
        guard Set(used(text, records: records).map(\.id)).union(accepted.map(\.id)).count <= 20 else { return nil }
        let first = accepted[0]
        return (merged, TaskContextInsertion(reference: first, focus: true, identity: identity, previousOccurrences: occurrences(text).filter { $0.id == first.id }.count, additional: Array(accepted.dropFirst()), atEnd: true))
    }
}
private extension NSRange { var nonEmpty: NSRange? { location != NSNotFound && length > 0 ? self : nil } }
