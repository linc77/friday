import SwiftUI
import WebKit
import UniformTypeIdentifiers

private struct TaskBrowserOpenKey:EnvironmentKey {static let defaultValue:((URL)->Bool)?=nil}
extension EnvironmentValues {var taskBrowserOpen:((URL)->Bool)? {get{self[TaskBrowserOpenKey.self]}set{self[TaskBrowserOpenKey.self]=newValue}}}
private struct TaskBrowserHistoryDocument:Codable {var projects:[String:[TaskBrowserVisit]]=[:]}
@MainActor final class TaskBrowserHistory:ObservableObject {
    static let shared=TaskBrowserHistory()
    @Published private(set) var revision=0
    private var documents:[String:TaskBrowserHistoryDocument]=[:]
    func visits(server:String,project:String)->[TaskBrowserVisit] { document(server).projects[project] ?? [] }
    private func document(_ server:String)->TaskBrowserHistoryDocument {
        if let value=documents[server] { return value }
        let value=TaskDraftCache.load(TaskBrowserHistoryDocument.self,server:server,context:"browser-history") ?? TaskBrowserHistoryDocument();documents[server]=value;return value
    }
    func record(server:String,project:String,url:String,title:String?) {
        guard let normalized=TaskBrowserPolicy.historyURL(url),let key=TaskBrowserPolicy.historyKey(normalized) else { return };var value=document(server)
        let visit=TaskBrowserVisit(url:normalized,title:title.map {String($0.prefix(512))},at:Date())
        let existing=value.projects[project] ?? []
        if existing.first?.url==normalized,existing.first?.title==visit.title { return }
        value.projects[project]=Array(([visit]+existing.filter {$0.id != key}).prefix(50))
        let retained=value.projects.sorted { ($0.value.first?.at ?? .distantPast)>($1.value.first?.at ?? .distantPast) }.prefix(20)
        value.projects=Dictionary(uniqueKeysWithValues:retained.map {($0.key,$0.value)})
        documents[server]=value;TaskDraftCache.save(value,server:server,context:"browser-history");revision+=1
    }
    func clear(server:String,project:String) {var value=document(server);value.projects.removeValue(forKey:project);documents[server]=value;TaskDraftCache.save(value,server:server,context:"browser-history");revision+=1}
}

struct TaskBrowserPanel:View {
    @ObservedObject var store:FridayStore
    let task:WorkItem
    @Binding var state:TaskBrowserPanelState
    @ObservedObject private var history=TaskBrowserHistory.shared
    @State private var address=""
    @State private var servers:[TaskBrowserServer]=[]
    @State private var error:String?
    @State private var resolving=false
    @State private var resolver:Task<Void,Never>?
    @State private var request=UUID()
    @State private var profiles:[TaskBrowserProfile]=[]
    @State private var profileName=""
    @State private var addingProfile=false
    @State private var managingProfiles=false
    @State private var configuringServers=false
    @State private var configuredDraft=""
    @State private var configuredError:String?
    @State private var focusRequest=0
    @State private var mountedConnection=""
    @State private var mounted=false
    @FocusState private var startAddressFocused:Bool
    private var scope:String {TaskBrowserSessionScope.value(owner:store.browserClientID,connection:store.connectionIdentity,task:task.id)}
    private var project:String {task.projectId ?? task.cwd}
    private var preferences:TaskBrowserPreferences {TaskBrowserPreferences.shared(server:store.connection.server)}
    private var visits:[TaskBrowserVisit] {history.visits(server:store.connection.server,project:project)}
    private var visibleServers:[TaskBrowserServer] {
        let configured=Set((state.configuredURLs ?? []).compactMap {value->Int? in guard let url=TaskBrowserPolicy.url(value),TaskBrowserPolicy.local(url) else{return nil};return url.port ?? (url.scheme=="https" ? 443:80)})
        return servers.sorted {a,b in let left=configured.contains(a.port),right=configured.contains(b.port);return left != right ? left:a.port<b.port}
    }
    var body:some View {
        Group {
            if let tab=state.current,tab.url != nil {
                if TaskBrowserPolicy.usesHost(tab,server:store.connection.server) {
                    TaskHostBrowserPage(tab:binding(tab),controller:TaskHostBrowserSessions.shared.controller(scope:scope,task:task.id,tab:tab,connection:store.connection,artifactScope:store.serviceId ?? store.connectionIdentity),server:store.connection.server,resolving:resolving,focusRequest:focusRequest,submit:resolve,popup:{value in
                        guard mounted,mountedConnection==store.connectionIdentity,!state.tabs.contains(where:{$0.id==value.tabId}) else{return false}
                        var opened=TaskBrowserTab(id:value.tabId,url:TaskBrowserPolicy.url(value.url)?.absoluteString ?? tab.url,profile:tab.profile,incognito:tab.incognito,hostBrowser:true,hostGeneration:value.generation);opened.zoom=tab.zoom;opened.appearance=tab.appearance;state.tabs.append(opened);state.selected=opened.id;return true
                    },visited:{url,title in if !tab.incognito {history.record(server:store.connection.server,project:project,url:url,title:title)}},float:{TaskBrowserSessions.shared.float(scope:scope,id:tab.id,host:true);state.visible=false},manageProfiles:{managingProfiles=true}).id(tab.id+"-host")
                }else{
                TaskBrowserPage(store:store,tab:binding(tab),controller:TaskBrowserSessions.shared.controller(scope:scope,profileScope:store.serviceId ?? store.connectionIdentity,tab:tab),profiles:profiles,
                    resolving:resolving,focusRequest:focusRequest,submit:resolve,newTab:{open()},newProfile:{profileName="";addingProfile=true},manageProfiles:{managingProfiles=true},
                    chooseProfile:{ profile,incognito in open(profile:profile,incognito:incognito) },popup:{ config,url in popup(from:tab,configuration:config,url:url) },
                    visited:{ url,title in if !tab.incognito { history.record(server:store.connection.server,project:project,url:url,title:title) } },closed:{close(tab.id)},float:{TaskBrowserSessions.shared.float(scope:scope,id:tab.id);state.visible=false}).id(tab.id)
                }
            } else {
                VStack(spacing:0) {
                    HStack {FridaySymbolImage(systemName:"globe").foregroundStyle(.secondary);TextField(friday:"输入网址或搜索",text:$address).textFieldStyle(.plain).autocorrectionDisabled().focused($startAddressFocused).onSubmit {resolve(address)};if resolving {FridaySymbolImage(systemName:"hourglass")};Button {resolve(address)} label: {FridaySymbolImage(systemName:"arrow.right")}.buttonStyle(FridaySymbolButtonStyle()).disabled(address.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || resolving)}.padding(12)
                    Divider();startPage
                }
            }
        }
        .overlay(alignment:.bottom) {if let error { Text(fridayString:error).font(.caption).foregroundStyle(.orange).padding(10).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8)).padding() }}
        .task(id:scope) {profiles=preferences.profiles.filter {!$0.builtIn};await discover()}
        .task(id:scope+(state.configuredURLs ?? []).joined(separator:"\n")) {
            while !Task.isCancelled {await discover();try? await Task.sleep(for:.seconds(3))}
        }
        .onAppear {mountedConnection=store.connectionIdentity;mounted=true;if let tab=state.current {TaskBrowserSessions.shared.closeFloat(scope:scope,id:tab.id)}}
        .onChange(of:state.selected) {_,value in if let value {TaskBrowserSessions.shared.closeFloat(scope:scope,id:value)}}
        .onDisappear {
            mounted=false
            resolver?.cancel();request=UUID();resolving=false
            if !mountedConnection.isEmpty,mountedConnection != store.connectionIdentity {TaskBrowserSessions.shared.close(owner:store.browserClientID,connection:mountedConnection)}
            else if store.taskWasRemoved(task.id) {TaskBrowserSessions.shared.close(owner:store.browserClientID,connection:mountedConnection,task:task.id)}
        }
        .background {
            HStack {
                Button {startAddressFocused=true;focusRequest+=1} label:{EmptyView()}.keyboardShortcut("l",modifiers:.command)
                Button {open()} label:{EmptyView()}.keyboardShortcut("t",modifiers:.command)
                Button {state.reopen()} label:{EmptyView()}.keyboardShortcut("t",modifiers:[.command,.shift]).disabled(state.closed?.isEmpty != false)
            }.frame(width:0,height:0).accessibilityHidden(true)
        }
        .onReceive(NotificationCenter.default.publisher(for:TaskBrowserPreferences.changed)) {note in if note.object as? String==store.connection.server {profiles=preferences.userProfiles}}
        .sheet(isPresented:$managingProfiles) {TaskBrowserPreferencesView(store:store,preferences:preferences,close:{managingProfiles=false})}
        .alert(Text(friday:"新增浏览配置"),isPresented:$addingProfile) {
            TextField(friday:"名称",text:$profileName)
            Button(friday:"取消",role:.cancel) {}
            Button(friday:"创建") {let name=profileName.trimmingCharacters(in:.whitespacesAndNewlines);guard !name.isEmpty else{return};guard let profile=preferences.create(name) else{return};profiles=preferences.userProfiles;open(profile:profile.id)}
        }
        .sheet(isPresented:$configuringServers) {
            VStack(alignment:.leading,spacing:12) {
                Text(friday:"本地服务地址").font(.headline)
                Text(friday:"每行一个本机地址，可包含页面路径").font(.caption).foregroundStyle(.secondary)
                TextEditor(text:$configuredDraft).font(.system(.body,design:.monospaced)).frame(minHeight:160)
                if let configuredError {Text(fridayString:configuredError).font(.caption).foregroundStyle(.orange)}
                HStack {Spacer();Button(friday:"取消") {configuringServers=false}.buttonStyle(FridayButtonStyle(compact:true));Button(friday:"保存") {let values=configuredDraft.split(whereSeparator:\.isNewline).map {String($0).trimmingCharacters(in:.whitespacesAndNewlines)};guard values.count<=32,values.allSatisfy({$0.utf16.count<=2048}) else{configuredError="最多配置 32 个地址，每个地址最多 2,048 个字符";return};state.configuredURLs=values;configuredError=nil;configuringServers=false}.buttonStyle(FridayButtonStyle(compact:true))}
            }.padding(20).frame(minWidth:340,idealWidth:440)
        }
    }
    private var startPage:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:18) {
                HStack {Text(friday:"本地服务").font(.headline);Spacer();Button {Task {await discover()}} label: {FridaySymbolImage(systemName:"arrow.clockwise")}.buttonStyle(FridaySymbolButtonStyle());Button {configuredDraft=(state.configuredURLs ?? []).joined(separator:"\n");configuringServers=true} label: {FridaySymbolImage(systemName:"slider.horizontal.3")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"配置本地服务地址"))}
                if servers.isEmpty {Text(friday:"暂未发现可预览的网页服务").font(.callout).foregroundStyle(.secondary)}
                ForEach(visibleServers) {server in
                    Button {resolve(server.url)} label: {
                        HStack {FridaySymbolImage(systemName:"network");VStack(alignment:.leading,spacing:3) {Text(verbatim:server.processName ?? "localhost").font(.callout.weight(.medium));Text(verbatim:server.url).font(.caption).foregroundStyle(.secondary)};Spacer();Text(verbatim:String(server.port)).font(.system(.caption,design:.monospaced))}.padding(10).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:8))
                    }.buttonStyle(FridaySymbolButtonStyle()).disabled(resolving)
                }
                HStack {Text(friday:"最近浏览").font(.headline);Spacer();if !visits.isEmpty {Button(friday:"清除历史") {history.clear(server:store.connection.server,project:project)}.font(.caption).buttonStyle(FridayButtonStyle(compact:true))}}
                if visits.isEmpty {Text(friday:"在此项目中打开的网页会显示在这里").font(.callout).foregroundStyle(.secondary)}
                ForEach(visits) {visit in Button {resolve(visit.url)} label: {HStack {FridaySymbolImage(systemName:"clock");VStack(alignment:.leading,spacing:3) {Text(verbatim:visit.title ?? visit.url).font(.callout).lineLimit(1);Text(verbatim:visit.url).font(.caption).foregroundStyle(.secondary).lineLimit(1)};Spacer()}.padding(.vertical,3)}.buttonStyle(FridaySymbolButtonStyle())}
                Menu {
                    Button(friday:"新标签页") {open()}
                    Button(friday:"无痕浏览") {open(profile:"incognito",incognito:true)}
                    ForEach(profiles) {profile in Button(profile.name) {open(profile:profile.id)}}
                    Button(friday:"新增浏览配置") {addingProfile=true}.disabled(profiles.count>=24)
                    Button(friday:"管理浏览配置") {managingProfiles=true}
                } label: {FridaySymbolLabel(friday:"打开网页",systemImage:"plus")}.fridayInteractiveCursor()
            }.padding(20).frame(maxWidth:560,alignment:.leading).frame(maxWidth:.infinity)
        }
    }
    private func binding(_ tab:TaskBrowserTab)->Binding<TaskBrowserTab> {Binding(get:{state.tabs.first {$0.id==tab.id} ?? tab},set:{value in if let index=state.tabs.firstIndex(where:{$0.id==tab.id}) {state.tabs[index]=value}})}
    private func close(_ id:String) {TaskBrowserSessions.shared.close(scope:scope,id:id);state.close(id)}
    @discardableResult private func open(_ url:String?=nil,profile:String?=nil,incognito:Bool=false)->TaskBrowserTab {state.open(url,profile:profile,incognito:incognito,defaults:preferences.defaults)}
    private func popup(from source:TaskBrowserTab,configuration:WKWebViewConfiguration,url:URL?)->WKWebView? {
        guard mounted,mountedConnection==store.connectionIdentity,state.tabs.contains(where:{$0.id==source.id}) else{return nil}
        var tab=open(url.flatMap {TaskBrowserPolicy.url($0.absoluteString)?.absoluteString} ?? "about:blank",profile:source.profile,incognito:source.incognito)
        tab.zoom=source.zoom;tab.appearance=source.appearance;tab.viewportWidth=source.viewportWidth;tab.viewportHeight=source.viewportHeight;tab.mobile=source.mobile;tab.deviceToolbar=source.deviceToolbar
        if let index=state.tabs.firstIndex(where:{$0.id==tab.id}) {state.tabs[index]=tab}
        let controller=TaskBrowserSessions.shared.controller(scope:scope,profileScope:store.serviceId ?? store.connectionIdentity,tab:tab,configuration:configuration);controller.apply(tab,server:store.connection.server);return controller.view
    }
    private func resolve(_ input:String) {
        guard !resolving else {return};resolver?.cancel();let key=scope,nonce=UUID(),tabID=state.current?.id;request=nonce;resolving=true;error=nil
        resolver=Task { @MainActor in
            defer {if request==nonce {resolving=false}}
            do {
                let data=try await store.connection.data("/api/task-browser/resolve",method:"POST",body:["taskId":task.id,"address":input]);let resolved=try JSONDecoder().decode(TaskBrowserResolvedAddress.self,from:data)
                guard !Task.isCancelled,scope==key,request==nonce,TaskBrowserPolicy.url(resolved.url) != nil else {return}
                if let tabID,let index=state.tabs.firstIndex(where:{$0.id==tabID}) {state.tabs[index].navigate(resolved.url)} else if tabID==nil {open(resolved.url)}
                address=resolved.url
            } catch {if !Task.isCancelled,scope==key,request==nonce {self.error=error.localizedDescription}}
        }
    }
    private func discover() async {
        guard store.connected else {return};let key=scope,configured=state.configuredURLs ?? []
        do {let data=try await store.connection.data("/api/task-browser/servers",method:"POST",body:["taskId":task.id,"configuredURLs":configured]);let result=try JSONDecoder().decode(TaskBrowserServers.self,from:data);guard !Task.isCancelled,key==scope,configured==state.configuredURLs ?? [] else{return};servers=result.servers}
        catch {if !Task.isCancelled,key==scope {self.error=error.localizedDescription}}
    }
}

private struct TaskBrowserPage:View {
    @ObservedObject var store:FridayStore
    @Binding var tab:TaskBrowserTab
    @ObservedObject var controller:TaskBrowserController
    @Environment(\.taskFileMentionBridge) private var mentionBridge
    let profiles:[TaskBrowserProfile]
    let resolving:Bool
    let focusRequest:Int
    let submit:(String)->Void
    let newTab:()->Void
    let newProfile:()->Void
    let manageProfiles:()->Void
    let chooseProfile:(String,Bool)->Void
    let popup:(WKWebViewConfiguration,URL?)->WKWebView?
    let visited:(String,String?)->Void
    let closed:()->Void
    let float:()->Void
    @State private var address=""
    @State private var widthDraft=""
    @State private var heightDraft=""
    @FocusState private var addressFocused:Bool
    @State private var popupOwner=UUID()
    var body:some View {
        VStack(spacing:0) {
            chrome
            if let session=controller.annotationSession {TaskBrowserAnnotationToolbar(session:session)}
            if tab.deviceToolbar {deviceToolbar}
            if controller.loading {ProgressView(value:controller.progress).progressViewStyle(.linear).frame(height:2)}
            ZStack {
                if controller.detached {
                    #if os(macOS)
                    VStack(spacing:12) {FridaySymbolImage(systemName:"macwindow").font(.title);Text(friday:"网页已在独立窗口中打开").font(.callout);HStack {Button(friday:"显示预览窗口") {controller.showStandalone()};Button(friday:"返回任务侧栏") {controller.returnInline()}}.buttonStyle(FridayButtonStyle(compact:true))}.frame(maxWidth:.infinity,maxHeight:.infinity)
                    #endif
                } else {GeometryReader {geometry in
                    let inset:CGFloat=tab.viewportWidth != nil && tab.viewportHeight != nil ? 12:0
                    let width=tab.viewportWidth.map {CGFloat($0)*tab.zoom} ?? max(1,geometry.size.width),height=tab.viewportHeight.map {CGFloat($0)*tab.zoom} ?? max(1,geometry.size.height)
                    let scale=min(1,max(1,geometry.size.width-inset*2)/width,max(1,geometry.size.height-inset*2)/height)
                    TaskBrowserNativeView(controller:controller).frame(width:width,height:height).scaleEffect(scale,anchor:.topLeading).frame(width:width*scale,height:height*scale).background(.background)
                        .overlay(alignment:.topLeading) {if tab.deviceToolbar,let width=tab.viewportWidth,let height=tab.viewportHeight {TaskBrowserResizeHandles(width:width,height:height,scale:scale*tab.zoom) {width,height in tab.viewportWidth=width;tab.viewportHeight=height}}}
                        .padding(inset)
                        .frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.top)
                }.clipped()}
                if let error=controller.error {VStack(spacing:14) {FridaySymbolImage(systemName:"globe.badge.chevron.backward").font(.title);Text(fridayString:error).font(.callout).multilineTextAlignment(.center).textSelection(.enabled);Button(friday:"重新加载") {controller.retry()}.buttonStyle(FridayButtonStyle(compact:true))}.padding(28).frame(maxWidth:.infinity,maxHeight:.infinity).background(FridayTheme.canvas)}
            }.frame(maxWidth:.infinity,maxHeight:.infinity)
            if let session=controller.annotationSession {TaskBrowserAnnotationComment(session:session)}
            if let session=controller.recordingSession {TaskBrowserRecordingStatus(session:session)}
        }
        .onAppear {mount()}
        .onChange(of:tab) {_,_ in controller.apply(tab,server:store.connection.server);if !addressFocused {address=tab.url ?? ""}}
        .onChange(of:tab.viewportWidth) {_,_ in widthDraft=String(tab.viewportWidth ?? 1024)}
        .onChange(of:tab.viewportHeight) {_,_ in heightDraft=String(tab.viewportHeight ?? 768)}
        .onChange(of:controller.url) {_,value in if !addressFocused {address=value ?? tab.url ?? ""}}
        .onChange(of:focusRequest) {_,_ in addressFocused=true}
        .onDisappear {if !controller.detached {controller.annotationSession?.cancel()};if !controller.detached && !controller.miniPlayer && !controller.floatingInTask && controller.recordingSession==nil {controller.metadata=nil;if controller.popupOwner==popupOwner {controller.popup=nil;controller.popupOwner=nil};controller.windowClosed=nil}}
        .modifier(TaskBrowserFileExport(controller:controller))
        .sheet(item:$controller.upload) {request in
            #if os(iOS)
            TaskBrowserFilePicker(request:request) {urls in if controller.upload?.id==request.id {controller.completeUpload(urls)}}
            #else
            EmptyView()
            #endif
        }
        .overlay(alignment:.bottom) {
            if let message=controller.message {HStack {Text(fridayString:message).font(.caption);Button {controller.message=nil} label:{FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle())}.padding(10).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8)).padding()}
        }
        .overlay(alignment:.bottom) {if !controller.detached {TaskBrowserArtifactNotice(controller:controller)}}
        .task(id:controller.message) {guard controller.message != nil else{return};try? await Task.sleep(for:.seconds(6));if !Task.isCancelled {controller.message=nil}}
    }
    private var chrome:some View {
        HStack(spacing:6) {
            Button {controller.goBack()} label: {FridaySymbolImage(systemName:"chevron.left")}.disabled(!controller.back).help(Text(friday:"后退")).keyboardShortcut("[",modifiers:.command)
            Button {controller.goForward()} label: {FridaySymbolImage(systemName:"chevron.right")}.disabled(!controller.forward).help(Text(friday:"前进")).keyboardShortcut("]",modifiers:.command)
            Button {controller.reload()} label: {FridaySymbolImage(systemName:controller.loading ? "xmark":"arrow.clockwise")}.help(Text(friday:controller.loading ? "停止加载":"重新加载")).keyboardShortcut("r",modifiers:.command)
            TextField(friday:"输入网址或搜索",text:$address).textFieldStyle(.plain).autocorrectionDisabled().font(.callout).focused($addressFocused).onSubmit {submit(address);addressFocused=false}.onKeyPress(.escape) {address=controller.url ?? tab.url ?? "";addressFocused=false;return .handled}.padding(6).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:6)).disabled(resolving)
            Button {controller.openExternal()} label: {FridaySymbolImage(systemName:"arrow.up.right.square")}.help(Text(friday:"在默认浏览器中打开")).disabled(controller.url==nil)
            TaskBrowserAudioButton(controller:controller)
            TaskBrowserCaptureButton(controller:controller)
            if let mentionBridge {TaskBrowserAnnotationEntry(controller:controller,bridge:mentionBridge)}
            Button(action:float) {FridaySymbolImage(systemName:"pip")}.help(Text(friday:"在任务中浮动预览")).disabled(controller.url==nil)
            more
        }.buttonStyle(FridaySymbolButtonStyle()).padding(8)
    }
    private var more:some View {
        Menu {
            Button(friday:"在主机浏览器中打开") {tab.hostBrowser=true}
            Button(friday:"强制重新加载") {controller.reload(hard:true)}.keyboardShortcut("r",modifiers:[.command,.option])
            #if os(macOS)
            Button(friday:controller.miniPlayer ? "关闭小预览":"置顶小预览") {controller.toggleMiniPlayer()}.disabled(controller.url==nil)
            Button(friday:controller.detached ? "返回任务侧栏":"打开独立预览窗口") {if controller.detached {controller.returnInline()}else{controller.showStandalone()}}.disabled(controller.url==nil)
            #endif
            TaskBrowserRecordingPreferences()
            TaskBrowserMiniPreference()
            if !controller.artifacts.isEmpty {Menu {ForEach(controller.artifacts) {artifact in Menu {TaskBrowserArtifactActions(controller:controller,artifact:artifact)} label:{Text(verbatim:artifact.name)}}} label:{Text(friday:"最近的截图与录屏")}}
            if !controller.interruptedArtifacts.isEmpty {Menu {ForEach(controller.interruptedArtifacts) {artifact in Menu {
                Button(friday:controller.recoveringArtifacts.contains(artifact.id) ? "正在恢复…":"恢复可用片段") {controller.recoverRecording(artifact)}.disabled(controller.recoveringArtifacts.contains(artifact.id))
                TaskBrowserArtifactActions(controller:controller,artifact:artifact)
            } label:{Text(verbatim:artifact.name)}}} label:{Text(friday:"未完成的录屏")}}
            Button(friday:tab.deviceToolbar ? "隐藏设备工具栏":"显示设备工具栏") {tab.deviceToolbar.toggle();if tab.deviceToolbar,tab.viewportWidth==nil {tab.viewportWidth=1024;tab.viewportHeight=768}}
            Menu {Button(friday:"跟随系统") {tab.appearance="system"};Button(friday:"浅色") {tab.appearance="light"};Button(friday:"深色") {tab.appearance="dark"}} label: {Text(friday:"网页外观")}
            Divider()
            Button(friday:"放大") {tab.zoom=TaskBrowserPolicy.zoom(tab.zoom,increase:true)}.keyboardShortcut("+",modifiers:.command)
            Button(friday:"缩小") {tab.zoom=TaskBrowserPolicy.zoom(tab.zoom,increase:false)}.keyboardShortcut("-",modifiers:.command)
            Button("\(Int(tab.zoom*100))% · "+String(localized:"重置缩放",bundle:.module)) {tab.zoom=1}.keyboardShortcut("0",modifiers:.command)
            Divider()
            #if os(macOS)
            Button(friday:"打开开发工具") {controller.openDevTools()}.disabled(!controller.canInspectPage)
            #endif
            Button(friday:controller.audioMuted ? "取消网页静音":"网页静音") {controller.setAudioMuted(!controller.audioMuted)}.disabled(!controller.canMuteAudio)
            Button(friday:"清除 Cookie") {controller.clearCookies()}
            Button(friday:"清除缓存") {controller.clearCache()}
            Divider()
            Button(friday:"新标签页",action:newTab)
            Button(friday:"无痕浏览") {chooseProfile("incognito",true)}
            Menu {Button(friday:"默认浏览配置") {chooseProfile("default",false)};ForEach(profiles) {profile in Button(profile.name) {chooseProfile(profile.id,false)}};Button(friday:"新增浏览配置",action:newProfile).disabled(profiles.count>=24);Button(friday:"管理浏览配置",action:manageProfiles)} label: {Text(friday:"浏览配置")}
            Button(friday:"复制网页地址") {if let url=controller.url {copyAgentText(url)}}.disabled(controller.url==nil)
        } label: {FridaySymbolImage(systemName:"ellipsis")}.fridayInteractiveCursor().help(Text(friday:"网页菜单"))
    }
    private var deviceToolbar:some View {
        HStack(spacing:6) {
            Menu {
                Button(friday:"自适应") {tab.viewportWidth=nil;tab.viewportHeight=nil}
                ForEach(TaskBrowserViewportPreset.all) {preset in Button("\(preset.label) · \(preset.width) × \(preset.height)") {tab.viewportWidth=preset.width;tab.viewportHeight=preset.height;tab.mobile=preset.mobile}}
            } label: {FridaySymbolImage(systemName:tab.mobile ? "iphone":"desktopcomputer")}.fridayInteractiveCursor()
            TextField(friday:"宽度",text:$widthDraft).frame(width:50).onSubmit {dimensions()}
            Text(verbatim:"×").foregroundStyle(.secondary)
            TextField(friday:"高度",text:$heightDraft).frame(width:50).onSubmit {dimensions()}
            Button {let width=tab.viewportWidth ?? 1024;tab.viewportWidth=tab.viewportHeight ?? 768;tab.viewportHeight=width} label: {FridaySymbolImage(systemName:"rotate.right")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"旋转视口"))
            Spacer()
            Text(verbatim:"\(Int(tab.zoom*100))%").font(.caption).foregroundStyle(.secondary)
        }.font(.system(.caption,design:.monospaced)).textFieldStyle(.roundedBorder).padding(8).background(.primary.opacity(0.025))
    }
    private func dimensions() {
        let width=min(3840,max(240,Int(widthDraft) ?? tab.viewportWidth ?? 1024)),height=min(3840,max(240,Int(heightDraft) ?? tab.viewportHeight ?? 768))
        guard width*height<=3840*2160 else {controller.message="视口面积不能超过 3840 × 2160";widthDraft=String(tab.viewportWidth ?? 1024);heightDraft=String(tab.viewportHeight ?? 768);return};tab.viewportWidth=width;tab.viewportHeight=height
    }
    private func mount() {
        controller.refreshInterruptedRecordings()
        address=controller.url ?? tab.url ?? "";widthDraft=String(tab.viewportWidth ?? 1024);heightDraft=String(tab.viewportHeight ?? 768)
        controller.metadata={url,title,complete in
            if let url {tab.url=url};if let title,!title.isEmpty {tab.title=title};if complete,let url {visited(url,title)}
        };controller.popup=popup;controller.popupOwner=popupOwner;controller.windowClosed=closed;controller.apply(tab,server:store.connection.server);controller.refreshMetadata()
    }
}

private struct TaskBrowserMiniPreference:View {
    @AppStorage("friday.browser.autoFloat") private var enabled=true
    var body:some View {Toggle(isOn:$enabled) {Text(friday:"关闭侧栏时浮动预览")}.fridayInteractiveCursor()}
}

struct TaskBrowserFileExport:ViewModifier {
    @ObservedObject var controller:TaskBrowserController
    var detached=false
    func body(content:Content)->some View {
        let url=controller.exported?.url
        let shown=Binding(get:{controller.exported != nil && controller.detached==detached},set:{value in if !value,controller.detached==detached {controller.exported=nil}})
        content.fileExporter(isPresented:shown,document:TaskBrowserExportDocument(source:url),contentType:url?.pathExtension.lowercased()=="png" ? .png:url?.pathExtension.lowercased()=="mp4" ? .mpeg4Movie:.data,defaultFilename:url?.lastPathComponent ?? "page") {_ in if let url {TaskBrowserDownloadFiles.removeTemporary(url)};controller.exported=nil}
    }
}

struct TaskBrowserExportDocument:FileDocument {
    static var readableContentTypes:[UTType] {[.data]}
    var source:URL?
    private var incoming:Data?
    init(source:URL?) {self.source=source}
    init(configuration:ReadConfiguration)throws {guard let data=configuration.file.regularFileContents else{throw CocoaError(.fileReadUnsupportedScheme)};incoming=data}
    func fileWrapper(configuration:WriteConfiguration)throws->FileWrapper {if let source {return try FileWrapper(url:source,options:[])};return FileWrapper(regularFileWithContents:incoming ?? Data())}
}
