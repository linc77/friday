import XCTest
import CoreGraphics
@preconcurrency import AVFoundation
@testable import FridayKit

@MainActor private final class CaptureOwnerFixture:TaskBrowserCaptureOwner {
    var captureClosed=false
    var captureAvailable:Bool {!captureClosed}
    var captureURL:String?="https://fixture.invalid/page"
    var captureDocument="document"
    let artifactScope=UUID().uuidString
    @Published var capturing=false
    @Published var message:String?
    @Published var exported:TaskBrowserExport?
    @Published var recordingSession:TaskBrowserRecordingSession?
    @Published var capturedArtifact:TaskBrowserArtifact?
    @Published var artifacts:[TaskBrowserArtifact]=[]
    @Published var interruptedArtifacts:[TaskBrowserArtifact]=[]
    @Published var recoveringArtifacts=Set<String>()
    var framesTaken=0
    var preparations=0
    var inputFinishes=0
    var finishes=0
    var preparing:(()async->Void)?
    private let image:CGImage
    lazy var frames=TaskBrowserFrames(capture:{[weak self] callback in guard let self else{callback(.failure(CancellationError()));return};framesTaken+=1;callback(.success(image))})
    init() {
        let context=CGContext(data:nil,width:320,height:240,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red:0.9,green:0.1,blue:0.2,alpha:1));context.fill(CGRect(x:0,y:0,width:320,height:240));image=context.makeImage()!
    }
    func captureImage()async throws->CGImage {image}
    func capture() {capturePageArtifact()}
    func prepareRecording(nonce:String,showKeys:Bool)async throws {preparations+=1;if let preparing {await preparing()}}
    func finishRecordingInput(nonce:String)async {inputFinishes+=1}
    func recordingDidFinish() {finishes+=1}
}
@MainActor private final class CapturePrepareGate {
    private var waiter:CheckedContinuation<Void,Never>?
    func wait()async {await withCheckedContinuation{waiter=$0}}
    func release() {waiter?.resume();waiter=nil}
}
final class BrowserCaptureOwnerTests:XCTestCase {
    @MainActor func testSharedCaptureOwnerEncodesSyntheticFramesAndCommitsTheSameRecoverableArtifactFormat()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("FridayCaptureOwner-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root)}
        let owner=CaptureOwnerFixture(),store=try TaskBrowserArtifactStore(scope:owner.artifactScope,root:root),session=try TaskBrowserRecordingSession(controller:owner,frameRate:30,artifactStore:store)
        owner.recordingSession=session;session.start()
        for _ in 0..<200 {if owner.framesTaken>=4 {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertGreaterThanOrEqual(owner.framesTaken,4);session.stop()
        for _ in 0..<400 {if session.phase == .finished {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertEqual(session.phase,.finished);XCTAssertEqual(owner.preparations,1);XCTAssertEqual(owner.inputFinishes,1);XCTAssertEqual(owner.finishes,1);XCTAssertNil(owner.recordingSession);XCTAssertFalse(owner.frames.active)
        let artifact=try XCTUnwrap(store.recent().first);XCTAssertTrue(artifact.recording);XCTAssertTrue(store.interrupted().isEmpty)
        let asset=AVURLAsset(url:try store.url(artifact));let duration=try await asset.load(.duration);XCTAssertGreaterThan(duration.seconds,0);XCTAssertFalse(TaskBrowserCaptureRegistry.shared.active)
    }
    @MainActor func testClosingDuringRemotePreparationDrainsTheLateLeaseWithoutCreatingAnEmptyMovie()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("FridayCaptureOwnerClose-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root);TaskBrowserCaptureRegistry.shared.cancelQuit()}
        let owner=CaptureOwnerFixture(),gate=CapturePrepareGate(),store=try TaskBrowserArtifactStore(scope:owner.artifactScope,root:root);owner.preparing={await gate.wait()}
        let session=try TaskBrowserRecordingSession(controller:owner,frameRate:60,artifactStore:store);owner.recordingSession=session;session.start()
        for _ in 0..<100 {if owner.preparations==1 {break};try await Task.sleep(for:.milliseconds(10))};XCTAssertEqual(owner.preparations,1)
        owner.captureClosed=true;session.stop();Task {try? await Task.sleep(for:.milliseconds(20));gate.release()};try await TaskBrowserCaptureRegistry.shared.prepareToQuit()
        XCTAssertEqual(session.phase,.finished);XCTAssertEqual(owner.inputFinishes,1);XCTAssertEqual(owner.framesTaken,0);XCTAssertEqual(owner.finishes,1);XCTAssertTrue(store.recent().isEmpty);XCTAssertTrue(store.interrupted().isEmpty);XCTAssertFalse(TaskBrowserCaptureRegistry.shared.active)
    }
}
