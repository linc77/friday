import XCTest
import CoreGraphics
@testable import FridayKit

final class HostBrowserTests:XCTestCase {
    private func snapshot(revision:Int=1,generation:String="generation",task:String="task",tab:String="tab")->[String:Any] {
        ["taskId":task,"tabId":tab,"generation":generation,"revision":revision,"url":"http://localhost:3000/","title":"Fixture","loading":false,"back":false,"forward":false,"error":NSNull(),"settings":["width":1280,"height":800,"mobile":false,"zoom":1,"appearance":"system"],"controller":"viewer","controlGeneration":1,"dialog":NSNull(),"popups":[]]
    }
    private func line(_ value:[String:Any])throws->String {"data: "+String(decoding:try JSONSerialization.data(withJSONObject:value),as:UTF8.self)}
    func testOnlyCurrentTaskTabAndBrowserGenerationCanUpdateTheStream()throws {
        var stream=TaskHostBrowserStream(task:"task",tab:"tab",generation:"generation")
        XCTAssertNil(try stream.read("event: state"))
        XCTAssertNotNil(try stream.read(line(["type":"state","state":snapshot(revision:4)])))
        for value in [snapshot(revision:3),snapshot(revision:100,generation:"old"),snapshot(revision:100,task:"other"),snapshot(revision:100,tab:"other")] {XCTAssertNil(try stream.read(line(["type":"state","state":value])))}
        XCTAssertEqual(stream.revision,4)
    }
    func testFrameSequenceAndDecodeBudgetsRejectMalformedOrStaleFrames()throws {
        var stream=TaskHostBrowserStream(task:"task",tab:"tab",generation:"generation")
        let frame:[String:Any]=["type":"frame","data":"c3ludGhldGlj","width":1280,"height":800,"sequence":10]
        XCTAssertNotNil(try stream.read(line(frame)));XCTAssertNil(try stream.read(line(frame)))
        var oversized=frame;oversized["sequence"]=11;oversized["width"]=15360;oversized["height"]=15360;XCTAssertNil(try stream.read(line(oversized)))
        XCTAssertNil(try stream.read(line(["type":"frame","sequence":12,"data":"c3ludGhldGlj"])))
        XCTAssertNil(TaskHostBrowserGeometry.decode(Data("not an image".utf8)))
        XCTAssertNil(TaskHostBrowserGeometry.decode(Data(count:6*1024*1024+1)))
        XCTAssertNotNil(try stream.read(line(["type":"gone"])))
    }
    func testNativeLetterboxingMapsPointerIntoRemoteCSSPixelsAndClampsDragRelease() {
        let viewport=CGSize(width:1280,height:800),frame=TaskHostBrowserGeometry.frame(container:CGSize(width:800,height:800),viewport:viewport)
        XCTAssertEqual(frame,CGRect(x:0,y:150,width:800,height:500))
        XCTAssertEqual(TaskHostBrowserGeometry.point(CGPoint(x:400,y:400),frame:frame,viewport:viewport),CGPoint(x:640,y:400))
        XCTAssertNil(TaskHostBrowserGeometry.point(CGPoint(x:1,y:1),frame:frame,viewport:viewport))
        XCTAssertEqual(TaskHostBrowserGeometry.point(CGPoint(x:-40,y:1000),frame:frame,viewport:viewport,clamped:true),CGPoint(x:0,y:800))
        XCTAssertEqual(TaskHostBrowserGeometry.frame(container:.zero,viewport:viewport),.zero)
    }
    @MainActor func testHostTransportFreezesAuthorizationAndNeverPutsItInFrameURLs()throws {
        let defaults=UserDefaults(suiteName:"friday-host-browser-tests")!;defer{defaults.removePersistentDomain(forName:"friday-host-browser-tests")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="https://fixture.invalid";connection.token="fixture-not-a-real-credential"
        let transport=try TaskHostBrowserTransport(connection:connection);connection.server="https://different.invalid";connection.token="changed"
        let request=try transport.request("events",query:["taskId":"task","tabId":"tab","viewer":"v","generation":"g"])
        XCTAssertEqual(request.url?.host,"fixture.invalid");XCTAssertEqual(request.value(forHTTPHeaderField:"Authorization"),"Bearer fixture-not-a-real-credential");XCTAssertFalse(request.url!.absoluteString.contains("credential"));XCTAssertEqual(request.httpMethod,"GET")
        let body=try transport.request("command",body:["taskId":"task","action":["type":"text","text":"中文🙂"]]);XCTAssertEqual(body.httpMethod,"POST");XCTAssertEqual(body.value(forHTTPHeaderField:"Content-Type"),"application/json");XCTAssertTrue(String(decoding:body.httpBody!,as:UTF8.self).contains("中文"))
        XCTAssertThrowsError(try transport.request("https://untrusted.invalid"))
        connection.server="http://remote.invalid";XCTAssertThrowsError(try TaskHostBrowserTransport(connection:connection))
    }
    func testHostRoutingUsesTheServiceForRemoteLoopbackAndSupportsExplicitHostPublicPages()throws {
        var tab=TaskBrowserTab(url:"http://localhost:3000/")
        XCTAssertTrue(TaskBrowserPolicy.usesHost(tab,server:"https://host.invalid"))
        #if os(macOS)
        XCTAssertFalse(TaskBrowserPolicy.usesHost(tab,server:"http://127.0.0.1:4317"))
        #endif
        tab.url="https://example.com/";XCTAssertFalse(TaskBrowserPolicy.usesHost(tab,server:"https://host.invalid"));tab.hostBrowser=true;XCTAssertTrue(TaskBrowserPolicy.usesHost(tab,server:"https://host.invalid"))
        let data=try JSONEncoder().encode(tab);let decoded=try JSONDecoder().decode(TaskBrowserTab.self,from:data);XCTAssertEqual(decoded.hostBrowser,true)
    }
    func testRemoteSettingsKeepDeviceCSSSizeZoomAndAppearanceIndependent() {
        let tab=TaskBrowserTab(zoom:1.5,appearance:"dark",viewportWidth:390,viewportHeight:844,mobile:true)
        let settings=TaskHostBrowserSettings(tab:tab);XCTAssertEqual(settings.width,390);XCTAssertEqual(settings.height,844);XCTAssertEqual(settings.zoom,1.5);XCTAssertTrue(settings.mobile);XCTAssertEqual(settings.appearance,"dark")
    }
}

private final class HostOpenRequests:@unchecked Sendable {
    private let lock=NSLock()
    private var values:[(String,[String:Any])]=[]
    func record(_ path:String,_ body:[String:Any]) {lock.lock();defer{lock.unlock()};values.append((path,body))}
    func read()->[(String,[String:Any])] {lock.lock();defer{lock.unlock()};return values}
    func reset() {lock.lock();defer{lock.unlock()};values=[]}
}
private final class HostOpenProtocol:URLProtocol,@unchecked Sendable {
    static let requests=HostOpenRequests()
    override class func canInit(with request:URLRequest)->Bool {request.url?.host=="friday-host-opening.test"}
    override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
    override func startLoading() {
        var data=request.httpBody ?? Data()
        if let stream=request.httpBodyStream {stream.open();defer{stream.close()};var bytes=[UInt8](repeating:0,count:4096);while stream.hasBytesAvailable {let count=stream.read(&bytes,maxLength:bytes.count);if count<=0 {break};data.append(contentsOf:bytes.prefix(count))}}
        let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any] ?? [:],path=request.url!.lastPathComponent
        Self.requests.record(path,body)
        let payload:[String:Any]
        if path=="open" {payload=["taskId":"task","tabId":body["tabId"] ?? "tab","generation":"created-before-close","revision":1,"url":"http://localhost:3000/","title":"Fixture","loading":false,"back":false,"forward":false,"error":NSNull(),"settings":["width":1280,"height":800,"mobile":false,"zoom":1,"appearance":"system"],"controller":NSNull(),"controlGeneration":0,"dialog":NSNull(),"popups":[]]}else{payload=["ok":true]}
        let result=try! JSONSerialization.data(withJSONObject:payload)
        DispatchQueue.global().asyncAfter(deadline:.now()+(path=="open" ? 0.12:0)) { [self] in
            let response=HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
            client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed);client?.urlProtocol(self,didLoad:result);client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}
extension HostBrowserTests {
    @MainActor func testClosingWhileTheInitialOpenIsPendingRetainsItsReceiptAndClosesOnlyThatCreatedGeneration()async throws {
        HostOpenProtocol.requests.reset()
        let configuration=URLSessionConfiguration.ephemeral;configuration.protocolClasses=[HostOpenProtocol.self];let session=URLSession(configuration:configuration);defer{session.invalidateAndCancel()}
        let defaults=UserDefaults(suiteName:"friday-host-open-tests")!;defer{defaults.removePersistentDomain(forName:"friday-host-open-tests")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="https://friday-host-opening.test";connection.token="fixture"
        let controller=TaskHostBrowserController(task:"task",tab:TaskBrowserTab(id:"opening-tab",url:"http://localhost:3000/"),connection:connection,session:session)
        controller.mount()
        for _ in 0..<100 {if !HostOpenProtocol.requests.read().isEmpty {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertEqual(HostOpenProtocol.requests.read().map(\.0),["open"]);controller.closeRemote()
        for _ in 0..<100 {if HostOpenProtocol.requests.read().count>=2 {break};try await Task.sleep(for:.milliseconds(10))}
        let requests=HostOpenProtocol.requests.read();XCTAssertEqual(requests.map(\.0),["open","close"]);XCTAssertEqual(requests.last?.1["generation"] as? String,"created-before-close");XCTAssertEqual(requests.last?.1["tabId"] as? String,"opening-tab");XCTAssertNil(controller.state);XCTAssertFalse(controller.connected)
    }
}

extension HostBrowserTests {
    @MainActor func testMetadataUpdatesPreserveAFilledRemoteViewportAndFixedPresetsKeepTheirCSSZoomLayout()throws {
        let defaults=UserDefaults(suiteName:"friday-host-layout-tests")!;defer{defaults.removePersistentDomain(forName:"friday-host-layout-tests")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="https://host-layout.invalid";connection.token="fixture"
        var tab=TaskBrowserTab(url:"http://localhost:3000/");let controller=TaskHostBrowserController(task:"task",tab:tab,connection:connection);defer{controller.dispose()}
        controller.resize(CGSize(width:640,height:480),tab:tab);XCTAssertEqual(controller.viewport,CGSize(width:640,height:480))
        tab.title="New title";controller.update(tab);XCTAssertEqual(controller.viewport,CGSize(width:640,height:480));XCTAssertFalse(controller.fixedViewport)
        tab.viewportWidth=390;tab.viewportHeight=844;tab.zoom=1.5;controller.update(tab);XCTAssertEqual(controller.viewport,CGSize(width:260,height:563));XCTAssertTrue(controller.fixedViewport)
        controller.resizeSurface(CGSize(width:1000,height:800));XCTAssertEqual(controller.viewport,CGSize(width:260,height:563))
    }
}
