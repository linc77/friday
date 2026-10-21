import XCTest
@testable import FridayKit

final class PullRequestMarkdownTests: XCTestCase {
    func testDroppedGitHubVideosAndFixedCommitFilesAreLiftedWithProseAndPositionalIdentity() {
        let url = "https://github.com/user-attachments/assets/abc-def"
        XCTAssertEqual(TaskChangeRequestMarkdownSegments.split("Before\n\n\(url)\n\nAfter"), [
            .init(id: "markdown:0", content: .markdown("Before")), .init(id: "attachment:1", content: .video(url)), .init(id: "markdown:2", content: .markdown("After"))])
        XCTAssertEqual(TaskChangeRequestMarkdownSegments.split("\(url)\n\n\(url)").map(\.id), ["attachment:0", "attachment:1"])
        XCTAssertEqual(TaskChangeRequestMarkdownSegments.split("[clip](https://github.com/a/b/blob/abc123/clip.MP4?raw=1)").first?.content, .video("https://github.com/a/b/blob/abc123/clip.MP4?raw=1"))
        XCTAssertEqual(TaskChangeRequestMarkdownSegments.split("<https://example.com/picture.png>").first?.content, .image("https://example.com/picture.png"))
    }
    func testBoundedStandaloneVideoExtractionNeverExecutesOrRendersItsHTML() {
        let source = "<video controls>\n  <source src=\"https://example.com/a.webm\">\n</video>"
        XCTAssertEqual(TaskChangeRequestMarkdownSegments.split(source), [.init(id: "attachment:0", content: .video("https://example.com/a.webm"))])
        for value in ["Before <video src='https://example.com/a.mp4'></video> after", "<video src='javascript:neverExecute()'></video>", "<video src='https://example.com/a.mp4'>\n" + String(repeating: "line\n", count: 8) + "</video>"] {
            XCTAssertEqual(TaskChangeRequestMarkdownSegments.split(value), [.init(id: "markdown:0", content: .markdown(value))])
        }
    }
    func testCodeExamplesIndentationAndOrdinaryLinksRetainTheirMarkdownMeaning() {
        let samples = ["```\nhttps://example.com/demo.mp4\n```", "```\n~~~\nhttps://example.com/demo.mp4\n```", "```\n```javascript\nhttps://example.com/demo.mp4\n```", "    https://example.com/demo.mp4", "\thttps://example.com/demo.mp4", "https://example.com/page\n\n[the docs](https://example.com/docs)", "![shot](https://github.com/user-attachments/assets/abc-def)", "<img alt='image' src='https://github.com/user-attachments/assets/abc-def' />"]
        for value in samples { XCTAssertEqual(TaskChangeRequestMarkdownSegments.split(value), [.init(id: "markdown:0", content: .markdown(value))], value) }
        XCTAssertTrue(TaskChangeRequestMarkdownSegments.split(" \n\n").isEmpty)
    }
}
