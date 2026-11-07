import XCTest
@testable import FridayKit

final class SourceEditorStateTests: XCTestCase {
    func testRestoringAnOldLineRequestDoesNotOverrideUserScrollingButNewRequestsDo() {
        let old = TaskSourceRevealRequest(line: 20, generation: 3)
        XCTAssertTrue(old.needsReveal(after: nil)); XCTAssertFalse(old.needsReveal(after: old))
        XCTAssertTrue(TaskSourceRevealRequest(line: 20, generation: 4).needsReveal(after: old))
        XCTAssertTrue(TaskSourceRevealRequest(line: 30, generation: 3).needsReveal(after: old))
        XCTAssertFalse(TaskSourceRevealRequest(line: nil, generation: 4).needsReveal(after: old))
    }
    func testRestorationClampsAfterContentOrViewportShrinksAndUsesUTF16Lengths() {
        let length = ("🚀中文" as NSString).length
        XCTAssertEqual(TaskSourceEditorPosition.selection(NSRange(location: 2, length: Int.max), length: length), NSRange(location: 2, length: 2))
        XCTAssertEqual(TaskSourceEditorPosition.selection(NSRange(location: 90, length: 4), length: length), NSRange(location: 4, length: 0))
        XCTAssertEqual(TaskSourceEditorPosition.selection(NSRange(location: NSNotFound, length: 0), length: length), NSRange(location: 0, length: 0))
        XCTAssertEqual(TaskSourceEditorPosition.origin(CGPoint(x: 800, y: 900), content: CGSize(width: 1000, height: 500), viewport: CGSize(width: 300, height: 200)), CGPoint(x: 700, y: 300))
        XCTAssertEqual(TaskSourceEditorPosition.origin(CGPoint(x: -5, y: 100), content: CGSize(width: 50, height: 50), viewport: CGSize(width: 100, height: 100)), .zero)
    }
}
