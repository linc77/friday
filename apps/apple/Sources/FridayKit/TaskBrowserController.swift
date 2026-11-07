import SwiftUI
import WebKit
import CryptoKit
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskBrowserExport:Identifiable {let id=UUID();let url:URL}
struct TaskBrowserUpload:Identifiable {let id=UUID();let multiple:Bool;let directories:Bool;let completion:([URL]?)->Void}

@MainActor final class TaskBrowserSessions:ObservableObject {
    static let shared=TaskBrowserSessions()
    private var values:[String:TaskBrowserController]=[:]
    private var dataStores:[String:WKWebsiteDataStore]=[:]
    func profileDataStore(scope:String,profile:String)->WKWebsiteDataStore {
        let key=scope+"\n"+profile+"\nfalse";if let value=dataStores[key] {return value}
        let value=TaskBrowserController.makeDataStore(profileScope:scope,tab:TaskBrowserTab(profile:profile));dataStores[key]=value;return value
    }
    @Published private(set) var floating:[String:TaskBrowserFloatingState]=[:]
    func clearProfileData(profileScope:String,profile:String)async {
        let prefix=profileScope+"\n"+profile+"\n"
        var stores=dataStores.filter {$0.key.hasPrefix(prefix)}.map(\.value)
        if profile != "incognito",stores.isEmpty {stores=[TaskBrowserController.makeDataStore(profileScope:profileScope,tab:TaskBrowserTab(profile:profile))]}
        for store in stores {await TaskBrowserWebsiteData.clear(store,types:TaskBrowserWebsiteData.cookies.union(TaskBrowserWebsiteData.cache))}
    }
    func existing(scope:String,id:String)->TaskBrowserController? {values[scope+"\n"+id]}
    func float(scope:String,id:String,host:Bool=false) {
        if host {
            guard let controller=TaskHostBrowserSessions.shared.existing(scope:scope,id:id),!controller.closed else{return}
            if floating[scope]?.tabID==id,floating[scope]?.host==true {return}
            let old=floating[scope];closeFloat(scope:scope)
            controller.floatingInTask=true
            #if os(macOS)
            controller.returnInline()
            #endif
            let size=controller.viewport
            floating[scope]=TaskBrowserFloatingState(tabID:id,source:.init(width:max(1,size.width),height:max(1,size.height)),width:old?.width,position:old?.position,lastInteraction:old?.lastInteraction ?? "drag",host:true)
            return
        }
        guard let controller=existing(scope:scope,id:id),!controller.closed else{return}
        if floating[scope]?.tabID==id,floating[scope]?.host==false {return}
        let old=floating[scope];closeFloat(scope:scope)
        #if os(macOS)
        controller.returnInline()
        #endif
        let source=controller.preferredViewport ?? controller.view.bounds.size
        floating[scope]=TaskBrowserFloatingState(tabID:id,source:.init(width:max(1,source.width),height:max(1,source.height)),width:old?.width,position:old?.position,lastInteraction:old?.lastInteraction ?? "drag")
        controller.floatingInTask=true
    }
    func closeFloat(scope:String,id:String?=nil) {
        guard let state=floating[scope],id==nil || state.tabID==id else{return}
        if state.host {TaskHostBrowserSessions.shared.existing(scope:scope,id:state.tabID)?.floatingInTask=false}else{existing(scope:scope,id:state.tabID)?.floatingInTask=false};floating.removeValue(forKey:scope)
    }
    func moveFloat(scope:String,id:String,point:TaskBrowserMiniPoint) {guard var value=floating[scope],value.tabID==id else{return};value.move(source:id,position:point);floating[scope]=value}
    func resizeFloat(scope:String,id:String,frame:TaskBrowserMiniFrame) {guard var value=floating[scope],value.tabID==id else{return};value.resize(source:id,width:frame.width,position:frame.point);floating[scope]=value}
    func controller(scope:String,profileScope:String,tab:TaskBrowserTab,configuration:WKWebViewConfiguration?=nil)->TaskBrowserController {
        let key=scope+"\n"+tab.id
        if let value=values[key] { return value }
        let storageKey=profileScope+"\n"+tab.profile+"\n"+String(tab.incognito)
        let dataStore=dataStores[storageKey] ?? TaskBrowserController.makeDataStore(profileScope:profileScope,tab:tab);dataStores[storageKey]=dataStore
        let value=TaskBrowserController(profileScope:profileScope,tab:tab,configuration:configuration,dataStore:dataStore);values[key]=value;return value
    }
    func close(scope:String,id:String) {
        TaskHostBrowserSessions.shared.close(scope:scope,id:id)
        closeFloat(scope:scope,id:id)
        guard let value=values.removeValue(forKey:scope+"\n"+id) else{return};value.close()
        if value.incognito,!values.values.contains(where:{$0.storageKey==value.storageKey}) {dataStores.removeValue(forKey:value.storageKey)}
    }
    func close(owner:UUID,connection:String?=nil,task:String?=nil) {
        TaskHostBrowserSessions.shared.close(owner:owner,connection:connection,task:task)
        let prefix=owner.uuidString+"\n"+(connection.map {$0+"\n"} ?? "")+(task.map {$0+"\n"} ?? "")
        for key in floating.keys.filter({$0.hasPrefix(prefix) || $0+"\n"==prefix}) {closeFloat(scope:key)}
        for key in values.keys.filter({$0.hasPrefix(prefix)}) {values.removeValue(forKey:key)?.close()}
        purgeDataStores()
    }
    func reconcile(owner:UUID,connection:String,taskIDs:Set<String>?=nil) {
        TaskHostBrowserSessions.shared.reconcile(owner:owner,connection:connection,taskIDs:taskIDs)
        for key in floating.keys.filter({TaskBrowserSessionScope.obsolete($0,owner:owner,connection:connection,taskIDs:taskIDs)}) {closeFloat(scope:key)}
        for key in values.keys.filter({TaskBrowserSessionScope.obsolete($0,owner:owner,connection:connection,taskIDs:taskIDs)}) {values.removeValue(forKey:key)?.close()}
        purgeDataStores()
    }
    private func purgeDataStores() {
        let retained=Set(values.values.map(\.storageKey))
        for key in dataStores.keys.filter({!retained.contains($0)}) {dataStores.removeValue(forKey:key)}
    }
}

@MainActor final class TaskBrowserController:NSObject,ObservableObject,WKNavigationDelegate,WKUIDelegate,WKDownloadDelegate {
    let view:WKWebView
    @Published private(set) var url:String?
    @Published private(set) var title:String?
    @Published private(set) var loading=false
    @Published private(set) var progress=0.0
    @Published private(set) var back=false
    @Published private(set) var forward=false
    @Published private(set) var error:String?
    @Published var capturing=false
    @Published var exported:TaskBrowserExport?
    @Published var upload:TaskBrowserUpload?
    @Published var message:String?
    @Published var audioMuted=false
    @Published var audible=false
    private var audioWatch:Task<Void,Never>?
    @Published var annotationSession:TaskBrowserAnnotationSession?
    @Published var recordingSession:TaskBrowserRecordingSession?
    @Published var capturedArtifact:TaskBrowserArtifact?
    @Published var artifacts:[TaskBrowserArtifact]=[]
    @Published var interruptedArtifacts:[TaskBrowserArtifact]=[]
    @Published var recoveringArtifacts:Set<String>=[]
    @Published var detached=false
    @Published var miniPlayer=false
    @Published var floatingInTask=false
    @Published var preferredViewport:CGSize?
    private(set) var closed=false
    var framePump:TaskBrowserFrames?
    private var artifactObserver:NSObjectProtocol?
    let artifactScope:String
    #if os(macOS)
    var standalone:TaskBrowserStandaloneWindow?
    var miniWindow:TaskBrowserMiniWindow?
    var retainedWindow:NSWindow?
    weak var inlineHost:TaskBrowserInlineHost?
    var ownedPopups:[UUID:TaskBrowserController]=[:]
    #endif
    var documentID=UUID()
    let annotationWorld=WKContentWorld.world(name:"FridayBrowserAnnotations-"+UUID().uuidString)
    let recordingWorld=WKContentWorld.world(name:"FridayBrowserRecording-"+UUID().uuidString)
    var metadata:((String?,String?,Bool)->Void)?
    var popup:((WKWebViewConfiguration,URL?)->WKWebView?)?
    var popupOwner:UUID?
    var windowClosed:(()->Void)?
    private var observations:[NSKeyValueObservation]=[]
    private var navigationID:String?
    let incognito:Bool
    let storageKey:String
    private var server=""
    private var lastRequestedURL:URL?
    private var uploadAccess:[URL]=[]
    private var downloads:[ObjectIdentifier:WKDownload]=[:]
    private var downloadURLs:[ObjectIdentifier:URL]=[:]
    private var downloadDestinations:[ObjectIdentifier:URL]=[:]
    private let profileScope:String
    static func makeDataStore(profileScope:String,tab:TaskBrowserTab)->WKWebsiteDataStore {
        if tab.incognito {return .nonPersistent()}
        let bytes=Array(SHA256.hash(data:Data((profileScope+"\n"+tab.profile).utf8)).prefix(16))
        let identifier=UUID(uuid:(bytes[0],bytes[1],bytes[2],bytes[3],bytes[4],bytes[5],bytes[6],bytes[7],bytes[8],bytes[9],bytes[10],bytes[11],bytes[12],bytes[13],bytes[14],bytes[15]))
        return WKWebsiteDataStore(forIdentifier:identifier)
    }
    init(profileScope:String,tab:TaskBrowserTab,configuration:WKWebViewConfiguration?=nil,dataStore:WKWebsiteDataStore?=nil) {
        artifactScope=profileScope
        self.profileScope=profileScope;incognito=tab.incognito;storageKey=profileScope+"\n"+tab.profile+"\n"+String(tab.incognito)
        let config=configuration ?? WKWebViewConfiguration()
        if configuration == nil {
            config.websiteDataStore=dataStore ?? Self.makeDataStore(profileScope:profileScope,tab:tab)
            config.preferences.javaScriptCanOpenWindowsAutomatically=false
            #if os(macOS)
            config.preferences.isElementFullscreenEnabled=true
            #else
            config.allowsInlineMediaPlayback=true;config.allowsPictureInPictureMediaPlayback=true
            #endif
        }
        view=WKWebView(frame:.zero,configuration:config)
        super.init();view.navigationDelegate=self;view.uiDelegate=self;view.allowsBackForwardNavigationGestures=true;view.isInspectable=true
        #if os(macOS)
        view.allowsMagnification=true
        #endif
        observations=[
            view.observe(\.isLoading,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() },
            view.observe(\.estimatedProgress,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() },
            view.observe(\.url,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() },
            view.observe(\.title,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() },
            view.observe(\.canGoBack,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() },
            view.observe(\.canGoForward,options:[.new]) { [weak self] _,_ in self?.scheduleUpdate() }
        ]
        audioWatch=Task { @MainActor [weak self] in
            while !Task.isCancelled {do {try await Task.sleep(for:.milliseconds(500))}catch{return};guard let self,!self.closed else{return};self.refreshAudio()}
        }
        if configuration != nil { navigationID=tab.navigationID }
        artifacts=(try? TaskBrowserArtifactStore(scope:artifactScope).recent()) ?? []
        refreshInterruptedRecordings()
        artifactObserver=NotificationCenter.default.addObserver(forName:TaskBrowserArtifactStore.saved,object:nil,queue:.main) { [weak self] note in
            guard let path=note.object as? String,let artifact=note.userInfo?["artifact"] as? TaskBrowserArtifact else{return}
            Task { @MainActor [weak self] in
                guard let self,!self.closed,let store=try? TaskBrowserArtifactStore(scope:self.artifactScope),store.directory.path==path else{return}
                self.publish(artifact,store:store)
            }
        }
    }
    nonisolated private func scheduleUpdate() { Task { @MainActor [weak self] in self?.update() } }
    private func update() {
        refreshAudio()
        url=view.url.flatMap { TaskBrowserPolicy.url($0.absoluteString)?.absoluteString };title=view.title
        loading=view.isLoading;progress=view.estimatedProgress;back=view.canGoBack;forward=view.canGoForward
        metadata?(url,title,!loading)
    }
    func refreshMetadata() {if !closed {update()}}
    func apply(_ tab:TaskBrowserTab,server:String) {
        self.server=server
        preferredViewport=tab.viewportWidth.flatMap {width in tab.viewportHeight.map {CGSize(width:Double(width)*tab.zoom,height:Double($0)*tab.zoom)}}
        view.pageZoom=CGFloat(tab.zoom)
        #if os(macOS)
        view.appearance=tab.appearance == "dark" ? NSAppearance(named:.darkAqua):tab.appearance == "light" ? NSAppearance(named:.aqua):nil
        #else
        view.overrideUserInterfaceStyle=tab.appearance == "dark" ? .dark:tab.appearance == "light" ? .light:.unspecified
        #endif
        guard navigationID != tab.navigationID else { return };navigationID=tab.navigationID
        guard let raw=tab.url,let url=TaskBrowserPolicy.url(raw) else { return }
        lastRequestedURL=url
        guard TaskBrowserPolicy.canOpen(url,server:server) else { error="此页面仅在主机本地可访问";return }
        error=nil;view.load(URLRequest(url:url))
    }
    func goBack() { error=nil;view.goBack() }
    func goForward() { error=nil;view.goForward() }
    func reload(hard:Bool=false) {
        if loading && !hard {view.stopLoading();return}
        guard let url=view.url ?? lastRequestedURL,TaskBrowserPolicy.canOpen(url,server:server) else{return};error=nil
        if view.url==nil {view.load(URLRequest(url:url))} else if hard {view.reloadFromOrigin()} else {view.reload()}
    }
    func retry() {reload()}
    func clearCookies() {
        Task {await TaskBrowserWebsiteData.clear(view.configuration.websiteDataStore,types:TaskBrowserWebsiteData.cookies);if !closed {message="Cookie 已清除"}}
    }
    func clearCache() {
        Task {await TaskBrowserWebsiteData.clear(view.configuration.websiteDataStore,types:TaskBrowserWebsiteData.cache);if !closed {message="缓存已清除"}}
    }
    func capture() {
        capturePageArtifact()
    }
    func openExternal() {
        guard let url=url.flatMap(TaskBrowserPolicy.url) else { return }
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        UIApplication.shared.open(url)
        #endif
    }
    func close() {
        guard !closed else{return};closed=true;audioWatch?.cancel();audioWatch=nil;_ = TaskBrowserNativeControls.inspect(view,show:false)
        if let artifactObserver {NotificationCenter.default.removeObserver(artifactObserver)};artifactObserver=nil
        recordingSession?.stop()
        #if os(macOS)
        for child in Array(ownedPopups.values) {child.close()};ownedPopups=[:]
        standalone?.close();standalone=nil;miniWindow?.close();miniWindow=nil;retainedWindow?.close();retainedWindow=nil
        #endif
        framePump?.close()
        annotationSession?.cancel()
        view.stopLoading();metadata=nil;popup=nil;windowClosed=nil;observations=[];view.navigationDelegate=nil;view.uiDelegate=nil
        for download in downloads.values { download.cancel { _ in } };downloads=[:]
        upload?.completion(nil);upload=nil
        uploadAccess.forEach {$0.stopAccessingSecurityScopedResource()};uploadAccess=[]
    }
    func completeUpload(_ urls:[URL]?) {for url in urls ?? [] {if url.startAccessingSecurityScopedResource() {uploadAccess.append(url)}};let callback=upload?.completion;upload=nil;callback?(urls)}
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void) {
        guard let url=navigationAction.request.url else { decisionHandler(.cancel);return }
        if url.absoluteString == "about:blank" { decisionHandler(.allow);return }
        if ["blob","data"].contains(url.scheme ?? ""),navigationAction.shouldPerformDownload {decisionHandler(.download);return}
        if ["blob","data"].contains(url.scheme ?? ""),navigationAction.targetFrame?.isMainFrame==false {decisionHandler(.allow);return}
        guard TaskBrowserPolicy.url(url.absoluteString) != nil else { decisionHandler(.cancel);return }
        guard TaskBrowserPolicy.canOpen(url,server:server) else {if navigationAction.targetFrame?.isMainFrame != false {error="此页面仅在主机本地可访问"};decisionHandler(.cancel);return}
        if navigationAction.shouldPerformDownload { decisionHandler(.download) } else { decisionHandler(.allow) }
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationResponse:WKNavigationResponse,decisionHandler:@escaping(WKNavigationResponsePolicy)->Void) { decisionHandler(navigationResponse.canShowMIMEType ? .allow:.download) }
    func webView(_ webView:WKWebView,didStartProvisionalNavigation navigation:WKNavigation!) {annotationSession?.cancel();documentID=UUID()}
    func webView(_ webView:WKWebView,didCommit navigation:WKNavigation!) {documentID=UUID();recordingSession?.restoreInput()}
    func webView(_ webView:WKWebView,didFinish navigation:WKNavigation!) {
        if audioMuted {_ = TaskBrowserNativeControls.mute(view,true)}
 error=nil;update() }
    func webView(_ webView:WKWebView,didFail navigation:WKNavigation!,withError error:any Error) { fail(error) }
    func webView(_ webView:WKWebView,didFailProvisionalNavigation navigation:WKNavigation!,withError error:any Error) { fail(error) }
    private func fail(_ failure:any Error) { if (failure as NSError).code != NSURLErrorCancelled { error=failure.localizedDescription;loading=false } }
    func webViewWebContentProcessDidTerminate(_ webView:WKWebView) { recordingSession?.stop();annotationSession?.cancel();documentID=UUID();error="网页进程已结束，请重新加载";loading=false }
    func webView(_ webView:WKWebView,createWebViewWith configuration:WKWebViewConfiguration,for navigationAction:WKNavigationAction,windowFeatures:WKWindowFeatures)->WKWebView? {
        guard navigationAction.targetFrame == nil else { return nil }
        if let url=navigationAction.request.url,url.absoluteString != "about:blank",TaskBrowserPolicy.url(url.absoluteString)==nil { return nil }
        if let created=popup?(configuration,navigationAction.request.url) {return created}
        #if os(macOS)
        if detached || miniPlayer || floatingInTask {
            let id=UUID(),tab=TaskBrowserTab(url:navigationAction.request.url?.absoluteString,incognito:incognito)
            let child=TaskBrowserController(profileScope:profileScope,tab:tab,configuration:configuration,dataStore:view.configuration.websiteDataStore)
            child.apply(tab,server:server);ownedPopups[id]=child
            let window=TaskBrowserStandaloneWindow(controller:child);child.standalone=window;child.detached=true
            window.dismissed={ [weak self,weak child] in self?.ownedPopups.removeValue(forKey:id);child?.close() }
            child.windowClosed={ [weak child] in child?.standalone?.close() };window.show();return child.view
        }
        #endif
        return nil
    }
    func webViewDidClose(_ webView:WKWebView) { windowClosed?() }
    func webView(_ webView:WKWebView,runJavaScriptAlertPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping()->Void) { TaskBrowserDialogs.show(view:webView,origin:frame.securityOrigin.host,message:message,kind:.alert) { _ in completionHandler() } }
    func webView(_ webView:WKWebView,runJavaScriptConfirmPanelWithMessage message:String,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(Bool)->Void) { TaskBrowserDialogs.show(view:webView,origin:frame.securityOrigin.host,message:message,kind:.confirm) { completionHandler($0 != nil) } }
    func webView(_ webView:WKWebView,runJavaScriptTextInputPanelWithPrompt prompt:String,defaultText:String?,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping(String?)->Void) { TaskBrowserDialogs.show(view:webView,origin:frame.securityOrigin.host,message:prompt,kind:.text(defaultText ?? ""),completion:completionHandler) }
    @available(iOS 18.4,*) func webView(_ webView:WKWebView,runOpenPanelWith parameters:WKOpenPanelParameters,initiatedByFrame frame:WKFrameInfo,completionHandler:@escaping([URL]?)->Void) {
        #if os(macOS)
        guard let window=webView.window else { completionHandler(nil);return };let panel=NSOpenPanel();panel.allowsMultipleSelection=parameters.allowsMultipleSelection;panel.canChooseDirectories=parameters.allowsDirectories;panel.canChooseFiles=true
        panel.beginSheetModal(for:window) { result in completionHandler(result == .OK ? panel.urls:nil) }
        #else
        upload=TaskBrowserUpload(multiple:parameters.allowsMultipleSelection,directories:parameters.allowsDirectories,completion:completionHandler)
        #endif
    }
    func webView(_ webView:WKWebView,navigationAction:WKNavigationAction,didBecome download:WKDownload) { retain(download) }
    func webView(_ webView:WKWebView,navigationResponse:WKNavigationResponse,didBecome download:WKDownload) { retain(download) }
    private func retain(_ download:WKDownload) { downloads[ObjectIdentifier(download)]=download;download.delegate=self }
    func download(_ download:WKDownload,decideDestinationUsing response:URLResponse,suggestedFilename:String,completionHandler:@escaping(URL?)->Void) {
        let name=TaskBrowserDownloadFiles.name(suggestedFilename)
        #if os(macOS)
        guard let window=view.window else { completionHandler(nil);return };let panel=NSSavePanel();panel.nameFieldStringValue=name
        panel.beginSheetModal(for:window) { [weak self] result in
            guard let self,result == .OK,let destination=panel.url else{completionHandler(nil);return}
            do {let temporary=try TaskBrowserDownloadFiles.temporary(name);self.downloadURLs[ObjectIdentifier(download)]=temporary;self.downloadDestinations[ObjectIdentifier(download)]=destination;completionHandler(temporary)}
            catch {self.message=error.localizedDescription;completionHandler(nil)}
        }
        #else
        do {let url=try TaskBrowserDownloadFiles.temporary(name);downloadURLs[ObjectIdentifier(download)]=url;completionHandler(url)} catch {message=error.localizedDescription;completionHandler(nil)}
        #endif
    }
    func downloadDidFinish(_ download:WKDownload) {
        let key=ObjectIdentifier(download);downloads.removeValue(forKey:key)
        if let url=downloadURLs.removeValue(forKey:key) {
            #if os(iOS)
            exported=TaskBrowserExport(url:url)
            #else
            if let destination=downloadDestinations.removeValue(forKey:key) {
                Task { [weak self] in
                    do {try await Task.detached {try TaskBrowserDownloadFiles.install(url,to:destination);TaskBrowserDownloadFiles.removeTemporary(url)}.value;self?.message="下载完成"}
                    catch {self?.message=error.localizedDescription;TaskBrowserDownloadFiles.removeTemporary(url)}
                }
            }
            #endif
        }
    }
    func download(_ download:WKDownload,didFailWithError error:any Error,resumeData:Data?) {
        let key=ObjectIdentifier(download);downloads.removeValue(forKey:key);if let url=downloadURLs.removeValue(forKey:key) {TaskBrowserDownloadFiles.removeTemporary(url)};downloadDestinations.removeValue(forKey:key)
        if (error as NSError).code != NSURLErrorCancelled {message=error.localizedDescription}
    }
}

enum TaskBrowserDialogKind {case alert,confirm,text(String)}
@MainActor enum TaskBrowserDialogs {
    static func show(view:WKWebView,origin:String,message:String,kind:TaskBrowserDialogKind,completion:@escaping(String?)->Void) {
        #if os(macOS)
        guard let window=view.window else { completion(nil);return }
        let alert=NSAlert();alert.messageText=origin.isEmpty ? view.url?.host ?? "网页":origin;alert.informativeText=message;alert.addButton(withTitle:String(localized:"确定",bundle:.module))
        var field:NSTextField?
        if case .text(let initial)=kind { let value=NSTextField(string:initial);value.frame=NSRect(x:0,y:0,width:280,height:24);alert.accessoryView=value;field=value }
        if case .alert=kind {} else { alert.addButton(withTitle:String(localized:"取消",bundle:.module)) }
        alert.beginSheetModal(for:window) { response in completion(response == .alertFirstButtonReturn ? field?.stringValue ?? "":nil) }
        #else
        var responder:UIResponder?=view;while responder != nil && !(responder is UIViewController) { responder=responder?.next }
        guard let parent=responder as? UIViewController,parent.presentedViewController==nil else { completion(nil);return }
        let alert=UIAlertController(title:origin.isEmpty ? view.url?.host:origin,message:message,preferredStyle:.alert)
        if case .text(let initial)=kind { alert.addTextField { $0.text=initial } }
        alert.addAction(UIAlertAction(title:String(localized:"确定",bundle:.module),style:.default) { _ in completion(alert.textFields?.first?.text ?? "") })
        if case .alert=kind {} else { alert.addAction(UIAlertAction(title:String(localized:"取消",bundle:.module),style:.cancel) { _ in completion(nil) }) }
        parent.present(alert,animated:true)
        #endif
    }
}

struct TaskBrowserNativeView {
    let controller:TaskBrowserController
    var floating=false
}
#if os(macOS)
extension TaskBrowserNativeView:NSViewRepresentable {
    func makeNSView(context:Context)->TaskBrowserInlineHost {let host=TaskBrowserInlineHost(controller:controller,floating:floating);host.attach();return host}
    func updateNSView(_ view:TaskBrowserInlineHost,context:Context) {view.attach()}
    static func dismantleNSView(_ view:TaskBrowserInlineHost,coordinator:()) {view.unmount()}
}
#else
extension TaskBrowserNativeView:UIViewRepresentable {
    func makeUIView(context:Context)->TaskBrowserMobileHost {let host=TaskBrowserMobileHost(controller:controller,floating:floating);host.attach();return host}
    func updateUIView(_ view:TaskBrowserMobileHost,context:Context) {view.attach()}
}
#endif
