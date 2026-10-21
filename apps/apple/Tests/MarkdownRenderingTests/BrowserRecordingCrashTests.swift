import XCTest
import CoreGraphics
import Darwin
@testable import FridayKit

/// Runs an encoder in a separate, credential-free process with synthetic pixels only.
final class BrowserRecordingCrashTests:XCTestCase {
    func testChildWriterFixture() async throws {
        guard let path=ProcessInfo.processInfo.environment["FRIDAY_CAPTURE_CRASH_FIXTURE"] else{return}
        let root=URL(fileURLWithPath:path),store=try TaskBrowserArtifactStore(scope:"crash",root:root),artifact=try store.prepare(page:"https://fixture.invalid/",recording:true),lease=try store.beginRecording(artifact)
        let bitmap=try XCTUnwrap(CGContext(data:nil,width:320,height:240,bitsPerComponent:8,bytesPerRow:1280,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue));bitmap.setFillColor(CGColor(red:0.2,green:0.4,blue:0.8,alpha:1));bitmap.fill(CGRect(x:0,y:0,width:320,height:240));let image=try XCTUnwrap(bitmap.makeImage())
        let writer=try TaskBrowserMovieWriter(url:store.url(artifact),imageSize:CGSize(width:320,height:240),frameRate:30,lease:lease)
        for frame in 0..<240 {while try await !writer.append(image,seconds:Double(frame)/30) {try await Task.sleep(for:.milliseconds(5))}}
        try JSONEncoder().encode(artifact).write(to:root.appendingPathComponent("ready.json"))
        while true {withExtendedLifetime(writer) {};try await Task.sleep(for:.seconds(1))}
    }
    func testSIGKILLPreservesCompleteFragmentsAndRecoveryIsScopedAndIdempotent() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("friday-crash-test-"+UUID().uuidString,isDirectory:true);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);defer {try? FileManager.default.removeItem(at:root)}
        let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/xcrun");process.arguments=["xctest","-XCTest","MarkdownRenderingTests.BrowserRecordingCrashTests/testChildWriterFixture",Bundle(for:Self.self).bundleURL.path]
        process.environment=["PATH":"/usr/bin:/bin:/usr/sbin:/sbin","LANG":"en_US.UTF-8","FRIDAY_CAPTURE_CRASH_FIXTURE":root.path]
        let log=root.appendingPathComponent("child.log");FileManager.default.createFile(atPath:log.path,contents:nil);let handle=try FileHandle(forWritingTo:log);process.standardOutput=handle;process.standardError=handle;try process.run()
        defer {if process.isRunning {kill(process.processIdentifier,SIGKILL);process.waitUntilExit()};try? handle.close()}
        let ready=root.appendingPathComponent("ready.json"),deadline=Date().addingTimeInterval(20)
        while !FileManager.default.fileExists(atPath:ready.path),process.isRunning,Date()<deadline {try await Task.sleep(for:.milliseconds(40))}
        guard FileManager.default.fileExists(atPath:ready.path),process.isRunning else{throw ConnectionError.message("Synthetic recording child did not become ready")}
        let store=try TaskBrowserArtifactStore(scope:"crash",root:root);XCTAssertTrue(store.interrupted().isEmpty,"A live producer must keep its lease")
        kill(process.processIdentifier,SIGKILL);process.waitUntilExit();XCTAssertEqual(process.terminationReason,.uncaughtSignal);XCTAssertEqual(process.terminationStatus,SIGKILL)
        let pending=try XCTUnwrap(store.interrupted().first);XCTAssertEqual(store.interrupted().count,1)
        let recovered=try await TaskBrowserRecordingRecovery.recover(pending,store:store);XCTAssertEqual(recovered.recovered,true);XCTAssertTrue(store.interrupted().isEmpty);XCTAssertEqual(store.recent(),[recovered])
        let duration=try await TaskBrowserRecordingRecovery.duration(store.url(recovered));XCTAssertGreaterThan(duration,1);XCTAssertLessThanOrEqual(duration,8.1)
        let repeated=try await TaskBrowserRecordingRecovery.recover(pending,store:store);XCTAssertEqual(repeated,recovered)
        XCTAssertTrue(FileManager.default.fileExists(atPath:try store.url(pending).path),"Recovery must retain the original")
        let other=try TaskBrowserArtifactStore(scope:"other",root:root);XCTAssertTrue(other.interrupted().isEmpty);XCTAssertTrue(other.recent().isEmpty)
    }
}
