import Foundation

struct TaskDiffReviewDocument {
    let rows: [TaskDiffDocument.Line]
    init(_ patch: String) { rows = TaskDiffDocument.lines(patch).filter { [.context, .addition, .deletion].contains($0.kind) && ($0.oldNumber != nil || $0.newNumber != nil) } }
    func index(_ point: TaskDiffReviewPoint) -> Int? {
        rows.firstIndex { point.side == "deletions" ? $0.oldNumber == point.line : $0.newNumber == point.line }
            ?? rows.firstIndex { point.side == "deletions" ? $0.newNumber == point.line : $0.oldNumber == point.line }
    }
    func contains(_ selection: TaskDiffReviewSelection) -> Bool { index(selection.first) != nil && index(selection.last) != nil }
    func review(_ selection: TaskDiffReviewSelection, sectionID: String, title: String) -> (metadata: TaskDiffReviewMetadata, patch: String)? {
        guard [selection.side, selection.endSide].allSatisfy({ ["additions", "deletions"].contains($0) }), let first = index(selection.first), let last = index(selection.last) else { return nil }
        let start = min(first, last), end = max(first, last), values = Array(rows[start...end])
        let old = values.compactMap(\.oldNumber), new = values.compactMap(\.newNumber)
        let patch = ["@@ -\(old.first ?? 0),\(old.count) +\(new.first ?? 0),\(new.count) @@"] + values.map { ($0.kind == .addition ? "+" : $0.kind == .deletion ? "-" : " ") + $0.text }
        let firstRow = values[0], lastRow = values[values.count - 1]
        let firstNumber = firstRow.newNumber ?? firstRow.oldNumber ?? 0, lastNumber = lastRow.newNumber ?? lastRow.oldNumber ?? 0
        let same = values.allSatisfy { $0.kind == firstRow.kind }, marker = same ? (firstRow.kind == .addition ? "+" : firstRow.kind == .deletion ? "-" : "") : ""
        let label = firstNumber == lastNumber ? "\(marker)\(firstNumber)" : "\(marker)\(firstNumber) to \(marker)\(lastNumber)"
        return (TaskDiffReviewMetadata(sectionID: sectionID, sectionTitle: title, startIndex: start, endIndex: end, rangeLabel: label, selection: selection), patch.joined(separator: "\n"))
    }
}

struct TaskDiffInlineComment: Equatable, Identifiable {
    let id: UUID; let selection: TaskDiffReviewSelection; let rangeLabel: String
    let text: String?; let referenceID: String?
    var presentationID: String? = nil
    var presentationVersion: String? = nil
}

/// Describes the actual displayed bytes and each source/gutter range. Rendering,
/// copying and review selection share these mappings in both native clients.
struct TaskDiffRenderedDocument {
    struct Row {
        let slot: Int; let line: TaskDiffDocument.Line?; let range: NSRange; let source: NSRange?; let displayLine: Int
        func point(side: String?) -> TaskDiffReviewPoint? {
            guard let line else { return nil }
            if side == "deletions", let number = line.oldNumber { return TaskDiffReviewPoint(line: number, side: "deletions") }
            if side == "additions", let number = line.newNumber { return TaskDiffReviewPoint(line: number, side: "additions") }
            if let number = line.newNumber { return TaskDiffReviewPoint(line: number, side: "additions") }
            return line.oldNumber.map { TaskDiffReviewPoint(line: $0, side: "deletions") }
        }
    }
    let text: String; let rows: [Row]; let side: String?; let gutterCharacters: Int
    var numberCharacters: Int { side == nil ? (gutterCharacters - 5) / 2 : gutterCharacters - 4 }
    init(patch: String, side: String?) {
        self.side = side
        let lines = TaskDiffDocument.lines(patch), values: [(Int, TaskDiffDocument.Line?)]
        let digits = max(5, lines.flatMap { [$0.oldNumber, $0.newNumber].compactMap { $0 } }.map { String($0).count }.max() ?? 0)
        self.gutterCharacters = (side == nil ? digits * 2 + 1 : digits) + 4
        func number(_ value: Int?) -> String { let text = value.map(String.init) ?? ""; return String(repeating: " ", count: max(0, digits - text.count)) + text }
        if let side { values = TaskDiffDocument.pairs(lines).enumerated().map { index, pair in (index, pair.full ?? (side == "deletions" ? pair.left : pair.right)) } }
        else { values = lines.enumerated().map { ($0.offset, $0.element) } }
        var text = "", rows: [Row] = [], displayLine = 1, offset = 0
        for (slot, line) in values {
            let numbers = side.map { side in number(side == "deletions" ? line?.oldNumber : line?.newNumber) }
                ?? [line?.oldNumber, line?.newNumber].map(number).joined(separator: " ")
            let prefix = numbers + "  " + (line?.kind == .addition ? "+" : line?.kind == .deletion ? "−" : " ") + " ", content = (line?.text ?? "") + "\n"
            let length = ((prefix + content) as NSString).length
            let source = line.flatMap { [.context, .addition, .deletion].contains($0.kind) ? NSRange(location: offset + (prefix as NSString).length, length: (content as NSString).length) : nil }
            rows.append(Row(slot: slot, line: line, range: NSRange(location: offset, length: length), source: source, displayLine: displayLine))
            displayLine += TaskSourceLines(prefix + content).starts.count - 1; text += prefix + content; offset += length
        }
        self.text = text; self.rows = rows
    }
    func copied(_ ranges: [NSRange]) -> String {
        let value = text as NSString
        return ranges.flatMap { range in rows.compactMap { row -> String? in guard let source = row.source else { return nil }; let overlap = NSIntersectionRange(source, range); return overlap.length > 0 ? value.substring(with: overlap) : nil } }.joined()
    }
    func selection(_ range: NSRange) -> TaskDiffReviewSelection? {
        let selected = rows.filter { $0.source != nil && NSIntersectionRange($0.range, range).length > 0 }
        guard let first = selected.first?.point(side: side), let last = selected.last?.point(side: side) else { return nil }
        return TaskDiffReviewSelection(start: first.line, side: first.side, end: last.line, endSide: last.side)
    }
    func row(at offset: Int) -> Row? {
        var low = 0, high = rows.count
        while low < high { let middle = (low + high) / 2; if rows[middle].range.location <= offset { low = middle + 1 } else { high = middle } }
        return low > 0 && NSLocationInRange(offset, rows[low - 1].range) ? rows[low - 1] : nil
    }
    func visibleRows(_ range: NSRange) -> ArraySlice<Row> {
        guard let first = row(at: range.location) else { return [] }
        let last = row(at: max(range.location, NSMaxRange(range) - 1)) ?? rows.last!
        return rows[first.slot...last.slot]
    }
    func anchor(_ point: TaskDiffReviewPoint) -> Row? {
        guard side == nil || side == point.side else { return nil }
        return rows.first { point.side == "deletions" ? $0.line?.oldNumber == point.line : $0.line?.newNumber == point.line }
    }
}
