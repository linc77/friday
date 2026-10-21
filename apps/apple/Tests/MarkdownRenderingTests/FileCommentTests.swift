import XCTest
@testable import FridayKit

final class FileCommentTests: XCTestCase {
    private func annotation(_ start: Int, _ end: Int, text: String? = "comment") -> TaskFileLineAnnotation { TaskFileLineAnnotation(id: UUID(), range: TaskSourceLineRange(start, end), text: text) }
    private func draft(_ contents: String = "source", target: String = "host\ntask:id\nqueue:") -> TaskFileReviewDraft { TaskFileReviewDraft(commentID: "comment", scope: "scope", target: target, workspaceRoot: "/project", workspaceVersion: "version", path: "a #?%.ts", range: TaskSourceLineRange(2, 3), comment: "Please simplify", contents: contents) }
    func testDraftReferencesAreStableAcrossRestartsButChangeWithTheSelectionAndKeepOldDraftsDecodable() throws {
        let value = draft(), reference = value.reference
        XCTAssertEqual(reference.id, value.reference.id); XCTAssertNotEqual(reference.id, draft("changed").reference.id)
        XCTAssertEqual(reference.kind, "review-comment"); XCTAssertEqual(reference.label, "a #?%.ts L2 to L3")
        let restored = try JSONDecoder().decode(TaskContextReference.self, from: JSONEncoder().encode(reference)); XCTAssertEqual(restored.reviewDraft, value)
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(reference)) as? [String: Any]); legacy.removeValue(forKey: "reviewDraft")
        XCTAssertNil(try JSONDecoder().decode(TaskContextReference.self, from: JSONSerialization.data(withJSONObject: legacy)).reviewDraft)
        let second = TaskFileReviewDraft(commentID: "another comment", scope: value.scope, target: value.target, workspaceRoot: value.workspaceRoot, workspaceVersion: value.workspaceVersion, path: value.path, range: value.range, comment: value.comment, contents: value.contents)
        XCTAssertNotEqual(second.reference.id, reference.id, "Two comments on the same lines remain independent")
        XCTAssertEqual(TaskFileReviewDraft.clipped("a🙂", length: 2), "a")
        XCTAssertEqual(TaskFileReviewDraft.clipped("a🙂", length: 3), "a🙂")
    }
    func testCommentUpdatesReplaceExistingReferencesWithoutAppendingAndDeletionRemovesAllOccurrences() throws {
        let old = draft().reference, next = draft("new source"), text = "before " + TaskContextDocument.token(old) + " after " + TaskContextDocument.token(old)
        let update = try XCTUnwrap(TaskFileReviewDocument.update(.upsert(next, replacing: old.id), text: text, records: [old], scope: "scope", target: next.target))
        XCTAssertNil(update.insert); XCTAssertEqual(TaskContextDocument.used(update.text, records: update.records).map(\.id), [next.reference.id]); XCTAssertEqual(TaskContextDocument.occurrences(update.text).count, 2)
        let removed = try XCTUnwrap(TaskFileReviewDocument.update(.remove(next.reference.id, target: next.target), text: update.text, records: update.records, scope: "scope", target: next.target))
        XCTAssertTrue(removed.records.isEmpty); XCTAssertTrue(TaskContextDocument.occurrences(removed.text).isEmpty)
        XCTAssertNil(TaskFileReviewDocument.update(.upsert(next, replacing: old.id), text: text, records: [old], scope: "other", target: next.target))
        XCTAssertNil(TaskFileReviewDocument.update(.remove(old.id, target: "old queue"), text: text, records: [old], scope: "scope", target: next.target))
    }
    func testDeletingTheComposerTokenDoesNotMakeAnEditInsertItAgain() throws {
        let old = draft().reference, next = draft("changed")
        let update = try XCTUnwrap(TaskFileReviewDocument.update(.upsert(next, replacing: old.id), text: "typed text", records: [old], scope: "scope", target: next.target))
        XCTAssertNil(update.insert); XCTAssertEqual(update.text, "typed text")
        let afterSend = try XCTUnwrap(TaskFileReviewDocument.update(.upsert(next, replacing: old.id), text: "", records: [], scope: "scope", target: next.target)); XCTAssertEqual(afterSend.insert?.id, next.reference.id)
    }
    func testNativeTextEditsKeepValidUTF16AndCommentAnchorsThroughInsertionsAndDeletes() {
        for (before, after) in [("🙂\na", "🙃\na"), ("a🙂b", "a𐀀b"), ("a\nb\nc\n", "new\na\nb\nc\n"), ("", "🙂")] {
            let edit = TaskSourceTextEdit.between(before, after); XCTAssertEqual((before as NSString).replacingCharacters(in: edit.range, with: edit.replacement), after)
        }
        let source = "a\nb\nc\n", value = annotation(2, 3)
        let inserted = TaskSourceTextEdit.between(source, "new\n" + source).remap([value], source: source)
        XCTAssertEqual(inserted.first?.range, TaskSourceLineRange(3, 4))
        let deleted = TaskSourceTextEdit.between(source, "a\n").remap([value], source: source); XCTAssertTrue(deleted.isEmpty)
    }
    func testLineMappingMatchesThePinnedPierreTextDocumentIncludingBlankLinesCRLFAndUnicode() throws {
        struct Range: Decodable { let location: Int; let length: Int }
        struct Fixture: Decodable { let source: String; let range: Range; let replacement: String; let after: String; let annotations: [TaskSourceLineRange]; let expected: [TaskSourceLineRange] }
        struct Fixtures: Decodable { let source: String; let cases: [Fixture] }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/pierre-file-annotations.json")
        let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: path)); XCTAssertEqual(fixtures.cases.count, 64)
        for (index, fixture) in fixtures.cases.enumerated() {
            let edit = TaskSourceTextEdit(range: NSRange(location: fixture.range.location, length: fixture.range.length), replacement: fixture.replacement)
            XCTAssertEqual((fixture.source as NSString).replacingCharacters(in: edit.range, with: edit.replacement), fixture.after, "case \(index)")
            let entries = fixture.annotations.map { annotation($0.start, $0.end) }
            XCTAssertEqual(edit.remap(entries, source: fixture.source).map(\.range), fixture.expected, "case \(index)")
        }
    }
    func testAnnotationHistoryRestoresDeletedCommentsAndExternalReplacementKeepsItsOwnUndoBoundary() {
        var state = TaskFileAnnotationState(source: "a\nb\nc\n")
        state.annotations = [annotation(2, 3)]; state.change("a\n"); XCTAssertTrue(state.annotations.isEmpty)
        state.change("a\nb\nc\n", undo: true); XCTAssertEqual(state.annotations.first?.range, TaskSourceLineRange(2, 3))
        state.change("a\n", redo: true); XCTAssertTrue(state.annotations.isEmpty)
        state.change("external\nfile\ncontents\n", external: true); state.change("a\n", undo: true); XCTAssertEqual(state.source, "a\n")
        state.begin(TaskSourceLineRange(1, 2)); state.begin(TaskSourceLineRange(2, 2)); XCTAssertEqual(state.annotations.filter { $0.text == nil }.count, 1)
    }
    func testUndoKeepsTheCurrentComposerCaptureBindingInsteadOfInsertingAnOlderDuplicate() throws {
        var state = TaskFileAnnotationState(source: "a\nb\nc\n")
        let entry = annotation(2, 3); state.annotations = [entry]
        state.references[entry.id] = TaskFileReviewBinding(referenceID: "first", target: "composer")
        state.change("new\n" + state.source)
        state.references[entry.id] = TaskFileReviewBinding(referenceID: "current", target: "composer")
        state.change("a\nb\nc\n", undo: true)
        XCTAssertEqual(state.annotations.first?.id, entry.id); XCTAssertEqual(state.references[entry.id]?.referenceID, "current")
        let before = "\n\n\n", insertion = TaskSourceTextEdit(range: NSRange(location: 0, length: 0), replacement: "\n")
        state = TaskFileAnnotationState(source: before); state.annotations = [annotation(1, 1)]
        state.change("\n" + before, edit: insertion); XCTAssertEqual(state.annotations.first?.range, TaskSourceLineRange(2, 2))
    }
    @MainActor func testExternalReplacementJoinsExistingUndoAndRedoAndRestoresSelection() {
        let manager = UndoManager(); manager.groupsByEvent = false
        var value = TaskSourceUndoSnapshot(source: "original", ranges: [NSRange(location: 2, length: 3)])
        let document = TaskSourceExternalUndo(manager: manager, read: { value }, write: { value = $0 })
        manager.beginUndoGrouping(); document.replace(TaskSourceUndoSnapshot(source: "typed", ranges: [NSRange(location: 5, length: 0)])); manager.endUndoGrouping()
        manager.beginUndoGrouping(); document.replace(.replacement("external")); manager.endUndoGrouping()
        manager.undo(); XCTAssertEqual(value.source, "typed"); XCTAssertEqual(value.ranges.first, NSRange(location: 5, length: 0))
        manager.undo(); XCTAssertEqual(value.source, "original"); XCTAssertEqual(value.ranges.first, NSRange(location: 2, length: 3))
        manager.redo(); manager.redo(); XCTAssertEqual(value.source, "external"); XCTAssertEqual(value.ranges.first, NSRange(location: 8, length: 0))
    }
}
