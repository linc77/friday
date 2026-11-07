import XCTest
@testable import FridayKit

final class HTMLMarkdownTests: XCTestCase {
    func testActualNativeParserKeepsMarkdownInsideNestedHTMLDetails() throws {
        let source = "<details open><summary>Read <strong>more</strong></summary>\n\n## Inner\n\n- Parent\n  - [x] Done\n  - [ ] Pending\n\n<details><summary>Nested</summary>\n\n**Body**\n\n</details>\n\n</details>"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source), "The actual JavaScriptCore parser must load, rather than silently use the fallback")
        guard case .details(let outer)? = blocks.first, case .heading(_, let heading) = outer.blocks[0],
              case .list(let list) = outer.blocks[1], case .details(let inner) = outer.blocks[2] else { return XCTFail("HTML boundaries flattened or consumed Markdown") }
        XCTAssertTrue(outer.initiallyOpen); XCTAssertEqual(outer.summary.plainText, "Read more")
        XCTAssertEqual(heading.plainText, "Inner"); XCTAssertEqual(heading.anchors, ["user-content-inner"])
        XCTAssertNil(list.items[0].checked, "A nested checkbox must not turn its parent into a task")
        guard case .list(let tasks) = list.items[0].blocks[1], case .paragraph(let body) = inner.blocks[0] else { return XCTFail("Nested list or details body missing") }
        XCTAssertEqual(tasks.items.map(\.checked), [true, false]); XCTAssertEqual(body.plainText, "Body"); XCTAssertFalse(inner.initiallyOpen)
        XCTAssertTrue(runs(body).contains { $0.style.contains(.strong) })
    }
    func testHTMLInlineFormattingEntitiesAndBreaksBecomeNativeRuns() throws {
        let source = "Use <kbd>⌘ K</kbd>, H<sub>2</sub>O, x<sup>2</sup>, <ins>added</ins>, <s>old</s> and <samp>output</samp>.<br>Next &amp; &#x1F680;"
        guard case .paragraph(let value)? = try XCTUnwrap(NativeMarkdownParser.shared.parse(source)).first else { return XCTFail("Missing HTML inline paragraph") }
        XCTAssertEqual(value.plainText, "Use ⌘ K, H2O, x2, added, old and output.\nNext & 🚀")
        for (text, style) in [("⌘ K", MarkdownStyle.keyboard), ("2", .subscriptText), ("2", .superscriptText), ("added", .underline), ("old", .strike), ("output", .code)] {
            XCTAssertTrue(runs(value).contains { $0.text == text && $0.style.contains(style) }, text)
        }
    }
    func testUnsafeHTMLIsSanitizedBeforeNativeProjection() throws {
        let source = "<div><script>globalThis.neverRun = true</script><a href='jav&#x61;script:alert(1)' onclick='bad()'>Read</a><img src='javascript:bad()' alt='Diagram' onerror='bad()'><iframe src='https://example.com'>Frame text</iframe></div>"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source))
        guard case .paragraph(let value)? = blocks.first else { return XCTFail("Safe content disappeared") }
        XCTAssertFalse(value.plainText.contains("neverRun")); XCTAssertTrue(value.plainText.contains("Read"))
        XCTAssertNil(runs(value).first { $0.text == "Read" }?.link)
        let image = value.fragments.compactMap { if case .image(let value) = $0 { value } else { nil } }.first
        XCTAssertEqual(image?.source, ""); XCTAssertEqual(image?.alt, "Diagram")
    }
    func testHeadingAndExplicitFragmentIdsResolveWithinTheirOwnMessage() throws {
        let source = "<a id='a'></a>\n\n# A\n\n# A\n\n# 中文 标题 🚀\n\n<details><summary>More</summary>\n\n<span id='deep'>Target</span>\n\n</details>\n\n[x](#deep)"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source))
        let anchors = MarkdownNavigation.anchors(in: blocks)
        XCTAssertEqual(anchors, ["user-content-a", "user-content-a-1", "user-content-a-2", "user-content-中文-标题-", "user-content-deep"])
        let first = MarkdownNavigation(scope: UUID(), anchors: anchors), other = MarkdownNavigation(scope: UUID(), anchors: anchors)
        XCTAssertEqual(first.target("#a-1")?.fragment, "user-content-a-1")
        XCTAssertEqual(first.target("#user-content-user-content-deep")?.fragment, "user-content-deep")
        XCTAssertEqual(first.target("#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98-")?.fragment, "user-content-中文-标题-")
        XCTAssertNotEqual(first.target("#deep"), other.target("#deep"))
        XCTAssertNil(first.target("#missing")); XCTAssertNil(first.target("https://example.com/#deep")); XCTAssertNil(first.target("#"))
    }
    func testHTMLTablesKeepCellsAndFencesKeepSourceAndMetadata() throws {
        let source = "<table><thead><tr><th align='right'>Name</th><th>Value</th></tr></thead><tbody><tr><td><b>A</b></td><td>one,two<br>three</td></tr></tbody></table>\n\n<details><summary>Code</summary>\n\n```html title=\"index.html\"\n<script>globalThis.neverRun = true</script>\n```\n\n</details>"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source))
        guard case .table(let table) = blocks[0], case .details(let details) = blocks[1], case .code(let fence) = details.blocks[0] else { return XCTFail("Missing HTML table or nested fence") }
        XCTAssertEqual(table.alignments, [.right, .left]); XCTAssertTrue(table.headerIsStyled)
        XCTAssertEqual(table.csv, "Name,Value\nA,\"one,two three\""); XCTAssertTrue(table.markdown.contains("**A**"))
        XCTAssertEqual(fence.language, "html"); XCTAssertEqual(fence.title, "index.html")
        XCTAssertEqual(fence.text, "<script>globalThis.neverRun = true</script>\n")
    }
    func testFootnoteReferencesAndBacklinksRetainDistinctTargets() throws {
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse("A note[^one].\n\n[^one]: Footnote **text**."))
        let anchors = MarkdownNavigation.anchors(in: blocks)
        XCTAssertTrue(anchors.contains("user-content-user-content-fnref-one")); XCTAssertTrue(anchors.contains("user-content-user-content-fn-one"))
        let navigation = MarkdownNavigation(scope: UUID(), anchors: anchors)
        XCTAssertNotNil(navigation.target("#user-content-fn-one")); XCTAssertNotNil(navigation.target("#user-content-fnref-one"))
    }
    func testOverIndentedListTextUsesT3RecoveryAndUnfinishedHTMLStaysReadable() throws {
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse("-      **Recover this**\n\n<details><summary>Still streaming</summary>\n\nPartial **body**"))
        guard case .list(let list) = blocks[0], case .paragraph(let recovered) = list.items[0].blocks[0], case .details(let details) = blocks[1], case .paragraph(let body) = details.blocks[0] else { return XCTFail("Recovered text or unfinished disclosure missing") }
        XCTAssertEqual(recovered.plainText, "Recover this"); XCTAssertTrue(runs(recovered).contains { $0.style.contains(.strong) })
        XCTAssertEqual(body.plainText, "Partial body")
        guard case .list(let exactCode)? = NativeMarkdownParser.shared.parse("-     **Keep as code**")?.first, case .code(let code) = exactCode.items[0].blocks[0] else { return XCTFail("T3 preserves exactly five-space code") }
        XCTAssertEqual(code.text, "**Keep as code**\n")
    }
    func testInlineCodeRetainsMeaningfulSpacesAndBackticks() throws {
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse("Use `a  b` and ``a`b``.\n\n| Value |\n| --- |\n| `a  b` |"))
        guard case .paragraph(let paragraph) = blocks[0], case .table(let table) = blocks[1] else { return XCTFail("Missing inline code") }
        XCTAssertTrue(runs(paragraph).contains { $0.text == "a  b" && $0.style.contains(.code) })
        XCTAssertTrue(runs(paragraph).contains { $0.text == "a`b" && $0.style.contains(.code) })
        XCTAssertTrue(table.markdown.contains("`a  b`"))
    }
    private func runs(_ value: MarkdownInline) -> [MarkdownRun] {
        value.fragments.compactMap { if case .text(let run) = $0 { run } else { nil } }
    }
}
