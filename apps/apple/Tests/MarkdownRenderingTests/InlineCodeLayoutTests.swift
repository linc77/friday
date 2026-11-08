import XCTest
#if os(macOS)
import AppKit
@testable import FridayKit

final class InlineCodeLayoutTests: XCTestCase {
    @MainActor func testPaddingPreservesUnicodeSourceAndLinks() async throws {
        let runs = [MarkdownRun(text: "提交🙂："), MarkdownRun(text: "main", style: .code), MarkdownRun(text: "，继续。")]
        let url = try XCTUnwrap(URL(string: "https://example.com/main"))
        let value = TaskCitationTextStyle.runs(runs, role: .body, links: [nil, url, nil], secondary: false, reading: ReadingStyle())
        XCTAssertEqual(value.string, "提交🙂：main，继续。")
        let range = (value.string as NSString).range(of: "main")
        XCTAssertEqual(value.attribute(.link, at: range.location, effectiveRange: nil) as? URL, url)
        let font = try XCTUnwrap(value.attribute(.font, at: range.location, effectiveRange: nil) as? NSFont)
        XCTAssertEqual(font.pointSize, 15 * 0.85, accuracy: 0.01)
        XCTAssertNil(value.attribute(.attachment, at: range.location, effectiveRange: nil))
        let view = CitationPartView(frame: .zero, textContainer: nil)
        view.configure(value, key: [], group: [], lines: nil, model: nil)
        let size = view.measure(400)
        view.frame.size = size
        let rect = try XCTUnwrap(view.rectangles(range).first)
        let hit = view.offset(at: CGPoint(x: rect.minX + 1, y: rect.midY))
        XCTAssertTrue(NSLocationInRange(hit, range))
        XCTAssertEqual(view.link(at: hit), url)
    }

    @MainActor func testWrappedCodeHasSeparateBackgroundsAndReservesBoundarySpace() async throws {
        let text = "long_identifier_with_many_parts_0123456789_abcdefghijklmnopqrstuvwxyz"
        let value = TaskCitationTextStyle.runs([MarkdownRun(text: "前"), MarkdownRun(text: text, style: .code), MarkdownRun(text: "后")], role: .body, links: [], secondary: false, reading: ReadingStyle())
        let view = CitationPartView(frame: .zero, textContainer: nil)
        view.configure(value, key: [], group: [], lines: nil, model: nil)
        let size = view.measure(180)
        view.frame.size = size
        let layout = try XCTUnwrap(view.layoutManager as? InlineCodeLayoutManager)
        let container = try XCTUnwrap(view.textContainer)
        let boxes = layout.codeBackgrounds(in: layout.glyphRange(for: container)).map(\.0)
        XCTAssertGreaterThan(boxes.count, 1)
        for box in boxes {
            XCTAssertGreaterThan(box.width, 0)
            XCTAssertGreaterThanOrEqual(box.minX + view.textContainerOrigin.x, -0.5)
            XCTAssertLessThanOrEqual(box.maxX + view.textContainerOrigin.x, 180.5)
            XCTAssertGreaterThanOrEqual(box.minY + view.textContainerOrigin.y, -0.5)
            XCTAssertLessThanOrEqual(box.maxY + view.textContainerOrigin.y, size.height + 0.5)
        }
        for pair in zip(boxes, boxes.dropFirst()) { XCTAssertLessThanOrEqual(pair.0.maxY, pair.1.minY + 0.5) }
        XCTAssertEqual(value.string, "前" + text + "后")
    }
}
#endif
