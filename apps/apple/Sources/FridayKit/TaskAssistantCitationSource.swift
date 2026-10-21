import SwiftUI

struct TaskAssistantCitationSource<Content:View>: View {
    @StateObject private var model: TaskCitationSelectionModel
    @ObservedObject var bridge: TaskFileMentionBridge
    @Environment(\.taskCitationReveal) private var reveal
    @FocusState private var quoteFocused: Bool
    @State private var handledReveal:UUID?
    let content: Content
    init(identity: TaskCitationSourceIdentity, bridge: TaskFileMentionBridge, @ViewBuilder content: () -> Content) {
        _model=StateObject(wrappedValue:TaskCitationSelectionModel(source:identity)); self.bridge=bridge; self.content=content()
    }
    var body: some View {
        content.environment(\.taskCitationDocument,model).environment(\.taskCitationPath,[])
            .overlay(alignment:.topLeading) {
                if model.actionVisible,model.citation != nil,bridge.context?.citations?.enabled == true {
                    GeometryReader { geometry in
                        Button { model.quote() } label: { FridaySymbolLabel(friday:"引用",systemImage:"quote.opening") }
                            .buttonStyle(FridayButtonStyle(compact:true)).focused($quoteFocused)
                            .padding(5).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8))
                            .position(x:min(max(40,model.actionPoint.x),max(40,geometry.size.width-40)),y:max(16,model.actionPoint.y+20))
                    }
                }
            }
            .onChange(of:bridge.context?.citations?.enabled,initial:true) { _,enabled in model.canCite=enabled == true }
            .onAppear { model.focusAction={ quoteFocused=true } }
            .onChange(of:reveal?.id,initial:true) { _,_ in revealSource() }
            .onChange(of:model.revision) { _,_ in revealSource() }
            .onDisappear { model.dismiss() }
    }
    private func revealSource() {
        guard let reveal,reveal.connection==model.source.connection,handledReveal != reveal.id else { return }
        if model.reveal(reveal.citation) { handledReveal=reveal.id }
    }
}
