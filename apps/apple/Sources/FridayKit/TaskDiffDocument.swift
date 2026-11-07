import Foundation

enum TaskDiffDocument {
    enum Kind { case context, addition, deletion, hunk, note, metadata }
    struct Line: Identifiable {
        let id: Int; let kind: Kind; let text: String; let oldNumber: Int?; let newNumber: Int?
    }
    struct Pair: Identifiable {
        let id: Int; let left: Line?; let right: Line?; let full: Line?
    }
    private static let header = try! NSRegularExpression(pattern: "^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@")
    static func lines(_ patch: String) -> [Line] {
        var result: [Line] = []; var old: Int?; var new: Int?; var inHunk = false
        var source = patch.components(separatedBy: "\n")
        if source.last == "" { source.removeLast() }
        for (index, text) in source.enumerated() {
            var kind: Kind = .metadata; var content = text; var oldNumber: Int?; var newNumber: Int?
            if text.hasPrefix("@@") {
                kind = .hunk; inHunk = true; old = nil; new = nil
                if let match = header.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
                   let left = Range(match.range(at: 1), in: text), let right = Range(match.range(at: 2), in: text) {
                    old = Int(text[left]); new = Int(text[right])
                }
            } else if text.hasPrefix("diff --git ") || text.hasPrefix("*** ") { inHunk = false }
            else if text.hasPrefix("\\ No newline") { kind = .note }
            else if inHunk {
                if text.hasPrefix("+") { kind = .addition; content = String(text.dropFirst()); newNumber = new; new = new.map { $0 + 1 } }
                else if text.hasPrefix("-") { kind = .deletion; content = String(text.dropFirst()); oldNumber = old; old = old.map { $0 + 1 } }
                else if text.hasPrefix(" ") { kind = .context; content = String(text.dropFirst()); oldNumber = old; newNumber = new; old = old.map { $0 + 1 }; new = new.map { $0 + 1 } }
                else { inHunk = false }
            }
            result.append(Line(id: index, kind: kind, text: content, oldNumber: oldNumber, newNumber: newNumber))
        }
        return result
    }
    static func pairs(_ lines: [Line]) -> [Pair] {
        var result: [Pair] = []; var deleted: [Line] = []; var added: [Line] = []
        func flush() {
            for index in 0..<max(deleted.count, added.count) {
                result.append(Pair(id: result.count, left: index < deleted.count ? deleted[index] : nil,
                                   right: index < added.count ? added[index] : nil, full: nil))
            }
            deleted = []; added = []
        }
        for line in lines {
            if line.kind == .deletion { if !added.isEmpty { flush() }; deleted.append(line) }
            else if line.kind == .addition { added.append(line) }
            else {
                flush()
                result.append(Pair(id: result.count, left: line.kind == .context ? line : nil, right: line.kind == .context ? line : nil, full: line.kind == .context ? nil : line))
            }
        }
        flush()
        return result
    }
}
