import SwiftUI

struct TaskCitationEditingTarget: Identifiable {
    var id = UUID()
    let identity: String
    var range: NSRange
    var citation: TaskAssistantCitation
}
struct TaskCitationComposer {
    let enabled: Bool
    let insert: (TaskAssistantCitation) -> TaskCitationEditingTarget?
    let edit: (TaskAssistantCitation, NSRange) -> TaskCitationEditingTarget?
    let replace: (TaskCitationEditingTarget, String) -> TaskCitationEditingTarget?
    let finish: (TaskCitationEditingTarget, Bool) -> Void
    let navigate: (TaskAssistantCitation) -> Void
}
struct TaskCitationNavigationRequest: Identifiable {
    let id = UUID()
    let citation: TaskAssistantCitation
    let connection: String
}
enum TaskCitationDraftEdit {
    struct Result { let text:String;let range:NSRange;let caret:Int }
    static func insert(_ citation:TaskAssistantCitation,in text:String,selection:NSRange) -> Result? {
        guard citation.valid else { return nil }
        let source=text as NSString, range=TaskSourceEditorPosition.selection(selection,length:source.length)
        let before=source.substring(to:range.location), space=before.last.map { !$0.isWhitespace } == true ? " " : ""
        let token=citation.token, value=space+token+" "
        return Result(text:source.replacingCharacters(in:range,with:value),range:NSRange(location:range.location+space.utf16.count,length:token.utf16.count),caret:range.location+value.utf16.count)
    }
    static func replace(_ target:TaskCitationEditingTarget,comment:String,in text:String,identity:String) -> Result? {
        guard target.identity==identity,comment.utf16.count<=8_000,target.range.location>=0,target.range.length>=0,NSMaxRange(target.range)<=(text as NSString).length,
              (text as NSString).substring(with:target.range).utf16.elementsEqual(target.citation.token.utf16) else { return nil }
        let citation=target.citation.withComment(comment),token=citation.token
        return Result(text:(text as NSString).replacingCharacters(in:target.range,with:token),range:NSRange(location:target.range.location,length:token.utf16.count),caret:target.range.location+token.utf16.count)
    }
}
private struct CitationNavigateKey: EnvironmentKey { static let defaultValue: ((TaskAssistantCitation) -> Void)? = nil }
private struct CitationRevealKey: EnvironmentKey { static let defaultValue: TaskCitationNavigationRequest? = nil }
extension EnvironmentValues {
    var taskCitationNavigate: ((TaskAssistantCitation) -> Void)? { get {self[CitationNavigateKey.self]} set {self[CitationNavigateKey.self]=newValue} }
    var taskCitationReveal: TaskCitationNavigationRequest? { get {self[CitationRevealKey.self]} set {self[CitationRevealKey.self]=newValue} }
}
struct TaskAssistantCitationPreview: View {
    let citation: TaskAssistantCitation
    @Environment(\.taskCitationNavigate) private var navigate
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            ScrollView { Text(verbatim:citation.text).font(.body).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading) }.frame(maxHeight:220)
            if let comment=citation.comment { Divider();Text(verbatim:comment).font(.body).textSelection(.enabled) }
            Button { dismiss();navigate?(citation) } label: {FridaySymbolLabel(friday:"返回原消息",systemImage:"arrow.up.right")}.buttonStyle(FridayButtonStyle(compact:true)).disabled(navigate == nil)
        }.padding(16).frame(minWidth:260,idealWidth:360,maxWidth:500)
    }
}
