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
    @AppStorage("friday.tasks.remoteEditorRevision") private var remoteRevision = 0
    @State private var refresh = 0
    @State private var showingError = false
    @State private var configuringRemote = false
    @State private var remoteHost = ""
    @State private var remoteServer = ""
    @State private var remoteError: String?
    private var identity: String { store.connectionIdentity + ":" + task.id + ":" + task.cwd }
    private var discoveryIdentity: String { identity + ":" + String(store.connected) + ":" + String(refresh) + ":" + String(remoteRevision) }
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
        .task(id: discoveryIdentity) {
            guard store.connected else { return }
            do { await model.load(identity: identity, root: task.cwd, transport: try TaskHostEditorTransport.task(store: store, task: task)) }
            catch { showingError = true }
        }
        .onChange(of: model.error) { _, error in if error != nil { showingError = true } }
        .onChange(of: identity) { _, _ in showingError = false; configuringRemote = false }
        .alert(Text(friday: "无法打开文件"), isPresented: $showingError) {
            Button(friday: "好", role: .cancel) {}
        } message: { Text(fridayString: model.error ?? "无法读取主机打开方式") }
        .sheet(isPresented: $configuringRemote) {
            VStack(alignment: .leading, spacing: 14) {
                Text(friday: "SSH 编辑器").font(.headline)
                Text(friday: "填写本机 SSH 配置中的主机别名，通过本机编辑器打开远端目录。留空时在服务主机上打开。").font(.caption).foregroundStyle(.secondary)
                TextField(friday: "SSH 主机别名", text: $remoteHost).textFieldStyle(.roundedBorder)
                if let remoteError { Text(fridayString: remoteError).font(.caption).foregroundStyle(.orange) }
                HStack {
                    Spacer()
                    Button(friday: "取消") { configuringRemote = false }.buttonStyle(FridayButtonStyle())
                    Button(friday: "保存") {
                        do { guard remoteServer == store.connection.server else { configuringRemote = false; return }; try TaskRemoteEditors.save(remoteHost, for: remoteServer); configuringRemote = false }
                        catch { remoteError = error.localizedDescription }
                    }.buttonStyle(FridayButtonStyle(prominent: true))
                }
            }.padding(24).frame(minWidth: 320, maxWidth: 440)
        }
    }
    @ViewBuilder private var choices: some View {
        let sourceIdentity = identity
        if let host = model.snapshot?.remoteHost { Text(verbatim: "SSH: " + host) }
        if model.loading { Text(friday: "正在查找主机编辑器…") }
        else if editors.isEmpty { Text(friday: "主机上未找到可用编辑器") }
        ForEach(editors) { editor in
            Button { open(editor, identity: sourceIdentity) } label: { Label { Text(verbatim: editor.label) } icon: { FridaySymbolImage(systemName: editor.id == preferred?.id ? "checkmark" : editor.symbol) } }
                .disabled(!store.connected || model.busy)
        }
        Divider()
        Button(friday: "刷新打开方式", systemImage: "arrow.clockwise") { refresh += 1 }.disabled(!store.connected || model.loading)
        Button(friday: "SSH 编辑器…", systemImage: "chevron.left.forwardslash.chevron.right") { remoteServer = store.connection.server; remoteHost = TaskRemoteEditors.alias(for: remoteServer) ?? ""; remoteError = nil; configuringRemote = true }
    }
    private func open(_ editor: TaskHostEditor, identity sourceIdentity: String) {
        guard store.connected, identity == sourceIdentity else { return }
        if model.open(TaskHostEditorAction(path: path, editor: editor.id, line: line), identity: sourceIdentity) != nil { preferredID = editor.id }
    }
}
