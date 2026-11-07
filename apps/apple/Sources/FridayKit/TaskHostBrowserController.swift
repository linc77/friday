import Foundation
import SwiftUI
import CoreGraphics

struct TaskHostBrowserTransport {
    private let template:URLRequest
    let session:URLSession
    @MainActor init(connection:Connection,session:URLSession = .shared)throws {template=try connection.request("/api/task-browser/host/open");self.session=session}
    func request(_ name:String,query:[String:String]=[:],body:[String:Any]?=nil)throws->URLRequest {
        guard ["open","command","close","events","ack","upload","download","capture","recording","resolve","annotation"].contains(name),let base=template.url else{throw ConnectionError.message("主机浏览请求无效")}
        var request=template
        let target=name=="resolve" ? base.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent(name):base.deletingLastPathComponent().appendingPathComponent(name)
        var components=URLComponents(url:target,resolvingAgainstBaseURL:false)!
        if !query.isEmpty {components.queryItems=query.sorted {$0.key<$1.key}.map {URLQueryItem(name:$0.key,value:$0.value)}}
        request.url=components.url;request.httpMethod=body==nil ? "GET":"POST";request.timeoutInterval=30
        if let body {request.httpBody=try JSONSerialization.data(withJSONObject:body);request.setValue("application/json",forHTTPHeaderField:"Content-Type")}
        return request
    }
    func data(_ name:String,body:[String:Any])async throws->Data {
        let (data,response)=try await session.data(for:request(name,body:body))
        guard let http=response as? HTTPURLResponse,(200..<300).contains(http.statusCode) else{throw ConnectionError.message((try? JSONDecoder().decode(APIError.self,from:data).error) ?? "主机浏览器请求失败")};return data
    }
}
@MainActor final class TaskHostBrowserSessions {
    static let shared=TaskHostBrowserSessions()
    private var values:[String:TaskHostBrowserController]=[:]
    func controller(scope:String,task:String,tab:TaskBrowserTab,connection:Connection,artifactScope:String?=nil)->TaskHostBrowserController {
        let key=scope+"\n"+tab.id;if let value=values[key] {return value}
        let value=TaskHostBrowserController(task:task,tab:tab,connection:connection,artifactScope:artifactScope);values[key]=value;return value
    }
    func existing(scope:String,id:String)->TaskHostBrowserController? {values[scope+"\n"+id]}
    func close(scope:String,id:String) {values.removeValue(forKey:scope+"\n"+id)?.closeRemote()}
    func close(owner:UUID,connection:String?,task:String?) {
        let prefix=owner.uuidString+"\n"+(connection.map {$0+"\n"} ?? "")+(task.map {$0+"\n"} ?? "")
        for key in values.keys.filter({$0.hasPrefix(prefix)}) {values.removeValue(forKey:key)?.dispose()}
    }
    func reconcile(owner:UUID,connection:String,taskIDs:Set<String>?) {for key in values.keys.filter({TaskBrowserSessionScope.obsolete($0,owner:owner,connection:connection,taskIDs:taskIDs)}) {values.removeValue(forKey:key)?.dispose()}}
}
@MainActor final class TaskHostBrowserController:ObservableObject,TaskBrowserCaptureOwner {
    let task:String;let tabID:String
    @Published private(set) var state:TaskHostBrowserSnapshot?
    @Published private(set) var image:CGImage?
    @Published private(set) var connected=false
    @Published private(set) var error:String?
    @Published private(set) var uncertain=false
    private var transport:TaskHostBrowserTransport?
    private var stream:Task<Void,Never>?
    private var commands:Task<Void,Never>?
    private var commandLifetime=UUID()
    private var pending:[[String:Any]]=[]
    private var viewer=UUID().uuidString
    private var sequence=0
    private var lifetime=UUID()
    private var settings:TaskHostBrowserSettings
    private(set) var fixedViewport=false
    private var initialURL:String
    private var attachmentGeneration:String?
    private var navigationID:String
    private(set) var closed=false
    let artifactScope:String
    @Published var capturing=false {didSet {if capturing,!closed {start()}else{suspendIfIdle()}}}
    @Published var message:String?
    @Published var exported:TaskBrowserExport?
    weak var annotationBridge:TaskFileMentionBridge?
    @Published var annotationSession:TaskBrowserAnnotationSession?
    @Published var recordingSession:TaskBrowserRecordingSession?
    @Published var capturedArtifact:TaskBrowserArtifact?
    @Published var artifacts:[TaskBrowserArtifact]=[]
    @Published var interruptedArtifacts:[TaskBrowserArtifact]=[]
    @Published var recoveringArtifacts=Set<String>()
    private let floatingSurface=UUID()
    @Published var floatingInTask=false {didSet {if floatingInTask,!closed {acquireSurface(floatingSurface)}else{releaseSurface(floatingSurface)}}}
    @Published var detached=false
    private var artifactObserver:NSObjectProtocol?
    private var framePump:TaskBrowserFrames?
    private var frameWaiter:((Result<CGImage,Error>)->Void)?
    private var frameConsumers=false
    private var frameSequence=0
    private var minimumRecordingSequence=0
    private var recordingContexts:[String:TaskHostBrowserTransferContext]=[:]
    private var surfaces=Set<UUID>()
    var popupOwner:UUID?
    #if os(macOS)
    var standalone:TaskHostBrowserStandaloneWindow?
    var miniWindow:TaskHostBrowserMiniWindow?
    var ownedPopups:[String:TaskHostBrowserController]=[:]
    #endif
    private var closeOpeningPage=false
    private var transferClient:TaskHostBrowserFileTransfers?
    var fileTransfers:TaskHostBrowserFileTransfers {if let transferClient {return transferClient};let value=TaskHostBrowserFileTransfers(controller:self);transferClient=value;return value}
    var clipboardSink:(String)->Void=TaskHostBrowserNativeClipboard.write
    private var mounted=false
    private var seenPopups=Set<String>()
    var popup:((TaskHostBrowserSnapshot.Popup)->Bool)?
    var canOperate:Bool {connected && state?.controller==viewer && !uncertain}
    var viewport:CGSize {(state?.settings ?? settings).layout}
    init(task:String,tab:TaskBrowserTab,connection:Connection,session:URLSession = .shared,artifactScope:String?=nil) {
        self.artifactScope=artifactScope ?? connection.server
        self.task=task;tabID=tab.id;settings=TaskHostBrowserSettings(tab:tab);initialURL=tab.url ?? "about:blank";navigationID=tab.navigationID;attachmentGeneration=tab.hostGeneration
        do {transport=try TaskHostBrowserTransport(connection:connection,session:session)}catch{self.error=error.localizedDescription}
        profile=tab.profile;incognito=tab.incognito;fixedViewport=tab.viewportWidth != nil || tab.viewportHeight != nil
        observeArtifacts()
    }
    private init(task:String,tab:TaskBrowserTab,transport:TaskHostBrowserTransport?,scope:String) {
        self.task=task;tabID=tab.id;settings=TaskHostBrowserSettings(tab:tab);initialURL=tab.url ?? "about:blank";navigationID=tab.navigationID;attachmentGeneration=tab.hostGeneration;profile=tab.profile;incognito=tab.incognito;artifactScope=scope;self.transport=transport;fixedViewport=tab.viewportWidth != nil || tab.viewportHeight != nil;observeArtifacts()
    }
    func relatedPopup(_ popup:TaskHostBrowserSnapshot.Popup)->TaskHostBrowserController {
        let tab=TaskBrowserTab(id:popup.tabId,url:TaskBrowserPolicy.url(popup.url)?.absoluteString ?? captureURL,zoom:settings.zoom,appearance:settings.appearance,viewportWidth:fixedViewport ? settings.width:nil,viewportHeight:fixedViewport ? settings.height:nil,mobile:settings.mobile,profile:profile,incognito:incognito,hostBrowser:true,hostGeneration:popup.generation)
        let child=TaskHostBrowserController(task:task,tab:tab,transport:transport,scope:artifactScope);child.settings=settings;child.annotationBridge=annotationBridge;return child
    }
    func navigateAddress(_ address:String) {
        guard canOperate,let transport else{return};let lease=lifetime
        Task { [weak self] in
            guard let self else{return}
            do {let data=try await transport.data("resolve",body:["taskId":task,"address":address]);let resolved=try JSONDecoder().decode(TaskBrowserResolvedAddress.self,from:data);guard !closed,lifetime==lease,canOperate else{return};send(["type":"navigate","url":resolved.url])}
            catch {if lifetime==lease,!closed {message=error.localizedDescription}}
        }
    }
    private let profile:String;private let incognito:Bool
    private var wantsStream:Bool {mounted || !surfaces.isEmpty || frameConsumers || recordingSession != nil || capturing}
    func mount() {guard !closed else{return};mounted=true;start()}
    func unmount() {mounted=false;suspendIfIdle()}
    func acquireSurface(_ id:UUID) {guard !closed else{return};surfaces.insert(id);start();deliverPopups()}
    func releaseSurface(_ id:UUID) {surfaces.remove(id);suspendIfIdle()}
    private func suspendIfIdle() {if !wantsStream || closed {resetStream()}}
    private func resetStream() {annotationSession?.cancel();stream?.cancel();stream=nil;connected=false;dropCommands();lifetime=UUID();let callback=frameWaiter;frameWaiter=nil;callback?(.failure(ConnectionError.message("主机画面连接已中断")))}
    private func dropCommands() {annotationSession?.cancel();if commands != nil {uncertain=true};commandLifetime=UUID();commands?.cancel();commands=nil;pending=[]}
    func dispose() {
        guard !closed else{return};closed=true;mounted=false;surfaces=[]
        recordingSession?.stop();resetStream();transferClient?.cancel();framePump?.close();image=nil;popup=nil
        if let artifactObserver {NotificationCenter.default.removeObserver(artifactObserver)};artifactObserver=nil
        #if os(macOS)
        standalone?.close();miniWindow?.close();let children=Array(ownedPopups.values);ownedPopups=[:];for child in children {child.closeRemote()}
        #endif
    }
    func closeRemote() {
        closeOpeningPage=true
        let current=state,transport=transport;dispose()
        if let current,let transport {Task {try? await transport.data("close",body:["taskId":task,"tabId":tabID,"generation":current.generation])}}
    }
    func reopen() {guard !closed else{return};recordingSession?.stop();resetStream();state=nil;attachmentGeneration=nil;image=nil;uncertain=false;error=nil;start()}
    func reconnect() {guard !closed else{return};recordingSession?.stop();resetStream();start()}
    private func start() {
        guard wantsStream,!closed,stream==nil,let transport else{return};let lease=UUID();lifetime=lease
        stream=Task { [weak self] in
            guard let self else{return}
            defer {if lifetime==lease {stream=nil;connected=false}}
            do {
                if state==nil {
                    var body=settings.body;body.merge(["taskId":task,"tabId":tabID,"url":initialURL,"profile":profile,"incognito":incognito]) {_,new in new};if let attachmentGeneration {body["generation"]=attachmentGeneration}
                    // Keep ownership until the service returns its external page ID. Cancelling the
                    // panel task must not discard that receipt and orphan a just-created page.
                    let opening=Task {try await transport.data("open",body:body)}
                    let data=try await opening.value,value=try JSONDecoder().decode(TaskHostBrowserSnapshot.self,from:data)
                    if closeOpeningPage {
                        let closing=Task {try? await transport.data("close",body:["taskId":task,"tabId":tabID,"generation":value.generation])}
                        _ = await closing.value
                        return
                    }
                    guard !Task.isCancelled,lifetime==lease else{return};apply(value)
                }
                guard let generation=state?.generation else{return}
                var failures=0
                while !Task.isCancelled,lifetime==lease,wantsStream {
                    annotationSession?.cancel();viewer=UUID().uuidString;sequence=0;connected=false
                    do {
                        let request=try transport.request("events",query:["taskId":task,"tabId":tabID,"generation":generation,"viewer":viewer])
                        let (bytes,response)=try await transport.session.bytes(for:request)
                        guard let http=response as? HTTPURLResponse,http.statusCode==200 else{error="主机会话已变化或连接被拒绝，请核对后重新打开";return}
                        var parser=TaskHostBrowserStream(task:task,tab:tabID,generation:generation)
                        for try await line in bytes.lines {
                            guard !Task.isCancelled,lifetime==lease else{return}
                            guard let event=try parser.read(line) else{continue}
                            if event.type=="gone" {error="主机标签已关闭，请重新打开";return}
                            if let value=event.state {connected=true;failures=0;apply(value)}
                            if let base64=event.data,let frameSequence=event.sequence {
                                if frameSequence>minimumRecordingSequence,let data=Data(base64Encoded:base64),let cg=TaskHostBrowserGeometry.decode(data) {image=cg;self.frameSequence=frameSequence;deliverFrameIfReady()}
                                let ack=try await transport.data("ack",body:["taskId":task,"tabId":tabID,"generation":generation,"viewer":viewer,"sequence":frameSequence]);if let reply=try? JSONDecoder().decode(TaskHostBrowserRecordingAck.self,from:ack) {for input in reply.inputs ?? [] {recordingSession?.receiveRemote(input)}}
                            }
                        }
                        if !Task.isCancelled {error="主机画面连接已中断，正在重连"}
                    }catch {if Task.isCancelled {return};self.error="主机画面连接已中断，正在重连"}
                    annotationSession?.cancel();connected=false;dropCommands();failures+=1
                    try await Task.sleep(for:.seconds(min(8,Double(failures))))
                }
            }catch {if !Task.isCancelled,lifetime==lease {self.error=error.localizedDescription}}
        }
    }
    private func apply(_ incoming:TaskHostBrowserSnapshot) {
        var value=incoming;value.clipboardText=nil
        guard value.taskId==task,value.tabId==tabID,state==nil || state?.generation==value.generation && value.revision>=(state?.revision ?? -1) else{return}
        let previouslyOperated=canOperate
        if state?.documentId != value.documentId {recordingSession?.clearInput()}
        state=value;if let session=annotationSession,!session.current {session.cancel()};if TaskBrowserPolicy.url(value.url) != nil {initialURL=value.url};if let message=value.error {error=message}else if !uncertain {error=nil}
        if value.error=="主机网页画面传输已停止，请重新连接" {recordingSession?.stop(error:ConnectionError.message(value.error!))}
        transferClient?.reconcile()
        if previouslyOperated,!canOperate {dropCommands()}
        if !previouslyOperated,canOperate,value.settings != settings {send(["type":"settings","value":settings.body])}
        deliverPopups()
    }
    func deliverPopups() {
        for item in state?.popups ?? [] where !seenPopups.contains(item.tabId) {
            if let popup,popup(item) {seenPopups.insert(item.tabId);continue}
            #if os(macOS)
            if standalone != nil || miniWindow != nil || floatingInTask {seenPopups.insert(item.tabId);openOwnedPopup(item)}
            #endif
        }
    }

    func update(_ tab:TaskBrowserTab) {
        let value=TaskHostBrowserSettings(tab:tab,width:settings.width,height:settings.height);fixedViewport=tab.viewportWidth != nil || tab.viewportHeight != nil
        if value != settings {settings=value;if canOperate {send(["type":"settings","value":value.body])}}
        if tab.navigationID != navigationID {navigationID=tab.navigationID;initialURL=tab.url ?? initialURL;if canOperate {send(["type":"navigate","url":initialURL])}}
    }
    func claim() {guard connected else{return};send(["type":"claim"],control:true)}
    func release() {send(["type":"release"])}
    func send(_ action:[String:Any],control:Bool=false) {
        guard !closed,connected,(canOperate || control),let state,let transport else{return}
        if pending.count>=128 {uncertain=true;pending=[];error="网页输入过多，请重新取得控制权";return}
        sequence+=1
        let body:[String:Any]=["taskId":task,"tabId":tabID,"generation":state.generation,"viewer":viewer,"controlGeneration":state.controlGeneration,"sequence":sequence,"requestId":UUID().uuidString,"action":action]
        if let type=action["type"] as? String,["claim","release","dialog","stop"].contains(type) {
            let lease=lifetime
            pending=[]
            if type=="claim" || type=="release" {dropCommands()}
            Task { [weak self] in
                do {
                    let data=try await transport.data("command",body:body),value=try JSONDecoder().decode(TaskHostBrowserSnapshot.self,from:data)
                    guard let self,!self.closed,self.lifetime==lease else{return}
                    if type=="claim" {self.uncertain=false;self.error=nil}
                    self.apply(value)
                    if type=="claim",self.canOperate,value.settings != self.settings {self.send(["type":"settings","value":self.settings.body])}
                }catch {guard let self,self.lifetime==lease else{return};self.uncertain=true;self.error="操作结果尚未确认，请检查页面后重新取得控制权"}
            }
            return
        }
        if let type=action["type"] as? String,["pointer","touch"].contains(type),action["phase"] as? String=="move",let last=pending.last,let previous=last["action"] as? [String:Any],previous["type"] as? String==type,previous["phase"] as? String=="move" {pending[pending.count-1]=body}else{pending.append(body)}
        guard commands==nil else{return};let lease=lifetime,commandLease=commandLifetime
        commands=Task { [weak self] in
            guard let self else{return};defer {if lifetime==lease,commandLifetime==commandLease {commands=nil}}
            while !Task.isCancelled,lifetime==lease,commandLifetime==commandLease,!pending.isEmpty {
                let next=pending.removeFirst()
                do {let data=try await transport.data("command",body:next),value=try JSONDecoder().decode(TaskHostBrowserSnapshot.self,from:data);guard !Task.isCancelled,lifetime==lease,commandLifetime==commandLease else{return};consumeClipboard(value,action:next["action"] as? [String:Any] ?? [:]);apply(value)}
                catch {if lifetime==lease,commandLifetime==commandLease {uncertain=true;pending=[];self.error="操作结果尚未确认。请检查页面后重新取得控制权；不会自动重发。"};return}
            }
        }
    }
    var activeChooser:TaskHostBrowserSnapshot.Chooser? {guard canOperate,let chooser=state?.chooser,chooser.offeredTo==viewer else{return nil};return chooser}
    func ownsDownloadOffer(_ item:TaskHostBrowserSnapshot.Download)->Bool {connected && item.offeredTo==viewer}
    func uploadContext(chooser:String,digest:String)async throws->TaskHostBrowserTransferContext {
        let lease=lifetime;await commands?.value
        guard !closed,!Task.isCancelled,lifetime==lease,canOperate,activeChooser?.id==chooser,let state,let transport else{throw ConnectionError.message("网页文件选择已变化，请重新选择")}
        sequence+=1
        return TaskHostBrowserTransferContext(transport:transport,query:["taskId":task,"tabId":tabID,"generation":state.generation,"viewer":viewer,"controlGeneration":String(state.controlGeneration),"chooser":chooser,"digest":digest,"requestId":UUID().uuidString,"sequence":String(sequence)])
    }
    func downloadContext(_ item:TaskHostBrowserSnapshot.Download)->TaskHostBrowserTransferContext? {
        guard !closed,let state,let transport,state.downloads?.contains(where:{$0==item})==true else{return nil}
        return TaskHostBrowserTransferContext(transport:transport,query:["taskId":task,"tabId":tabID,"generation":state.generation,"id":item.id])
    }
    func acceptTransferReply(_ value:TaskHostBrowserSnapshot) {guard !closed else{return};apply(value)}
    private func consumeClipboard(_ value:TaskHostBrowserSnapshot,action:[String:Any]) {
        guard let text=value.clipboardText,text.utf16.count<=1048576,canOperate,value.generation==state?.generation,value.controller==viewer,value.controlGeneration==state?.controlGeneration else{return}
        let edit=action["type"] as? String=="edit" && ["copy","cut"].contains(action["command"] as? String ?? "")
        let modifier=(action["modifiers"] as? Int ?? 0)&7
        let key=action["type"] as? String=="key" && action["phase"] as? String=="down" && [2,4].contains(modifier) && ["c","x"].contains((action["key"] as? String ?? "").lowercased())
        if edit || key {clipboardSink(text)}
    }
    func pasteClipboard() {
        guard canOperate,let text=TaskHostBrowserNativeClipboard.read(),!text.isEmpty else{return}
        guard text.utf16.count<=1048576 else{error="剪贴板文字过长";return}
        let chunks=TaskHostBrowserClipboardText.chunks(text)
        guard chunks.count+pending.count<128 else{error="剪贴板文字过长，请分段粘贴";return}
        for chunk in chunks {send(["type":"text","text":chunk])}
    }
    var captureClosed:Bool {closed}
    var captureAvailable:Bool {!closed && connected && captureURL != nil && state?.documentId != nil}
    var captureURL:String? {state.flatMap {TaskBrowserPolicy.url($0.url)?.absoluteString}}
    var captureDocument:String {state?.documentId ?? ""}
    var frames:TaskBrowserFrames {
        if let framePump {return framePump}
        let value=TaskBrowserFrames(capture:{[weak self] completion in
            guard let self,!closed,connected else{completion(.failure(ConnectionError.message("主机画面连接已中断")));return}
            if let image,frameSequence>minimumRecordingSequence {completion(.success(image))}else{frameWaiter=completion}
        },activity:{[weak self] active in guard let self else{return};frameConsumers=active;if active {start()}else{suspendIfIdle()}})
        framePump=value;return value
    }
    private func deliverFrameIfReady() {guard let image,frameSequence>minimumRecordingSequence,let callback=frameWaiter else{return};frameWaiter=nil;callback(.success(image))}
    private func observeArtifacts() {
        artifacts=(try? TaskBrowserArtifactStore(scope:artifactScope).recent()) ?? [];refreshInterruptedRecordings()
        artifactObserver=NotificationCenter.default.addObserver(forName:TaskBrowserArtifactStore.saved,object:nil,queue:.main) {[weak self] note in
            guard let path=note.object as? String,let artifact=note.userInfo?["artifact"] as? TaskBrowserArtifact else{return}
            Task { @MainActor [weak self] in guard let self,!closed,let store=try? TaskBrowserArtifactStore(scope:artifactScope),store.directory.path==path else{return};publish(artifact,store:store) }
        }
    }
    func annotationContext()throws->TaskHostBrowserTransferContext {
        guard canOperate,let state else{throw ConnectionError.message("请先取得网页控制权")}
        let context=try captureContext();var query=context.query;query["controlGeneration"]=String(state.controlGeneration)
        return TaskHostBrowserTransferContext(transport:context.transport,query:query)
    }
    func annotationIsCurrent(_ context:TaskHostBrowserTransferContext)->Bool {
        !closed && canOperate && context.query["generation"]==state?.generation && context.query["viewer"]==viewer && context.query["document"]==captureDocument && context.query["controlGeneration"]==state.map {String($0.controlGeneration)}
    }
    static func annotationCall(_ context:TaskHostBrowserTransferContext,nonce:String,action:String,arguments:[String:Any]=[:])async throws->Any {
        var body:[String:Any]=context.query;body["controlGeneration"]=Int(context.query["controlGeneration"] ?? "");body["id"]=nonce;body["action"]=action
        for key in ["tool","property","value"] {if let value=arguments[key] {body[key]=value}}
        let data=try await context.transport.data("annotation",body:body)
        guard data.count<=4*1024*1024+4096,let result=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{throw ConnectionError.message("网页批注响应无效")}
        return result["value"] ?? NSNull()
    }
    private func captureContext()throws->TaskHostBrowserTransferContext {
        guard captureAvailable,let state,let transport else{throw ConnectionError.message("主机网页尚未连接")}
        return TaskHostBrowserTransferContext(transport:transport,query:["taskId":task,"tabId":tabID,"generation":state.generation,"viewer":viewer,"document":captureDocument])
    }
    private func capturePNG()async throws->(CGImage,Int) {
        let context=try captureContext(),lease=lifetime,document=captureDocument
        let (data,response)=try await context.transport.session.data(for:context.transport.request("capture",body:context.query))
        guard let http=response as? HTTPURLResponse,http.statusCode==200 else{throw ConnectionError.message((try? JSONDecoder().decode(APIError.self,from:data).error) ?? "主机网页截图失败")}
        guard !closed,lifetime==lease,captureDocument==document,http.value(forHTTPHeaderField:"X-Friday-Capture-Document")==document else{throw ConnectionError.message("网页已变化，请重新截图")}
        guard let image=TaskHostBrowserGeometry.decode(data,maxBytes:64*1024*1024),let sequence=Int(http.value(forHTTPHeaderField:"X-Friday-Capture-Sequence") ?? ""),sequence>=0 else{throw ConnectionError.message("主机未返回有效的 PNG 截图")}
        return (image,sequence)
    }
    func captureImage()async throws->CGImage {try await capturePNG().0}
    func capture() {capturePageArtifact()}
    func prepareRecording(nonce:String,showKeys:Bool)async throws {
        let context=try captureContext();recordingContexts[nonce]=context;minimumRecordingSequence=Int.max
        var body:[String:Any]=context.query;body["id"]=nonce;body["action"]="start";body["keys"]=showKeys
        let starting=Task {try await context.transport.data("recording",body:body)}
        _ = try await starting.value
        let (first,sequence)=try await capturePNG()
        image=first;frameSequence=sequence+1;minimumRecordingSequence=sequence;deliverFrameIfReady()
    }
    func finishRecordingInput(nonce:String)async {
        guard let context=recordingContexts.removeValue(forKey:nonce) else{return}
        var body:[String:Any]=context.query;body["id"]=nonce;body["action"]="stop"
        // Finalize local media immediately. The passive server hook is also
        // lease-scoped to this viewer, so a slow network must not hold the file.
        Task {try? await context.transport.data("recording",body:body)}
        minimumRecordingSequence=0;deliverFrameIfReady()
    }
    func recordingDidFinish() {suspendIfIdle()}
    func resizeSurface(_ size:CGSize) {
        guard !fixedViewport else{return}
        resize(size,tab:TaskBrowserTab(zoom:settings.zoom,appearance:settings.appearance,mobile:settings.mobile))
    }
    func resize(_ size:CGSize,tab:TaskBrowserTab) {
        guard tab.viewportWidth==nil,tab.viewportHeight==nil,size.width.isFinite,size.height.isFinite else{return}
        let width=min(3840,max(240,Int(size.width.rounded()))),height=min(3840,max(240,Int(size.height.rounded())))
        let fitted=min(height,3840*2160/width),value=TaskHostBrowserSettings(tab:tab,width:width,height:fitted)
        guard abs(value.width-settings.width)>2 || abs(value.height-settings.height)>2 else{return};settings=value;if canOperate {send(["type":"settings","value":value.body])}
    }
}

extension TaskHostBrowserController:TaskBrowserAnnotationOwner {
    var annotationAvailable:Bool {canOperate && captureAvailable && state?.loading != true && state?.error==nil}
    func annotate(_ composer:TaskBrowserAnnotationComposer) {
        if let annotationSession {annotationSession.cancel();return}
        guard composer.enabled,composer.current(),annotationAvailable else{return}
        do {let session=try TaskBrowserAnnotationSession(host:self,composer:composer);annotationSession=session;Task {await session.start()}}
        catch {message=error.localizedDescription}
    }
}
