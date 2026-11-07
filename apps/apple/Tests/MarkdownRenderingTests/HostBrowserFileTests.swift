import XCTest
@testable import FridayKit

final class HostBrowserFileTests:XCTestCase {
    struct Fixture:Decodable {struct Upload:Decodable {struct File:Decodable,Equatable {let name:String;let mimeType:String;let base64:String};let files:[File];let digest:String};let upload:Upload}
    private var root:URL {var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()};return root}
    private func fixture()throws->Fixture {try JSONDecoder().decode(Fixture.self,from:Data(contentsOf:root.appendingPathComponent("server/test/fixtures/t3-host-browser-transfers.json")))}
    private func directory()throws->URL {let value=FileManager.default.temporaryDirectory.appendingPathComponent("FridayHostFileTest-"+UUID().uuidString);try FileManager.default.createDirectory(at:value,withIntermediateDirectories:true);return value}
    private func files(_ fixture:Fixture,in directory:URL)throws->[URL] {try fixture.upload.files.map {file in let url=directory.appendingPathComponent(file.name);try Data(base64Encoded:file.base64)!.write(to:url);return url}}
    func testNativeMultipartBytesAndDigestMatchTheServiceUnicodeAndBinaryFixture()throws {
        let fixture=try fixture(),directory=try directory();defer{try? FileManager.default.removeItem(at:directory)}
        let urls=try files(fixture,in:directory),bundle=try TaskHostBrowserUploadBundle.build(urls,multiple:true);defer{bundle.remove()}
        XCTAssertEqual(bundle.digest,fixture.upload.digest);XCTAssertEqual(bundle.count,2);XCTAssertTrue(bundle.contentType.hasPrefix("multipart/form-data; boundary=Friday-"))
        let body=try Data(contentsOf:bundle.url);for file in fixture.upload.files {XCTAssertNotNil(body.range(of:Data(base64Encoded:file.base64)!))}
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath:bundle.url.path)[.posixPermissions] as? NSNumber)?.intValue,0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath:bundle.url.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)?.intValue,0o700)
    }
    func testUploadLimitsRejectOversizedSparseFilesAndTooManySelectionsWithoutReadingThem()throws {
        let directory=try directory();defer{try? FileManager.default.removeItem(at:directory)}
        let url=directory.appendingPathComponent("large.txt");FileManager.default.createFile(atPath:url.path,contents:Data());let handle=try FileHandle(forWritingTo:url);try handle.truncate(atOffset:UInt64(TaskHostBrowserUploadBundle.maximumBytes+1));try handle.close()
        XCTAssertThrowsError(try TaskHostBrowserUploadBundle.build([url],multiple:true));XCTAssertThrowsError(try TaskHostBrowserUploadBundle.build(Array(repeating:url,count:21),multiple:true));XCTAssertThrowsError(try TaskHostBrowserUploadBundle.build([url,url],multiple:false))
        let link=directory.appendingPathComponent("link.txt");try FileManager.default.createSymbolicLink(at:link,withDestinationURL:url);XCTAssertThrowsError(try TaskHostBrowserUploadBundle.build([link],multiple:false))
    }
    func testClipboardChunksPreserveUnicodeScalarBoundariesAndFileAcceptTypes() {
        let text=String(repeating:"a",count:8191)+"🙂中文"+String(repeating:"b",count:8193)
        let chunks=TaskHostBrowserClipboardText.chunks(text);XCTAssertEqual(chunks.joined(),text);XCTAssertTrue(chunks.allSatisfy{$0.utf16.count<=8192});XCTAssertFalse(chunks.joined().contains("�"))
        XCTAssertEqual(TaskHostBrowserUploadBundle.maximumFiles,20);XCTAssertEqual(TaskHostBrowserUploadBundle.maximumBytes,104857600)
        XCTAssertEqual(TaskHostBrowserUploadBundle.name("../文档.txt"),"文档.txt");XCTAssertEqual(TaskHostBrowserUploadBundle.name(".."),"download");XCTAssertTrue(TaskHostBrowserUploadBundle.name(String(repeating:"文🙂",count:100)).utf8.count<=240)
        XCTAssertEqual(TaskHostBrowserUploadBundle.types("image/*,.txt").count,2)
    }
    @MainActor func testNativeUploadAndDownloadRoundTripUseFrozenAuthAndCleanPrivateExportFiles()async throws {
        let directory=try directory();defer{try? FileManager.default.removeItem(at:directory)}
        let fixture=try fixture(),urls=try files(fixture,in:directory),bundle=try TaskHostBrowserUploadBundle.build(urls,multiple:true);defer{bundle.remove()}
        let payload=Data((0..<65536).map{UInt8($0%251)}),source=directory.appendingPathComponent("source.bin"),marker=directory.appendingPathComponent("ready.json");try payload.write(to:source)
        let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/env");process.arguments=["node","--import","tsx",root.appendingPathComponent("server/test/fixtures/host-browser-transfer.mjs").path,marker.path,source.path];process.currentDirectoryURL=root;process.environment=["PATH":ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin","LANG":"en_US.UTF-8"];process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice;try process.run();defer{if process.isRunning {process.terminate()};process.waitUntilExit()}
        for _ in 0..<200 {if FileManager.default.fileExists(atPath:marker.path) {break};if !process.isRunning {XCTFail("Host file fixture exited");return};try await Task.sleep(for:.milliseconds(10))}
        let ready=try JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as! [String:Any],port=ready["port"] as! Int
        let defaults=UserDefaults(suiteName:"friday-host-roundtrip")!;defer{defaults.removePersistentDomain(forName:"friday-host-roundtrip")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="http://127.0.0.1:\(port)";connection.token="synthetic-file-fixture"
        let transport=try TaskHostBrowserTransport(connection:connection);var request=try transport.request("upload",query:["digest":bundle.digest]);request.httpMethod="POST";request.setValue(bundle.contentType,forHTTPHeaderField:"Content-Type")
        let (data,response)=try await transport.session.upload(for:request,fromFile:bundle.url);XCTAssertEqual((response as? HTTPURLResponse)?.statusCode,200,String(decoding:data,as:UTF8.self))
        struct Reply:Decodable {let digest:String;let files:[Fixture.Upload.File]};let reply=try JSONDecoder().decode(Reply.self,from:data);XCTAssertEqual(reply.digest,fixture.upload.digest);XCTAssertEqual(reply.files,fixture.upload.files)
        let controller=TaskHostBrowserController(task:"task",tab:TaskBrowserTab(id:"tab",url:"http://localhost:3000/"),connection:connection)
        let state:[String:Any]=["taskId":"task","tabId":"tab","generation":"generation","revision":1,"url":"http://localhost:3000/","title":"Fixture","loading":false,"back":false,"forward":false,"settings":["width":1280,"height":800,"mobile":false,"zoom":1,"appearance":"system"],"controlGeneration":1,"popups":[],"downloads":[["id":"download","fileName":"下载🙂.bin","sizeBytes":payload.count,"status":"ready"]]]
        controller.acceptTransferReply(try JSONDecoder().decode(TaskHostBrowserSnapshot.self,from:JSONSerialization.data(withJSONObject:state)));let transfer=controller.fileTransfers;transfer.save(controller.state!.downloads![0])
        for _ in 0..<200 {if transfer.exported != nil || transfer.error != nil {break};try await Task.sleep(for:.milliseconds(10))}
        XCTAssertNil(transfer.error);let exported=try XCTUnwrap(transfer.exported);XCTAssertEqual(try Data(contentsOf:exported.url),payload);XCTAssertEqual(exported.url.lastPathComponent,"下载🙂.bin")
        transfer.finishExport(exported.id);XCTAssertFalse(FileManager.default.fileExists(atPath:exported.url.path));controller.dispose()
    }
    @MainActor func testOnlyAnExplicitCopyReplyWritesTheClientClipboardAndNoClipboardTextEntersSharedState()async throws {
        let directory=try directory();defer{try? FileManager.default.removeItem(at:directory)}
        let source=directory.appendingPathComponent("bytes"),marker=directory.appendingPathComponent("ready.json");try Data("synthetic".utf8).write(to:source)
        let process=Process();process.executableURL=URL(fileURLWithPath:"/usr/bin/env");process.arguments=["node","--import","tsx",root.appendingPathComponent("server/test/fixtures/host-browser-transfer.mjs").path,marker.path,source.path];process.currentDirectoryURL=root;process.environment=["PATH":ProcessInfo.processInfo.environment["PATH"] ?? "/opt/homebrew/bin:/usr/bin:/bin","LANG":"en_US.UTF-8"];process.standardOutput=FileHandle.nullDevice;process.standardError=FileHandle.nullDevice;try process.run();defer{if process.isRunning {process.terminate()};process.waitUntilExit()}
        for _ in 0..<200 {if FileManager.default.fileExists(atPath:marker.path) {break};try await Task.sleep(for:.milliseconds(10))}
        let port=(try JSONSerialization.jsonObject(with:Data(contentsOf:marker)) as! [String:Any])["port"] as! Int
        let defaults=UserDefaults(suiteName:"friday-host-clipboard-test")!;defer{defaults.removePersistentDomain(forName:"friday-host-clipboard-test")}
        let connection=Connection(defaults:defaults,environment:[:],development:false);connection.server="http://127.0.0.1:\(port)";connection.token="synthetic-file-fixture"
        let controller=TaskHostBrowserController(task:"task",tab:TaskBrowserTab(id:"tab",url:"http://localhost:3000/"),connection:connection);var copies:[String]=[];controller.clipboardSink={copies.append($0)};defer{controller.dispose()};controller.mount()
        for _ in 0..<200 {if controller.canOperate {break};try await Task.sleep(for:.milliseconds(10))};XCTAssertTrue(controller.canOperate)
        controller.send(["type":"edit","command":"copy"])
        for _ in 0..<200 {if !copies.isEmpty {break};try await Task.sleep(for:.milliseconds(10))};XCTAssertEqual(copies,["explicit synthetic copy"]);XCTAssertNil(controller.state?.clipboardText)
        let before=controller.state?.revision ?? 0;controller.send(["type":"text","text":"typed"])
        for _ in 0..<200 {if (controller.state?.revision ?? 0)>before {break};try await Task.sleep(for:.milliseconds(10))};XCTAssertEqual(copies.count,1);XCTAssertNil(controller.state?.clipboardText)
    }

}
