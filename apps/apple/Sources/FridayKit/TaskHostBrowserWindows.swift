#if os(macOS)
import AppKit
import SwiftUI

extension TaskHostBrowserController {
    func showStandalone() {
        guard !closed else{return};if let standalone {standalone.show();return}
        let window=TaskHostBrowserStandaloneWindow(controller:self);standalone=window;detached=true;window.show()
    }
    func returnInline() {standalone?.close()}
    func toggleMiniPlayer() {
        guard !closed else{return};if let miniWindow {miniWindow.close();return}
        let window=TaskHostBrowserMiniWindow(controller:self);miniWindow=window;window.show()
    }
    func openOwnedPopup(_ popup:TaskHostBrowserSnapshot.Popup) {
        guard !closed,ownedPopups[popup.tabId]==nil else{return}
        let child=relatedPopup(popup);ownedPopups[popup.tabId]=child;child.showStandalone()
        child.standalone?.dismissed={ [weak self,weak child] in self?.ownedPopups.removeValue(forKey:popup.tabId);child?.closeRemote() }
    }
}
@MainActor final class TaskHostBrowserStandaloneWindow:NSObject,NSWindowDelegate {
    private weak var controller:TaskHostBrowserController?
    private var window:NSWindow?
    private let surface=UUID()
    var dismissed:(()->Void)?
    init(controller:TaskHostBrowserController) {self.controller=controller;super.init()}
    func show() {
        guard let controller,!controller.closed else{return}
        if let window {window.makeKeyAndOrderFront(nil);return}
        controller.acquireSurface(surface)
        let window=NSWindow(contentRect:CGRect(x:0,y:0,width:1040,height:760),styleMask:[.titled,.closable,.miniaturizable,.resizable,.fullSizeContentView],backing:.buffered,defer:false)
        window.title=FridayAppName.displayName+" · "+String(localized:"网页预览",bundle:.module);window.titlebarAppearsTransparent=true;window.isReleasedWhenClosed=false;window.contentMinSize=CGSize(width:480,height:360);window.delegate=self
        self.window=window;window.contentView=NSHostingView(rootView:TaskHostBrowserStandaloneContent(controller:controller));window.center();window.makeKeyAndOrderFront(nil)
    }
    func close() {window?.performClose(nil)}
    func windowWillClose(_ notification:Notification) {
        let old=window;window=nil;old?.contentView=nil;old?.delegate=nil
        if let controller {controller.annotationSession?.cancel();controller.detached=false;if controller.standalone === self {controller.standalone=nil};controller.releaseSurface(surface)}
        let callback=dismissed;dismissed=nil;callback?()
    }
}
private struct TaskHostBrowserStandaloneContent:View {
    @ObservedObject var controller:TaskHostBrowserController
    @State private var address=""
    @FocusState private var focused:Bool
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:6) {
                Button {controller.send(["type":"back"])} label:{FridaySymbolImage(systemName:"chevron.left")}.disabled(!controller.canOperate || controller.state?.back != true)
                Button {controller.send(["type":"forward"])} label:{FridaySymbolImage(systemName:"chevron.right")}.disabled(!controller.canOperate || controller.state?.forward != true)
                Button {controller.send(["type":controller.state?.loading==true ? "stop":"reload"])} label:{FridaySymbolImage(systemName:controller.state?.loading==true ? "xmark":"arrow.clockwise")}.disabled(!controller.canOperate).keyboardShortcut("r",modifiers:.command)
                TextField(friday:"输入网址或搜索",text:$address).focused($focused).textFieldStyle(.plain).autocorrectionDisabled().onSubmit{controller.navigateAddress(address);focused=false}.disabled(!controller.canOperate)
                if let bridge=controller.annotationBridge {TaskBrowserAnnotationEntry(controller:controller,bridge:bridge)}
                TaskBrowserCaptureButton(controller:controller)
                TaskHostBrowserDownloadsMenu(controller:controller,transfers:controller.fileTransfers)
                Menu {
                    TaskBrowserRecordingPreferences()
                    Button(friday:"置顶小预览") {controller.toggleMiniPlayer()}
                    Button(friday:"返回任务侧栏") {controller.returnInline()}
                    Divider()
                    ForEach(controller.artifacts) {artifact in Menu {TaskBrowserArtifactActions(controller:controller,artifact:artifact)} label:{Text(verbatim:artifact.name)}}
                    Button(friday:"取得控制权") {controller.claim()}.disabled(!controller.connected)
                } label:{FridaySymbolImage(systemName:"ellipsis")}.fridayInteractiveCursor()
            }.buttonStyle(FridaySymbolButtonStyle()).padding(10)
            if let session=controller.annotationSession {TaskBrowserAnnotationToolbar(session:session)}
            Divider();GeometryReader {geometry in TaskHostBrowserCanvas(controller:controller).frame(maxWidth:.infinity,maxHeight:.infinity).task(id:"\(Int(geometry.size.width))x\(Int(geometry.size.height))-\(controller.fixedViewport)") {try? await Task.sleep(for:.milliseconds(250));if !Task.isCancelled {controller.resizeSurface(geometry.size)}}}
            TaskHostBrowserTransferPanel(controller:controller,transfers:controller.fileTransfers,detached:true)
            if let session=controller.annotationSession {TaskBrowserAnnotationComment(session:session)}
            if let session=controller.recordingSession {TaskBrowserRecordingStatus(session:session)}
            if let error=controller.error {Text(fridayString:error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(8)}
        }.background(FridayTheme.canvas).onAppear{address=controller.state?.url ?? ""}.onChange(of:controller.state?.url){_,value in if !focused {address=value ?? ""}}
            .overlay(alignment:.bottom){TaskBrowserArtifactNotice(controller:controller)}.modifier(TaskHostBrowserArtifactExporter(controller:controller,detached:true))
            .background{Button{focused=true} label:{EmptyView()}.keyboardShortcut("l",modifiers:.command).frame(width:0,height:0).accessibilityHidden(true)}
            .sheet(item:Binding(get:{controller.detached && controller.canOperate ? controller.state?.dialog:nil},set:{value in if value==nil,controller.detached,let dialog=controller.state?.dialog {controller.send(["type":"dialog","id":dialog.id,"accept":false,"text":""])}})) {dialog in TaskHostBrowserDialogView(dialog:dialog,answer:{accept,text in controller.send(["type":"dialog","id":dialog.id,"accept":accept,"text":text])})}
    }
}
@MainActor final class TaskHostBrowserMiniWindow:NSObject,ObservableObject,NSWindowDelegate {
    @Published private(set) var image:CGImage?
    @Published private(set) var error:String?
    private weak var controller:TaskHostBrowserController?
    private var window:NSPanel?
    private var subscription:UUID?
    private var aspect:Double?
    private let surface=UUID()
    init(controller:TaskHostBrowserController) {self.controller=controller;super.init()}
    func show() {
        guard let controller,!controller.closed else{return};controller.acquireSurface(surface)
        let panel=NSPanel(contentRect:CGRect(x:0,y:0,width:480,height:320),styleMask:[.titled,.closable,.resizable,.nonactivatingPanel,.fullSizeContentView],backing:.buffered,defer:false)
        panel.title=FridayAppName.displayName+" · "+String(localized:"置顶小预览",bundle:.module);panel.titleVisibility = .hidden;panel.titlebarAppearsTransparent=true;panel.level = .floating;panel.isFloatingPanel=true;panel.hidesOnDeactivate=false;panel.isReleasedWhenClosed=false;panel.isExcludedFromWindowsMenu=true;panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];panel.contentMinSize=CGSize(width:240,height:160);panel.delegate=self
        window=panel;panel.contentView=NSHostingView(rootView:TaskHostBrowserMiniContent(model:self,controller:controller));panel.center();panel.orderFrontRegardless()
        subscription=controller.frames.subscribe(fps:12) {[weak self] result,_ in
            guard let self,let window else{return}
            switch result {case .failure(let error):self.error=error.localizedDescription
            case .success(let image):self.image=image;error=nil;let next=Double(image.width)/Double(image.height)
                if aspect==nil || abs((aspect ?? next)-next)>0.002 {aspect=next;let size=TaskBrowserCapturePolicy.pictureSize(window.contentRect(forFrameRect:window.frame).size,aspect:next);window.contentAspectRatio=CGSize(width:image.width,height:image.height);window.setContentSize(size)}
            }
        }
    }
    func close() {window?.performClose(nil)}
    func windowWillClose(_ notification:Notification) {
        let old=window;window=nil;old?.contentView=nil;old?.delegate=nil
        if let controller {if let subscription {controller.frames.unsubscribe(subscription)};self.subscription=nil;if controller.miniWindow === self {controller.miniWindow=nil};controller.releaseSurface(surface)}
    }
}
private struct TaskHostBrowserMiniContent:View {
    @ObservedObject var model:TaskHostBrowserMiniWindow
    @ObservedObject var controller:TaskHostBrowserController
    var body:some View {
        ZStack {FridayTheme.canvas;if let image=model.image {Image(decorative:image,scale:1,orientation:.up).resizable().aspectRatio(contentMode:.fit)}else if let error=model.error {Text(fridayString:error).font(.caption).padding()}}
            .overlay(alignment:.topTrailing) {HStack(spacing:4) {Button {controller.showStandalone();model.close()} label:{FridaySymbolImage(systemName:"arrow.up.left.and.arrow.down.right")};Button {model.close()} label:{FridaySymbolImage(systemName:"xmark")}}.buttonStyle(FridaySymbolButtonStyle()).padding(4).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8)).padding(6)}
    }
}
#endif
