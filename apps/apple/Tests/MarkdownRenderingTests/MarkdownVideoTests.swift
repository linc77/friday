import XCTest
@testable import FridayKit

final class MarkdownVideoTests: XCTestCase {
    func testVideoKindsFollowAuthoredURIsAndDoNotEmbedAudioOrDecodeLiteralPathsTwice() {
        for ext in ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"] {
            XCTAssertTrue(MarkdownMediaKind.video("https://host.test/video.\(ext.uppercased())?x=1#t=2"))
            XCTAssertTrue(MarkdownMediaKind.video("../clips/video.\(ext)#t=2,4"))
        }
        XCTAssertTrue(MarkdownMediaKind.video("<https://host.test/a%2Emp4>"))
        for value in ["a.mp3", "a.wav", "a.aac", "a.png", "dir.mp4/file", "file:///host/a%252Emp4", "https://host.test/a.png?path=clip.mp4"] { XCTAssertFalse(MarkdownMediaKind.video(value), value) }
        XCTAssertEqual(MarkdownMediaKind.fragment("<clip%23literal.mp4#t=2,4>"), "#t=2,4")
        XCTAssertEqual(MarkdownMediaSource.classify("clips\\a.mp4#t=2", workspacePath: "/root"), .hostFile("/root/clips/a.mp4"))
    }
    func testHostLinksPreserveTheirTimeFragmentsAndLiteralPercentQueryCharacters() throws {
        let link = try XCTUnwrap(MarkdownMediaKind.link("../clips/a%2520%23%3F.mp4#t=2,4", workspace: "/root/docs"))
        XCTAssertEqual(link.path, "/root/clips/a%20#?.mp4"); XCTAssertEqual(link.fragment, "t=2,4")
        XCTAssertNil(MarkdownMediaKind.link("javascript:clip.mp4", workspace: "/root"))
    }
    func testMarkdownVideoUsesImageSyntaxAndSanitizedHTMLDimensionsWithoutAddingRawMediaElements() throws {
        let source = "![clip](assets/clip.MP4#t=2)\n\n<img src='clip.webm' width='0x140' height='200'>\n\n[audio](voice.mp3)\n\n<video controls src='other.mp4'></video><audio src='voice.mp3'></audio>"
        let blocks = try XCTUnwrap(NativeMarkdownParser.shared.parse(source))
        guard case .paragraph(let first) = blocks[0], case .image(let video) = first.fragments.first else { return XCTFail("Video embed lost") }
        XCTAssertTrue(MarkdownMediaKind.video(video.source)); XCTAssertEqual(video.source, "assets/clip.MP4#t=2")
        guard case .paragraph(let second) = blocks[1], case .image(let html) = second.fragments.first else { return XCTFail("HTML image lost") }
        XCTAssertEqual(html.width, 320); XCTAssertEqual(html.height, 200)
        guard case .paragraph(let audio) = blocks[2], case .text(let link) = audio.fragments.first else { return XCTFail("Audio should remain a link") }
        XCTAssertEqual(link.link, "voice.mp3")
        let embeds = blocks.flatMap { block -> [String] in
            guard case .paragraph(let inline) = block else { return [] }
            return inline.fragments.compactMap { if case .image(let image) = $0 { image.source } else { nil } }
        }
        XCTAssertEqual(embeds, ["assets/clip.MP4#t=2", "clip.webm"])
    }
    func testAuthoredSizeAndVisiblePreloadBoundsMatchTheInlineMediaLimits() {
        XCTAssertEqual(MarkdownVideoLayout.size(available: 900, width: nil, height: nil), CGSize(width: 480, height: 270))
        XCTAssertEqual(MarkdownVideoLayout.size(available: 300, width: 240, height: 120), CGSize(width: 240, height: 120))
        XCTAssertEqual(MarkdownVideoLayout.size(available: 900, width: 200, height: 600), CGSize(width: 160, height: 480))
        XCTAssertEqual(MarkdownVideoLayout.size(available: 300, width: .infinity, height: nil), CGSize(width: 300, height: 168.75))
        let viewport = CGRect(x: 0, y: 100, width: 400, height: 500)
        XCTAssertTrue(MarkdownVideoLayout.near(frame: CGRect(x: 0, y: 799, width: 300, height: 100), viewport: viewport))
        XCTAssertFalse(MarkdownVideoLayout.near(frame: CGRect(x: 0, y: 801, width: 300, height: 100), viewport: viewport))
        XCTAssertFalse(MarkdownVideoLayout.near(frame: .zero, viewport: viewport))
        XCTAssertFalse(MarkdownVideoLayout.near([(CGRect(x: 500, y: 0, width: 50, height: 50), CGRect(x: 0, y: 0, width: 300, height: 100)), (CGRect(x: 0, y: 200, width: 300, height: 100), viewport)]))
        XCTAssertTrue(MarkdownVideoLayout.near(frame: CGRect(x: 450, y: 200, width: 50, height: 50), viewport: viewport))
    }
    func testPublicVideoDoesNotRequireCORSButPrivateFilesKeepTheCapabilityBoundary() throws {
        let url = URL(string: "https://cdn.test/video.mp4#t=2")!
        XCTAssertNil(TaskWorkspaceMediaPolicy.wrapper(url: url, name: "video", video: true, documentID: "id"))
        let html = try XCTUnwrap(TaskWorkspaceMediaPolicy.wrapper(url: url, name: "video", video: true, documentID: "id", requiresCapability: false, inline: true))
        XCTAssertTrue(html.contains("preload=\"none\"")); XCTAssertFalse(html.contains("crossorigin")); XCTAssertTrue(html.contains("media-src http: https:"))
        XCTAssertTrue(html.contains("#t=2")); XCTAssertTrue(html.contains("max-width:480px")); XCTAssertFalse(html.contains(" autoplay"))
    }
    func testInlineImagesKeepNaturalSizeAndApplyAuthoredBoundsWithoutChangingExpandedImages() {
        XCTAssertEqual(MarkdownVideoLayout.image(natural: CGSize(width: 100, height: 50), available: 900, width: nil, height: nil), CGSize(width: 100, height: 50))
        XCTAssertEqual(MarkdownVideoLayout.image(natural: CGSize(width: 1000, height: 500), available: 400, width: nil, height: nil), CGSize(width: 400, height: 200))
        XCTAssertEqual(MarkdownVideoLayout.image(natural: CGSize(width: 100, height: 50), available: 900, width: 300, height: nil), CGSize(width: 100, height: 50))
        XCTAssertEqual(MarkdownVideoLayout.image(natural: CGSize(width: 100, height: 50), available: 900, width: 300, height: 300), CGSize(width: 300, height: 300))
        XCTAssertEqual(MarkdownVideoLayout.image(natural: CGSize(width: 100, height: 500), available: 900, width: nil, height: 100), CGSize(width: 20, height: 100))
    }
    @MainActor func testOpenInFileViewerIsPresentOnlyWhenItsScopedCallbackIsAvailable() {
        var opened = 0
        var source = TaskMediaActionSource(kind: .video, reference: .file(path: "/root/clip.mp4", relative: "clip.mp4"), name: "clip", prepare: nil)
        XCTAssertFalse(source.actions.contains(.openFile)); source.openFile = { opened += 1 }
        XCTAssertEqual(source.actions, [.copyFullPath, .copyRelativePath, .openFile, .save])
        TaskMediaExportController().perform(.openFile, source: source); XCTAssertEqual(opened, 1)
    }
}
