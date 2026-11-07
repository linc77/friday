import XCTest
@testable import FridayKit

final class DiffReviewTests: XCTestCase {
    private let patch = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,3 @@\n common\n-old 🙂\n+new 二\n tail\n"
    func testReviewRangesAndQuotedPatchMatchAllUpstreamSelectionsIncludingBothSidesAndReversedDrags() throws {
        struct Fixture: Decodable { let patch: String; let selection: TaskDiffReviewSelection; let startIndex: Int; let endIndex: Int; let rangeLabel: String; let expected: String }
        struct Fixtures: Decodable { let source: String; let cases: [Fixture] }
        let path = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/t3-diff-reviews.json")
        let fixtures = try JSONDecoder().decode(Fixtures.self, from: Data(contentsOf: path)); XCTAssertEqual(fixtures.cases.count, 544)
        for (index, fixture) in fixtures.cases.enumerated() {
            let actual = try XCTUnwrap(TaskDiffReviewDocument(fixture.patch).review(fixture.selection, sectionID: "unstaged", title: "Uncommitted"), "case \(index)")
            XCTAssertEqual(actual.patch, fixture.expected, "case \(index)"); XCTAssertEqual(actual.metadata.rangeLabel, fixture.rangeLabel, "case \(index)")
            XCTAssertEqual(actual.metadata.startIndex, fixture.startIndex, "case \(index)"); XCTAssertEqual(actual.metadata.endIndex, fixture.endIndex, "case \(index)")
            XCTAssertEqual(actual.metadata.selection, fixture.selection)
        }
    }
    func testDisplayedSourceRangesExcludeHeadersGuttersPaddingAndOppositeSideContent() throws {
        let unified = TaskDiffRenderedDocument(patch: patch, side: nil)
        XCTAssertEqual(unified.copied([NSRange(location: 0, length: (unified.text as NSString).length)]), "common\nold 🙂\nnew 二\ntail\n")
        for side in ["deletions", "additions"] {
            let document = TaskDiffRenderedDocument(patch: patch, side: side)
            let copied = document.copied([NSRange(location: 0, length: (document.text as NSString).length)])
            XCTAssertEqual(copied, side == "deletions" ? "common\nold 🙂\ntail\n" : "common\nnew 二\ntail\n")
            let point = TaskDiffReviewPoint(line: 2, side: side), row = try XCTUnwrap(document.anchor(point))
            XCTAssertEqual(document.selection(row.range)?.first, point)
            XCTAssertEqual((document.text as NSString).substring(with: try XCTUnwrap(row.source)), side == "deletions" ? "old 🙂\n" : "new 二\n")
            XCTAssertNil(document.anchor(TaskDiffReviewPoint(line: 2, side: side == "deletions" ? "additions" : "deletions")))
        }
    }
    func testReviewMetadataRemainsDistinctAcrossSectionsAndUsesTheUpstreamBeforeLabel() throws {
        let selection = TaskDiffReviewSelection(start: 2, side: "deletions", end: 2, endSide: "deletions")
        let review = try XCTUnwrap(TaskDiffReviewDocument(patch).review(selection, sectionID: "turn:run", title: "Turn 1"))
        let draft = TaskFileReviewDraft(commentID: "comment", scope: "scope", target: "composer", workspaceRoot: "/root", workspaceVersion: "", path: "file.ts", range: TaskSourceLineRange(2, 2), comment: "Check this", contents: review.patch, diffReview: review.metadata)
        XCTAssertEqual(draft.reference.label, "file.ts L2 (before)"); XCTAssertNil(draft.body["workspaceVersion"])
        let body = try XCTUnwrap(draft.body["diffReview"] as? [String: Any]); XCTAssertEqual(body["sectionID"] as? String, "turn:run")
        let decoded = try JSONDecoder().decode(TaskContextReference.self, from: JSONEncoder().encode(draft.reference)); XCTAssertEqual(decoded.reviewDraft?.diffReview, review.metadata)
        XCTAssertNotNil(TaskContextSnapshot(reference: draft.reference, cwd: "/root", text: "").fileReview?.diffReview)
        let invalid = TaskDiffReviewSelection(start: 999, side: "deletions", end: 1, endSide: "additions"); XCTAssertFalse(TaskDiffReviewDocument(patch).contains(invalid))
    }
    func testLargeLineNumbersKeepStableGutterColumnsAndVisibleRowRanges() throws {
        let value = TaskDiffRenderedDocument(patch: "@@ -99999,2 +99999,2 @@\n a\n-old\n+new\n", side: nil)
        XCTAssertEqual(value.numberCharacters, 6); XCTAssertEqual(value.gutterCharacters, 17)
        for row in value.rows where row.source != nil { XCTAssertEqual(try XCTUnwrap(row.source).location - row.range.location, value.gutterCharacters) }
        let last = try XCTUnwrap(value.rows.last)
        XCTAssertEqual(value.visibleRows(NSRange(location: last.range.location, length: last.range.length)).map(\.slot), [last.slot])
        XCTAssertTrue(value.visibleRows(NSRange(location: (value.text as NSString).length, length: 0)).isEmpty)
    }
}
