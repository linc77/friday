import XCTest
import CoreGraphics
@testable import FridayKit

final class HostBrowserCaptureTransportTests:XCTestCase {
    @MainActor func testPrivatePNGCaptureSeedsStaticRecordingsAndAnotherSurfaceKeepsTheConnectionAlive()async throws {
        var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()}
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("FridayRemoteCapture-"+UUID().uuidString);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:directory)}
        let context=CGContext(data:nil,width:320,height:240,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red:0.2,green:0.5,blue:0.8,alpha:1));context.fill(CGRect(x:0,y:0,width:320,height:240));let png=directory.appendingPathComponent("page.png");try XCTUnwrap(TaskBrowserFrames.png(context.makeImage()!)).write(to:png)
        let marker=directory.appendingPathComponent("ready.json"),process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/env");process.arguments=["node",root.appendingPathComponent("server/test/fixtures/host-browser-capture.mjs").path,marker.path,png.path];process.currentDirectoryURL=root;process.environment=["PATH":ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin","LANG":"en_US.UTF-8"];process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice;try process.run();defer{if process.isRunning {process.terminate()};process.waitUntilExit()}
        for _ in 0..<200 {if FileManager.default.fileExists(atPath:marker.path) {break};try await Task.sleep(for:.milliseconds(10))}
        let port=(try JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as! [String:Any])["port"] as! Int,defaults=UserDefaults(suiteName:"friday-capture-transport-test")!;defer{defaults.removePersistentDomain(forName:"friday-capture-transport-test")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="http://127.0.0.1:\(port)";connection.token="synthetic-capture-fixture"
        let controller=TaskHostBrowserController(task:"task",tab:TaskBrowserTab(id:"tab",url:"http://localhost:3000/"),connection:connection);defer{controller.dispose()};controller.mount()
        for _ in 0..<200 {if controller.captureAvailable {break};try await Task.sleep(for:.milliseconds(10))};XCTAssertTrue(controller.captureAvailable)
        let surface=UUID();controller.acquireSurface(surface);controller.unmount();XCTAssertTrue(controller.connected)
        let image=try await controller.captureImage();XCTAssertEqual(image.width,320);XCTAssertEqual(image.height,240)
        try await controller.prepareRecording(nonce:"recording",showKeys:false);let first=try await controller.frames.capture();XCTAssertEqual(first.width,320);await controller.finishRecordingInput(nonce:"recording")
        controller.releaseSurface(surface);XCTAssertFalse(controller.connected)
    }
}
