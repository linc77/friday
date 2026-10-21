import SwiftUI
import CryptoKit

struct TaskWorkspacePanelLayout: ViewModifier {
    @ObservedObject var store: FridayStore
    @ObservedObject private var editors = FileEditorStore.shared
    let task: WorkItem
    @Binding var diff: TaskDiffSelection?
    @Binding var files: TaskFilesPanelState
    @Binding var browser:TaskBrowserPanelState
    @Binding var active: String
    @Binding var width: Double
    @State private var dragWidth: Double?
    private var visible: Bool { diff != nil || files.visible || browser.visible }
    private var showingBrowser:Bool {browser.visible && (active == "browser" || diff == nil && !files.visible)}
    private var showingFiles: Bool { !showingBrowser && files.visible && (active == "files" || diff == nil) }
    private var browserScope:String {TaskBrowserSessionScope.value(owner:store.browserClientID,connection:store.connectionIdentity,task:task.id)}
    private var browserDragScope:String {SHA256.hash(data:Data(browserScope.utf8)).map {String(format:"%02x",$0)}.joined()}
    func body(content: Content) -> some View {
        #if os(macOS)
        GeometryReader { geometry in
            let maximum = max(320, geometry.size.width - 380), panelWidth = min(maximum, max(320, width))
            HStack(spacing: 0) {
                content.frame(maxWidth: .infinity)
                if visible {
                    Rectangle().fill(.primary.opacity(0.1)).frame(width: 5).contentShape(Rectangle()).fridayInteractiveCursor()
                        .gesture(DragGesture().onChanged { gesture in if dragWidth == nil { dragWidth = panelWidth }; width = min(maximum, max(320, (dragWidth ?? panelWidth) - gesture.translation.width)) }.onEnded { _ in dragWidth = nil })
                        .accessibilityLabel(Text(friday: "调整侧栏宽度")).accessibilityAdjustableAction { width = min(maximum, max(320, width + ($0 == .increment ? 40 : -40))) }
                    panel.frame(width: panelWidth)
                }
            }
        }
        #else
        content.sheet(isPresented: Binding(get: { visible }, set: { if !$0 { close() } })) { panel }
        #endif
    }
    private var panel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        if diff != nil { Button { active = "diff" } label: { FridaySymbolLabel(friday: "改动", systemImage: "plus.forwardslash.minus").padding(6).background(!showingFiles && !showingBrowser ? FridayTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5)) } }
                        ForEach(files.tabs) { tab in
                            HStack(spacing: 4) {
                                Button { files.selected = tab.path; files.visible = true; active = "files" } label: {
                                    HStack(spacing: 4) { if tab.isDirectory { FridaySymbolImage(systemName: "folder") }; if tab.path.isEmpty { Text(friday: "文件") } else { Text(verbatim: tab.name).lineLimit(1) } }
                                }
                                if editors.current(editorKey(tab.path))?.pendingInTab == true { Circle().fill(FridayTheme.accent).frame(width: 5, height: 5).accessibilityLabel(Text(friday: "未保存")) }
                                Button { editors.flush(editorKey(tab.path)); files.close(tab.path) } label: { FridaySymbolImage(systemName: "xmark").font(.system(size: 8)) }.accessibilityLabel(Text(friday: "关闭文件"))
                            }.padding(6).background(showingFiles && files.selected == tab.path ? FridayTheme.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5))
                        }
                        ForEach(browser.tabs) {tab in
                            HStack(spacing:4) {
                                Button {browser.selected=tab.id;browser.visible=true;active="browser"} label: {HStack(spacing:4) {FridaySymbolImage(systemName:tab.incognito ? "eye.slash":"globe");Group {if tab.url != nil || tab.title != nil {Text(verbatim:tab.name)} else {Text(friday:"新标签页")}}.lineLimit(1).frame(maxWidth:160)}}
                                if !TaskBrowserPolicy.usesHost(tab,server:store.connection.server),let controller=TaskBrowserSessions.shared.existing(scope:browserScope,id:tab.id) {TaskBrowserAudioButton(controller:controller)}
                                Button {closeBrowser(tab.id)} label: {FridaySymbolImage(systemName:"xmark").font(.system(size:8))}.accessibilityLabel(Text(friday:"关闭网页"))
                            }.padding(6).background(showingBrowser && browser.current?.id==tab.id ? FridayTheme.accent.opacity(0.12):.clear,in:RoundedRectangle(cornerRadius:5))
                                .draggable("friday-browser-tab:"+browserDragScope+":"+tab.id)
                                .dropDestination(for:String.self) {items,_ in guard let id=items.first,let source=browser.tabs.first(where:{"friday-browser-tab:"+browserDragScope+":"+$0.id==id}) else{return false};browser.move(source.id,before:tab.id);return true}
                                .contextMenu {
                                    Button(friday:"复制标签页") {var copy=tab;copy.id=UUID().uuidString;copy.navigationID=UUID().uuidString;browser.tabs.append(copy);browser.selected=copy.id;browser.visible=true;active="browser"}
                                    Button(friday:"复制网页地址") {if let url=tab.url {copyAgentText(url)}}.disabled(tab.url==nil)
                                    Divider()
                                    Button(friday:"关闭其他标签页") {for other in browser.tabs where other.id != tab.id {closeBrowser(other.id)}}
                                    Button(friday:"关闭右侧标签页") {if let index=browser.tabs.firstIndex(where:{$0.id==tab.id}) {for other in browser.tabs.suffix(from:index+1) {closeBrowser(other.id)}}}
                                    Button(friday:"关闭网页") {closeBrowser(tab.id)}
                                }
                        }
                    }
                }.scrollIndicators(.hidden)
                Menu {
                    Button(friday:"新标签页") {browser.open(defaults:TaskBrowserPreferences.shared(server:store.connection.server).defaults);active="browser"}
                    Button(friday:"无痕浏览") {browser.open(profile:"incognito",incognito:true,defaults:TaskBrowserPreferences.shared(server:store.connection.server).defaults);active="browser"}
                    Button(friday:"重新打开已关闭的标签页") {browser.reopen();active="browser"}.disabled(browser.closed?.isEmpty != false)
                } label: {FridaySymbolImage(systemName:"plus")}.fridayInteractiveCursor().accessibilityLabel(Text(friday:"添加侧栏标签页"))
                Button { close() } label: { FridaySymbolImage(systemName: "xmark") }.accessibilityLabel(Text(friday: "关闭侧栏"))
            }.buttonStyle(FridaySymbolButtonStyle()).font(.caption).padding(8)
            Divider()
            if showingBrowser {TaskBrowserPanel(store:store,task:task,state:$browser).id(browserScope)}
            else if showingFiles { TaskFilesPanel(store: store, task: task, state: $files).id(store.connectionIdentity + ":" + task.id + ":" + task.cwd) }
            else if let value = diff { TaskChangesPanel(store: store, task: task, selection: Binding(get: { diff ?? value }, set: { diff = $0 }), close: close) }
        }.background(FridayTheme.canvas)
    }
    private func editorKey(_ path: String) -> String { FileEditorStore.key(server: store.connection.server, token: store.connection.token, cwd: task.cwd, path: path) }
    private func closeBrowser(_ id:String) {TaskBrowserSessions.shared.close(scope:browserScope,id:id);browser.close(id)}
    private func close() { for tab in files.tabs { editors.flush(editorKey(tab.path)) }; diff = nil; files.visible = false;browser.visible=false }
}
