import XCTest
@testable import FridayKit

final class WorkspaceMediaTests: XCTestCase {
    func testTheGeneratedMediaScriptUsesScopedPointerAndKeyboardMessages() throws {
        let url = URL(string: "https://host.test/file-assets/private-token/a.mp4")!
        let html = try XCTUnwrap(TaskWorkspaceMediaPolicy.wrapper(url: url, name: "name", video: true, documentID: "bridge-test", actions: true))
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".html")
        try html.write(to: file, atomically: true, encoding: .utf8); defer { try? FileManager.default.removeItem(at: file) }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let process = Process(), output = Pipe(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", root.appendingPathComponent("scripts/test-workspace-media-script.mjs").path, file.path]
        process.standardOutput = output; process.standardError = output; try process.run(); process.waitUntilExit()
        let text = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        XCTAssertEqual(process.terminationStatus, 0, text)
    }
    private func source(_ token: String, _ revision: String = "one") -> TaskMediaSource { TaskMediaSource(url: URL(string: "https://host.test/file-assets/\(token)/clip.mp4")!, revision: revision) }
    func testResigningDoesNotResetPlaybackOrPausedPlayhead() {
        var state = TaskMediaPlaybackState(); let first = source("first"), renewed = source("renewed")
        XCTAssertEqual(state.update(first), first); XCTAssertEqual(state.update(renewed), renewed)
        XCTAssertNil(state.event("play")); XCTAssertTrue(state.playing); XCTAssertNil(state.update(source("again")))
        XCTAssertNil(state.event("pause")); XCTAssertFalse(state.playing); XCTAssertEqual(state.current, renewed)
    }
    func testChangedFileWaitsForPauseOrEndAndKeepsOnlyTheNewestRevision() {
        for event in ["pause", "ended"] {
            var state = TaskMediaPlaybackState(); _ = state.update(source("first")); _ = state.event("play")
            XCTAssertNil(state.update(source("second", "two"))); XCTAssertNil(state.update(source("third", "three")))
            XCTAssertEqual(state.current, source("first")); XCTAssertEqual(state.event(event), source("third", "three"))
            XCTAssertEqual(state.current, state.latest); XCTAssertFalse(state.playing)
            XCTAssertEqual(state.update(source("fourth", "four")), source("fourth", "four"))
        }
    }
    func testAnExpiredPlaybackLinkUsesItsRenewedURLBeforeShowingFailure() {
        var state = TaskMediaPlaybackState(); _ = state.update(source("first")); _ = state.event("play"); _ = state.update(source("renewed"))
        XCTAssertEqual(state.event("error"), source("renewed")); XCTAssertFalse(state.playing); XCTAssertNil(state.event("error"))
        let current = state.current; XCTAssertNil(state.event("forged")); XCTAssertEqual(state.current, current)
    }
    func testVideoAndAudioUseControlsMetadataAndEscapedExactFileURLsWithoutConnectionCredentials() throws {
        let url = try XCTUnwrap(URL(string: "https://host.test:4321/file-assets/cap/a%22%26.mp4"))
        for video in [true, false] {
            let html = try XCTUnwrap(TaskWorkspaceMediaPolicy.wrapper(url: url, name: "\"><script>bad()</script>", video: video, documentID: "document-1"))
            XCTAssertTrue(html.contains(video ? "<video " : "<audio ")); XCTAssertTrue(html.contains("controls playsinline preload=\"metadata\" crossorigin=\"anonymous\""))
            XCTAssertFalse(html.contains("<script>bad()")); XCTAssertTrue(html.contains("&lt;script&gt;bad()&lt;/script&gt;"))
            XCTAssertTrue(html.contains("media-src https://host.test:4321/file-assets/")); XCTAssertTrue(html.contains("default-src 'none'")); XCTAssertTrue(html.contains("script-src 'nonce-document-1'"))
            XCTAssertTrue(html.contains("no-referrer")); XCTAssertFalse(html.contains("Authorization")); XCTAssertFalse(html.contains(" autoplay"))
            XCTAssertTrue(html.contains("document.hidden")); XCTAssertTrue(html.contains("!media.webkitDisplayingFullscreen"))
        }
    }
    func testOnlyHTTPFileCapabilitiesAndSafeDocumentNoncesCanEnterTheWrapper() {
        for value in ["file:///private/movie.mp4", "data:video/mp4;base64,AAAA", "javascript:bad()", "https://user:pass@host.test/file-assets/cap/a.mp4", "https://host.test/api/state"] {
            XCTAssertNil(TaskWorkspaceMediaPolicy.wrapper(url: URL(string: value)!, name: "name", video: true, documentID: "safe"))
        }
        XCTAssertNil(TaskWorkspaceMediaPolicy.wrapper(url: source("cap").url, name: "name", video: true, documentID: "</script>"))
        XCTAssertNotNil(TaskWorkspaceMediaPolicy.wrapper(url: URL(string: "http://[::1]:14317/file-assets/cap/a.wav")!, name: "audio", video: false, documentID: "safe"))
    }
}
