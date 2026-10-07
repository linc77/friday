import Foundation

enum MarkdownBlock: Equatable {
    case paragraph(String), heading(Int, String), code(String, String), list(String, String, Int), quote(String), rule
    case table([String], [[String]])
}

enum MarkdownBlocks {
    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
        }
        func cells(_ line: String) -> [String] {
            var value = line.trimmingCharacters(in: .whitespaces)
            if value.hasPrefix("|") { value.removeFirst() }; if value.hasSuffix("|") { value.removeLast() }
            return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
        }
        while index < lines.count {
            let line = lines[index]; let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { flush(); index += 1; continue }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let symbol = trimmed.first!
                let length = trimmed.prefix { $0 == symbol }.count
                let fence = String(repeating: String(symbol), count: length)
                let language = String(trimmed.dropFirst(length)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []; index += 1
                while index < lines.count {
                    let closing = lines[index].trimmingCharacters(in: .whitespaces)
                    if closing.hasPrefix(fence) && closing.allSatisfy({ $0 == symbol }) { index += 1; break }
                    code.append(lines[index]); index += 1
                }
                // An unfinished streamed fence still renders as a code block.
                blocks.append(.code(language, code.joined(separator: "\n"))); continue
            }
            let hashes = trimmed.prefix { $0 == "#" }.count
            if (1...6).contains(hashes) && trimmed.dropFirst(hashes).first == " " {
                flush(); blocks.append(.heading(hashes, String(trimmed.dropFirst(hashes + 1)))); index += 1; continue
            }
            if ["---", "***", "___"].contains(trimmed) { flush(); blocks.append(.rule); index += 1; continue }
            if trimmed.hasPrefix("> ") {
                flush(); blocks.append(.quote(String(trimmed.dropFirst(2)))); index += 1; continue
            }
            if index + 1 < lines.count && trimmed.contains("|") {
                let separators = cells(lines[index + 1])
                if !separators.isEmpty && separators.allSatisfy({ $0.filter { $0 == "-" }.count >= 3 && $0.allSatisfy { $0 == "-" || $0 == ":" } }) {
                    flush(); let headers = cells(line); var rows: [[String]] = []; index += 2
                    while index < lines.count && lines[index].contains("|") && !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                        rows.append(cells(lines[index])); index += 1
                    }
                    blocks.append(.table(headers, rows)); continue
                }
            }
            let bullet = ["- ", "* ", "+ "].first { trimmed.hasPrefix($0) }
            let digits = trimmed.prefix { $0.isNumber }
            let numbered = !digits.isEmpty && trimmed.dropFirst(digits.count).hasPrefix(". ")
            if bullet != nil || numbered {
                flush(); let marker = numbered ? String(digits) + "." : "•"
                let prefix = numbered ? digits.count + 2 : 2
                blocks.append(.list(marker, String(trimmed.dropFirst(prefix)), min(3, (line.count - line.drop { $0 == " " }.count) / 2)))
                index += 1; continue
            }
            paragraph.append(line); index += 1
        }
        flush(); return blocks
    }
}
