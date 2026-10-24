import XCTest
@testable import FridayKit

final class AcpAuthTerminalTests: XCTestCase {
    func testOldAuthResponsesCannotRestoreCompletedInteractions() throws {
        let decode = { (json: String) in try JSONDecoder().decode(AcpNativeLoginState.self, from: Data(json.utf8)) }
        let completed = try decode(#"{"pending":false,"flowId":"one","revision":10,"phase":"complete"}"#)
        let old = try decode(#"{"pending":true,"flowId":"one","revision":9,"phase":"terminal"}"#)
        let new = try decode(#"{"pending":true,"flowId":"two","revision":0,"phase":"starting"}"#)
        XCTAssertFalse(old.accepts(after: completed))
        XCTAssertTrue(completed.accepts(after: old))
        XCTAssertTrue(new.accepts(after: completed))
    }
    func testTerminalSnapshotsOnlyAppendNewUTF16OutputAndIgnoreOldReplies() {
        var cursor = AcpTerminalOutputCursor()
        let first = cursor.receive("Hello 🙂", end: 8)
        XCTAssertTrue(first.reset); XCTAssertEqual(first.text, "Hello 🙂")
        XCTAssertEqual(cursor.receive("Hello 🙂", end: 8).text, "")
        let next = cursor.receive("Hello 🙂\r\n", end: 10)
        XCTAssertFalse(next.reset); XCTAssertEqual(next.text, "\r\n")
        XCTAssertEqual(cursor.receive("Hello 🙂", end: 8).text, "")
        XCTAssertEqual(cursor.offset, 10)
    }
    func testTerminalReconnectAfterTruncationResetsOnceAndNewFlowStartsFresh() {
        var cursor = AcpTerminalOutputCursor()
        _ = cursor.receive("first", end: 5)
        let truncated = cursor.receive("latest", end: 100)
        XCTAssertTrue(truncated.reset); XCTAssertEqual(truncated.text, "latest")
        XCTAssertEqual(cursor.receive("latest!", end: 101).text, "!")
        cursor.reset()
        let new = cursor.receive("new", end: 3)
        XCTAssertTrue(new.reset); XCTAssertEqual(new.text, "new")
        XCTAssertEqual(cursor.receive("invalid", end: 1).text, "")
        XCTAssertEqual(cursor.offset, 3)
    }
}
