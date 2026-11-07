import XCTest
import WebKit
@testable import FridayKit

final class MermaidTests: XCTestCase {
    func testRenderReceiptPreservesSVGAndFitsWithoutUpscaling() throws {
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240"><text>中文 🚀</text></svg>"#
        let raw: [String: Any] = ["type": "rendered", "id": "owned-render", "svg": svg, "width": 600, "height": 240]
        let message = try JSONDecoder().decode(MermaidWorkerMessage.self, from: JSONSerialization.data(withJSONObject: raw))
        let diagram = try XCTUnwrap(message.diagram)
        XCTAssertEqual(message.id, "owned-render"); XCTAssertEqual(diagram.svg, svg)
        XCTAssertEqual(diagram.displayHeight(availableWidth: 300), 120); XCTAssertEqual(diagram.displayHeight(availableWidth: 1200), 240)
        XCTAssertEqual(String(data: MermaidSVGDocument(svg: svg).data, encoding: .utf8), svg)
    }
    func testInvalidDimensionsAndNonSVGResultsDoNotReachTheDisplay() {
        for value in [Double.nan, .infinity, -1, 0, 100_001] {
            XCTAssertNil(MermaidDiagram(svg: "<svg/>", width: value, height: 100))
            XCTAssertNil(MermaidDiagram(svg: "<svg/>", width: 100, height: value))
        }
        XCTAssertNil(MermaidDiagram(svg: "<html>not an SVG</html>", width: 100, height: 100))
        XCTAssertNil(MermaidDiagram(svg: "<svg>" + String(repeating: "x", count: 8 * 1024 * 1024) + "</svg>", width: 100, height: 100))
    }
    func testSettledRenderCacheKeepsRecentResultsAndSeparatesThemes() {
        var cache = MermaidRenderCache(); let result = MermaidResult.failure("Syntax error", retryable: false)
        for index in 0..<64 { cache.store(MermaidRequest(source: "graph-\(index)", dark: false), result: result) }
        XCTAssertEqual(cache.read(MermaidRequest(source: " graph-0 \n", dark: false)), result)
        cache.store(MermaidRequest(source: "graph-64", dark: false), result: result)
        XCTAssertNil(cache.read(MermaidRequest(source: "graph-1", dark: false)))
        XCTAssertEqual(cache.read(MermaidRequest(source: "graph-0", dark: false)), result)
        XCTAssertNil(cache.read(MermaidRequest(source: "graph-0", dark: true)))
        cache.remove(MermaidRequest(source: "graph-0", dark: false)); XCTAssertNil(cache.read(MermaidRequest(source: "graph-0", dark: false)))
    }
    func testSVGViewerNeverNavigatesToRemoteOrHostResources() {
        XCTAssertTrue(MermaidWebPolicy.navigationAllowed(URL(string: "about:blank")))
        for value in ["https://example.com", "http://127.0.0.1:14317", "file:///private/file", "javascript:alert(1)", "data:text/html,hello", "about:blank#other"] {
            XCTAssertFalse(MermaidWebPolicy.navigationAllowed(URL(string: value)))
        }
    }
    @MainActor func testWebKitCompilesTheNetworkBlockerWithoutOpeningAView() async throws {
        let identifier = "Friday.Mermaid.rule-test." + UUID().uuidString
        let store = WKContentRuleListStore.default()!
        let rule = try await store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: MermaidWebPolicy.networkRules)
        XCTAssertNotNil(rule)
        try await store.removeContentRuleList(forIdentifier: identifier)
    }
    func testOnlyTheCurrentUnfinishedReplyIsMarkedStreaming() throws {
        let raw = #"""
        {"id":"one","title":"Test","prompt":"Test","projectId":null,"cwd":"/project","agent":"codex","mode":"research","status":"running","createdAt":"2026-10-19T01:00:00Z","updatedAt":"2026-10-19T01:00:03Z","durableId":1,"threadId":"native","turnId":"second","result":"","error":null,"artifact":null,"lastRequestId":"request","approvals":[],"messages":[],"events":[
        {"id":"old","kind":"message","phase":"final_answer","text":"```mermaid\nflowchart LR\n A-->B\n```","at":"2026-10-19T01:00:00Z","status":"completed","turnId":"first"},
        {"id":"new","kind":"message","phase":"final_answer","text":"```mermaid\nflowchart LR\n C-->","at":"2026-10-19T01:00:02Z","status":"running","turnId":"second"}]}
        """#
        var task = try JSONDecoder().decode(WorkItem.self, from: Data(raw.utf8))
        var rows = CodexTranscript.rows(task).filter { if case .reply = $0.content { return true }; return false }
        XCTAssertEqual(rows.map(\.isStreaming), [false, true])
        task = try JSONDecoder().decode(WorkItem.self, from: Data(raw.replacingOccurrences(of: #""status":"running","turnId":"second""#, with: #""status":"completed","turnId":"second""#).utf8))
        rows = CodexTranscript.rows(task).filter { if case .reply = $0.content { return true }; return false }
        XCTAssertEqual(rows.map(\.isStreaming), [false, false], "Later work must not reopen an already completed reply")
    }
}
