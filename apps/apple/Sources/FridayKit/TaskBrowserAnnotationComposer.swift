import Foundation

struct TaskBrowserAnnotationAttachment {
    var accepted:Bool
    var warning:String?=nil
}
struct TaskBrowserAnnotationComposer {
    let enabled:Bool
    let target:String
    let scope:String
    let workspaceRoot:String
    let current:()->Bool
    let attach:(TaskBrowserAnnotationRecord,Data?,Bool)->TaskBrowserAnnotationAttachment
}

struct TaskBrowserAnnotationDraftEdit {
    let text:String
    let contexts:[TaskContextReference]
    let images:[IdeaImage]
    let insertion:TaskContextInsertion
    let screenshotAttached:Bool
    static func make(record:TaskBrowserAnnotationRecord,image:IdeaImage?,text:String,contexts:[TaskContextReference],images:[IdeaImage],target:String,scope:String,workspaceRoot:String,identity:String,send:Bool)->Self? {
        guard TaskContextDocument.used(text,records:contexts).count<20 else{return nil}
        var record=record.normalized;var nextImages=images;record.screenshotImageId=nil
        if let image,images.contains(where:{$0.id==image.id}) || images.count<20 {
            record.screenshotImageId=image.id;if !images.contains(where:{$0.id==image.id}) {nextImages.append(image)}
        }
        let draft=TaskBrowserAnnotationDraft(record:record,target:target,scope:scope,workspaceRoot:workspaceRoot)
        guard let reference=draft.reference else{return nil}
        var nextContexts=contexts;if !contexts.contains(where:{$0.id==reference.id}) {nextContexts.append(reference)}
        var request=TaskContextInsertion(reference:reference,focus:!send,identity:identity,previousOccurrences:0,atEnd:true)
        let range=TaskContextDocument.insertionRange(request,text:text,caret:NSRange(location:text.utf16.count,length:0)),insert=TaskContextDocument.insertionText(request,text:text)
        let next=(text as NSString).replacingCharacters(in:range,with:insert)
        request.alreadyInserted=true;request.caret=range.location+insert.utf16.count
        return Self(text:next,contexts:nextContexts,images:nextImages,insertion:request,screenshotAttached:record.screenshotImageId != nil)
    }
}
