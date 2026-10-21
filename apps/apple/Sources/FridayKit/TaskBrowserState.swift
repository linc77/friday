import Foundation

struct TaskBrowserServer: Decodable, Identifiable, Equatable {
    let host:String;let port:Int;let url:String;let processName:String?;let pid:Int?
    let terminal:TaskBrowserTerminalOwner?
    var id:Int { port }
}
struct TaskBrowserTerminalOwner:Decodable,Equatable {let threadId:String;let terminalId:String}
struct TaskBrowserServers:Decodable {let servers:[TaskBrowserServer];let scannedAt:String}
struct TaskBrowserResolvedAddress:Decodable {let url:String}
struct TaskBrowserTab:Codable,Equatable,Identifiable {
    var id=UUID().uuidString
    var url:String?
    var title:String?
    var navigationID=UUID().uuidString
    var zoom=1.0
    var appearance="system"
    var viewportWidth:Int?
    var viewportHeight:Int?
    var deviceToolbar=false
    var mobile=false
    var profile="default"
    var incognito=false
    var hostBrowser:Bool?=nil
    var hostGeneration:String?=nil
    var name:String { title.flatMap { $0.isEmpty ? nil:$0 } ?? url.flatMap { URL(string:$0)?.host } ?? "新标签页" }
    mutating func navigate(_ value:String) { url=value;title=nil;navigationID=UUID().uuidString }
}
struct TaskBrowserPanelState:Codable,Equatable {
    var tabs:[TaskBrowserTab]=[]
    var selected:String?
    var visible=false
    var configuredURLs:[String]?=nil
    var closed:[TaskBrowserTab]?=nil
    var current:TaskBrowserTab? { tabs.first { $0.id==selected } ?? tabs.first }
    @discardableResult mutating func open(_ url:String?=nil,profile:String?=nil,incognito:Bool=false,defaults:TaskBrowserDefaults?=nil)->TaskBrowserTab {
        let values=defaults ?? TaskBrowserDefaults(),profile=profile ?? defaults?.profile ?? "default"
        let tab=TaskBrowserTab(url:url,zoom:values.zoom,appearance:values.appearance,viewportWidth:values.width,viewportHeight:values.height,deviceToolbar:values.width != nil,mobile:values.mobile,profile:profile,incognito:incognito || profile=="incognito");tabs.append(tab);selected=tab.id;visible=true;return tab
    }
    mutating func close(_ id:String) {
        guard let index=tabs.firstIndex(where:{$0.id==id}) else { return }
        let tab=tabs.remove(at:index)
        if !tab.incognito { closed=([tab]+(closed ?? [])).prefix(10).map { $0 } }
        if selected==id { selected=tabs.isEmpty ? nil:tabs[min(index,tabs.count-1)].id }
    }
    mutating func reopen() {
        guard var values=closed,!values.isEmpty else { return };var tab=values.removeFirst();closed=values
        tab.id=UUID().uuidString;tab.navigationID=UUID().uuidString;tabs.append(tab);selected=tab.id;visible=true
    }
    mutating func move(_ id:String,before destination:String) {
        guard id != destination,let from=tabs.firstIndex(where:{$0.id==id}),tabs.contains(where:{$0.id==destination}) else { return }
        let tab=tabs.remove(at:from);let index=tabs.firstIndex(where:{$0.id==destination}) ?? tabs.count;tabs.insert(tab,at:index)
    }
    var persisted:Self {
        var value=self;value.tabs=tabs.filter { !$0.incognito };value.closed=closed?.filter { !$0.incognito }
        if !value.tabs.contains(where:{$0.id==selected}) { value.selected=value.tabs.first?.id }
        return value
    }
    mutating func validate() {
        var ids=Set<String>();tabs=tabs.filter { tab in !tab.id.isEmpty && ids.insert(tab.id).inserted && (tab.url == nil || TaskBrowserPolicy.url(tab.url!) != nil) }
        for index in tabs.indices {
            if !TaskBrowserProfile.validID(tabs[index].profile) {tabs[index].profile="default"}
            tabs[index].zoom=tabs[index].zoom.isFinite ? min(5,max(0.25,tabs[index].zoom)):1
            if !["system","light","dark"].contains(tabs[index].appearance) { tabs[index].appearance="system" }
            if let width=tabs[index].viewportWidth { tabs[index].viewportWidth=min(3840,max(240,width)) }
            if let height=tabs[index].viewportHeight { tabs[index].viewportHeight=min(3840,max(240,height)) }
            if let width=tabs[index].viewportWidth,let height=tabs[index].viewportHeight,width*height>3840*2160 {tabs[index].viewportHeight=3840*2160/width}
        }
        if !tabs.contains(where:{$0.id==selected}) { selected=tabs.first?.id }
        configuredURLs=Array((configuredURLs ?? []).filter { TaskBrowserPolicy.url($0) != nil }.prefix(32))
    }
}
enum TaskBrowserPolicy {
    static let loopback:Set<String>=["localhost","127.0.0.1","0.0.0.0","::1","[::1]"]
    static func url(_ value:String)->URL? {
        guard value.utf16.count<=2048,let url=URL(string:value),["http","https"].contains(url.scheme?.lowercased() ?? ""),url.host?.isEmpty==false else { return nil };return url
    }
    static func local(_ url:URL)->Bool { loopback.contains(url.host?.lowercased() ?? "") }
    static func usesHost(_ tab:TaskBrowserTab,server:String)->Bool {tab.hostBrowser==true || tab.url.flatMap(url).map {!canOpen($0,server:server)}==true}
    static func canOpen(_ url:URL,server:String)->Bool {
        guard local(url) else { return true }
        #if os(macOS)
        return URL(string:server).map(local) == true
        #else
        return false
        #endif
    }
    static func zoom(_ current:Double,increase:Bool)->Double {
        let values:[Double]=[0.25,0.33,0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5]
        return increase ? values.first(where:{$0>current+0.001}) ?? 5:values.last(where:{$0<current-0.001}) ?? 0.25
    }
    enum ResizeAxis {case width,height,both}
    static func resized(width:Int,height:Int,dx:Double,dy:Double,scale:Double,axis:ResizeAxis)->(width:Int,height:Int) {
        let factor=scale.isFinite && scale>0 ? scale:1
        var w=Int(min(3840,max(240,(Double(width)+(axis == .height || !dx.isFinite ? 0:dx/factor)).rounded())))
        var h=Int(min(3840,max(240,(Double(height)+(axis == .width || !dy.isFinite ? 0:dy/factor)).rounded())))
        if w*h>3840*2160 {if axis == .width {w=3840*2160/h} else {h=3840*2160/w}}
        return(w,h)
    }
    static func historyKey(_ value:String)->String? {
        guard let normalized=historyURL(value),let url=url(normalized),var parts=URLComponents(url:url,resolvingAgainstBaseURL:false) else { return nil }
        if local(url) {parts.host="local"}
        return parts.string
    }
    static func historyURL(_ value:String)->String? {
        guard let url=url(value),var parts=URLComponents(url:url,resolvingAgainstBaseURL:false) else{return nil};parts.user=nil;parts.password=nil
        if parts.path.isEmpty {parts.path="/"};return parts.string
    }
}
struct TaskBrowserVisit:Codable,Equatable,Identifiable {
    var url:String;var title:String?;var at:Date
    var id:String { TaskBrowserPolicy.historyKey(url) ?? url }
}
enum TaskBrowserSessionScope {
    static func value(owner:UUID,connection:String,task:String)->String {owner.uuidString+"\n"+connection+"\n"+task}
    static func obsolete(_ key:String,owner:UUID,connection:String,taskIDs:Set<String>?)->Bool {
        let ownerPrefix=owner.uuidString+"\n";guard key.hasPrefix(ownerPrefix) else{return false}
        let connectionPrefix=ownerPrefix+connection+"\n";guard key.hasPrefix(connectionPrefix) else{return true}
        guard let taskIDs else{return false}
        let task=key.dropFirst(connectionPrefix.count).split(separator:"\n",maxSplits:1).first.map(String.init) ?? ""
        return !taskIDs.contains(task)
    }
}
