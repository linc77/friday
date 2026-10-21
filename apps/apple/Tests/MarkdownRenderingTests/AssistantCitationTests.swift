import XCTest
#if os(macOS)
import AppKit
#else
import UIKit
#endif
@testable import FridayKit

final class AssistantCitationTests: XCTestCase {
    func testSelectorsURLFormEncodingLabelsAndDriftMatchTheUpstreamUnicodeFixtures() throws {
        struct Range:Decodable { let location:Int; let length:Int }
        struct Selector:Decodable { let text:String;let start:Int;let end:Int;let prefix:String;let suffix:String }
        struct Found:Decodable {let start:Int;let end:Int}
        struct Fixture:Decodable {let source:String;let range:Range;let selector:Selector;let href:String;let label:String;let find:Found?;let drift:String;let driftFind:Found?}
        struct Fixtures:Decodable {let source:String;let cases:[Fixture]}
        let path=URL(fileURLWithPath:#filePath).deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Fixtures/t3-assistant-citations.json")
        let fixtures=try JSONDecoder().decode(Fixtures.self,from:Data(contentsOf:path));XCTAssertEqual(fixtures.cases.count,93)
        for (index,f) in fixtures.cases.enumerated() {
            var citation=try XCTUnwrap(TaskAssistantCitation.make(environment:"host /?#🙂",task:"task",message:"message",source:f.source,range:NSRange(location:f.range.location,length:f.range.length)),"case \(index)")
            XCTAssertEqual(citation.text,f.selector.text,"case \(index)");XCTAssertEqual(citation.start,f.selector.start,"case \(index)");XCTAssertEqual(citation.end,f.selector.end,"case \(index)")
            XCTAssertEqual(citation.prefix,f.selector.prefix,"case \(index)");XCTAssertEqual(citation.suffix,f.selector.suffix,"case \(index)")
            citation.comment=" optional + /\n二 "
            XCTAssertEqual(citation.href,f.href,"case \(index)");XCTAssertEqual(citation.label,f.label,"case \(index)");XCTAssertEqual(TaskAssistantCitation.parse(f.href),citation)
            XCTAssertEqual(citation.find(in:f.source),f.find.map {NSRange(location:$0.start,length:$0.end-$0.start)},"case \(index)")
            XCTAssertEqual(citation.find(in:f.drift),f.driftFind.map {NSRange(location:$0.start,length:$0.end-$0.start)},"case \(index)")
            XCTAssertEqual(TaskAssistantCitation.occurrences(citation.token).first?.citation,citation)
        }
    }
    func testInvalidAndAmbiguousCitationsNeverNavigateToAnUnrelatedSource() throws {
        let value=TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:"same",start:0,end:4,prefix:"",suffix:"")
        XCTAssertNil(value.find(in:"same same"));XCTAssertEqual(value.find(in:"prefix same suffix"),NSRange(location:7,length:4))
        for href in [value.href+"&text=duplicate",value.href+"&unknown=x",value.href+"#fragment",value.href.replacingOccurrences(of:"start=0",with:"start=-1"),value.href.replacingOccurrences(of:"end=4",with:"end=0"),value.href.replacingOccurrences(of:"host/",with:"%FF/")] {XCTAssertNil(TaskAssistantCitation.parse(href),href)}
        XCTAssertNil(TaskAssistantCitation.parse(TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:String(repeating:"x",count:8001),start:0,end:8001,prefix:"",suffix:"").href))
        XCTAssertNil(value.withComment(String(repeating:"x",count:8001)).valid ? value : nil)
        XCTAssertNil(value.withComment(" \u{FEFF}\n").comment)
    }
    func testCitationInsertionUsesTheSameCanonicalRequestWithoutAFileCapture() throws {
        let citation=TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:"quote",start:1,end:6,prefix:"x",suffix:"y")
        let request=TaskContextInsertion(citation:citation,focus:false,identity:"composer")
        XCTAssertEqual(TaskContextDocument.insertionText(request,text:""),citation.token+" ");XCTAssertTrue(request.shouldInsert(in:""));XCTAssertFalse(request.shouldInsert(in:citation.token))
        let restored=try JSONDecoder().decode(TaskContextInsertion.self,from:JSONEncoder().encode(request));XCTAssertNil(restored.reference);XCTAssertEqual(restored.citation,citation)
    }
    func testCaretInsertionAndCommentEditsKeepDuplicateOccurrencesDistinct() throws {
        let citation=TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:"🙂 quote",start:0,end:8,prefix:"",suffix:"")
        let insertion=try XCTUnwrap(TaskCitationDraftEdit.insert(citation,in:"before🙂 after",selection:NSRange(location:8,length:0)))
        XCTAssertEqual(insertion.text,"before🙂 "+citation.token+"  after")
        XCTAssertEqual((insertion.text as NSString).substring(with:insertion.range),citation.token)
        let text=citation.token+" / "+citation.token
        let target=TaskCitationEditingTarget(identity:"task+queue",range:NSRange(location:0,length:citation.token.utf16.count),citation:citation)
        let edit=try XCTUnwrap(TaskCitationDraftEdit.replace(target,comment:" do this ",in:text,identity:"task+queue"))
        XCTAssertEqual(edit.text,citation.withComment("do this").token+" / "+citation.token)
        XCTAssertNil(TaskCitationDraftEdit.replace(target,comment:"x",in:text,identity:"other-queue"))
        XCTAssertNil(TaskCitationDraftEdit.replace(target,comment:"x",in:"prefix "+text,identity:"task+queue"))
        XCTAssertNil(TaskCitationDraftEdit.replace(target,comment:String(repeating:"x",count:8001),in:text,identity:"task+queue"))
    }
    @MainActor func testCommentDraftCommitsOutsideCloseRevertsEscapeAndBlocksOversize() async throws {
        let citation=TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:"quote",start:0,end:5,prefix:"",suffix:"",comment:"initial")
        var text=citation.token,finished:[Bool]=[]
        let target=TaskCitationEditingTarget(identity:"current",range:NSRange(location:0,length:text.utf16.count),citation:citation)
        let broker=TaskCitationComposer(enabled:true,insert:{_ in nil},edit:{_,_ in nil},replace:{ target,comment in
            guard let edit=TaskCitationDraftEdit.replace(target,comment:comment,in:text,identity:"current") else { return nil }
            text=edit.text;var next=target;next.citation=target.citation.withComment(comment);next.range=edit.range;return next
        },finish:{ _,send in finished.append(send) },navigate:{_ in})
        let state=TaskCitationCommentState(target:target,composer:broker)
        state.draft="changed";state.changed();XCTAssertEqual(text,citation.withComment("changed").token)
        state.draft=String(repeating:"x",count:8001);state.changed();XCTAssertFalse(state.finish());XCTAssertTrue(finished.isEmpty)
        state.cancel();XCTAssertEqual(text,citation.token);XCTAssertEqual(finished,[false])
        let next=TaskCitationCommentState(target:target,composer:broker);next.draft="saved";XCTAssertTrue(next.finish(send:true));XCTAssertEqual(text,citation.withComment("saved").token);XCTAssertEqual(finished,[false,true])
    }
    @MainActor func testAtomicCitationChipsRetainPortableCopyAndCanonicalCaretOffsets() async throws {
        let citation=TaskAssistantCitation(environmentId:"host",threadId:"task",messageId:"message",text:"🙂",start:0,end:2,prefix:"",suffix:"")
        let text="a "+citation.token+" z"
        let document=TaskContextText.document(text,records:[],font:.systemFont(ofSize:14))
        XCTAssertEqual(document.length,5);XCTAssertEqual(TaskContextText.canonical(document),text)
        XCTAssertEqual(TaskContextText.modelRange(NSRange(location:2,length:1),in:document),NSRange(location:2,length:citation.token.utf16.count))
        XCTAssertEqual(TaskContextText.viewRange(NSRange(location:2+citation.token.utf16.count,length:0),in:document),NSRange(location:3,length:0))
        XCTAssertEqual(document.attribute(.link,at:2,effectiveRange:nil) as? String,citation.href)
    }
    @MainActor func testRenderedPartGraphOrdersBlocksWithoutControlLabelsAndLocatesAcrossLeaves() async throws {
        let identity=TaskCitationSourceIdentity(environment:"host",task:"task",message:"message",connection:"connection")
        let model=TaskCitationSelectionModel(source:identity)
        let first=CitationTestPart(key:[0,0],group:[0],text:"first "),inline=CitationTestPart(key:[0,2],group:[0],text:"🙂 text"),code=CitationTestPart(key:[1,0],group:[1],text:"let x = 1\n"),cell=CitationTestPart(key:[2,2,0,0,0],group:[2,2,0,0],text:"cell")
        for part in [cell,inline,code,first] { model.register(part) };model.rebuild()
        XCTAssertEqual(model.text,"first 🙂 text\nlet x = 1\n\ncell")
        let range=(model.text as NSString).range(of:"🙂 text\nlet x = 1")
        model.select(range);let citation=try XCTUnwrap(model.citation)
        XCTAssertEqual(citation.text,"🙂 text\nlet x = 1");XCTAssertTrue(model.reveal(citation));XCTAssertNotNil(first.highlighted == nil ? inline.highlighted : nil)
        model.unregister(code);model.rebuild();XCTAssertNil(model.selected);XCTAssertFalse(model.reveal(citation))
        XCTAssertFalse(model.reveal(TaskAssistantCitation(environmentId:"other-host",threadId:"task",messageId:"message",text:"cell",start:0,end:4,prefix:"",suffix:"")))
    }
}

@MainActor private final class CitationTestPart: TaskCitationNativePart {
    let citationKey:[Int];let citationGroup:[Int];let citationText:String
    let citationView=TaskCitationPlatformView(frame:.zero)
    var highlighted:NSRange?
    init(key:[Int],group:[Int],text:String) { citationKey=key;citationGroup=group;citationText=text }
    func offset(at point:CGPoint)->Int { 0 }
    func rectangles(_ range:NSRange)->[CGRect] { [] }
    func highlight(_ range:NSRange?) { highlighted=range }
    func link(at offset:Int)->URL? { nil }
    func reveal(_ range:NSRange) {}
}
