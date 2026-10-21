import XCTest
@testable import FridayKit

final class BrowserAnnotationTests:XCTestCase {
    private func fixture(_ name:String)throws->Data {
        var root=URL(fileURLWithPath:#filePath);for _ in 0..<5 {root.deleteLastPathComponent()}
        return try Data(contentsOf:root.appendingPathComponent("server/test/fixtures/"+name+".json"))
    }
    private func record()->TaskBrowserAnnotationRecord {TaskBrowserAnnotationRecord(annotationId:"note",pageUrl:"http://localhost:3000/",pageTitle:"Preview",comment:"make this smaller",elements:[],elementIds:[],styleChangeDetails:[],regionCount:1,strokeCount:0)}
    func testExactPinnedT3NormalizationAndProviderBody()throws {
        struct Fixture:Decodable {let cases:[Entry]}
        struct Entry:Decodable {let record:TaskBrowserAnnotationRecord;let rendered:String;let rawElements:[TaskBrowserElementDetails]}
        let values=try JSONDecoder().decode(Fixture.self,from:fixture("t3-browser-annotations"));XCTAssertEqual(values.cases.count,11)
        for (index,entry) in values.cases.enumerated() {
            let record=entry.record.normalized;XCTAssertTrue(record.valid,"case \(index)")
            XCTAssertEqual(record.rendered(screenshotReference:record.screenshotImageId.map {"image_"+$0}),entry.rendered,"case \(index)")
            var raw=entry.record;raw.elements=entry.rawElements
            XCTAssertEqual(raw.normalized.elements,record.elements,"case \(index)")
        }
    }
    func testCropGeometryUsesTheActualT3PaddingAndViewportRules()throws {
        struct Fixture:Decodable {let unions:[Entry]}
        struct Viewport:Decodable {let width:Double;let height:Double}
        struct Entry:Decodable {let rects:[TaskBrowserAnnotationRect];let viewport:Viewport;let padding:Double;let expected:TaskBrowserAnnotationRect?}
        let values=try JSONDecoder().decode(Fixture.self,from:fixture("t3-browser-annotation-geometry"));XCTAssertEqual(values.unions.count,20)
        for value in values.unions {XCTAssertEqual(TaskBrowserAnnotationRect.union(value.rects,viewport:CGSize(width:value.viewport.width,height:value.viewport.height),padding:value.padding),value.expected)}
        XCTAssertNil(TaskBrowserAnnotationRect.union([.init(x:.nan,y:0,width:2,height:3)],viewport:CGSize(width:390,height:844)))
    }
    func testMergedDraftRetainsExistingTextImagesAndContextAndSurvivesCoding()throws {
        let image=IdeaImage(id:String(repeating:"a",count:64),name:"old.png",mediaType:"image/png"),crop=IdeaImage(id:String(repeating:"b",count:64),name:"crop.png",mediaType:"image/png")
        let old=try XCTUnwrap(TaskBrowserAnnotationDraft(record:record(),target:"task",scope:"scope",workspaceRoot:"/root").reference)
        var next=record();next.annotationId="next"
        let original="before🙂 "+TaskContextDocument.token(old)
        let edit=try XCTUnwrap(TaskBrowserAnnotationDraftEdit.make(record:next,image:crop,text:original,contexts:[old],images:[image],target:"task\nqueue:one",scope:"scope",workspaceRoot:"/root",identity:"composer",send:true))
        XCTAssertTrue(edit.text.hasPrefix(original));XCTAssertEqual(edit.images,[image,crop]);XCTAssertEqual(edit.contexts.count,2);XCTAssertTrue(edit.screenshotAttached);XCTAssertEqual(edit.insertion.alreadyInserted,true);XCTAssertFalse(edit.insertion.focus)
        XCTAssertEqual(edit.contexts.last?.annotationDraft?.record.screenshotImageId,crop.id)
        let restored=try JSONDecoder().decode(TaskContextReference.self,from:JSONEncoder().encode(try XCTUnwrap(edit.contexts.last)))
        XCTAssertEqual(restored,edit.contexts.last);XCTAssertEqual(restored.annotationDraft?.target,"task\nqueue:one")
        XCTAssertEqual(TaskContextDocument.used(edit.text,records:edit.contexts).map(\.id),edit.contexts.map(\.id))
    }
    func testScreenshotFailureOrAttachmentLimitStillProducesTextWithoutAFakeImageReference()throws {
        let images=(0..<20).map {IdeaImage(id:String(format:"%064x",$0),name:"old.png",mediaType:"image/png")}
        let crop=IdeaImage(id:String(repeating:"b",count:64),name:"crop.png",mediaType:"image/png")
        var input=record();input.screenshotImageId="stale"
        for image in [crop,nil] {
            let edit=try XCTUnwrap(TaskBrowserAnnotationDraftEdit.make(record:input,image:image,text:"draft",contexts:[],images:images,target:"task",scope:"scope",workspaceRoot:"/root",identity:"composer",send:false))
            XCTAssertTrue(edit.text.hasPrefix("draft"));XCTAssertEqual(edit.images,images);XCTAssertFalse(edit.screenshotAttached);XCTAssertNil(edit.contexts[0].annotationDraft?.record.screenshotImageId)
        }
        let reused=try XCTUnwrap(TaskBrowserAnnotationDraftEdit.make(record:input,image:images[0],text:"draft",contexts:[],images:images,target:"task",scope:"scope",workspaceRoot:"/root",identity:"composer",send:false))
        XCTAssertEqual(reused.images.count,20);XCTAssertTrue(reused.screenshotAttached)
    }
    func testCancelledAndStaleCapturesCannotAttachAndAcceptedDraftsSurviveBrowserTeardown() {
        let document=UUID();var cancelled=TaskBrowserAnnotationLifetime(document:document);cancelled.cancel();XCTAssertFalse(cancelled.accept(document:document,currentComposer:true))
        var value=TaskBrowserAnnotationLifetime(document:document);XCTAssertFalse(value.accept(document:UUID(),currentComposer:true));XCTAssertFalse(value.accept(document:document,currentComposer:false));XCTAssertTrue(value.accept(document:document,currentComposer:true))
        value.cancel();XCTAssertTrue(value.accepted);XCTAssertFalse(value.cancelled);XCTAssertFalse(value.accept(document:document,currentComposer:true))
    }
    func testIMEAndMultilineInputHaveT3AttachAndSendSemantics() {
        for command in [false,true] {for control in [false,true] {
            XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Enter",shift:false,command:command,control:control,composing:true),.ignore)
            XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Enter",shift:true,command:command,control:control,composing:false),.newline)
        }}
        XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Enter",shift:false,command:false,control:false,composing:false),.attach)
        XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Enter",shift:false,command:true,control:false,composing:false),.send)
        XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Escape",shift:false,command:false,control:false,composing:true),.ignore)
        XCTAssertEqual(TaskBrowserAnnotationKeyboard.action(key:"Escape",shift:false,command:false,control:false,composing:false),.cancel)
    }
    func testImmutableDraftIDsAndBoundsRejectInvalidRecords()throws {
        let original=TaskBrowserAnnotationDraft(record:record(),target:"task",scope:"scope",workspaceRoot:"/root")
        XCTAssertEqual(original.reference?.id,original.reference?.id)
        var changed=record();changed.comment="different";XCTAssertNotEqual(original.reference?.id,TaskBrowserAnnotationDraft(record:changed,target:"task",scope:"scope",workspaceRoot:"/root").reference?.id)
        changed=record();changed.comment=String(repeating:"x",count:8001);XCTAssertFalse(changed.valid)
        changed=record();changed.regionCount=0;XCTAssertFalse(changed.valid)
        changed=record();changed.comment=" \u{FEFF}\n";changed.pageTitle=" ";XCTAssertEqual(changed.normalized.label,"Preview annotation")
        let reference=try XCTUnwrap(original.reference);let snapshot=TaskContextSnapshot(reference:reference,cwd:"/root",text:"")
        XCTAssertEqual(snapshot.browserAnnotation,original.record);XCTAssertEqual(snapshot.copiedContents,original.record.rendered())
    }
}
