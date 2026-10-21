import XCTest
import CoreGraphics
@testable import FridayKit

final class HostBrowserAnnotationTransportTests:XCTestCase {
    @MainActor private final class Fixture {
        let directory:URL
        let marker:URL
        let process=Process()
        let defaults:UserDefaults
        let suite="friday-host-annotation-test-"+UUID().uuidString
        var controller:TaskHostBrowserController!
        init(delay:Int=0)throws {
            directory=FileManager.default.temporaryDirectory.appendingPathComponent("FridayRemoteAnnotation-"+UUID().uuidString);marker=directory.appendingPathComponent("ready.json")
            defaults=UserDefaults(suiteName:suite)!
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            let context=try XCTUnwrap(CGContext(data:nil,width:320,height:240,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue))
            context.setFillColor(CGColor(red:0.2,green:0.5,blue:0.8,alpha:1));context.fill(CGRect(x:0,y:0,width:320,height:240))
            let png=directory.appendingPathComponent("synthetic.png");try XCTUnwrap(TaskBrowserFrames.png(context.makeImage()!)).write(to:png)
            var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()}
            process.executableURL=URL(fileURLWithPath:"/usr/bin/env");process.arguments=["node",root.appendingPathComponent("server/test/fixtures/host-browser-capture.mjs").path,marker.path,png.path,String(delay)];process.currentDirectoryURL=root
            process.environment=["PATH":ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin","LANG":"en_US.UTF-8"];process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice;try process.run()
        }
        func connect()async throws {
            for _ in 0..<200 {if FileManager.default.fileExists(atPath:marker.path) {break};try await Task.sleep(for:.milliseconds(10))}
            let port=(try JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as! [String:Any])["port"] as! Int
            let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="http://127.0.0.1:\(port)";connection.token="synthetic-capture-fixture"
            controller=TaskHostBrowserController(task:"task",tab:TaskBrowserTab(id:"tab",url:"http://localhost:3000/"),connection:connection);controller.mount()
            for _ in 0..<200 {if controller.annotationAvailable {return};try await Task.sleep(for:.milliseconds(10))};XCTFail("Fixture did not connect")
        }
        var requests:[[String:String]] {guard let data=try? String(contentsOf:URL(fileURLWithPath:marker.path+".requests"),encoding:.utf8) else{return []};return data.split(separator:"\n").compactMap {try? JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:String]}}
        func close() {controller?.dispose();if process.isRunning {process.terminate()};process.waitUntilExit();defaults.removePersistentDomain(forName:suite);try? FileManager.default.removeItem(at:directory)}
    }
    @MainActor func testRemoteSelectionUsesTheExistingComposerAndAttachesBoundedSourceAndCroppedPNG()async throws {
        let fixture=try Fixture();defer{fixture.close()};try await fixture.connect();let controller=fixture.controller!
        var attached:TaskBrowserAnnotationRecord?,image:Data?,sent=false
        let composer=TaskBrowserAnnotationComposer(enabled:true,target:"task\nqueue:edited",scope:"synthetic-scope",workspaceRoot:"/project",current:{true},attach:{record,png,send in attached=record;image=png;sent=send;return .init(accepted:true)})
        controller.annotate(composer);let session=try XCTUnwrap(controller.annotationSession)
        for _ in 0..<200 {if session.ready && session.snapshot?.hasTargets==true {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertTrue(session.ready);XCTAssertTrue(session.current);session.comment="keep original draft"
        session.choose(.draw);session.style("color","blue");session.submit(send:true)
        for _ in 0..<200 {if attached != nil {break};try await Task.sleep(for:.milliseconds(10))}
        let record=try XCTUnwrap(attached);XCTAssertEqual(record.comment,"keep original draft");XCTAssertEqual(record.elements.first?.componentName,"FixtureButton");XCTAssertEqual(record.elements.first?.source?.fileName,"/src/Button.tsx");XCTAssertTrue(record.valid);XCTAssertTrue(sent)
        let crop=try XCTUnwrap(TaskHostBrowserGeometry.decode(try XCTUnwrap(image)));XCTAssertEqual(crop.width,70);XCTAssertEqual(crop.height,40);XCTAssertNil(controller.annotationSession)
        for _ in 0..<100 {if fixture.requests.contains(where:{$0["action"]=="stop"}) {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertEqual(fixture.requests.filter {$0["action"]=="stop"}.first?["id"],record.annotationId)
        XCTAssertEqual(fixture.requests.compactMap {$0["action"]}.filter {["tool","style","freeze"].contains($0)},["tool","style","freeze"])
    }
    @MainActor func testCancelledLateStartCannotReplaceTheNewSessionAndComposerChangesCannotAttach()async throws {
        let fixture=try Fixture(delay:150);defer{fixture.close()};try await fixture.connect();let controller=fixture.controller!
        var current=true,attached=0
        let composer=TaskBrowserAnnotationComposer(enabled:true,target:"task",scope:"scope",workspaceRoot:"/project",current:{current},attach:{_,_,_ in attached+=1;return .init(accepted:true)})
        controller.annotate(composer);let first=try XCTUnwrap(controller.annotationSession)
        for _ in 0..<100 {if fixture.requests.contains(where:{$0["id"]==first.nonce}) {break};try await Task.sleep(for:.milliseconds(10))}
        first.cancel();controller.annotate(composer);let second=try XCTUnwrap(controller.annotationSession);XCTAssertNotEqual(first.nonce,second.nonce)
        for _ in 0..<200 {if second.ready {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertTrue(second.ready);XCTAssertTrue(controller.annotationSession === second);XCTAssertFalse(first.current)
        current=false;second.submit(send:true)
        for _ in 0..<100 {if controller.annotationSession==nil {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertNil(controller.annotationSession);XCTAssertEqual(attached,0)
        for _ in 0..<100 {if fixture.requests.filter({$0["action"]=="stop"}).count>=2 {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertEqual(Set(fixture.requests.filter {$0["action"]=="stop"}.compactMap {$0["id"]}),Set([first.nonce,second.nonce]))
    }
    @MainActor func testPixelCropScalesCSSCoordinatesAndRejectsAnInvalidViewport()throws {
        let context=try XCTUnwrap(CGContext(data:nil,width:1280,height:960,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)),image=try XCTUnwrap(context.makeImage())
        let data=try XCTUnwrap(TaskBrowserAnnotationImage.crop(image,crop:.init(x:10,y:20,width:100,height:50),viewport:CGSize(width:640,height:480)))
        let decoded=try XCTUnwrap(TaskHostBrowserGeometry.decode(data));XCTAssertEqual(decoded.width,200);XCTAssertEqual(decoded.height,100)
        XCTAssertNil(TaskBrowserAnnotationImage.crop(image,crop:.init(x:0,y:0,width:10,height:10),viewport:CGSize(width:0,height:480)))
    }
}
