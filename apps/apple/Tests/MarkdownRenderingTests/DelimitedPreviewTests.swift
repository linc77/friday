import XCTest
@testable import FridayKit

final class DelimitedPreviewTests: XCTestCase {
    func testNativeParserMatchesTheReferenceCorpus() throws {
        struct Corpus: Decodable { let reference: String; let cases: [Case] }
        struct Case: Decodable { let text: String; let delimiter: String; let rows: [[String]]; let truncated: Bool }
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../server/test/fixtures/t3-delimited-preview.json").standardizedFileURL
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
        XCTAssertTrue(corpus.reference.contains("8cd9641f")); XCTAssertEqual(corpus.cases.count, 174)
        for (index, item) in corpus.cases.enumerated() {
            let value = TaskDelimitedTable.parse(item.text, delimiter: try XCTUnwrap(item.delimiter.utf16.first))
            XCTAssertEqual(value.rows, item.rows, "Reference case \(index)"); XCTAssertEqual(value.truncated, item.truncated, "Reference case \(index)")
        }
    }
    func testMimeDeterminesTheDelimiterBeforeAnExtensionFallback() {
        XCTAssertEqual(TaskDelimitedTable.delimiter(name: "unknown", mimeType: "TEXT/CSV; charset=utf-8"), 44)
        XCTAssertEqual(TaskDelimitedTable.delimiter(name: "table.csv", mimeType: "text/tab-separated-values"), 9)
        XCTAssertEqual(TaskDelimitedTable.delimiter(name: "table.TSV", mimeType: "application/octet-stream"), 9)
        XCTAssertEqual(TaskDelimitedTable.delimiter(name: "table.CSV", mimeType: "text/plain"), 44)
        XCTAssertNil(TaskDelimitedTable.delimiter(name: "table.csv", mimeType: "application/json"))
        XCTAssertNil(TaskDelimitedTable.delimiter(name: "plain.txt", mimeType: nil))
    }
    func testQuotedNewlinesBOMAndHeaderCellsRemainLiteralText() {
        let value = TaskDelimitedTable.parse("\u{feff}Name,Value\r\n\"文 🚀\",\"a,b\r\n=1+1 <script>\"", delimiter: 44)
        XCTAssertEqual(value.rows, [["Name", "Value"], ["文 🚀", "a,b\r\n=1+1 <script>"]]); XCTAssertFalse(value.truncated)
    }
}
