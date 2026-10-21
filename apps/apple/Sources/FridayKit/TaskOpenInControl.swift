import SwiftUI

struct TaskOpenInControl: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    var path = ""
    var line: Int? = nil
    var enableShortcut = false
    var menuOnly = false
    @StateObject private var model = TaskHostEditorModel()
    @AppStorage("friday.tasks.preferredEditor") private var preferredID = ""
    @State private var refresh = 0
    @State private var showingError = false
    private var identity: String { store.connectionIdentity + ":" + task.id + ":" + task.cwd }
    private var editors: [TaskHostEditor] { model.snapshot?.editors ?? [] }
    private var preferred: TaskHostEditor? { TaskHostEditor.preferred(preferredID, in: editors) }
    private var enabled: Bool { store.connected && !model.busy && preferred != nil }
    var body: some View {
        let sourceIdentity = identity
        Group {
            if menuOnly { Menu { choices } label: { FridaySymbolLabel(friday: "打开方式", systemImage: "arrow.up.forward.app") } }
            else {
                HStack(spacing: 0) {
                    Button { if let preferred { open(preferred, identity: sourceIdentity) } } label: {
                        FridaySymbolLabel(friday: "打开", systemImage: preferred?.symbol ?? "arrow.up.forward.app").font(.caption)
                    }.disabled(!enabled)
                        .help(Text(friday: enableShortcut ? "在首选编辑器中打开 · ⌘O" : "在主机上打开"))
                        .background { if enableShortcut { Button("") { if let preferred, enabled { open(preferred, identity: sourceIdentity) } }.keyboardShortcut("o", modifiers: .command).disabled(!enabled).hidden().accessibilityHidden(true) } }
                    Menu { choices } label: { FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9)).frame(width: 20, height: 24) }
                        #if os(macOS)
                        .menuStyle(.borderlessButton)
                        #endif
                        .fixedSize()
                }.buttonStyle(FridaySymbolButtonStyle()).fridayInteractiveCursor()
            }
        }
        .task(id: identity + ":" + String(store.connected) + ":\(refresh)") {
            guard store.connected else { return }
            do { await model.load(identity: identity, root: task.cwd, transport: try TaskHostEditorTransport.task(store: store, task: task)) }
            catch { showingError = true }
        }
        .onChange(of: model.error) { _, error in if error != nil { showingError = true } }
        .onChange(of: identity) { _, _ in showingError = false }
        .alert(Text(friday: "无法打开文件"), isPresented: $showingError) {
            Button(friday: "好", role: .cancel) {}
        } message: { Text(fridayString: model.error ?? "无法读取主机打开方式") }
    }
    @ViewBuilder private var choices: some View {
        let sourceIdentity = identity
        if model.loading { Text(friday: "正在查找主机编辑器…") }
        else if editors.isEmpty { Text(friday: "主机上未找到可用编辑器") }
        ForEach(editors) { editor in
            Button { open(editor, identity: sourceIdentity) } label: { Label { Text(verbatim: editor.label) } icon: { FridaySymbolImage(systemName: editor.id == preferred?.id ? "checkmark" : editor.symbol) } }
                .disabled(!store.connected || model.busy)
        }
        Divider()
        Button(friday: "刷新打开方式", systemImage: "arrow.clockwise") { refresh += 1 }.disabled(!store.connected || model.loading)
    }
    private func open(_ editor: TaskHostEditor, identity sourceIdentity: String) {
        guard store.connected, identity == sourceIdentity else { return }
        if model.open(TaskHostEditorAction(path: path, editor: editor.id, line: line), identity: sourceIdentity) != nil { preferredID = editor.id }
    }
}
