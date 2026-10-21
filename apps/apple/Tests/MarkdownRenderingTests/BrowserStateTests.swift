import XCTest
@testable import FridayKit

final class BrowserStateTests:XCTestCase {
    func testPanelPersistenceRetainsTabOrderAndPreferencesButDropsPrivatePages() throws {
        var state=TaskBrowserPanelState()
        let first=state.open("http://localhost:3000/a"),second=state.open("https://example.com/",profile:"work")
        let privateTab=state.open("https://private.example/secret",profile:"incognito",incognito:true)
        state.move(second.id,before:first.id)
        state.tabs[0].zoom=1.5;state.tabs[0].appearance="dark";state.tabs[0].viewportWidth=390;state.tabs[0].viewportHeight=844
        let data=try JSONEncoder().encode(state.persisted),restored=try JSONDecoder().decode(TaskBrowserPanelState.self,from:data)
        XCTAssertEqual(restored.tabs.map(\.id),[second.id,first.id]);XCTAssertFalse(String(decoding:data,as:UTF8.self).contains("private.example"));XCTAssertNotEqual(restored.selected,privateTab.id)
        XCTAssertEqual(restored.tabs[0].zoom,1.5);XCTAssertEqual(restored.tabs[0].viewportHeight,844);XCTAssertEqual(restored.tabs[0].profile,"work")
        let legacy=try JSONDecoder().decode(TaskPanelPreferences.self,from:Data(#"{"width":460,"activePanel":"files"}"#.utf8));XCTAssertNil(legacy.browser);XCTAssertEqual(legacy.activePanel,"files")
    }
    func testClosingTabsRetainsAdjacentSelectionAndReopeningCreatesANewNavigationIdentity() {
        var state=TaskBrowserPanelState();let first=state.open("https://one.example/"),second=state.open("https://two.example/"),third=state.open("https://three.example/")
        state.selected=second.id;state.close(second.id);XCTAssertEqual(state.selected,third.id)
        state.reopen();XCTAssertEqual(state.current?.url,second.url);XCTAssertNotEqual(state.current?.id,second.id);XCTAssertNotEqual(state.current?.navigationID,second.navigationID)
        let privateTab=state.open("https://private.example/",incognito:true);state.close(privateTab.id)
        XCTAssertFalse(state.closed?.contains(where:{$0.incognito}) ?? true)
        state.close(first.id);XCTAssertFalse(state.tabs.contains(where:{$0.id==first.id}))
    }
    func testRestoreValidatesUnsafeURLsAndUnboundedSizesWithoutDroppingValidBrowserTabs() {
        var state=TaskBrowserPanelState();state.open("file:///etc/passwd");state.open("javascript:alert(1)");state.open("https://example.com/")
        state.tabs[2].zoom = .infinity;state.tabs[2].viewportWidth=90000;state.tabs[2].viewportHeight=90000;state.tabs[2].appearance="other"
        state.validate();XCTAssertEqual(state.tabs.count,1);XCTAssertEqual(state.current?.zoom,1);XCTAssertEqual(state.current?.appearance,"system")
        XCTAssertEqual(state.current?.viewportWidth,3840);XCTAssertEqual(state.current?.viewportHeight,2160)
        for index in 0..<105 {state.open("https://example.com/\(index)")};state.validate();XCTAssertEqual(state.tabs.count,106)
    }
    func testHistoryRemovesCredentialsAndCoalescesLocalInterfacesWithoutLosingPageFragments() {
        XCTAssertEqual(TaskBrowserPolicy.historyURL("https://user:secret@example.com/a#x"),"https://example.com/a#x")
        XCTAssertEqual(TaskBrowserPolicy.historyKey("http://localhost:3000/a#x"),TaskBrowserPolicy.historyKey("http://127.0.0.1:3000/a#x"))
        XCTAssertEqual(TaskBrowserPolicy.historyKey("http://[::1]:3000/a#x"),TaskBrowserPolicy.historyKey("http://0.0.0.0:3000/a#x"))
        XCTAssertNotEqual(TaskBrowserPolicy.historyKey("https://example.com/a#x"),TaskBrowserPolicy.historyKey("https://example.com/a#y"))
        XCTAssertNil(TaskBrowserPolicy.historyURL("file:///tmp/a"));XCTAssertNil(TaskBrowserPolicy.url("https://example.com/"+String(repeating:"x",count:2048)))
    }
    func testLocalTargetsNeverResolveToTheRemoteClientsLoopbackAndZoomMatchesT3Levels() throws {
        let localhost=try XCTUnwrap(URL(string:"http://localhost:3000/")),publicPage=try XCTUnwrap(URL(string:"https://example.com/"))
        XCTAssertFalse(TaskBrowserPolicy.canOpen(localhost,server:"https://my-mac.example.ts.net"));XCTAssertTrue(TaskBrowserPolicy.canOpen(publicPage,server:"https://my-mac.example.ts.net"))
        #if os(macOS)
        XCTAssertTrue(TaskBrowserPolicy.canOpen(localhost,server:"http://127.0.0.1:14317"))
        #endif
        XCTAssertEqual(TaskBrowserPolicy.zoom(1,increase:true),1.1);XCTAssertEqual(TaskBrowserPolicy.zoom(1,increase:false),0.9);XCTAssertEqual(TaskBrowserPolicy.zoom(5,increase:true),5);XCTAssertEqual(TaskBrowserPolicy.zoom(0.25,increase:false),0.25)
        XCTAssertEqual(TaskBrowserViewportPreset.all.count,17);XCTAssertEqual(TaskBrowserViewportPreset.all.first?.label,"iPhone SE")
    }
    func testDownloadsKeepTheOriginalUntilTheCompletedTemporaryFileCanBeInstalled() throws {
        let directory=FileManager.default.temporaryDirectory.appendingPathComponent("browser-download-test-"+UUID().uuidString,isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true);defer {try? FileManager.default.removeItem(at:directory)}
        let old=directory.appendingPathComponent("saved.txt"),new=directory.appendingPathComponent("incoming.txt")
        try Data("old".utf8).write(to:old);try Data("new".utf8).write(to:new)
        XCTAssertThrowsError(try TaskBrowserDownloadFiles.install(directory.appendingPathComponent("missing"),to:old));XCTAssertEqual(try String(contentsOf:old,encoding:.utf8),"old")
        try TaskBrowserDownloadFiles.install(new,to:old);XCTAssertEqual(try String(contentsOf:old,encoding:.utf8),"new")
        XCTAssertThrowsError(try TaskBrowserDownloadFiles.install(new,to:directory));XCTAssertTrue(FileManager.default.fileExists(atPath:new.path))
        XCTAssertEqual(TaskBrowserDownloadFiles.name("../../file.txt"),"file.txt");XCTAssertEqual(TaskBrowserDownloadFiles.name(".."),"download");XCTAssertEqual(TaskBrowserDownloadFiles.name("folder\\file.txt"),"file.txt")
        XCTAssertLessThan(TaskBrowserDownloadFiles.name(String(repeating:"🙂",count:500)).utf8.count,255)
    }
    func testViewportDragUsesTheDisplayedScaleAndKeepsT3DimensionAndAreaBounds() {
        let resized=TaskBrowserPolicy.resized(width:390,height:844,dx:20,dy:0,scale:0.5,axis:.width);XCTAssertEqual(resized.width,430);XCTAssertEqual(resized.height,844)
        let bounded=TaskBrowserPolicy.resized(width:300,height:3840,dx:9000,dy:0,scale:1,axis:.width);XCTAssertEqual(bounded.width,2160);XCTAssertEqual(bounded.height,3840)
        let minimum=TaskBrowserPolicy.resized(width:390,height:844,dx:-9000,dy:-9000,scale:1,axis:.both);XCTAssertEqual(minimum.width,240);XCTAssertEqual(minimum.height,240)
        let invalid=TaskBrowserPolicy.resized(width:390,height:844,dx:.infinity,dy:.nan,scale:0,axis:.both);XCTAssertEqual(invalid.width,390);XCTAssertEqual(invalid.height,844)
    }
    func testHiddenBrowserLifetimesAreReconciledByTaskConnectionAndOwningWindow() {
        let owner=UUID(),other=UUID(),connection="https://host.example\nowner-token"
        let key=TaskBrowserSessionScope.value(owner:owner,connection:connection,task:"task")+"\ntab"
        XCTAssertFalse(TaskBrowserSessionScope.obsolete(key,owner:owner,connection:connection,taskIDs:["task"]))
        XCTAssertTrue(TaskBrowserSessionScope.obsolete(key,owner:owner,connection:connection,taskIDs:[]))
        XCTAssertTrue(TaskBrowserSessionScope.obsolete(key,owner:owner,connection:connection+"-rotated",taskIDs:nil))
        XCTAssertFalse(TaskBrowserSessionScope.obsolete(key,owner:other,connection:connection+"-rotated",taskIDs:[]))
        XCTAssertNotEqual(TaskBrowserSessionScope.value(owner:owner,connection:connection,task:"task"),TaskBrowserSessionScope.value(owner:other,connection:connection,task:"task"))
    }
    @MainActor func testProjectHistoryUsesT3LimitsAndNeverRetainsHTTPPasswords() async {
        let history=TaskBrowserHistory.shared,server="browser-history-test-"+UUID().uuidString
        defer {history.clear(server:server,project:"project");for index in 0..<21 {history.clear(server:server,project:"p\(index)")}}
        for index in 0..<60 {history.record(server:server,project:"project",url:"https://user:password@example.com/\(index)",title:"Page \(index)")}
        let visits=history.visits(server:server,project:"project");XCTAssertEqual(visits.count,50);XCTAssertEqual(visits.first?.url,"https://example.com/59");XCTAssertFalse(visits.contains(where:{$0.url.contains("password")}))
        history.record(server:server,project:"project",url:"http://localhost:3000/a#x",title:"Local")
        history.record(server:server,project:"project",url:"http://127.0.0.1:3000/a#x",title:"Local again")
        XCTAssertEqual(history.visits(server:server,project:"project").filter{$0.url.contains(":3000")}.count,1)
        for index in 0..<21 {history.record(server:server,project:"p\(index)",url:"https://example.com/\(index)",title:nil)}
        XCTAssertTrue(history.visits(server:server,project:"p0").isEmpty);XCTAssertEqual(history.visits(server:server,project:"p20").count,1)
    }
}
