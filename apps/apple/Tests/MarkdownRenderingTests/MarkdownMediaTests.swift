import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import FridayKit

final class MarkdownMediaTests: XCTestCase {
    func testGitHubMediaPolicyRecognizesOnlyCredentialedMediaResources() {
        for source in ["https://github.com/user-attachments/assets/abc-def", "https://www.github.com/owner/repo/assets/123/abc_def", "https://github.com/owner/repo/blob/abcdef/图%20片.png#view", "https://raw.githubusercontent.com/owner/repo/commit/clip.mp4", "https://media.githubusercontent.com/media/owner/repo/main/clip.mp4"] {
            XCTAssertTrue(GitHubMediaPolicy.supports(URL(string: source)!), source)
        }
        for source in ["http://github.com/owner/repo/raw/main/image.png", "https://evil.test/image.png", "https://github.com/owner/repo/issues/1", "https://objects.githubusercontent.com/signed", "https://user:secret@github.com/a/b/raw/main/image.png"] {
            XCTAssertFalse(GitHubMediaPolicy.supports(URL(string: source)!), source)
        }
    }
    @MainActor func testGitHubCapabilityCoalescesScopesRenewsAndDoesNotSendFridayCredentialsToMedia() async throws {
        let fixture = try MediaHTTPFixture(); defer { fixture.close() }
        let source = URL(string: "https://github.com/fixture/private/blob/abcdef/image.png")!
        func context(_ id: String, mode: String = "") -> MarkdownMediaContext {
            MarkdownMediaContext(id: id, request: { _ in throw URLError(.badURL) }, githubRequest: { source in
                var request = URLRequest(url: fixture.url("/github-issue" + (mode.isEmpty ? "" : "?mode=" + mode))); request.httpMethod = "POST"
                request.setValue("Bearer fixture-device", forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["taskId":"fixture", "url":source.absoluteString]); return request
            })
        }
        let first = context(UUID().uuidString)
        async let a = first.githubAssetURL(source); async let b = first.githubAssetURL(source)
        let initial = try await a, coalesced = try await b; XCTAssertEqual(initial, coalesced)
        let cached = try await first.githubAssetURL(source); XCTAssertEqual(initial, cached)
        let renewed = try await first.githubAssetURL(source, refresh: true); XCTAssertNotEqual(initial, renewed)
        let second = context(UUID().uuidString), otherScope = try await second.githubAssetURL(source); XCTAssertNotEqual(initial, otherScope)
        let image = try await first.githubImage(source, refresh: false); XCTAssertFalse(image.data.isEmpty)
        let (raw, _) = try await URLSession.shared.data(from: fixture.url("/stats"))
        let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any]), requests = try XCTUnwrap(stats["github"] as? [[String: Any]])
        XCTAssertEqual(requests.count, 3); XCTAssertTrue(requests.allSatisfy { $0["authorization"] as? String == "Bearer fixture-device" })
        XCTAssertEqual((stats["captured"] as? [Any])?.count, 1); XCTAssertTrue((stats["captured"] as? [Any])?.first is NSNull)
        let reference = TaskMediaActionSource.image(MarkdownImage(source: source.absoluteString, alt: "private", title: nil, link: nil), workspace: nil, context: first)
        XCTAssertEqual(reference?.reference.text(for: .copyURL), source.absoluteString)
        let prepare = try XCTUnwrap(reference?.prepare), exported = try await prepare(); XCTAssertFalse(exported.publicRedirects); XCTAssertNil(exported.request.value(forHTTPHeaderField: "Authorization")); XCTAssertTrue(exported.request.url!.path.hasPrefix("/file-assets/github/"))
    }
    @MainActor func testGitHubCapabilityRejectsSourceOrOriginChangesAndRefreshesAnExpiredImage() async throws {
        let fixture = try MediaHTTPFixture(); defer { fixture.close() }
        let source = URL(string: "https://github.com/fixture/private/raw/commit/image.png")!
        func context(_ mode: String) -> MarkdownMediaContext {
            MarkdownMediaContext(id: UUID().uuidString, request: { _ in throw URLError(.badURL) }, githubRequest: { source in
                var request = URLRequest(url: fixture.url("/github-issue?mode=" + mode)); request.httpMethod = "POST"
                request.setValue("Bearer fixture-device", forHTTPHeaderField: "Authorization")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["taskId":"fixture", "url":source.absoluteString]); return request
            })
        }
        // Use a fresh fixture so the first capability really is the expired one.
        let image = try await context("expired-image").githubImage(source, refresh: false); XCTAssertFalse(image.data.isEmpty)
        for mode in ["foreign", "wrong-source", "redirect"] {
            do { _ = try await context(mode).githubAssetURL(source); XCTFail("Accepted " + mode) } catch {}
        }
        let nearlyExpired = context("near-expiry"), first = try await nearlyExpired.githubAssetURL(source), second = try await nearlyExpired.githubAssetURL(source)
        XCTAssertNotEqual(first, second)
        let (raw, _) = try await URLSession.shared.data(from: fixture.url("/stats"))
        let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual((stats["captured"] as? [Any])?.count, 2)
        XCTAssertTrue((stats["captured"] as? [Any])?.allSatisfy { $0 is NSNull } == true)
    }
    func testFilesystemImagesResolveOnTheHostAndDecodeSuffixesOnce() {
        XCTAssertEqual(MarkdownMediaSource.classify("../images/图%20片%23%3F.png?unused#view", workspacePath: "/host/project"), .hostFile("/host/images/图 片#?.png"))
        XCTAssertEqual(MarkdownMediaSource.classify("file:///host/image%2520.png#view", workspacePath: nil), .hostFile("/host/image%20.png"))
        XCTAssertEqual(MarkdownMediaSource.classify("/host/absolute.png", workspacePath: nil), .hostFile("/host/absolute.png"))
        XCTAssertEqual(MarkdownMediaSource.classify("//example.com/a.png", workspacePath: nil), .remote(URL(string: "https://example.com/a.png")!))
        for path in ["#part", "?path", "~/a.png", "relative.png", "file://another-host/private.png", "javascript:bad()", "data:image/png;base64,abc", "https://user:secret@example.com/a.png", "/host/bad%00.png"] {
            XCTAssertEqual(MarkdownMediaSource.classify(path, workspacePath: nil), .blocked, path)
        }
    }
    func testAuthenticatedRequestRoutesPreserveLiteralHostFilenames() throws {
        let path = "/host/图 #?&%.png", route = try XCTUnwrap(MarkdownMediaSource.route(taskID: "task-id", path: path))
        let url = try XCTUnwrap(URLComponents(string: "https://host.test" + route))
        XCTAssertEqual(url.path, "/api/tasks/task-id/media"); XCTAssertEqual(url.queryItems?.first?.value, path); XCTAssertNil(url.fragment)
    }
    func testImageIODecodesTheActualRasterAndRejectsNonImageBytes() throws {
        let image = try raster(), data = try XCTUnwrap(MarkdownImageFile.png(image))
        guard case .raster(let decoded) = MarkdownDecodedImage.decode(MarkdownMediaBytes(data: data, mimeType: "application/octet-stream")) else { return XCTFail("A generic MIME response containing a real image must still decode") }
        XCTAssertEqual(decoded.width, 8); XCTAssertEqual(decoded.height, 5)
        XCTAssertNil(MarkdownDecodedImage.decode(MarkdownMediaBytes(data: Data("<html><script>neverExecute()</script></html>".utf8), mimeType: "image/png")))
        XCTAssertEqual(MarkdownImageFile(data: data).data, data)
    }
    func testSVGBytesRemainInAnIsolatedImageResourceAndUseTheirViewBox() throws {
        let raw = #"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 240"><script>neverExecute()</script><image href="https://example.com/private.png"/></svg>"#
        let svg = try XCTUnwrap(MarkdownSVGImage.document(Data(raw.utf8)))
        XCTAssertEqual(svg.width, 640); XCTAssertEqual(svg.height, 240)
        XCTAssertFalse(svg.svg.contains("<script")); XCTAssertFalse(svg.svg.contains("example.com"))
        XCTAssertTrue(svg.svg.contains(Data(raw.utf8).base64EncodedString()))
        let html = MermaidWebPolicy.svgHTML(svg, expanded: false, embeddedImages: true)
        XCTAssertTrue(html.contains("img-src data:")); XCTAssertTrue(html.contains("script-src 'none'"))
        for raw in ["<html>not an image</html>", "<svg width='-1' height='2'/>", "<svg width='inf' height='2'/>", "<svg xmlns='https://other.test' width='2' height='2'/>"] { XCTAssertNil(MarkdownSVGImage.document(Data(raw.utf8)), raw) }
    }
    func testAnimatedGIFUsesAnImageDocumentRatherThanLosingItsSecondFrame() throws {
        let data = NSMutableData(), image = try raster()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, 2, nil))
        for _ in 0..<2 { CGImageDestinationAddImage(destination, image, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: 0.1]] as CFDictionary) }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        guard case .webImage(let document) = MarkdownDecodedImage.decode(MarkdownMediaBytes(data: data as Data, mimeType: "image/gif")) else { return XCTFail("Animation discarded") }
        XCTAssertTrue(document.svg.contains("data:image/gif;base64,"))
    }
    func testGalleryKeepsDuplicateImagesAndWrapsNavigationLikeT3() {
        let first = MarkdownImage(source: "/host/a.png", alt: "A", title: nil, link: nil, galleryID: "0")
        let second = MarkdownImage(source: "/host/a.png", alt: "A", title: nil, link: nil, galleryID: "1")
        let selection = MarkdownImageGallery.selection(second, visible: [first, second]); XCTAssertEqual(selection.images.count, 2); XCTAssertEqual(selection.index, 1)
        XCTAssertEqual(MarkdownImageGallery.selection(second, visible: [first]).images, [second])
        XCTAssertEqual(MarkdownImageGallery.wrapped(-1, count: 2), 1); XCTAssertEqual(MarkdownImageGallery.wrapped(2, count: 2), 0); XCTAssertEqual(MarkdownImageGallery.wrapped(-5, count: 0), 0)
        let linked = MarkdownImage(source: "https://example.com/thumb.png", alt: "A", title: nil, link: "https://example.com/full.png?size=2", galleryID: "2")
        XCTAssertEqual(MarkdownImageGallery.previewImage(linked).source, linked.link)
        XCTAssertFalse(MarkdownImageGallery.isImageLink("https://example.com/article"))
        let captioned = MarkdownImage(source: "/host/a.png", alt: "[A]\\B", title: "A \"quote\"", link: nil)
        XCTAssertEqual(MarkdownImageGallery.markdown(captioned), "![\\[A\\]\\\\B](/host/a.png \"A \\\"quote\\\"\")")
    }
    func testRealURLSessionRedirectIsolationCacheScopeCoalescingBoundsAndCancellation() async throws {
        let fixture = try MediaHTTPFixture(); defer { fixture.close() }
        var publicRequest = URLRequest(url: fixture.url("/public-redirect")); publicRequest.setValue("Bearer must-not-leak", forHTTPHeaderField: "Authorization")
        let publicImage = try await MarkdownImageDownload.load(publicRequest, authenticated: false); XCTAssertFalse(publicImage.data.isEmpty)
        var privateRequest = URLRequest(url: fixture.url("/private-redirect")); privateRequest.setValue("Bearer fixture-device", forHTTPHeaderField: "Authorization")
        do { _ = try await MarkdownImageDownload.load(privateRequest, authenticated: true); XCTFail("Authenticated redirect followed") } catch {}
        let loader = MarkdownMediaLoader(); let request = URLRequest(url: fixture.url("/delayed.png"))
        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<8 { group.addTask { try await loader.load(request, scope: "one", authenticated: false).data.count } }
            for try await count in group { XCTAssertGreaterThan(count, 0) }
        }
        _ = try await loader.load(request, scope: "one", authenticated: false)
        _ = try await loader.load(request, scope: "two", authenticated: false)
        _ = try await loader.load(request, scope: "two", authenticated: false, refresh: true)
        var authenticated = URLRequest(url: fixture.url("/private.png")); authenticated.setValue("Bearer fixture-device", forHTTPHeaderField: "Authorization")
        _ = try await MarkdownImageDownload.load(authenticated, authenticated: true)
        for path in ["/oversize", "/not-found"] {
            do { _ = try await MarkdownImageDownload.load(URLRequest(url: fixture.url(path)), authenticated: false); XCTFail("Invalid response accepted: " + path) } catch {}
        }
        let slow = Task { try await MarkdownImageDownload.load(URLRequest(url: fixture.url("/slow")), authenticated: false) }
        try await Task.sleep(for: .milliseconds(120)); slow.cancel()
        do { _ = try await slow.value; XCTFail("Cancelled download completed") } catch { XCTAssertTrue(error is CancellationError) }
        let (raw, _) = try await URLSession.shared.data(from: fixture.url("/stats"))
        let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual((stats["counts"] as? [String: Int])?["/delayed.png"], 3)
        let captured = try XCTUnwrap(stats["captured"] as? [Any]); XCTAssertEqual(captured.count, 1); XCTAssertTrue(captured[0] is NSNull)
    }
    private func raster() throws -> CGImage {
        let context = try XCTUnwrap(CGContext(data: nil, width: 8, height: 5, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: 8, height: 5)); return try XCTUnwrap(context.makeImage())
    }
}

private final class MediaHTTPFixture {
    let process = Process(); let port: Int
    init() throws {
        var root = URL(fileURLWithPath: #filePath); for _ in 0..<5 { root.deleteLastPathComponent() }
        let output = Pipe(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", root.appendingPathComponent("scripts/fixtures/markdown-media-server.mjs").path]
        process.standardOutput = output; process.standardError = Pipe(); try process.run()
        var data = Data()
        while data.count < 4096, let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
            if byte[0] == 10 { break }; data.append(byte)
        }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Int], let port = value["port"] else { if process.isRunning { process.terminate() }; throw URLError(.cannotConnectToHost) }; self.port = port
    }
    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)" + path)! }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}
