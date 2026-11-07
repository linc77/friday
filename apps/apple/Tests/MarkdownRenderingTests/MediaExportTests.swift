import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import FridayKit

final class MediaExportTests: XCTestCase {
    func testMenusMatchTheActualT3ImageAndVideoActionsAndWorkspaceBoundaries() {
        let file = TaskMediaReference.file("/root/project/images/图 #?%.png", root: "/root/project")
        XCTAssertEqual(file.text(for: .copyFullPath), "/root/project/images/图 #?%.png"); XCTAssertEqual(file.text(for: .copyRelativePath), "images/图 #?%.png"); XCTAssertNil(file.text(for: .copyURL))
        XCTAssertNil(TaskMediaReference.file("/root/project-other/a", root: "/root/project").text(for: .copyRelativePath))
        let video = TaskMediaActionSource(kind: .video, reference: file, name: "v.mp4", prepare: nil)
        XCTAssertEqual(video.actions, [.copyFullPath, .copyRelativePath, .save])
        let remote = TaskMediaActionSource(kind: .image, reference: .remote(URL(string: "https://host.test/a.png")!), name: "a.png", prepare: nil)
        XCTAssertEqual(remote.actions, [.copyURL, .save, .copyImage])
        let literal = "/root/a%20 #?.png"
        XCTAssertEqual(MarkdownMediaSource.classify(URL(fileURLWithPath: literal).absoluteString, workspacePath: nil), .hostFile(literal))
        XCTAssertEqual(TaskMediaExportFile.name("../../clip #?.mp4", mimeType: "video/mp4"), "clip #?.mp4")
        XCTAssertEqual(TaskMediaExportFile.name("image", mimeType: "image/png"), "image.png")
    }
    func testLargeDownloadsGoToPrivateFilesAndInstallExactBytesWithoutA40MiBPreviewLimit() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let file = try await TaskMediaDownload.load(.init(request: URLRequest(url: fixture.url("/large")), publicRedirects: false), temporaryDirectory: root)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.url.path)[.size] as? NSNumber)?.intValue, 48 * 1024 * 1024)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.directory.path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let target = root.appendingPathComponent("clip #?.mp4"); try Data("old".utf8).write(to: target)
        try TaskMediaExportFile.install(file, at: target)
        let handle = try FileHandle(forReadingFrom: target); defer { try? handle.close() }
        var size = 0
        while let data = try handle.read(upToCount: 65536), !data.isEmpty { XCTAssertTrue(data.allSatisfy { $0 == 61 }); size += data.count }
        XCTAssertEqual(size, 48 * 1024 * 1024); file.remove()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [target.lastPathComponent])
    }
    func testFailuresCancellationAndPrivateRedirectsCleanTemporaryFiles() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        for route in ["/html", "/missing", "/redirect"] {
            var request = URLRequest(url: fixture.url(route)); request.setValue("Bearer fixture-device", forHTTPHeaderField: "Authorization")
            do { let file = try await TaskMediaDownload.load(.init(request: request, publicRedirects: false), temporaryDirectory: root); file.remove(); XCTFail("Invalid response accepted") } catch {}
        }
        let task = Task { try await TaskMediaDownload.load(.init(request: URLRequest(url: fixture.url("/slow")), publicRedirects: false), temporaryDirectory: root) }
        try await Task.sleep(for: .milliseconds(100)); task.cancel()
        do { let file = try await task.value; file.remove(); XCTFail("Cancellation ignored") } catch { XCTAssertTrue(error is CancellationError) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
        let (data, _) = try await URLSession.shared.data(from: fixture.url("/stats")); let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((stats["captured"] as? [Any])?.count, 0)
    }
    func testPublicRedirectsNeverForwardAuthorizationOrCookies() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        var request = URLRequest(url: fixture.url("/redirect")); request.setValue("Bearer fixture", forHTTPHeaderField: "Authorization"); request.setValue("fixture=secret", forHTTPHeaderField: "Cookie")
        let file = try await TaskMediaDownload.load(.init(request: request, publicRedirects: true)); defer { file.remove() }
        let (data, _) = try await URLSession.shared.data(from: fixture.url("/stats")); let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let captured = try XCTUnwrap((stats["captured"] as? [[String: Any]])?.first)
        XCTAssertTrue(captured["authorization"] is NSNull); XCTAssertTrue(captured["cookie"] is NSNull)
    }
    func testCompressedMediaUsesDecodedBytesRatherThanEncodedContentLength() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        let file = try await TaskMediaDownload.load(.init(request: URLRequest(url: fixture.url("/gzip")), publicRedirects: true)); defer { file.remove() }
        XCTAssertEqual(file.mimeType, "image/svg+xml")
        XCTAssertEqual(try String(contentsOf: file.url, encoding: .utf8), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"5\"/>")
    }
    @MainActor func testAChosenMediaActionKeepsItsOriginalConnectionTaskAndLiteralPath() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        var request = URLRequest(url: fixture.url("/api/task-files/asset-url")); request.httpMethod = "POST"; request.setValue("Bearer original", forHTTPHeaderField: "Authorization")
        let source = TaskMediaActionSource.workspace(request: request, taskID: "original-task", cwd: "/workspace", path: "a #?%.mp4", kind: .video)
        request.url = URL(string: "http://127.0.0.1:1/other"); request.setValue("Bearer changed", forHTTPHeaderField: "Authorization")
        let prepared = try await XCTUnwrap(source.prepare)(); XCTAssertNil(prepared.request.value(forHTTPHeaderField: "Authorization")); XCTAssertFalse(prepared.publicRedirects)
        XCTAssertEqual(prepared.request.url, fixture.url("/file-assets/frozen/clip.mp4"))
        let (data, _) = try await URLSession.shared.data(from: fixture.url("/stats")); let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any]); let captured = try XCTUnwrap((stats["requests"] as? [[String: Any]])?.first)
        XCTAssertEqual(captured["authorization"] as? String, "Bearer original"); let body = try XCTUnwrap(captured["body"] as? [String: Any]); XCTAssertEqual(body["path"] as? String, "a #?%.mp4"); XCTAssertEqual(body["workspaceRoot"] as? String, "/workspace"); XCTAssertEqual((body["scope"] as? [String: String])?["taskId"], "original-task")
    }
    @MainActor func testPNGIsLosslessAndSVGCopyProducesActualPNGWithoutOpeningAWindow() async throws {
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let context = try XCTUnwrap(CGContext(data: nil, width: 8, height: 5, bitsPerComponent: 8, bytesPerRow: 32, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let original = try XCTUnwrap(MarkdownImageFile.png(try XCTUnwrap(context.makeImage()))), url = root.appendingPathComponent("image.png"); try original.write(to: url)
        let png = try await TaskMediaImageCopy.png(.init(directory: root, url: url, mimeType: "image/png")); XCTAssertEqual(png, original)
        let svg = root.appendingPathComponent("image.svg"); try Data("<svg xmlns='http://www.w3.org/2000/svg' width='8' height='5'><style>rect{fill:red}</style><rect width='8' height='5'/></svg>".utf8).write(to: svg)
        let copied = try await TaskMediaImageCopy.png(.init(directory: root, url: svg, mimeType: "image/svg+xml"))
        let decoded = try XCTUnwrap(CGImageSourceCreateWithData(copied as CFData, nil)); XCTAssertEqual(CGImageSourceGetType(decoded) as String?, "public.png")
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(decoded, 0, nil)); XCTAssertEqual(image.width, 8); XCTAssertEqual(image.height, 5)
        let pixels = try XCTUnwrap(CGContext(data: nil, width: 8, height: 5, bitsPerComponent: 8, bytesPerRow: 32, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
        pixels.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 5)); let raw = try XCTUnwrap(pixels.data).assumingMemoryBound(to: UInt8.self)
        XCTAssertEqual(Array(UnsafeBufferPointer(start: raw, count: 4)), [255, 0, 0, 255])
    }
    @MainActor func testMissingOrChangedWorkspaceEchoStopsBeforeDownloading() async throws {
        let fixture = try ExportHTTPFixture(); defer { fixture.close() }
        for path in ["no-echo.mp4", "wrong-root.mp4"] {
            var request = URLRequest(url: fixture.url("/api/task-files/asset-url")); request.httpMethod = "POST"
            let source = TaskMediaActionSource.workspace(request: request, taskID: "task", cwd: "/original", path: path, kind: .video)
            do { _ = try await XCTUnwrap(source.prepare)(); XCTFail("Unverified workspace accepted") }
            catch { XCTAssertTrue(error.localizedDescription.contains("媒体来源无法确认")) }
        }
    }
    private func directory() throws -> URL { let url = FileManager.default.temporaryDirectory.appendingPathComponent("friday-export-tests-" + UUID().uuidString); try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false); return url }
}
private final class ExportHTTPFixture {
    private let process = Process(); private let port: Int
    init() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let pipe = Pipe(); process.executableURL = URL(fileURLWithPath: "/usr/bin/env"); process.arguments = ["node", root.appendingPathComponent("scripts/fixtures/media-export-server.mjs").path]; process.standardOutput = pipe; process.standardError = Pipe(); try process.run()
        var data = Data(); while data.count < 4096, let byte = try pipe.fileHandleForReading.read(upToCount: 1), !byte.isEmpty { if byte[0] == 10 { break }; data.append(byte) }
        guard let port = (try JSONSerialization.jsonObject(with: data) as? [String: Int])?["port"] else { if process.isRunning { process.terminate() }; throw URLError(.cannotConnectToHost) }; self.port = port
    }
    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)" + path)! }
    func close() { if process.isRunning { process.terminate(); process.waitUntilExit() } }
}
