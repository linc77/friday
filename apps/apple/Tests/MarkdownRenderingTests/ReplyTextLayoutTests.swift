import XCTest
#if os(macOS)
import AppKit
@testable import FridayKit

final class ReplyTextLayoutTests: XCTestCase {
    @MainActor func testReplyKeepsItsTextAndAllocatesVisibleLines() async throws {
        let view = CitationPartView(frame: .zero, textContainer: nil)
        let model = TaskCitationSelectionModel(source: TaskCitationSourceIdentity(environment: "host", task: "task", message: "reply", connection: "connection"))
        let text = "你好，Friday。\nThis reply must remain visible."
        let value = TaskCitationTextStyle.runs([MarkdownRun(text: text)], role: .body, links: [nil], secondary: false)

        view.configure(value, key: [0, 0], group: [0], lines: nil, model: model)

        XCTAssertNotNil(view.textStorage, "A reply cannot display without its native text storage")
        XCTAssertNotNil(view.textContainer)
        XCTAssertNotNil(view.layoutManager)
        XCTAssertEqual(view.string, text)
        let size = view.measure(560)
        XCTAssertEqual(size.width, 560)
        XCTAssertGreaterThan(size.height, NSFont.preferredFont(forTextStyle: .body).pointSize)
        XCTAssertFalse(view.rectangles(NSRange(location: 0, length: text.utf16.count)).isEmpty)
        model.rebuild()
        XCTAssertEqual(model.text, text, "Visible text and the citation source must use the same storage")
    }

    @MainActor func testStreamingUpdatesAndWidthChangesKeepCompleteTextAndCitationRanges() async throws {
        let view = CitationPartView(frame: .zero, textContainer: nil)
        let model = TaskCitationSelectionModel(source: TaskCitationSourceIdentity(environment: "host", task: "task", message: "stream", connection: "connection"))
        let url = try XCTUnwrap(URL(string: "https://example.test/reply"))
        let first = TaskCitationTextStyle.runs([MarkdownRun(text: "Hello")], role: .body, links: [nil], secondary: false)
        view.configure(first, key: [0, 0], group: [0], lines: nil, model: model)
        XCTAssertGreaterThan(view.measure(560).height, 1)

        let text = String(repeating: "持续输出 🙂 streaming text. ", count: 12)
        let updated = TaskCitationTextStyle.runs([MarkdownRun(text: text, style: [.strong], link: url.absoluteString)], role: .body, links: [url], secondary: false)
        view.configure(updated, key: [0, 0], group: [0], lines: nil, model: model)
        let narrow = view.measure(180), wide = view.measure(720)
        XCTAssertGreaterThan(narrow.height, wide.height)
        XCTAssertGreaterThan(wide.height, 1)
        XCTAssertTrue(view.measure(nil).height.isFinite)
        XCTAssertEqual(view.string, text)
        XCTAssertEqual(view.link(at: 0), url)
        model.rebuild()
        let range = (text as NSString).range(of: "🙂")
        model.select(range)
        XCTAssertEqual(model.citation?.text, "🙂")
        XCTAssertFalse(view.rectangles(range).isEmpty)
    }
}
#endif
