import XCTest
@testable import FridayKit

final class MarkdownRenderingTests: XCTestCase {
    func testNestedListsKeepTheirBlocksAndTaskState() {
        let blocks = MarkdownBlocks.parse("10. **Parent**\n    - [x] Done\n      continued\n    - [ ] Pending\n\n    More detail\n\n11. Next")
        guard case .list(let outer)? = blocks.first else { return XCTFail("Missing ordered list") }
        XCTAssertEqual(outer.start, 10); XCTAssertEqual(outer.items.count, 2)
        guard case .list(let nested) = outer.items[0].blocks[1] else { return XCTFail("Missing nested list") }
        XCTAssertEqual(nested.items.map(\.checked), [true, false])
        guard case .paragraph(let text) = nested.items[0].blocks[0] else { return XCTFail("Missing continued paragraph") }
        XCTAssertEqual(text.plainText, "Done continued")
        XCTAssertEqual(outer.items[0].blocks.count, 3, "A second list paragraph remains inside its item")
    }
    func testInlineStylesAndReferenceLinksAreResolvedAcrossBlocks() {
        let blocks = MarkdownBlocks.parse("***Both*** and ~~old~~ and `a|b` plus [**file**][source].\n\n[source]: ./Sources/A.swift:12")
        guard case .paragraph(let value)? = blocks.first else { return XCTFail("Missing paragraph") }
        let runs = value.fragments.compactMap { fragment -> MarkdownRun? in if case .text(let run) = fragment { return run }; return nil }
        XCTAssertTrue(runs.contains { $0.text == "Both" && $0.style.contains([.strong, .emphasis]) })
        XCTAssertTrue(runs.contains { $0.text == "old" && $0.style.contains(.strike) })
        XCTAssertTrue(runs.contains { $0.text == "a|b" && $0.style.contains(.code) })
        XCTAssertTrue(runs.contains { $0.text == "file" && $0.style.contains(.strong) && $0.link == "./Sources/A.swift:12" })
    }
    func testCommonMarkHeadingsEntitiesAndIndentedCode() {
        let blocks = MarkdownBlocks.parse("Heading\n===\n\nA &amp; B -- \"quotes\"\n\n    let x = 1\n")
        guard case .heading(let level, let title) = blocks[0], case .paragraph(let paragraph) = blocks[1], case .code(let code) = blocks[2] else { return XCTFail("Missing CommonMark blocks") }
        XCTAssertEqual(level, 1); XCTAssertEqual(title.plainText, "Heading")
        XCTAssertEqual(paragraph.plainText, "A & B -- \"quotes\"")
        XCTAssertEqual(code.text, "let x = 1\n")
    }
    func testFencesKeepNestedBackticksTitlesAndStreamingSource() {
        let source = "````typescript title=\"src/Example.ts\"\nconst text = `three ``` ticks`;\n````"
        guard case .code(let fence)? = MarkdownBlocks.parse(source).first else { return XCTFail("Missing fence") }
        XCTAssertEqual(fence.language, "typescript"); XCTAssertEqual(fence.title, "src/Example.ts")
        XCTAssertEqual(fence.text, "const text = `three ``` ticks`;\n")
        guard case .code(let partial)? = MarkdownBlocks.parse("```ts\nconst partial =").first else { return XCTFail("Streaming fence disappeared") }
        XCTAssertEqual(partial.text, "const partial =\n")
        XCTAssertEqual(MarkdownFence(info: "gitignore .gitignore", text: "").language, "ini")
        XCTAssertEqual(MarkdownFence(info: "swift Sources/Runner.swift", text: "").title, "Sources/Runner.swift")
        XCTAssertEqual(MarkdownFence(info: "python file='hello world.py'", text: "").title, "hello world.py")
    }
    func testAlignedTablesKeepEscapedPipesAndInlineFormatting() {
        let blocks = MarkdownBlocks.parse("| Name | Value | More |\n| :--- | ---: | :---: |\n| **A** | `a\\|b` | café 🚀 |")
        guard case .table(let table)? = blocks.first else { return XCTFail("Missing table") }
        XCTAssertEqual(table.alignments, [.left, .right, .center]); XCTAssertEqual(table.rows[0].map(\.plainText), ["A", "a|b", "café 🚀"])
        XCTAssertTrue(table.markdown.contains("a\\|b")); XCTAssertTrue(table.markdown.contains("---:")); XCTAssertTrue(table.markdown.contains("**A**"))
        XCTAssertEqual(table.csv, "Name,Value,More\nA,a|b,café 🚀")
    }
    func testTableCopyNormalizesWhitespaceAndQuotesCommaAndQuoteCells() {
        let table = MarkdownTable(headers: [.text("A"), .text("B")], rows: [[.text("one,two"), .text("a\"b\nc")]], alignments: [.left, .center])
        XCTAssertEqual(table.csv, "A,B\n\"one,two\",\"a\"\"b c\"")
        XCTAssertTrue(table.markdown.contains("a\"b c"))
    }
    func testGithubAlertsKeepStructuredContentsAndOrdinaryQuotes() {
        let source = "> [!WARNING]\n> Keep **changes**.\n>\n> - One\n> - Two\n\n> Ordinary\n> continued"
        let blocks = MarkdownBlocks.parse(source)
        guard case .alert(let kind, let contents) = blocks[0], case .quote(let quote) = blocks[1] else { return XCTFail("Missing quote styles") }
        XCTAssertEqual(kind, .warning)
        guard case .paragraph(let text) = contents[0], case .list(let list) = contents[1], case .paragraph(let quoted) = quote[0] else { return XCTFail("Flattened quote structure") }
        XCTAssertEqual(text.plainText, "Keep changes."); XCTAssertEqual(list.items.count, 2); XCTAssertEqual(quoted.plainText, "Ordinary continued")
        guard case .quote? = MarkdownBlocks.parse("> [!NOTE]**ordinary inline text**").first else { return XCTFail("An inline prefix must not become an alert") }
    }
    func testImagesKeepResolvedSourceAltAndLinkedDestination() {
        guard case .paragraph(let value)? = MarkdownBlocks.parse("Before [![**diagram**][image]](https://example.com/detail) after\n\n[image]: https://example.com/image.png \"Caption\"").first,
              let image = value.fragments.compactMap({ fragment -> MarkdownImage? in if case .image(let image) = fragment { return image }; return nil }).first else { return XCTFail("Missing image") }
        XCTAssertEqual(image.alt, "diagram"); XCTAssertEqual(image.source, "https://example.com/image.png"); XCTAssertEqual(image.title, "Caption")
        XCTAssertEqual(image.link, "https://example.com/detail")
    }
    func testLinksRespectLocalPermissionsAndRejectActiveSchemes() {
        for value in ["javascript:alert(1)", "data:text/html,script", "vbscript:bad", "https://example.com/\nprivate", "#section", "file://other-host/private/file", "file:///tmp/file%0Aname"] {
            XCTAssertNil(MarkdownLinkPolicy.target(value, workspacePath: "/project", canOpenLocalFiles: true))
        }
        XCTAssertNil(MarkdownLinkPolicy.target("file:///private/file.txt", workspacePath: "/project", canOpenLocalFiles: false))
        XCTAssertNil(MarkdownLinkPolicy.target("./Sources/A.swift", workspacePath: "/project", canOpenLocalFiles: false))
        XCTAssertEqual(MarkdownLinkPolicy.target("./Sources/A.swift:12:3", workspacePath: "/project", canOpenLocalFiles: true)?.path, "/project/Sources/A.swift")
        XCTAssertEqual(MarkdownLinkPolicy.target("file:///tmp/hello%20world.swift#L12", workspacePath: nil, canOpenLocalFiles: true)?.path, "/tmp/hello world.swift")
        XCTAssertEqual(MarkdownLinkPolicy.target("https://example.com/path", workspacePath: nil, canOpenLocalFiles: false)?.host, "example.com")
        XCTAssertEqual(MarkdownLinkPolicy.target("mailto:test@example.com", workspacePath: nil, canOpenLocalFiles: false)?.scheme, "mailto")
    }
    func testRemoteImagesNeverUseFileOrCredentialURLs() {
        for value in ["file:///private/picture.png", "data:image/png;base64,abcd", "https://user:secret@example.com/image.png", "mailto:test@example.com"] { XCTAssertNil(MarkdownLinkPolicy.remoteImage(value)) }
        XCTAssertEqual(MarkdownLinkPolicy.remoteImage("https://example.com/image.png")?.host, "example.com")
    }
    func testActualNativeHighlighterUsesGrammarsAndBothThemesWithoutChangingSource() async {
        let source = "const café = `hello 🚀`;\n"
        let dark = await CodeHighlighter.shared.highlight(source, language: "typescript", dark: true)
        let light = await CodeHighlighter.shared.highlight(source, language: "typescript", dark: false)
        XCTAssertEqual(dark?.text, source); XCTAssertEqual(light?.text, source)
        XCTAssertEqual(dark?.language, "typescript"); XCTAssertNotEqual(dark?.foreground, light?.foreground)
        XCTAssertGreaterThan(Set(dark?.tokens.map(\.color) ?? []).count, 2)
        let cached = await CodeHighlighter.shared.highlight(source, language: "typescript", dark: true)
        XCTAssertEqual(cached?.tokens.map(\.color), dark?.tokens.map(\.color))
    }
    func testNativeHighlighterResolvesLanguageAliasesAndLeavesUnknownTextIntact() async {
        let samples = [("js", "let x = 1;"), ("python", "def hello():\n    return True"), ("swift", "let value: String = \"hello\""),
            ("rust", "fn main() { println!(\"hello\"); }"), ("json", "{\"value\": true}"), ("gitignore", "# comment\nnode_modules/"), ("Terminal", "echo hello")]
        for (language, source) in samples {
            let result = await CodeHighlighter.shared.highlight(source, language: language, dark: true)
            XCTAssertEqual(result?.text, source, language); XCTAssertNotEqual(result?.language, "text", language)
        }
        let source = "globalThis.neverExecuteMe = true; </script> café 🚀\n"
        let unknown = await CodeHighlighter.shared.highlight(source, language: "unknown-language-for-test", dark: true)
        XCTAssertEqual(unknown?.text, source); XCTAssertEqual(unknown?.language, "text")
    }
}
