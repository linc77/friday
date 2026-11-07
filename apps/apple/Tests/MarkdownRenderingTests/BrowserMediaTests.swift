import XCTest
import AVFoundation
import CoreGraphics
@testable import FridayKit

final class BrowserMediaTests:XCTestCase {
    private func image(width:Int=320,height:Int=240)throws->CGImage {
        let context=try XCTUnwrap(CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue))
        for (rect,color) in [(CGRect(x:0,y:0,width:width/2,height:height/2),CGColor(red:1,green:0,blue:0,alpha:1)),(CGRect(x:width/2,y:0,width:width,height:height/2),CGColor(red:0,green:1,blue:0,alpha:1)),(CGRect(x:0,y:height/2,width:width/2,height:height),CGColor(red:0,green:0,blue:1,alpha:1)),(CGRect(x:width/2,y:height/2,width:width,height:height),CGColor(gray:1,alpha:1))] {context.setFillColor(color);context.fill(rect)}
        return try XCTUnwrap(context.makeImage())
    }
    private func temporary()throws->URL {let root=FileManager.default.temporaryDirectory.appendingPathComponent("browser-media-test-"+UUID().uuidString,isDirectory:true);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);return root}
    private func fixture()throws->Data {var url=URL(fileURLWithPath:#filePath);for _ in 0..<5 {url.deleteLastPathComponent()};return try Data(contentsOf:url.appendingPathComponent("server/test/fixtures/t3-browser-capture.json"))}
    func testPinnedPictureInPictureGeometryAndPrivateArtifactNames()throws {
        struct Fixtures:Decodable {let pictures:[Picture];let pages:[Page]}
        struct Picture:Decodable {let size:[Double];let aspect:Double;let expected:[Double]}
        struct Page:Decodable {let page:String;let expected:String}
        let fixtures=try JSONDecoder().decode(Fixtures.self,from:fixture());XCTAssertEqual(fixtures.pictures.count,20)
        for item in fixtures.pictures {let size=TaskBrowserCapturePolicy.pictureSize(CGSize(width:item.size[0],height:item.size[1]),aspect:item.aspect);XCTAssertEqual([size.width,size.height],item.expected)}
        for item in fixtures.pages {XCTAssertEqual(TaskBrowserCapturePolicy.siteSlug(item.page),item.expected)}
        let name=TaskBrowserCapturePolicy.fileName(page:"https://user:password@example.com/page?token=private",recording:false,date:Date(timeIntervalSince1970:100),id:UUID(uuidString:"01234567-89AB-CDEF-0123-456789ABCDEF")!)
        XCTAssertEqual(name,"browser-screenshot-example-com-255s-01234567.png");XCTAssertFalse(name.contains("password"));XCTAssertFalse(name.contains("private"))
        XCTAssertEqual(TaskBrowserCapturePolicy.frameRate(60),60);XCTAssertEqual(TaskBrowserCapturePolicy.frameRate(15),30)
        XCTAssertEqual(TaskBrowserCapturePolicy.bitRate(width:1920,height:1080,frameRate:30),3_110_400)
        XCTAssertEqual(TaskBrowserCapturePolicy.bitRate(width:3840,height:2160,frameRate:60),24_883_200)
    }
    func testVideoBoundsUseEvenPixelSizesAndRespectAspectInsteadOfStretching() {
        for input in [CGSize(width:321,height:241),CGSize(width:7680,height:4320),CGSize(width:240,height:7680),CGSize(width:4800,height:4800),CGSize(width:CGFloat.nan,height:10)] {
            let output=TaskBrowserCapturePolicy.videoSize(input);XCTAssertTrue(output.width.isFinite);XCTAssertEqual(Int(output.width)%2,0);XCTAssertEqual(Int(output.height)%2,0);XCTAssertLessThanOrEqual(max(output.width,output.height),3840);XCTAssertLessThanOrEqual(output.width*output.height,Double(3840*2160))
        }
        XCTAssertEqual(TaskBrowserCapturePolicy.videoSize(CGSize(width:7680,height:4320)),CGSize(width:3840,height:2160))
        XCTAssertEqual(TaskBrowserCapturePolicy.videoSize(CGSize(width:4320,height:7680)),CGSize(width:2160,height:3840))
    }
    @MainActor func testFrameRequestsCoalesceAndLateCancelledCallbacksCannotCompleteANewCapture() async throws {
        var callbacks:[(Result<CGImage,Error>)->Void]=[]
        let sampler=TaskBrowserFrameSampler {callbacks.append($0)},frame=try image()
        let first=Task {try await sampler.request()},second=Task {try await sampler.request()}
        for _ in 0..<20 {await Task.yield();if callbacks.count==1 {break}}
        XCTAssertEqual(callbacks.count,1);callbacks[0](.success(frame));let a=try await first.value,b=try await second.value;XCTAssertTrue(a===b)
        let cancelled=Task {try await sampler.request()};for _ in 0..<20 {await Task.yield();if callbacks.count==2 {break}};sampler.cancel()
        do {_=try await cancelled.value;XCTFail("Cancelled capture returned an image")}catch{}
        var resolved=false
        let next=Task {let value=try await sampler.request();resolved=true;return value};for _ in 0..<20 {await Task.yield();if callbacks.count==3 {break}}
        callbacks[1](.success(frame));await Task.yield();XCTAssertFalse(resolved);callbacks[2](.success(frame));_=try await next.value
    }
    @MainActor func testAStalledCaptureTimesOutAndDoesNotHoldTheNextRequest() async throws {
        var callbacks:[(Result<CGImage,Error>)->Void]=[]
        let sampler=TaskBrowserFrameSampler(timeout:.milliseconds(20)) {callbacks.append($0)}
        do {_=try await sampler.request();XCTFail("Stalled capture did not time out")}catch{XCTAssertTrue(error.localizedDescription.contains("超时"))}
        let frame=try image(),next=Task {try await sampler.request()};for _ in 0..<20 {await Task.yield();if callbacks.count==2 {break}}
        callbacks[0](.success(frame));callbacks[1](.success(frame));_=try await next.value
    }
    func testRecordingStartStopAndRepeatedStopCannotPublishALateStart() {
        var cancelled=TaskBrowserRecordingLifecycle();XCTAssertTrue(cancelled.stop());XCTAssertFalse(cancelled.firstFrame(at:100));XCTAssertFalse(cancelled.stop());cancelled.finish();XCTAssertEqual(cancelled.phase,.finished)
        var active=TaskBrowserRecordingLifecycle();XCTAssertTrue(active.firstFrame(at:10));XCTAssertFalse(active.firstFrame(at:20));XCTAssertEqual(active.elapsed(at:12.5),2.5);XCTAssertEqual(active.elapsed(at:9),0);XCTAssertTrue(active.stop());XCTAssertFalse(active.acceptsFrames)
    }
    func testArtifactsStayPrivateSurviveReloadAndRejectPathAndSymlinkEscapes()throws {
        let root=try temporary();defer {try? FileManager.default.removeItem(at:root)}
        let store=try TaskBrowserArtifactStore(scope:"service\ntab",root:root),other=try TaskBrowserArtifactStore(scope:"other\ntab",root:root),data=Data([1,2,3]),artifact=try store.save(data,page:"https://example.com/")
        XCTAssertEqual(try Data(contentsOf:store.url(artifact)),data);XCTAssertEqual(try TaskBrowserArtifactStore(scope:"service\ntab",root:root).recent(),[artifact]);XCTAssertTrue(other.recent().isEmpty)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath:store.url(artifact).path)[.posixPermissions] as? NSNumber)?.intValue,0o600)
        let traversal=TaskBrowserArtifact(id:artifact.id,name:"../outside.png",recording:false,createdAt:Date());XCTAssertThrowsError(try store.url(traversal))
        let target=try store.url(artifact);try FileManager.default.removeItem(at:target);try FileManager.default.createSymbolicLink(at:target,withDestinationURL:root.appendingPathComponent("outside"));XCTAssertThrowsError(try store.url(artifact))
    }
    func testRealMP4EncodingPreservesDurationBoundsAndPixelOrientation() async throws {
        let root=try temporary();defer {try? FileManager.default.removeItem(at:root)}
        let url=root.appendingPathComponent("recording.mp4"),frame=try image(width:321,height:241),writer=try TaskBrowserMovieWriter(url:url,imageSize:CGSize(width:frame.width,height:frame.height),frameRate:30)
        var decoration=TaskBrowserRecordingDecorations(showKeys:true,showMouse:true)
        decoration.apply(TaskBrowserRecordingInput(nonce:"n",document:"d",type:"pointer",width:321,height:241,x:10,y:20,phase:"down",label:nil,held:nil),now:1)
        decoration.apply(TaskBrowserRecordingInput(nonce:"n",document:"d",type:"key",width:321,height:241,x:nil,y:nil,phase:nil,label:"⌘K",held:false),now:1)
        var accepted=false
        for _ in 0..<100 {if try await writer.append(frame,seconds:0) {accepted=true;break};try await Task.sleep(for:.milliseconds(10))};XCTAssertTrue(accepted)
        _=try await writer.append(frame,seconds:0.1,decoration:decoration,now:1.1);_=try await writer.append(frame,seconds:0.5);try await writer.finish(seconds:1.25)
        let asset=AVURLAsset(url:url),duration=try await asset.load(.duration),tracks=try await asset.loadTracks(withMediaType:.video),track=try XCTUnwrap(tracks.first),size=try await track.load(.naturalSize)
        XCTAssertEqual(CMTimeGetSeconds(duration),1.25,accuracy:0.04);XCTAssertEqual(size,CGSize(width:320,height:240));XCTAssertGreaterThan((try FileManager.default.attributesOfItem(atPath:url.path)[.size] as? NSNumber)?.intValue ?? 0,1000)
        let generator=AVAssetImageGenerator(asset:asset);generator.appliesPreferredTrackTransform=true;let result=try await generator.image(at:CMTime(seconds:0.1,preferredTimescale:600))
        func pixels(_ image:CGImage)throws->[UInt8] {let context=try XCTUnwrap(CGContext(data:nil,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue));context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height));let bytes=try XCTUnwrap(context.data);return Array(UnsafeBufferPointer(start:bytes.assumingMemoryBound(to:UInt8.self),count:image.width*image.height*4))}
        let actual=try pixels(result.image),expected=try pixels(frame)
        for (x,y) in [(0.25,0.25),(0.75,0.25),(0.25,0.75),(0.75,0.75)] {for channel in 0..<3 {let a=(Int(Double(result.image.height)*y)*result.image.width+Int(Double(result.image.width)*x))*4+channel,b=(Int(Double(frame.height)*y)*frame.width+Int(Double(frame.width)*x))*4+channel;XCTAssertEqual(Int(actual[a]),Int(expected[b]),accuracy:35)}}
        do {try await writer.finish(seconds:2);XCTFail("Finished writer finalized twice")}catch{}
    }
    func testKeyAndMouseDecorationsUseT3ExpiryAndClearSemantics() {
        func input(type:String,phase:String?=nil,label:String?=nil,held:Bool?=nil,x:Double?=nil,y:Double?=nil)->TaskBrowserRecordingInput {.init(nonce:"n",document:"d",type:type,width:1280,height:720,x:x,y:y,phase:phase,label:label,held:held)}
        var value=TaskBrowserRecordingDecorations(showKeys:true,showMouse:true)
        value.apply(input(type:"key",label:"⌘A",held:true),now:10);XCTAssertEqual(value.visibleKey(now:100),"⌘A")
        value.apply(input(type:"key",label:"⌘A",held:false),now:11);XCTAssertEqual(value.visibleKey(now:11.899),"⌘A");XCTAssertNil(value.visibleKey(now:11.9))
        value.apply(input(type:"pointer",phase:"down",x:10,y:20),now:12);XCTAssertEqual(value.ringProgress(now:100),0)
        value.apply(input(type:"pointer",phase:"up",x:30,y:40),now:13);XCTAssertEqual(value.ringProgress(now:13.3) ?? -1,0.5,accuracy:0.001);XCTAssertNil(value.ringProgress(now:13.6))
        value.apply(input(type:"clear"),now:14);XCTAssertNil(value.pointer);XCTAssertNil(value.ring);XCTAssertNil(value.key)
        value.apply(input(type:"key",label:"⌘K",held:true),now:15)
        value.apply(TaskBrowserRecordingInput(nonce:"n",document:"d",type:"clear",width:0,height:0,x:nil,y:nil,phase:nil,label:nil,held:nil),now:16);XCTAssertNil(value.key)
        var disabled=TaskBrowserRecordingDecorations(showKeys:false,showMouse:false);disabled.apply(input(type:"key",label:"private",held:true),now:1);disabled.apply(input(type:"pointer",phase:"down",x:1,y:2),now:1);XCTAssertNil(disabled.key);XCTAssertNil(disabled.ring);XCTAssertNotNil(disabled.pointer)
    }
}
