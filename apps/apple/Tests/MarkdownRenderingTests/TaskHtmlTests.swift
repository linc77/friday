import XCTest
@testable import FridayKit

final class TaskHtmlTests: XCTestCase {
    func testPublishedHTMLIsAStandaloneRowBetweenWorkAndTheAnswer() throws {
        let json = #"{"id":"task","title":"Page","prompt":"Show","projectId":null,"cwd":"/project","agent":"codex","mode":"code","status":"completed","createdAt":"2026-11-08T00:00:00Z","updatedAt":"2026-11-08T00:00:04Z","durableId":null,"threadId":"thread","turnId":"turn","result":"Done","error":null,"approvals":[],"artifact":null,"messages":[{"id":"user","role":"user","text":"Show","at":"2026-11-08T00:00:00Z"},{"id":"answer","role":"assistant","text":"Done","at":"2026-11-08T00:00:03Z"}],"events":[{"id":"tool","kind":"tool","text":"html_render","at":"2026-11-08T00:00:01Z"},{"id":"html-page","kind":"html","text":"Interactive page","at":"2026-11-08T00:00:02Z","html":{"id":"page","title":"Interactive page","height":400}}]}"#
        var task = try JSONDecoder().decode(WorkItem.self, from: Data(json.utf8))
        let rows = CodexTranscript.rows(task)
        XCTAssertEqual(rows.count, 4)
        guard case .work = rows[1].content, case .html(let event) = rows[2].content, case .reply("Done") = rows[3].content else { return XCTFail("HTML must remain outside the collapsed work log") }
        XCTAssertEqual(event.html?.height, 400); XCTAssertEqual(rows[2].id, "html-page")
        let restored = try JSONDecoder().decode(TaskEvent.self, from: JSONEncoder().encode(event))
        XCTAssertEqual(restored.html, event.html)
        task.events[1].revertedAt = "2026-11-08T00:00:05Z"
        XCTAssertFalse(CodexTranscript.rows(task).contains { $0.id == "html-page" })
    }

    func testGeneratedPreviewUsesANarrowSandboxAndMainFrameHeightBridge() throws {
        let id = UUID().uuidString, url = try XCTUnwrap(URL(string: "https://host.test/file-assets/html/cap/index.html"))
        let html = try XCTUnwrap(WorkspaceDocumentPolicy.wrapper(url: url, pdf: false, interactiveID: id))
        XCTAssertTrue(html.contains(#"sandbox="allow-scripts""#))
        for forbidden in ["allow-same-origin", "allow-popups", "allow-forms", "allow-downloads", "Authorization"] { XCTAssertFalse(html.contains(forbidden)) }
        XCTAssertTrue(html.contains("event.source!==frame.contentWindow")); XCTAssertTrue(html.contains(id))
        XCTAssertTrue(html.contains("Math.min(900,Math.max(180,height))"))
        let ordinary = try XCTUnwrap(WorkspaceDocumentPolicy.wrapper(url: url, pdf: false))
        XCTAssertFalse(ordinary.contains("messageHandlers"), "Existing file previews gain no script bridge")
    }
}
