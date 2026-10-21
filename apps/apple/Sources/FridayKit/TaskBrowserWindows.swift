#if os(macOS)
import AppKit
import SwiftUI

@MainActor final class TaskBrowserInlineHost:NSView {
    weak var controller:TaskBrowserController?
    let floating:Bool
    init(controller:TaskBrowserController,floating:Bool=false) {self.controller=controller;self.floating=floating;super.init(frame:.zero)}
    required init?(coder:NSCoder) {fatalError("init(coder:) has not been implemented")}
    func attach() {
        guard let controller,!controller.detached,!controller.closed,controller.floatingInTask==floating else{return};controller.inlineHost=self
        if controller.view.superview !== self {controller.view.removeFromSuperview();addSubview(controller.view)}
        controller.view.frame=bounds;controller.view.autoresizingMask=[.width,.height]
        controller.retainedWindow?.contentView=nil;controller.retainedWindow?.close();controller.retainedWindow=nil
    }
    override func layout() {super.layout();if let controller,controller.view.superview === self {controller.view.frame=bounds}}
    func unmount() {
        guard let controller else{return};if controller.inlineHost === self {controller.inlineHost=nil}
        guard controller.view.superview === self else{return}
        controller.view.removeFromSuperview();controller.retainForCapture()
    }
}
extension TaskBrowserController {
    func retainForCapture() {
        guard !closed,!detached,retainedWindow==nil,framePump?.active==true else{return}
        let size=view.bounds.size,window=NSWindow(contentRect:CGRect(origin:CGPoint(x:-10000,y:-10000),size:size),styleMask:.borderless,backing:.buffered,defer:false)
        window.isReleasedWhenClosed=false;window.isExcludedFromWindowsMenu=true;window.ignoresMouseEvents=true;window.alphaValue=0
        window.collectionBehavior=[.canJoinAllSpaces,.stationary,.ignoresCycle];let host=NSView(frame:CGRect(origin:.zero,size:size));window.contentView=host
        view.removeFromSuperview();view.frame=host.bounds;view.autoresizingMask=[.width,.height];host.addSubview(view);retainedWindow=window;window.orderBack(nil)
    }
    func releaseRetainedWindowIfUnused() {
        guard framePump?.active != true else{return}
        if let inlineHost,!detached {inlineHost.attach()}
        else {view.removeFromSuperview();retainedWindow?.contentView=nil;retainedWindow?.close();retainedWindow=nil}
    }
    func showStandalone() {
        guard !closed,url != nil else{return}
        if let standalone {standalone.window?.makeKeyAndOrderFront(nil);return}
        annotationSession?.cancel();let value=TaskBrowserStandaloneWindow(controller:self);standalone=value;detached=true;value.show()
    }
    func returnInline() {standalone?.close()}
    func toggleMiniPlayer() {
        guard !closed,url != nil else{return}
        if let miniWindow {miniWindow.close();return}
        let value=TaskBrowserMiniWindow(controller:self);miniWindow=value;miniPlayer=true;value.show()
    }
}
@MainActor final class TaskBrowserStandaloneWindow:NSObject,NSWindowDelegate {
    weak var controller:TaskBrowserController?
    private(set) var window:NSWindow?
    var dismissed:(()->Void)?
    init(controller:TaskBrowserController) {self.controller=controller;super.init()}
    func show() {
        guard let controller else{return}
        let size=CGSize(width:min(1100,max(640,controller.view.bounds.width)),height:min(850,max(480,controller.view.bounds.height+50)))
        let window=NSWindow(contentRect:CGRect(origin:.zero,size:size),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false)
        window.title=FridayAppName.displayName+" · "+(controller.title ?? String(localized:"网页预览",bundle:.module));window.isReleasedWhenClosed=false;window.contentMinSize=CGSize(width:360,height:280);window.delegate=self
        self.window=window;window.contentView=NSHostingView(rootView:TaskBrowserStandaloneContent(controller:controller));window.center();window.makeKeyAndOrderFront(nil)
    }
    func close() {window?.close()}
    func windowWillClose(_ notification:Notification) {
        guard let controller else{return};controller.annotationSession?.cancel();controller.view.removeFromSuperview();window?.contentView=nil;window?.delegate=nil;window=nil
        controller.detached=false;controller.standalone=nil
        if let inlineHost=controller.inlineHost {inlineHost.attach()}else{controller.retainForCapture()}
        let callback=dismissed;dismissed=nil;callback?()
    }
}
private struct TaskBrowserStandaloneContent:View {
    @ObservedObject var controller:TaskBrowserController
    var body:some View {
        VStack(spacing:0) {
            HStack(spacing:8) {
                Button {controller.goBack()} label:{FridaySymbolImage(systemName:"chevron.left")}.disabled(!controller.back)
                Button {controller.goForward()} label:{FridaySymbolImage(systemName:"chevron.right")}.disabled(!controller.forward)
                Button {controller.reload()} label:{FridaySymbolImage(systemName:controller.loading ? "xmark":"arrow.clockwise")}
                Text(verbatim:controller.url ?? "").font(.caption).lineLimit(1).truncationMode(.middle).textSelection(.enabled);Spacer(minLength:0)
                TaskBrowserAudioButton(controller:controller)
                Button {controller.openDevTools()} label:{FridaySymbolImage(systemName:"hammer")}.disabled(!controller.canInspectPage).help(Text(friday:"打开开发工具"))
                TaskBrowserCaptureButton(controller:controller)
                Button {controller.toggleMiniPlayer()} label:{FridaySymbolImage(systemName:"pip")}.help(Text(friday:"置顶小预览"))
                Button {controller.returnInline()} label:{FridaySymbolImage(systemName:"arrow.down.right.and.arrow.up.left")}.help(Text(friday:"返回任务侧栏"))
            }.buttonStyle(FridaySymbolButtonStyle()).padding(8)
            if let session=controller.annotationSession {TaskBrowserAnnotationToolbar(session:session)}
            GeometryReader {geometry in
                let size=controller.preferredViewport ?? geometry.size,scale=min(1,max(1,geometry.size.width)/max(1,size.width),max(1,geometry.size.height)/max(1,size.height))
                TaskBrowserDetachedNativeView(controller:controller).frame(width:size.width,height:size.height).scaleEffect(scale,anchor:.topLeading).frame(width:size.width*scale,height:size.height*scale).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
            }.frame(maxWidth:.infinity,maxHeight:.infinity).clipped()
            if let session=controller.annotationSession {TaskBrowserAnnotationComment(session:session)}
            if let session=controller.recordingSession {TaskBrowserRecordingStatus(session:session)}
        }.background(FridayTheme.canvas).overlay(alignment:.bottom) {TaskBrowserArtifactNotice(controller:controller)}
            .overlay(alignment:.bottom) {if controller.capturedArtifact==nil,let message=controller.message {HStack {Text(fridayString:message).font(.caption);Button {controller.message=nil} label:{FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle())}.padding(10).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8)).padding(10)}}
            .frame(minWidth:360,minHeight:280)
            .modifier(TaskBrowserFileExport(controller:controller,detached:true))
            .onChange(of:controller.title) {_,title in controller.standalone?.window?.title=FridayAppName.displayName+" · "+(title ?? String(localized:"网页预览",bundle:.module))}
    }
}
private struct TaskBrowserDetachedNativeView:NSViewRepresentable {
    let controller:TaskBrowserController
    func makeNSView(context:Context)->NSView {let host=NSView();controller.view.removeFromSuperview();host.addSubview(controller.view);controller.view.frame=host.bounds;controller.view.autoresizingMask=[.width,.height];controller.retainedWindow?.contentView=nil;controller.retainedWindow?.close();controller.retainedWindow=nil;return host}
    func updateNSView(_ view:NSView,context:Context) {if controller.view.superview === view {controller.view.frame=view.bounds}}
}

@MainActor final class TaskBrowserMiniWindow:NSObject,ObservableObject,NSWindowDelegate {
    @Published private(set) var image:CGImage?
    @Published private(set) var error:String?
    private weak var controller:TaskBrowserController?
    private var subscription:UUID?
    private var window:NSPanel?
    private var aspect:Double?
    init(controller:TaskBrowserController) {self.controller=controller;super.init()}
    func show() {
        guard let controller else{return}
        let panel=NSPanel(contentRect:CGRect(x:0,y:0,width:480,height:320),styleMask:[.titled,.closable,.resizable,.nonactivatingPanel,.fullSizeContentView],backing:.buffered,defer:false)
        panel.title=FridayAppName.displayName+" · "+String(localized:"置顶小预览",bundle:.module);panel.titleVisibility = .hidden;panel.titlebarAppearsTransparent=true;panel.level = .floating
        panel.isFloatingPanel=true;panel.hidesOnDeactivate=false;panel.isReleasedWhenClosed=false;panel.isExcludedFromWindowsMenu=true;panel.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];panel.contentMinSize=CGSize(width:240,height:160);panel.delegate=self
        window=panel;panel.contentView=NSHostingView(rootView:TaskBrowserMiniContent(model:self,controller:controller));panel.center();panel.orderFrontRegardless()
        subscription=controller.frames.subscribe(fps:12) { [weak self] result,_ in
            guard let self,let window=self.window else{return}
            switch result {
            case .failure(let error):self.error=error.localizedDescription
            case .success(let image):
                self.error=nil;self.image=image;let next=Double(image.width)/Double(image.height)
                if aspect==nil || abs((aspect ?? next)-next)>0.002 {
                    aspect=next;let content=window.contentRect(forFrameRect:window.frame).size,size=TaskBrowserCapturePolicy.pictureSize(content,aspect:next)
                    window.contentAspectRatio=CGSize(width:image.width,height:image.height);window.setContentSize(size)
                }
            }
        }
    }
    func close() {window?.close()}
    func windowWillClose(_ notification:Notification) {
        if let subscription {controller?.framePump?.unsubscribe(subscription)};subscription=nil;image=nil
        window?.contentView=nil;window?.delegate=nil;window=nil
        controller?.miniPlayer=false;controller?.miniWindow=nil;controller?.releaseRetainedWindowIfUnused()
    }
}
private struct TaskBrowserMiniContent:View {
    @ObservedObject var model:TaskBrowserMiniWindow
    @ObservedObject var controller:TaskBrowserController
    @State private var hovering=false
    var body:some View {
        ZStack {
            Color.black
            if let image=model.image {Image(decorative:image,scale:1).resizable().scaledToFit()}
            if let error=model.error {Text(fridayString:error).font(.caption).foregroundStyle(.white).padding(12)}
            if hovering {
                VStack {HStack {Spacer();Button {controller.showStandalone()} label:{FridaySymbolImage(systemName:"arrow.up.left.and.arrow.down.right")}.help(Text(friday:"打开独立预览窗口"));Button {model.close()} label:{FridaySymbolImage(systemName:"xmark")}.help(Text(friday:"关闭小预览"))};Spacer()}.buttonStyle(FridaySymbolButtonStyle()).padding(8).background(alignment:.top) {LinearGradient(colors:[.black.opacity(0.5),.clear],startPoint:.top,endPoint:.bottom).frame(height:60)}.foregroundStyle(.white)
            }
        }.onHover {hovering=$0}.frame(minWidth:240,minHeight:160)
    }
}
#endif
