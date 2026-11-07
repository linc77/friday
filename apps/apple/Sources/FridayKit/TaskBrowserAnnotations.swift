import Foundation
import CryptoKit

enum TaskBrowserAnnotationText {
    static let whitespace=CharacterSet(charactersIn:"\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func trim(_ text:String)->String {text.trimmingCharacters(in:whitespace)}
    static func limit(_ text:String,_ count:Int)->String {text.utf16.count<=count ? text:String(decoding:text.utf16.prefix(max(0,count-1)),as:UTF16.self)+"…"}
    static func normalizeLines(_ text:String)->String {text.replacingOccurrences(of:"\r\n",with:"\n").trimmingCharacters(in:CharacterSet(charactersIn:"\n"))}
    static func indent(_ text:String)->String {text.components(separatedBy:"\n").map {"  "+$0}.joined(separator:"\n")}
}
extension TaskBrowserAnnotationRecord {
    var normalized:Self {
        var value=self;value.pageUrl=TaskBrowserAnnotationText.trim(pageUrl);value.comment=TaskBrowserAnnotationText.trim(comment)
        value.elements=elements.map {e in
            var e=e;e.pageUrl=TaskBrowserAnnotationText.trim(e.pageUrl);e.tagName=TaskBrowserAnnotationText.trim(e.tagName).lowercased();e.pageTitle=e.pageTitle.map(TaskBrowserAnnotationText.trim)
            e.selector=e.selector.map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0};e.componentName=e.componentName.map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0}
            e.htmlPreview=TaskBrowserAnnotationText.limit(TaskBrowserAnnotationText.normalizeLines(e.htmlPreview),4000);e.styles=TaskBrowserAnnotationText.limit(TaskBrowserAnnotationText.normalizeLines(e.styles),4000)
            if var source=e.source {source.functionName=source.functionName.map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0};source.fileName=source.fileName.map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0};e.source=source}
            return e
        };return value
    }
    var valid:Bool {
        func text(_ value:String,_ limit:Int)->Bool {value.utf16.count<=limit && !value.contains("\0")}
        func optional(_ value:String?,_ limit:Int=2048)->Bool {value.map {text($0,limit)} ?? true}
        return version==1 && !annotationId.isEmpty && text(annotationId,2048) && !pageUrl.isEmpty && text(pageUrl,2048) && optional(pageTitle) && text(comment,8000)
            && elements.count<=50 && elementIds.count==elements.count && Set(elementIds).count==elementIds.count && elementIds.allSatisfy {!$0.isEmpty && text($0,2048)}
            && regionCount>=0 && strokeCount>=0 && (!elements.isEmpty || regionCount>0 || strokeCount>0) && styleChangeDetails.count<=200
            && styleChangeDetails.allSatisfy {text($0.targetId,2048) && optional($0.selector) && text($0.property,2048) && text($0.previousValue,8000) && text($0.value,8000)}
            && elements.allSatisfy {e in !e.pageUrl.isEmpty && text(e.pageUrl,2048) && !e.tagName.isEmpty && text(e.tagName,255) && optional(e.pageTitle) && optional(e.selector) && optional(e.componentName) && text(e.htmlPreview,8000) && text(e.styles,8000) && (e.source.map {optional($0.functionName) && optional($0.fileName) && ($0.lineNumber ?? 0)>=0 && ($0.columnNumber ?? 0)>=0} ?? true)}
    }
    var label:String {
        let comment=TaskBrowserAnnotationText.trim(comment).components(separatedBy:TaskBrowserAnnotationText.whitespace).filter {!$0.isEmpty}.joined(separator:" ")
        return comment.isEmpty ? TaskBrowserAnnotationText.limit(pageTitle.map(TaskBrowserAnnotationText.trim).flatMap {$0.isEmpty ? nil:$0} ?? "Preview annotation",200):TaskBrowserAnnotationText.limit(comment,48)
    }
    var summary:String {[(elements.count,"selected element"),(regionCount,"marked region"),(strokeCount,"drawing")].filter {$0.0>0}.map {"\($0.0) \($0.1)"+($0.0==1 ? "":"s")}.joined(separator:", ")}
    func rendered(screenshotReference:String?=nil)->String {
        let trimmed=TaskBrowserAnnotationText.trim,indent=TaskBrowserAnnotationText.indent
        var lines=["page: "+(pageTitle.map(trimmed).flatMap {$0.isEmpty ? nil:$0} ?? pageUrl),"url: "+pageUrl]
        if !trimmed(comment).isEmpty {lines.append("comment: "+trimmed(comment))};if !summary.isEmpty {lines.append("targets: "+summary)}
        if !styleChangeDetails.isEmpty {lines.append("requested visual changes:");lines += styleChangeDetails.map {"- \($0.property): \($0.previousValue.isEmpty ? "(unset)":$0.previousValue) → \($0.value)"}}
        if let screenshotReference {lines.append("screenshot: ref="+screenshotReference)}
        for (index,e) in elements.enumerated() {
            var detail=["url: "+e.pageUrl,"tag: "+e.tagName]
            if let title=e.pageTitle,!title.isEmpty {detail.append("title: "+title)};if let selector=e.selector {detail.append("selector: "+selector)};if let component=e.componentName {detail.append("component: "+component)}
            if let source=e.source,let file=source.fileName {detail.append("source: "+file+(source.lineNumber.map {":"+String($0)+(source.columnNumber.map {":"+String($0)} ?? "")} ?? ""))}
            if !trimmed(e.htmlPreview).isEmpty {detail += ["html:",indent(trimmed(e.htmlPreview))]};if !trimmed(e.styles).isEmpty {detail += ["styles:",indent(trimmed(e.styles))]}
            lines += ["element \(index+1):",indent(detail.joined(separator:"\n"))]
        };return lines.joined(separator:"\n")
    }
}
extension TaskBrowserAnnotationDraft {
    var reference:TaskContextReference? {
        guard record.valid else{return nil};let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        guard let data=try? encoder.encode(self) else{return nil}
        let hash=SHA256.hash(data:data).map {String(format:"%02x",$0)}.joined()
        return TaskContextReference(id:"browser-note-"+hash,kind:"preview-annotation",label:record.label,capturedAt:ISO8601DateFormatter().string(from:Date()),digest:hash,byteLength:data.count,path:nil,terminalId:nil,terminalLabel:nil,generation:nil,lineStart:nil,lineEnd:nil,truncated:nil,annotationDraft:self)
    }
    var body:[String:Any] {
        let record=(try? JSONSerialization.jsonObject(with:JSONEncoder().encode(record))) ?? [:]
        return ["kind":"preview-annotation","annotation":record]
    }
}
extension TaskContextSnapshot {
    var browserAnnotation:TaskBrowserAnnotationRecord? {
        guard reference.kind=="preview-annotation" else{return nil}
        return reference.annotationDraft?.record ?? text.data(using:.utf8).flatMap {try? JSONDecoder().decode(TaskBrowserAnnotationRecord.self,from:$0)}
    }
}
extension TaskBrowserAnnotationRect {
    var cgRect:CGRect {CGRect(x:x,y:y,width:width,height:height)}
    var valid:Bool {[x,y,width,height].allSatisfy(\.isFinite) && width>=0 && height>=0}
    static func union(_ rects:[Self],viewport:CGSize,padding:Double=20)->Self? {
        guard let first=rects.first,rects.allSatisfy(\.valid) else{return nil}
        let left=rects.map(\.x).min() ?? first.x,top=rects.map(\.y).min() ?? first.y,right=rects.map {$0.x+$0.width}.max() ?? first.x,bottom=rects.map {$0.y+$0.height}.max() ?? first.y
        let x=max(0,left-padding),y=max(0,top-padding)
        return Self(x:x,y:y,width:min(max(1,viewport.width-x),right-left+padding*2),height:min(max(1,viewport.height-y),bottom-top+padding*2))
    }
}
