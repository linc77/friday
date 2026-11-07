import Foundation

/// Mirrors T3's delimitedPreview.ts, including its UTF-16 cell bound and
/// permissive handling of a partially written quoted field.
struct TaskDelimitedTable: Equatable, Sendable {
    let rows: [[String]]
    let truncated: Bool
    static func delimiter(name: String, mimeType: String?) -> UInt16? {
        let mime = mimeType?.split(separator: ";", omittingEmptySubsequences: false).first?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if mime == "text/csv" { return 44 }; if mime == "text/tab-separated-values" { return 9 }
        if let mime, !mime.isEmpty, mime != "text/plain", mime != "application/octet-stream" { return nil }
        if name.lowercased().hasSuffix(".csv") { return 44 }; if name.lowercased().hasSuffix(".tsv") { return 9 }; return nil
    }
    static func parse(_ text: String, delimiter: UInt16) -> Self {
        let text = Array(text.utf16); var rows: [[String]] = [], row: [String] = [], cell: [UInt16] = []
        var quoted = false, truncated = false, rowStart = text.first == 0xfeff ? 1 : 0, index = rowStart
        func endCell() {
            if row.count < 30 { row.append(String(decoding: cell, as: UTF16.self)) } else { truncated = true }
            cell.removeAll(keepingCapacity: true)
        }
        while index < text.count {
            let char = text[index]
            if char == 34 {
                if quoted && index + 1 < text.count && text[index + 1] == 34 {
                    if cell.count < 2000 { cell.append(34) } else { truncated = true }; index += 2; continue
                }
                if quoted || cell.isEmpty { quoted.toggle(); index += 1; continue }
            }
            if !quoted && (char == delimiter || char == 10 || char == 13) {
                endCell()
                if char != delimiter {
                    rows.append(row); row = []
                    if char == 13 && index + 1 < text.count && text[index + 1] == 10 { index += 1 }
                    rowStart = index + 1
                    if rows.count == 100 { return Self(rows: rows, truncated: truncated || index < text.count - 1) }
                }
            } else if cell.count < 2000 { cell.append(char) } else { truncated = true }
            index += 1
        }
        if rowStart < text.count { endCell(); rows.append(row) }
        return Self(rows: rows, truncated: truncated || quoted)
    }
}
