import Foundation
import CryptoKit

/// Kept only in the client draft. Materialized as an immutable private capture
/// before sending; public task snapshots never contain this payload.
extension TaskFileReviewDraft {
    var body: [String: Any] {
        var body: [String: Any] = ["kind": "review-comment", "path": path, "lineStart": range.start, "lineEnd": range.end, "comment": comment, "contents": contents, "workspaceRoot": workspaceRoot]
        if let diffReview { body["diffReview"] = (try? JSONEncoder().encode(diffReview)).flatMap { try? JSONSerialization.jsonObject(with: $0) } }
        else { body["workspaceVersion"] = workspaceVersion }
        return body
    }
    var reference: TaskContextReference {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let bytes = (try? encoder.encode(self)) ?? Data()
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return TaskContextReference(id: "file-comment-" + hash, kind: "review-comment", label: (path as NSString).lastPathComponent + " " + (diffReview?.contextLabel ?? range.label), capturedAt: ISO8601DateFormatter().string(from: Date()), digest: hash, byteLength: contents.utf8.count, path: path, terminalId: nil, terminalLabel: nil, generation: nil, lineStart: range.start, lineEnd: range.end, truncated: nil, reviewDraft: self)
    }
    var preview: String { comment + "\n\n" + path + " " + range.label + "\n\n" + contents }
    static func clipped(_ text: String, length: Int) -> String {
        let value = text as NSString; guard value.length > length else { return text }
        var end = max(0, length)
        if end > 0, (0xD800...0xDBFF).contains(value.character(at: end - 1)) { end -= 1 }
        return value.substring(to: end)
    }
}

struct TaskFileReviewContents: Decodable {
    let fenceLanguage: String; let source: String; let text: String
    var diffReview: TaskDiffReviewMetadata? = nil
}
extension TaskContextSnapshot {
    var fileReview: TaskFileReviewContents? {
        guard reference.kind == "review-comment" else { return nil }
        if let draft = reference.reviewDraft { return TaskFileReviewContents(fenceLanguage: draft.diffReview == nil ? (draft.path as NSString).pathExtension.lowercased() : "diff", source: draft.contents, text: draft.comment, diffReview: draft.diffReview) }
        return try? JSONDecoder().decode(TaskFileReviewContents.self, from: Data(text.utf8))
    }
    var copiedContents: String { browserAnnotation?.rendered() ?? fileReview.map { reference.label + "\n\n" + $0.text + "\n\n" + $0.source } ?? text }
}

struct TaskFileLineAnnotation: Identifiable, Equatable {
    let id: UUID
    var range: TaskSourceLineRange
    var text: String? // nil is the single open comment form.
    var presentationID: String? = nil
    var presentationVersion: String? = nil
}
struct TaskFileReviewBinding { let referenceID: String; let target: String }

enum TaskFileReviewMutation {
    case upsert(TaskFileReviewDraft, replacing: String?)
    case remove(String, target: String)
}

enum TaskFileReviewDocument {
    static func update(_ mutation: TaskFileReviewMutation, text: String, records: [TaskContextReference], scope: String, target: String) -> (text: String, records: [TaskContextReference], insert: TaskContextReference?)? {
        switch mutation {
        case let .upsert(draft, old):
            guard draft.scope == scope, draft.target == target else { return nil }
        let reference = draft.reference
            var values = records.filter { $0.id != old && $0.id != reference.id }; values.append(reference)
            let existing = old.flatMap { id in records.first { $0.id == id } }
            var next = text
            if let old { for occurrence in TaskContextDocument.occurrences(text).reversed() where occurrence.id == old { next = (next as NSString).replacingCharacters(in: occurrence.range, with: TaskContextDocument.token(reference)) } }
            guard Set(TaskContextDocument.used(next, records: values).map(\.id)).union(existing == nil ? [reference.id] : []).count <= 20 else { return nil }
            return (next, values, existing == nil ? reference : nil)
        case let .remove(id, expected):
            guard expected == target else { return nil }
            var next = text
            for occurrence in TaskContextDocument.occurrences(text).reversed() where occurrence.id == id { next = (next as NSString).replacingCharacters(in: occurrence.range, with: "") }
            return (next, records.filter { $0.id != id }, nil)
        }
    }
}

/// One native edit, expressed in UTF-16 offsets shared with NSTextView/UITextView.
struct TaskSourceTextEdit {
    let range: NSRange; let replacement: String
    static func between(_ before: String, _ after: String) -> Self {
        let left = Array(before.utf16), right = Array(after.utf16); var start = 0, end = 0
        while start < min(left.count, right.count), left[start] == right[start] { start += 1 }
        while end < min(left.count, right.count) - start, left[left.count - end - 1] == right[right.count - end - 1] { end += 1 }
        // Do not split a surrogate pair when a changed scalar shares its high surrogate.
        if start > 0, start < left.count, (0xDC00...0xDFFF).contains(left[start]) { start -= 1 }
        if end > 0, left.count - end > start, (0xDC00...0xDFFF).contains(left[left.count - end]) { end -= 1 }
        return Self(range: NSRange(location: start, length: left.count - start - end), replacement: String(decoding: right[start..<(right.count - end)], as: UTF16.self))
    }
    func remap(_ annotations: [TaskFileLineAnnotation], source: String) -> [TaskFileLineAnnotation] {
        let lines = TaskSourceLines(source), start = lines.number(at: range.location) - 1, end = lines.number(at: NSMaxRange(range)) - 1
        let breaks = replacement.utf16.filter { $0 == 10 }.count, delta = breaks - (end - start)
        guard delta != 0 || breaks > 0 else { return annotations }
        let newCount = max(1, lines.starts.count + delta), atStart = range.location == lines.starts[start], deletesEnd = delta < 0 && NSMaxRange(range) == lines.length
        return annotations.compactMap { annotation in
            let line = annotation.range.end - 1
            let mapped: Int?
            if line < start { mapped = line }
            else if line > end || (end > start && line == end && !deletesEnd) { mapped = line + delta }
            else if start == end { mapped = atStart ? line + breaks : line }
            else if delta < 0 && !(line == start && !atStart) && !(line == end && !deletesEnd) { mapped = nil }
            else { mapped = min(newCount - 1, start + min(max(0, line - start), breaks)) }
            guard let mapped else { return nil }
            var value = annotation; let width = annotation.range.end - annotation.range.start
            value.range = TaskSourceLineRange(max(1, mapped + 1 - width), mapped + 1); return value
        }
    }
}

struct TaskFileAnnotationState {
    private struct Snapshot { let hash: Data; let annotations: [TaskFileLineAnnotation] }
    private var history: [Snapshot] = []
    private var index = -1
    private(set) var source: String
    var annotations: [TaskFileLineAnnotation] = []
    // Logical comment identity survives undo; an immutable capture ID changes
    // with its payload and must not be restored from an older text snapshot.
    var references: [UUID: TaskFileReviewBinding] = [:]
    init(source: String) { self.source = source; remember() }
    private static func hash(_ source: String) -> Data { Data(SHA256.hash(data: Data(source.utf8))) }
    private mutating func remember() {
        history = Array(history.prefix(index + 1)); history.append(Snapshot(hash: Self.hash(source), annotations: annotations)); index = history.count - 1
    }
    mutating func change(_ contents: String, undo: Bool = false, redo: Bool = false, external: Bool = false, edit: TaskSourceTextEdit? = nil) {
        guard contents != source else { return }
        if index >= 0 { history[index] = Snapshot(hash: Self.hash(source), annotations: annotations) }
        let hash = Self.hash(contents)
        let restored = undo ? history.indices.prefix(index).last(where: { history[$0].hash == hash }) : redo ? history.indices.dropFirst(index + 1).first(where: { history[$0].hash == hash }) : nil
        if let restored { index = restored; annotations = history[restored].annotations; source = contents; return }
        if !external { annotations = (edit ?? TaskSourceTextEdit.between(source, contents)).remap(annotations, source: source) }
        source = contents; remember()
    }
    mutating func begin(_ range: TaskSourceLineRange) {
        annotations.removeAll { $0.text == nil }
        annotations.append(TaskFileLineAnnotation(id: UUID(), range: range, text: nil))
    }
}

/// Shares the native UndoManager with typing. External replacements are one
/// additional reversible edit, rather than resetting that timeline.
@MainActor final class TaskSourceExternalUndo<Value: Equatable> {
    let manager: UndoManager
    let read: () -> Value
    let write: (Value) -> Void
    init(manager: UndoManager, read: @escaping () -> Value, write: @escaping (Value) -> Void) { self.manager = manager; self.read = read; self.write = write }
    func replace(_ value: Value) {
        let before = read(); guard before != value else { return }
        manager.registerUndo(withTarget: self) { target in MainActor.assumeIsolated { target.replace(before) } }
        write(value)
    }
}
