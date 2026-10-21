import SwiftUI

struct TaskContextMessageText: View {
    @ObservedObject var store: FridayStore
    let text: String
    let contexts: [TaskContextReference]
    let taskID: String
    @State private var preview: TaskContextReference?
    @State private var citation:TaskCitationNavigationRequest?
    var body: some View {
        if TaskContextDocument.occurrences(text).isEmpty && TaskAssistantCitation.occurrences(text).isEmpty {
            Text(verbatim: text).font(.body).lineSpacing(5).textSelection(.enabled)
        } else {
            TaskPromptEditor(text: .constant(text), placeholder: "", enabled: false, focused: false, minimumHeight: 22,
                focusChanged: { _ in }, submit: {}, importProviders: { _ in },
                identity: "message:" + taskID + ":" + text, contexts: contexts,
                openContext: { id in preview = contexts.first { $0.id == id } },openCitation:{ citation=TaskCitationNavigationRequest(citation:$0,connection:store.connectionIdentity) }, maximumHeight: .greatestFiniteMagnitude, accessibilityName: "用户消息")
                .frame(idealWidth: idealWidth)
                .popover(item: $preview) { reference in TaskContextPreview(store: store, reference: reference, scope: TaskContextScope(taskID: taskID)) }
                .popover(item:$citation) { request in TaskAssistantCitationPreview(citation:request.citation) }
        }
    }
    private var idealWidth: CGFloat {
        #if os(macOS)
        let document = TaskContextText.document(text, records: contexts, font: .systemFont(ofSize: 14))
        let width = document.boundingRect(with: CGSize(width: 624, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).width
        #else
        let document = TaskContextText.document(text, records: contexts, font: .preferredFont(forTextStyle: .body))
        let width = document.boundingRect(with: CGSize(width: 624, height: CGFloat.greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width
        #endif
        return min(630, max(100, ceil(width) + 6))
    }
}
