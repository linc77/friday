#if os(macOS)
import XCTest
import SQLite3
import WebKit
@testable import FridayKit

private final class CookieImportCounter:@unchecked Sendable {
    private let lock=NSLock();private var value=0
    func add(){lock.lock();value+=1;lock.unlock()}
    var count:Int {lock.lock();defer{lock.unlock()};return value}
}
private final class CookieFixtureDB {
    let url:URL;var db:OpaquePointer?
    init(_ url:URL)throws {self.url=url;try FileManager.default.createDirectory(at:url.deletingLastPathComponent(),withIntermediateDirectories:true);guard sqlite3_open(url.path,&db)==SQLITE_OK else{throw TaskBrowserImportFailure.readFailed}}
    deinit {sqlite3_close(db)}
    func exec(_ sql:String)throws {guard sqlite3_exec(db,sql,nil,nil,nil)==SQLITE_OK else{throw TaskBrowserImportFailure.readFailed}}
}
final class BrowserCookieImportTests:XCTestCase {
    struct Fixture:Decodable {
        struct Derivation:Decodable {let secret:String;let key:String}
        struct Crypto:Decodable {let data:String;let key:String;let host:String;let version:Int;let expected:String?}
        struct Safari:Decodable {let data:String;let expected:[TaskBrowserImportedCookie]?;let fails:Bool?}
        struct Firefox:Decodable {let ini:String;let root:String;let expected:[Profile]}
        struct Profile:Decodable {let directory:String;let name:String}
        let synthetic:Bool;let derivation:Derivation;let crypto:[Crypto];let safari:[Safari];let firefoxProfiles:[Firefox]
    }
    private func fixture()throws->Fixture {var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()};return try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:root.appendingPathComponent("server/test/fixtures/t3-cookie-import.json")))}
    private func temporary()throws->URL {let root=FileManager.default.temporaryDirectory.appendingPathComponent("FridayCookieTests-"+UUID().uuidString);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true);return root}
    func testMacOSCryptoAndDomainBindingMatchThirtyExecutionsOfThePinnedT3Reader()throws {
        let fixture=try fixture();XCTAssertTrue(fixture.synthetic);XCTAssertEqual(fixture.crypto.count,30)
        XCTAssertEqual(try TaskBrowserCookieCrypto.derive(Data(fixture.derivation.secret.utf8)),Data(base64Encoded:fixture.derivation.key))
        for (index,value) in fixture.crypto.enumerated() {XCTAssertEqual(TaskBrowserCookieCrypto.decrypt(try XCTUnwrap(Data(base64Encoded:value.data)),key:try XCTUnwrap(Data(base64Encoded:value.key)),host:value.host,version:value.version),value.expected,"case \(index)")}
    }
    func testSafariCookiesMatchPinnedScopeAndMalformedPageBounds()throws {
        let fixture=try fixture();XCTAssertEqual(fixture.safari.count,15)
        for value in fixture.safari {let data=try XCTUnwrap(Data(base64Encoded:value.data));if value.fails==true {XCTAssertThrowsError(try TaskBrowserCookieDatabases.safari(data))}else{XCTAssertEqual(try TaskBrowserCookieDatabases.safari(data).cookies,value.expected)}}
    }
    func testFirefoxMetadataPathsMatchThePinnedReaderAndNeverAcceptAnUnreportedTraversal()throws {
        let fixture=try fixture();for value in fixture.firefoxProfiles {let actual=TaskBrowserCookieImporter.firefoxProfiles(value.ini,root:URL(fileURLWithPath:value.root));XCTAssertEqual(actual.map(\.directory),value.expected.map(\.directory));XCTAssertEqual(actual.map(\.name),value.expected.map(\.name))}
    }
    func testSQLiteBackupIncludesCommittedWALAndChromiumSkipsPartitionsWithoutChangingSourceOrKeepingTempCopies()async throws {
        let root=try temporary();defer{try? FileManager.default.removeItem(at:root)};let definitions=TaskBrowserImportDefinition.all,chrome=try XCTUnwrap(definitions.first {$0.id=="chrome"}),directory=chrome.root(home:root),path=directory.appendingPathComponent("Default/Network/Cookies")
        let db=try CookieFixtureDB(path),counter=CookieImportCounter(),fixture=try fixture(),payload=try XCTUnwrap(fixture.crypto.first {$0.version==24 && $0.host==".fixture.invalid" && $0.expected=="hello"})
        try db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('version','24');CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT);")
        let encrypted=try XCTUnwrap(Data(base64Encoded:payload.data)).map {String(format:"%02x",$0)}.joined()
        try db.exec("INSERT INTO cookies VALUES('.fixture.invalid','session','',X'\(encrypted)','/path',13300000000000000,1,1,2,'');INSERT INTO cookies VALUES('other.fixture.invalid','partitioned','synthetic',X'','/',0,0,0,-1,'https://partition.invalid');")
        try Data(#"{"profile":{"info_cache":{"Default":{"name":"Synthetic profile"},"../../bad":{"name":"escape"}}}}"#.utf8).write(to:directory.appendingPathComponent("Local State"))
        let snapshots=root.appendingPathComponent("snapshots");try FileManager.default.createDirectory(at:snapshots,withIntermediateDirectories:true)
        let importer=TaskBrowserCookieImporter(home:root,temporary:snapshots,running:{_,_ in false},key:{_ in counter.add();return Data(fixture.derivation.secret.utf8)})
        let sources=await importer.sources();XCTAssertEqual(sources.first {$0.id=="chrome"}?.profiles.map(\.directory),["Default"]);XCTAssertEqual(counter.count,0)
        do {_ = try await importer.read(sourceID:"chrome",profileDirectory:"../../bad");XCTFail()}catch {XCTAssertEqual(error as? TaskBrowserImportFailure,.unknownSourceProfile)};XCTAssertEqual(counter.count,0)
        let manual=root.appendingPathComponent("manual.sqlite");try TaskBrowserCookieSQL(path).snapshot(to:manual)
        let checked=try TaskBrowserCookieDatabases.chromium(TaskBrowserCookieSQL(manual),key:try XCTUnwrap(Data(base64Encoded:fixture.derivation.key)));XCTAssertEqual(checked.cookies.count,1)
        let batch:TaskBrowserCookieReadBatch
        do {batch=try await importer.read(sourceID:"chrome",profileDirectory:"Default")}catch {XCTFail("Synthetic importer failed after \(counter.count) key calls: \(error)");return}
        XCTAssertEqual(counter.count,1);XCTAssertEqual(batch.cookies.count,1);XCTAssertEqual(batch.cookies[0].value,"hello");XCTAssertEqual(batch.cookies[0].domain,".fixture.invalid");XCTAssertEqual(batch.cookies[0].sameSite,"strict");XCTAssertEqual(batch.skipped,1);XCTAssertEqual(batch.skippedDomains,["other.fixture.invalid"])
        XCTAssertEqual(try TaskBrowserCookieSQL(path).query("SELECT count(*) AS count FROM cookies").first?["count"]?.number,2);XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath:snapshots.path).isEmpty)
    }
    func testFirefoxSchemaUnitsSameSiteAndContainerSeparationAndRunningSourceRejectsBeforeKeyAccess()async throws {
        let root=try temporary();defer{try? FileManager.default.removeItem(at:root)}
        for version in [9,12,16] {
            let db=try CookieFixtureDB(root.appendingPathComponent("\(version).sqlite"));try db.exec("PRAGMA user_version=\(version);CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,rawSameSite INTEGER,originAttributes TEXT);INSERT INTO moz_cookies VALUES('fixture.invalid','normal','synthetic','/',\(version>=16 ? 1800000000000:1800000000),1,1,1,0,'');INSERT INTO moz_cookies VALUES('fixture.invalid','container','private','/',0,0,0,0,0,'^userContextId=2');")
            let result=try TaskBrowserCookieDatabases.firefox(TaskBrowserCookieSQL(db.url));XCTAssertEqual(result.cookies.count,1);XCTAssertEqual(result.cookies[0].expirationDate,1800000000);XCTAssertEqual(result.cookies[0].domain,nil);XCTAssertEqual(result.cookies[0].sameSite,version==12 ? "unspecified":"lax")
        }
        let chrome=TaskBrowserImportDefinition.all.first {$0.id=="chrome"}!,counter=CookieImportCounter(),profile=chrome.root(home:root).appendingPathComponent("Default",isDirectory:true);try FileManager.default.createDirectory(at:profile,withIntermediateDirectories:true);try Data().write(to:profile.appendingPathComponent("Cookies"))
        let importer=TaskBrowserCookieImporter(home:root,running:{_,_ in true},key:{_ in counter.add();return Data()})
        do {_ = try await importer.read(sourceID:"chrome",profileDirectory:"Default");XCTFail()}catch {XCTAssertEqual(error as? TaskBrowserImportFailure,.browserRunning)};XCTAssertEqual(counter.count,0)
    }
    func testSourceLocksIgnoreStaleOwnersAndDoNotTreatFirefoxParentLockFilesAsRunning()throws {
        XCTAssertFalse(TaskBrowserImportProcesses.chromiumLock("fixture-host-42",host:"fixture-host",alive:{_ in false}));XCTAssertTrue(TaskBrowserImportProcesses.chromiumLock("other-host-42",host:"fixture-host",alive:{_ in false}));XCTAssertTrue(TaskBrowserImportProcesses.chromiumLock("invalid",host:"fixture-host",alive:{_ in false}))
        XCTAssertFalse(TaskBrowserImportProcesses.firefoxLock("127.0.0.1:+42",addresses:["127.0.0.1"],alive:{_ in false}));XCTAssertTrue(TaskBrowserImportProcesses.firefoxLock("192.0.2.1:42",addresses:["127.0.0.1"],alive:{_ in false}))
        let root=try temporary();defer{try? FileManager.default.removeItem(at:root)};let lock=root.appendingPathComponent(".parentlock");try Data().write(to:lock);XCTAssertFalse(TaskBrowserImportProcesses.posixLock(lock.path))
    }

}

@MainActor private final class CookieSinkFixture:TaskBrowserCookieSink {
    var values:[HTTPCookie]=[];var flushes=0
    func set(_ cookie:HTTPCookie)async throws {if cookie.name=="reject" {throw TaskBrowserImportFailure.readFailed};values.append(cookie)}
    func flush()async->Bool {flushes+=1;return true}
}
final class BrowserCookieWriterTests:XCTestCase {
    @MainActor func testCookiePropertiesKeepHostOnlyDomainHttpOnlySameSiteExpiryAndPrefixRules()throws {
        let expiry=floor(Date().timeIntervalSince1970)+3600,source=TaskBrowserImportedCookie.make(host:"fixture.invalid",name:"__Host-session",value:"synthetic",path:"/",secure:true,httpOnly:true,expires:expiry,sameSite:"strict"),cookie=try XCTUnwrap(TaskBrowserCookieWriter.cookie(source))
        XCTAssertEqual(cookie.domain,"fixture.invalid");XCTAssertTrue(cookie.isHTTPOnly);XCTAssertTrue(cookie.isSecure);XCTAssertEqual(cookie.path,"/");XCTAssertEqual(cookie.expiresDate?.timeIntervalSince1970,expiry);XCTAssertEqual((cookie.properties?[.sameSitePolicy] as? String)?.lowercased(),"strict")
        let domain=TaskBrowserImportedCookie.make(host:".fixture.invalid",name:"domain",value:"synthetic",path:"/path",secure:true,httpOnly:false,expires:nil,sameSite:"unspecified"),domainCookie=try XCTUnwrap(TaskBrowserCookieWriter.cookie(domain));XCTAssertEqual(domainCookie.domain,".fixture.invalid");XCTAssertNil(domainCookie.expiresDate);XCTAssertNil(domainCookie.properties?[.sameSitePolicy])
        XCTAssertNil(TaskBrowserCookieWriter.cookie(.make(host:".fixture.invalid",name:"__Host-session",value:"synthetic",path:"/",secure:true,httpOnly:false,expires:nil,sameSite:"lax")))
    }
    @MainActor func testIndividualRejectedCookiesDoNotAbortOthersAndDiskFlushFollowsTheWrites()async {
        let sink=CookieSinkFixture();var batch=TaskBrowserCookieReadBatch();batch.skip(".partition.invalid")
        for name in ["ok","reject","bad\nname"] {batch.cookies.append(.make(host:"fixture.invalid",name:name,value:"synthetic",path:"/",secure:true,httpOnly:false,expires:nil,sameSite:"lax"))}
        let result=await TaskBrowserCookieWriter.write(batch,to:sink);XCTAssertEqual(result.imported,1);XCTAssertEqual(result.skipped,3);XCTAssertEqual(result.skippedDomains,["partition.invalid","fixture.invalid"]);XCTAssertTrue(result.persisted);XCTAssertEqual(sink.flushes,1)
    }
    @MainActor func testNewProfilesArePublishedOnlyAfterImportsAndReservationOwnershipCannotUnlockAnotherOperation()async throws {
        let preferences=TaskBrowserPreferences(server:"fixture",profiles:[],defaults:TaskBrowserDefaults(),persist:false)
        let first=try preferences.reserveImport(existing:nil,name:"Chrome");XCTAssertTrue(preferences.busy);XCTAssertFalse(preferences.profiles.contains(first.profile));XCTAssertThrowsError(try preferences.reserveImport(existing:"default",name:""));try preferences.finishImport(first,imported:2);XCTAssertTrue(preferences.profiles.contains(first.profile))
        let second=try preferences.reserveImport(existing:nil,name:"Chrome");preferences.cancelImport(first);XCTAssertTrue(preferences.busy);XCTAssertEqual(second.profile.name,"Chrome 2");try preferences.finishImport(second,imported:0);XCTAssertFalse(preferences.profiles.contains(second.profile));XCTAssertFalse(preferences.busy)
    }
    @MainActor func testWebKitCookieStoreReceivesSyntheticHostOnlyAndHttpOnlyCookiesWithoutOpeningAWebView()async throws {
        let store=WKWebsiteDataStore.nonPersistent(),source=TaskBrowserImportedCookie.make(host:"fixture.invalid",name:"__Host-cookie-import-test",value:"synthetic",path:"/",secure:true,httpOnly:true,expires:nil,sameSite:"strict"),cookie=try XCTUnwrap(TaskBrowserCookieWriter.cookie(source))
        let set=expectation(description:"set synthetic cookie");store.httpCookieStore.setCookie(cookie){set.fulfill()};await fulfillment(of:[set],timeout:10)
        let get=expectation(description:"read synthetic cookie");store.httpCookieStore.getAllCookies {cookies in
            let imported=cookies.first {$0.name==source.name};XCTAssertNotNil(imported);XCTAssertEqual(imported?.domain,"fixture.invalid");XCTAssertEqual(imported?.value,"synthetic");XCTAssertEqual(imported?.isHTTPOnly,true);XCTAssertEqual(imported?.isSecure,true);get.fulfill()
        };await fulfillment(of:[get],timeout:10)
    }
    @MainActor func testWizardFreezesDestinationAndCleansAnUnregisteredNewTargetWhenNoCookieCanBeWritten()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("FridayCookieWizard-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root)}
        let firefox=TaskBrowserImportDefinition.all.first {$0.id=="firefox"}!,base=firefox.root(home:root),db=try CookieFixtureDB(base.appendingPathComponent("Profiles/p/cookies.sqlite"))
        try db.exec("PRAGMA user_version=16;CREATE TABLE moz_cookies(host TEXT,name TEXT,value TEXT,path TEXT,expiry INTEGER,isSecure INTEGER,isHttpOnly INTEGER,sameSite INTEGER,originAttributes TEXT);INSERT INTO moz_cookies VALUES('fixture.invalid','normal','synthetic','/',0,1,1,2,'');")
        try Data("[Profile0]\nName=Fixture\nPath=Profiles/p\n".utf8).write(to:base.appendingPathComponent("profiles.ini"))
        let counter=CookieImportCounter(),importer=TaskBrowserCookieImporter(home:root,running:{_,_ in false},key:{_ in counter.add();throw TaskBrowserImportFailure.keychainUnavailable})
        let preferences=TaskBrowserPreferences(server:"fixture",profiles:[],defaults:TaskBrowserDefaults(),persist:false);var destinations:[String]=[],cleared:[String]=[]
        let model=TaskBrowserCookieImportModel(importer:importer,write:{batch,scope,id in XCTAssertEqual(batch.cookies.count,1);XCTAssertEqual(scope,"frozen-service");destinations.append(id);return .init(imported:1,skipped:0,skippedDomains:[],persisted:true)},clear:{_,id in cleared.append(id)})
        XCTAssertTrue(model.sources.isEmpty);XCTAssertEqual(counter.count,0);await model.reload();await model.run(source:"firefox",directory:"Profiles/p",existing:nil,preferences:preferences,scope:"frozen-service")
        XCTAssertEqual(preferences.userProfiles.map(\.id),destinations);XCTAssertEqual(preferences.userProfiles.first?.name,"Firefox");XCTAssertEqual(model.result?.imported,1);XCTAssertTrue(cleared.isEmpty);XCTAssertFalse(model.busy);XCTAssertFalse(preferences.busy);XCTAssertEqual(counter.count,0)
        let zero=TaskBrowserCookieImportModel(importer:importer,write:{_,_,id in destinations.append(id);return .init(imported:0,skipped:1,skippedDomains:["fixture.invalid"],persisted:true)},clear:{scope,id in XCTAssertEqual(scope,"frozen-service");cleared.append(id)})
        await zero.reload();await zero.run(source:"firefox",directory:"Profiles/p",existing:nil,preferences:preferences,scope:"frozen-service");XCTAssertEqual(preferences.userProfiles.count,1);XCTAssertEqual(cleared,[destinations.last!]);XCTAssertFalse(preferences.busy)
    }
    @MainActor func testKeychainDenialCannotWriteCookiesPublishAProfileOrUnlockAnotherReservation()async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("FridayCookieDenied-"+UUID().uuidString);defer{try? FileManager.default.removeItem(at:root)}
        let chrome=TaskBrowserImportDefinition.all.first {$0.id=="chrome"}!,db=try CookieFixtureDB(chrome.root(home:root).appendingPathComponent("Default/Cookies"))
        try db.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES('version','24');CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,path TEXT,expires_utc INTEGER,is_secure INTEGER,is_httponly INTEGER,samesite INTEGER,top_frame_site_key TEXT);")
        let counter=CookieImportCounter(),importer=TaskBrowserCookieImporter(home:root,running:{_,_ in false},key:{_ in counter.add();throw TaskBrowserImportFailure.needsKeychainApproval}),preferences=TaskBrowserPreferences(server:"fixture",profiles:[],defaults:TaskBrowserDefaults(),persist:false)
        var writes=0,clears=0;let model=TaskBrowserCookieImportModel(importer:importer,write:{_,_,_ in writes+=1;return .init(imported:0,skipped:0,skippedDomains:[],persisted:true)},clear:{_,_ in clears+=1})
        await model.reload();XCTAssertEqual(counter.count,0);await model.run(source:"chrome",directory:"Default",existing:nil,preferences:preferences,scope:"scope");XCTAssertEqual(model.failure,.needsKeychainApproval);XCTAssertEqual(counter.count,1);XCTAssertEqual(writes,0);XCTAssertEqual(clears,0);XCTAssertTrue(preferences.userProfiles.isEmpty);XCTAssertFalse(preferences.busy)
        let other=try preferences.reserveImport(existing:"default",name:"");await model.run(source:"chrome",directory:"Default",existing:nil,preferences:preferences,scope:"scope");XCTAssertTrue(preferences.busy);XCTAssertEqual(counter.count,1);preferences.cancelImport(other)
    }
}
@MainActor private final class CookieFlushFixture:NSObject {
    var calls=0
    @objc(_flushCookiesToDiskWithCompletionHandler:) func flush(_ completion:@escaping ()->Void) {calls+=1;completion()}
}
final class BrowserCookieFlushTests:XCTestCase {
    @MainActor func testDiskFlushUsesTheGuardedWebKitCallbackABI() {
        let fixture=CookieFlushFixture();var done=false;XCTAssertTrue(TaskBrowserNativeControls.flushCookies(fixture){done=true});XCTAssertTrue(done);XCTAssertEqual(fixture.calls,1);XCTAssertFalse(TaskBrowserNativeControls.flushCookies(NSObject()){})
    }
}
#endif
