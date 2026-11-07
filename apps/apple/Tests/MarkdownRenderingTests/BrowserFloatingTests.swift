import XCTest
@testable import FridayKit

final class BrowserFloatingTests:XCTestCase {
    func testActualPinnedMiniPlayerFramesAndAllEightResizeDirections()throws {
        struct Fixture:Decodable {let cases:[Entry]}
        struct Input:Decodable {let width:Double?;let position:TaskBrowserMiniPoint?;let source:TaskBrowserMiniSize;let container:TaskBrowserMiniSize;let obstacles:TaskBrowserMiniObstacles}
        struct Resize:Decodable {let direction:String;let delta:TaskBrowserMiniPoint;let expected:TaskBrowserMiniFrame}
        struct Entry:Decodable {let input:Input;let expected:TaskBrowserMiniFrame;let resizes:[Resize]}
        var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()}
        let fixture=try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:root.appendingPathComponent("server/test/fixtures/t3-browser-floating.json")));XCTAssertEqual(fixture.cases.count,180)
        for (index,entry) in fixture.cases.enumerated() {
            let input=entry.input,result=TaskBrowserMiniLayout.resolve(width:input.width,position:input.position,source:input.source,container:input.container,obstacles:input.obstacles)
            XCTAssertEqual(result,entry.expected,"frame \(index)")
            for resize in entry.resizes {
                XCTAssertEqual(TaskBrowserMiniLayout.resize(start:entry.expected,direction:resize.direction,delta:resize.delta,source:input.source,container:input.container,obstacles:input.obstacles),resize.expected,"\(index) \(resize.direction)")
            }
        }
    }
    func testTemporaryNarrowContainersDoNotDestroySavedSizeAndLateGesturesCannotChangeAnotherTab() {
        var state=TaskBrowserFloatingState(tabID:"one",source:.init(width:1600,height:1000),width:800,position:.init(x:100,y:80))
        let narrow=TaskBrowserMiniLayout.resolve(width:state.width,position:state.position,source:state.source,container:.init(width:420,height:300))
        XCTAssertLessThan(narrow.width,800);XCTAssertEqual(state.width,800)
        state.move(source:"old",position:.init(x:1,y:2));XCTAssertEqual(state.position,.init(x:100,y:80))
        state.resize(source:"old",width:300,position:.init(x:1,y:2));XCTAssertEqual(state.width,800)
        state.move(source:"one",position:.init(x:30,y:40));XCTAssertEqual(state.lastInteraction,"drag")
        state.resize(source:"one",width:500,position:.init(x:20,y:30));XCTAssertEqual(state.lastInteraction,"resize");XCTAssertEqual(state.width,500)
    }
    @MainActor func testQuitDrainsClosedWindowWorkOnceAndPropagatesFailureWithoutAcceptingNewWork() async throws {
        let registry=TaskBrowserCaptureRegistry(),id=UUID();var stopped=0;var completed=false
        registry.register(id:id,stop:{stopped+=1},wait:{completed=true;registry.remove(id)})
        XCTAssertTrue(registry.active);try await registry.prepareToQuit();XCTAssertEqual(stopped,1);XCTAssertTrue(completed);XCTAssertFalse(registry.active);XCTAssertTrue(registry.terminating)
        registry.cancelQuit();XCTAssertFalse(registry.terminating)
        registry.register(id:id,wait:{registry.remove(id);throw ConnectionError.message("fixture failure")})
        do {try await registry.prepareToQuit();XCTFail("Save failure allowed quit")}catch{XCTAssertEqual(error.localizedDescription,"fixture failure")}
        XCTAssertTrue(registry.terminating);registry.cancelQuit();XCTAssertFalse(registry.terminating)
    }
    func testReplyTimeoutCompletesOnceEvenWhenNativeCompletionArrivesLate() async throws {
        var reply:TaskBrowserCaptureReply<Int>?
        do {_ = try await withCheckedThrowingContinuation {(continuation:CheckedContinuation<Int,Error>) in reply=TaskBrowserCaptureReply(continuation,timeout:0.02)};XCTFail("Timeout ignored")}catch{}
        reply?.finish(.success(1));reply?.finish(.failure(CancellationError()))
    }
    func testPendingJournalRequiresARealReleasedWriterLockAndRejectsForeignMetadata()throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("friday-pending-test-"+UUID().uuidString);defer {try? FileManager.default.removeItem(at:root)}
        let store=try TaskBrowserArtifactStore(scope:"fixture",root:root),artifact=try store.prepare(page:"https://example.invalid/",recording:true)
        var lease:TaskBrowserRecordingLease?=try store.beginRecording(artifact);try Data([1,2,3]).write(to:store.url(artifact))
        XCTAssertTrue(store.interrupted().isEmpty);XCTAssertThrowsError(try TaskBrowserRecordingLease(folder:store.url(artifact).deletingLastPathComponent()))
        withExtendedLifetime(lease) {};lease=nil;XCTAssertEqual(store.interrupted(),[artifact])
        let pending=try store.url(artifact).deletingLastPathComponent().appendingPathComponent("pending.json")
        let forged=TaskBrowserArtifact(id:UUID().uuidString.lowercased(),name:"outside.mp4",recording:true,createdAt:Date())
        try JSONEncoder().encode(forged).write(to:pending);XCTAssertTrue(store.interrupted().isEmpty)
    }
    func testInvalidInterruptedMediaIsKeptForManualExportAndNeverCommittedAsRecovered() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("friday-invalid-recording-"+UUID().uuidString);defer {try? FileManager.default.removeItem(at:root)}
        let store=try TaskBrowserArtifactStore(scope:"fixture",root:root),artifact=try store.prepare(page:"https://fixture.invalid/",recording:true)
        var lease:TaskBrowserRecordingLease?=try store.beginRecording(artifact);let bytes=Data("incomplete media fixture".utf8);try bytes.write(to:store.url(artifact));withExtendedLifetime(lease) {};lease=nil
        do {_=try await TaskBrowserRecordingRecovery.recover(artifact,store:store);XCTFail("Invalid media was promoted as recovered")}catch{}
        XCTAssertEqual(try Data(contentsOf:store.url(artifact)),bytes);XCTAssertEqual(store.interrupted(),[artifact]);XCTAssertTrue(store.recent().isEmpty)
    }
}
