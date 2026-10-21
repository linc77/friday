import SwiftUI

struct TaskHostBrowserPage:View {
    @Environment(\.taskFileMentionBridge) private var mentionBridge
    @Binding var tab:TaskBrowserTab
    @ObservedObject var controller:TaskHostBrowserController
    let server:String
    let resolving:Bool
    let focusRequest:Int
    let submit:(String)->Void
    let popup:(TaskHostBrowserSnapshot.Popup)->Bool
    let visited:(String,String?)->Void
    var float:(()->Void)?=nil
    var manageProfiles:(()->Void)?=nil
    @State private var surface=UUID()
    @State private var address=""
    @State private var keyboard=false
    @FocusState private var addressFocused:Bool
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                Button {controller.send(["type":"back"])} label:{FridaySymbolImage(systemName:"chevron.left")}.disabled(!controller.canOperate || controller.state?.back != true).help(Text(friday:"后退"))
                Button {controller.send(["type":"forward"])} label:{FridaySymbolImage(systemName:"chevron.right")}.disabled(!controller.canOperate || controller.state?.forward != true).help(Text(friday:"前进"))
                Button {controller.send(["type":controller.state?.loading==true ? "stop":"reload"])} label:{FridaySymbolImage(systemName:controller.state?.loading==true ? "xmark":"arrow.clockwise")}.disabled(!controller.canOperate).help(Text(friday:controller.state?.loading==true ? "停止加载":"重新加载"))
                TextField(friday:"输入网址或搜索",text:$address).textFieldStyle(.plain).autocorrectionDisabled().focused($addressFocused).font(.callout).padding(6).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:6)).onSubmit {submit(address);addressFocused=false}.disabled(resolving || !controller.canOperate)
                #if os(iOS)
                Button {keyboard.toggle()} label:{FridaySymbolImage(systemName:keyboard ? "keyboard.chevron.compact.down":"keyboard")}.disabled(!controller.canOperate).help(Text(friday:"网页键盘"))
                #endif
                if let mentionBridge {TaskBrowserAnnotationEntry(controller:controller,bridge:mentionBridge)}
                TaskBrowserCaptureButton(controller:controller)
                if let float {Button(action:float) {FridaySymbolImage(systemName:"pip")}.help(Text(friday:"在任务中浮动预览"))}
                TaskHostBrowserDownloadsMenu(controller:controller,transfers:controller.fileTransfers)
                more
            }.buttonStyle(FridaySymbolButtonStyle()).padding(8)
            Divider()
            if let session=controller.annotationSession,!controller.detached {TaskBrowserAnnotationToolbar(session:session)}
            if tab.deviceToolbar {deviceToolbar;Divider()}
            GeometryReader {geometry in
                ZStack {
                    FridayTheme.canvas
                    if controller.detached {
                        VStack(spacing:8) {Text(friday:"网页已在独立窗口中打开");Button(friday:"返回任务侧栏") {
                            #if os(macOS)
                            controller.returnInline()
                            #endif
                        }.buttonStyle(FridayButtonStyle(compact:true))}
                    }else{TaskHostBrowserCanvas(controller:controller,keyboardRequested:keyboard)}
                    if controller.image==nil {VStack(spacing:12) {FridaySymbolImage(systemName:"network").font(.title2);Text(friday:controller.connected ? "等待主机网页画面":"正在连接主机浏览器").font(.callout).foregroundStyle(.secondary)}.allowsHitTesting(false)}
                }.clipped()
                .task(id:"\(Int(geometry.size.width))x\(Int(geometry.size.height))-\(tab.viewportWidth ?? -1)-\(tab.viewportHeight ?? -1)-\(controller.detached)") {try? await Task.sleep(for:.milliseconds(250));if !Task.isCancelled,!controller.detached {controller.resize(geometry.size,tab:tab)}}
            }
            HStack(spacing:8) {
                FridaySymbolImage(systemName:"network").font(.caption)
                Text(friday:"主机浏览器").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if controller.connected {
                    if controller.canOperate {Button(friday:"释放控制权") {controller.release()}.buttonStyle(FridayButtonStyle(compact:true))}
                    else {Button(friday:controller.uncertain ? "继续控制":"取得控制权") {controller.claim()}.buttonStyle(FridayButtonStyle(compact:true))}
                }else {Button(friday:"重新打开") {controller.reopen()}.buttonStyle(FridayButtonStyle(compact:true))}
            }.padding(8)
            TaskHostBrowserTransferPanel(controller:controller,transfers:controller.fileTransfers)
            if let session=controller.annotationSession,!controller.detached {TaskBrowserAnnotationComment(session:session)}
            if let session=controller.recordingSession {TaskBrowserRecordingStatus(session:session)}
            if let error=controller.error {HStack(alignment:.top,spacing:8) {FridaySymbolImage(systemName:"exclamationmark.circle");Text(fridayString:error).font(.caption).textSelection(.enabled);Spacer()}.foregroundStyle(.orange).padding(10).background(FridayTheme.canvas)}
        }
        .onAppear {controller.annotationBridge=mentionBridge;address=controller.state?.url ?? tab.url ?? "";controller.popup=popup;controller.popupOwner=surface;controller.update(tab);controller.acquireSurface(surface)}
        .onDisappear {if !controller.detached {controller.annotationSession?.cancel()};if controller.popupOwner==surface {controller.popup=nil;controller.popupOwner=nil};controller.releaseSurface(surface)}
        .onChange(of:tab) {_,value in controller.update(value)}
        .onChange(of:focusRequest) {_,_ in addressFocused=true}
        .onChange(of:controller.state) {_,value in
            guard let value else{return}
            if !addressFocused {address=value.url}
            if TaskBrowserPolicy.url(value.url) != nil {tab.url=value.url;tab.title=value.title;tab.hostGeneration=value.generation;visited(value.url,value.title)}
        }
        .overlay(alignment:.bottom){if !controller.detached {TaskBrowserArtifactNotice(controller:controller)}}
        .modifier(TaskHostBrowserArtifactExporter(controller:controller))
        .sheet(item:Binding(get:{!controller.detached && controller.canOperate ? controller.state?.dialog:nil},set:{value in if value==nil,!controller.detached,let dialog=controller.state?.dialog {controller.send(["type":"dialog","id":dialog.id,"accept":false,"text":""])}})) {dialog in TaskHostBrowserDialogView(dialog:dialog,answer:{accept,text in controller.send(["type":"dialog","id":dialog.id,"accept":accept,"text":text])})}
    }
    private var more:some View {
        Menu {
            Button(friday:"重新连接画面") {controller.reconnect()}
            Button(friday:"重新打开主机标签") {controller.reopen()}
            TaskBrowserRecordingPreferences()
            #if os(macOS)
            Button(friday:"在独立窗口中打开") {controller.showStandalone()}
            Button(friday:"置顶小预览") {controller.toggleMiniPlayer()}
            #endif
            ForEach(controller.artifacts) {artifact in Menu {TaskBrowserArtifactActions(controller:controller,artifact:artifact)} label:{Text(verbatim:artifact.name)}}
            if !controller.interruptedArtifacts.isEmpty {Menu {ForEach(controller.interruptedArtifacts) {artifact in Button(friday:"恢复可用片段") {controller.recoverRecording(artifact)}.disabled(controller.recoveringArtifacts.contains(artifact.id))}} label:{Text(friday:"未完成的录屏")}}
            Divider()
            Button(friday:"复制") {controller.send(["type":"edit","command":"copy"])}.disabled(!controller.canOperate)
            Button(friday:"剪切") {controller.send(["type":"edit","command":"cut"])}.disabled(!controller.canOperate)
            Button(friday:"粘贴") {controller.pasteClipboard()}.disabled(!controller.canOperate)
            Button(friday:"全选") {controller.send(["type":"edit","command":"selectAll"])}.disabled(!controller.canOperate)
            Button(friday:"撤销") {controller.send(["type":"edit","command":"undo"])}.disabled(!controller.canOperate)
            Button(friday:"重做") {controller.send(["type":"edit","command":"redo"])}.disabled(!controller.canOperate)
            Divider()
            if let manageProfiles {Button(friday:"管理浏览配置",action:manageProfiles)}
            Button(friday:"在此设备中打开") {tab.hostBrowser=false}.disabled(tab.url.flatMap(TaskBrowserPolicy.url).map {TaskBrowserPolicy.canOpen($0,server:server)} != true)
            Button(friday:tab.deviceToolbar ? "隐藏设备工具栏":"显示设备工具栏") {tab.deviceToolbar.toggle()}
            Menu {Button(friday:"跟随系统") {tab.appearance="system"};Button(friday:"浅色") {tab.appearance="light"};Button(friday:"深色") {tab.appearance="dark"}} label:{Text(friday:"网页外观")}
            Button(friday:"放大") {tab.zoom=TaskBrowserPolicy.zoom(tab.zoom,increase:true)}.disabled(!controller.canOperate)
            Button(friday:"缩小") {tab.zoom=TaskBrowserPolicy.zoom(tab.zoom,increase:false)}.disabled(!controller.canOperate)
            Button("\(Int(tab.zoom*100))% · "+String(localized:"重置缩放",bundle:.module)) {tab.zoom=1}.disabled(!controller.canOperate)
        } label:{FridaySymbolImage(systemName:"ellipsis")}.fridayInteractiveCursor()
    }
    private var deviceToolbar:some View {
        HStack(spacing:8) {
            Menu {
                Button(friday:"填充面板") {tab.viewportWidth=nil;tab.viewportHeight=nil;tab.mobile=false}
                ForEach(TaskBrowserViewportPreset.all) {preset in Button(preset.label) {tab.viewportWidth=preset.width;tab.viewportHeight=preset.height;tab.mobile=preset.mobile}}
            } label:{Text(friday:"设备视口")}.fridayInteractiveCursor()
            if let width=tab.viewportWidth,let height=tab.viewportHeight {Text("\(width) × \(height)").font(.system(.caption,design:.monospaced));Button {tab.viewportWidth=height;tab.viewportHeight=width} label:{FridaySymbolImage(systemName:"rotate.right")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"旋转视口"))}
            Spacer()
        }.font(.caption).padding(8).disabled(!controller.canOperate)
    }
}
struct TaskHostBrowserDialogView:View {
    let dialog:TaskHostBrowserSnapshot.Dialog
    let answer:(Bool,String)->Void
    @State private var text=""
    var body:some View {
        VStack(alignment:.leading,spacing:14) {
            Text(friday:"网页对话框").font(.headline)
            ScrollView {Text(verbatim:dialog.message).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)}.frame(maxHeight:220)
            if dialog.type=="prompt" {TextField(friday:"回复",text:$text).textFieldStyle(.roundedBorder).onSubmit{answer(true,text)}}
            HStack {Spacer();if dialog.type != "alert" {Button(friday:"取消") {answer(false,"")}.buttonStyle(FridayButtonStyle(compact:true))};Button(friday:"确定") {answer(true,text)}.buttonStyle(FridayButtonStyle(compact:true))}
        }.padding(20).frame(minWidth:300,idealWidth:420).onAppear{text=dialog.defaultValue}
    }
}
