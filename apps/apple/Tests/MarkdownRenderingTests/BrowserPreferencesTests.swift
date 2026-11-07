import XCTest
import WebKit
@testable import FridayKit

final class BrowserPreferencesTests:XCTestCase {
    @MainActor func testProfileResolutionExecutesTheSamePinnedT3CasesAndMigratesOldNames()throws {
        struct Fixture:Decodable {struct Entry:Decodable {let user:[TaskBrowserProfile];let expected:[TaskBrowserProfile]};let cases:[Entry]}
        var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()}
        let fixture=try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:root.appendingPathComponent("server/test/fixtures/t3-browser-profiles.json")))
        XCTAssertEqual(fixture.cases.count,6);for entry in fixture.cases {XCTAssertEqual(TaskBrowserProfile.resolve(entry.user),entry.expected)}
        let legacy=try JSONDecoder().decode(TaskBrowserProfile.self,from:Data(#"{"id":"legacy","name":"Legacy"}"#.utf8));XCTAssertEqual(TaskBrowserProfile.resolve([legacy]).last?.kind,"persistent")
        XCTAssertFalse(TaskBrowserProfile.validID("one\ntwo"));XCTAssertFalse(TaskBrowserProfile.validID(" one"));XCTAssertTrue(TaskBrowserProfile.validID("配置一"))
    }
    @MainActor func testProfileLimitNamesAndDefaultSurviveCodingAndUseDefaultsOnlyForNewTabs()throws {
        let preferences=TaskBrowserPreferences(server:"fixture-"+UUID().uuidString,profiles:[],defaults:TaskBrowserDefaults(),persist:false)
        for _ in 0..<24 {XCTAssertNotNil(preferences.create("Work"))};XCTAssertNil(preferences.create());XCTAssertEqual(Set(preferences.userProfiles.map(\.name)).count,24)
        let profile=preferences.userProfiles[0];preferences.rename(profile.id,to:"  "+String(repeating:"😀",count:40));XCTAssertEqual(preferences.userProfiles[0].name.utf16.count,48)
        preferences.rename("default",to:"changed");XCTAssertEqual(preferences.profiles[0].name,"Default")
        var value=TaskBrowserDefaults();value.profile=profile.id;value.zoom=1.5;value.appearance="dark";value.width=390;value.height=844;value.mobile=true;preferences.update(value)
        var panel=TaskBrowserPanelState();let first=panel.open("http://localhost:3000/",defaults:preferences.defaults);XCTAssertEqual(first.profile,profile.id);XCTAssertEqual(first.zoom,1.5);XCTAssertEqual(first.viewportWidth,390)
        value.zoom=2;preferences.update(value);_ = panel.open(defaults:preferences.defaults);XCTAssertEqual(panel.tabs[0],first);XCTAssertEqual(panel.tabs[1].zoom,2)
        let restored=try JSONDecoder().decode(TaskBrowserDefaults.self,from:JSONEncoder().encode(preferences.defaults));XCTAssertEqual(restored,preferences.defaults)
        XCTAssertTrue(panel.open(profile:"incognito",defaults:preferences.defaults).incognito)
    }
    @MainActor func testRemovalKeepsMetadataAndDefaultUntilAllDataClearsAndFailuresCanRetry()async throws {
        let preferences=TaskBrowserPreferences(server:"fixture-"+UUID().uuidString,profiles:[],defaults:TaskBrowserDefaults(),persist:false),profile=try XCTUnwrap(preferences.create("Work"));var value=preferences.defaults;value.profile=profile.id;preferences.update(value)
        do {try await preferences.remove(profile.id){throw ConnectionError.message("fixture")};XCTFail()}catch{}
        XCTAssertTrue(preferences.profiles.contains(profile));XCTAssertEqual(preferences.defaults.profile,profile.id);XCTAssertFalse(preferences.busy)
        try await preferences.remove(profile.id){XCTAssertTrue(preferences.busy);XCTAssertNil(preferences.create("blocked"));XCTAssertTrue(preferences.profiles.contains(profile))}
        XCTAssertFalse(preferences.profiles.contains(profile));XCTAssertEqual(preferences.defaults.profile,"default")
    }
    func testCookieAndCacheClearMatchTheT3StorageBoundaries() {
        XCTAssertEqual(TaskBrowserWebsiteData.cookies,[WKWebsiteDataTypeCookies,WKWebsiteDataTypeLocalStorage,WKWebsiteDataTypeIndexedDBDatabases,WKWebsiteDataTypeServiceWorkerRegistrations]);XCTAssertEqual(TaskBrowserWebsiteData.cache,[WKWebsiteDataTypeDiskCache,WKWebsiteDataTypeMemoryCache])
    }
}
@MainActor private final class NativeControlFixture:NSObject {
    var bits:UInt=6;var playing=true;let inspector=InspectorFixture()
    @objc(_mediaMutedState) func mutedState()->UInt {bits}
    @objc(_setPageMuted:) func setMuted(_ value:UInt) {bits=value}
    @objc(_isPlayingAudio) func isPlaying()->Bool {playing}
    @objc(_inspector) func getInspector()->NSObject {inspector}
}
@MainActor private final class InspectorFixture:NSObject {
    var opened=0;var closed=0
    @objc func show(){opened+=1}
    @objc func close(){closed+=1}
}
@MainActor private final class WrongControlFixture:NSObject {
    @objc(_mediaMutedState) func mutedState()->NSString {"wrong"}
    @objc(_setPageMuted:) func setMuted(_ value:NSString) {}
}
final class BrowserNativeControlsTests:XCTestCase {
    @MainActor func testPageMutePreservesCaptureBitsAndUsesTheNativeAudibilityGetter() {
        let fixture=NativeControlFixture();XCTAssertTrue(TaskBrowserNativeControls.canMute(fixture));XCTAssertEqual(TaskBrowserNativeControls.playing(fixture),true)
        XCTAssertTrue(TaskBrowserNativeControls.mute(fixture,true));XCTAssertEqual(fixture.bits,7);XCTAssertTrue(TaskBrowserNativeControls.mute(fixture,false));XCTAssertEqual(fixture.bits,6)
        fixture.playing=false;XCTAssertEqual(TaskBrowserNativeControls.playing(fixture),false)
    }
    @MainActor func testInspectorUsesTheOwnedWebKitInspectorAndRejectsMissingOrChangedABIs() {
        let fixture=NativeControlFixture();XCTAssertTrue(TaskBrowserNativeControls.inspect(fixture,show:true));XCTAssertTrue(TaskBrowserNativeControls.inspect(fixture,show:false));XCTAssertEqual(fixture.inspector.opened,1);XCTAssertEqual(fixture.inspector.closed,1)
        XCTAssertFalse(TaskBrowserNativeControls.mute(WrongControlFixture(),true));XCTAssertFalse(TaskBrowserNativeControls.canMute(WrongControlFixture()));XCTAssertFalse(TaskBrowserNativeControls.inspect(NSObject(),show:true));XCTAssertNil(TaskBrowserNativeControls.playing(NSObject()))
    }
}
