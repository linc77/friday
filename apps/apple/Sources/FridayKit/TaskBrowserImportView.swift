#if os(macOS)
import SwiftUI
import WebKit
import AppKit

@MainActor final class TaskBrowserCookieImportModel:ObservableObject {
    @Published private(set) var sources:[TaskBrowserImportSource]=[]
    @Published private(set) var loading=false
    @Published private(set) var busy=false
    @Published private(set) var result:TaskBrowserCookieImportResult?
    @Published private(set) var failure:TaskBrowserImportFailure?
    private let importer:TaskBrowserCookieImporter
    private let write:(TaskBrowserCookieReadBatch,String,String)async->TaskBrowserCookieImportResult
    private let clear:(String,String)async->Void
    init(importer:TaskBrowserCookieImporter=TaskBrowserCookieImporter(),write:((TaskBrowserCookieReadBatch,String,String)async->TaskBrowserCookieImportResult)?=nil,clear:((String,String)async->Void)?=nil) {
        self.importer=importer
        self.write=write ?? {batch,scope,id in let store=TaskBrowserSessions.shared.profileDataStore(scope:scope,profile:id);return await TaskBrowserCookieWriter.write(batch,to:TaskBrowserWebKitCookieSink(store.httpCookieStore))}
        self.clear=clear ?? {scope,id in await TaskBrowserSessions.shared.clearProfileData(profileScope:scope,profile:id)}
    }
    func reload()async {guard !loading,!busy else{return};loading=true;defer{loading=false};sources=await importer.sources()}
    func run(source:String,directory:String,existing:String?,preferences:TaskBrowserPreferences,scope:String)async {
        guard !busy,!loading,let selected=sources.first(where:{$0.id==source}) else{return}
        busy=true;failure=nil;result=nil;var target:TaskBrowserPreferences.ImportTarget?,wrote=false
        defer{if let target {preferences.cancelImport(target)};busy=false}
        do {
            if let unavailable=selected.unavailable {throw unavailable}
            let reserved=try preferences.reserveImport(existing:existing,name:selected.definition.name);target=reserved
            let batch=try await importer.read(sourceID:source,profileDirectory:directory)
            wrote=true;let outcome=await write(batch,scope,reserved.profile.id)
            try preferences.finishImport(reserved,imported:outcome.imported)
            if reserved.isNew,outcome.imported==0 {await clear(scope,reserved.profile.id)}
            result=outcome
        }catch {
            if let target,target.isNew,wrote {await clear(scope,target.profile.id)}
            failure=(error as? TaskBrowserImportFailure) ?? .readFailed
        }
    }
}
private enum TaskBrowserImportTarget:Hashable {case new,existing(String)}
struct TaskBrowserImportView:View {
    @ObservedObject var store:FridayStore
    @ObservedObject var preferences:TaskBrowserPreferences
    @StateObject private var model=TaskBrowserCookieImportModel()
    let close:()->Void
    @State private var source=""
    @State private var directory=""
    @State private var target=TaskBrowserImportTarget.new
    private var available:[TaskBrowserImportSource] {model.sources.filter {$0.unavailable != .notInstalled}}
    private var selected:TaskBrowserImportSource? {model.sources.first {$0.id==source}}
    private var valid:Bool {store.connected && !model.loading && !model.busy && selected?.unavailable==nil && selected?.profiles.contains(where:{$0.directory==directory})==true && (target != .new || preferences.userProfiles.count<24)}
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {Text(friday:"导入浏览器 Cookie").font(.title2.weight(.semibold));Spacer();Button(action:close){FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle()).disabled(model.busy).help(Text(friday:"关闭"))}
            Text(friday:"导入 Cookie 以复用登录状态。macOS 可能请求钥匙串或完全磁盘访问权限。").font(.callout).foregroundStyle(.secondary)
            if model.loading {Text(friday:"正在读取浏览器配置…").foregroundStyle(.secondary)}
            if available.isEmpty,!model.loading {Text(friday:"未发现可导入的浏览器配置").foregroundStyle(.secondary)}
            Picker(String(localized:"来源浏览器",bundle:.module),selection:$source) {ForEach(available) {item in Text(verbatim:item.definition.name).tag(item.id)}}.fridayInteractiveCursor().disabled(model.busy || model.loading)
            Picker(String(localized:"来源配置",bundle:.module),selection:$directory) {ForEach(selected?.profiles ?? []) {profile in Text(verbatim:profile.name+(profile.cookieCount.map {" · \($0) Cookie"} ?? "")).tag(profile.directory)}}.fridayInteractiveCursor().disabled(model.busy || model.loading)
            if let reason=selected?.unavailable {Text(verbatim:reason.localizedDescription).font(.callout).foregroundStyle(.orange)}
            if let selected,selected.definition.engine != "safari" {Text(friday:"请先退出来源浏览器。").font(.caption).foregroundStyle(.secondary)}
            Picker(String(localized:"此 Mac 的浏览配置",bundle:.module),selection:$target) {
                Text(friday:"新建浏览配置").tag(TaskBrowserImportTarget.new)
                ForEach(preferences.profiles.filter {$0.id != "incognito"}) {profile in Group {if profile.builtIn {Text(fridayString:profile.name)}else{Text(verbatim:profile.name)}}.tag(TaskBrowserImportTarget.existing(profile.id))}
            }.fridayInteractiveCursor().disabled(model.busy || model.loading)
            Text(friday:"相同域名、路径和名称的 Cookie 将更新为来源值。").font(.caption).foregroundStyle(.secondary)
            if target == .new,preferences.userProfiles.count>=24 {Text(verbatim:TaskBrowserImportFailure.profileLimitReached.localizedDescription).font(.callout).foregroundStyle(.orange)}
            if let result=model.result {
                Text(String(format:String(localized:"导入完成：%d 项，跳过 %d 项",bundle:.module),result.imported,result.skipped)).font(.callout.weight(.medium))
                if !result.skippedDomains.isEmpty {Text(friday:"部分 Cookie 未能导入").font(.caption).foregroundStyle(.secondary);Text(verbatim:result.skippedDomains.joined(separator:", ")).font(.caption).textSelection(.enabled)}
                if !result.persisted {Text(friday:"已写入登录状态，尚未确认保存到磁盘。").font(.caption).foregroundStyle(.orange)}
            }
            if let failure=model.failure {
                Text(verbatim:failure.localizedDescription).font(.callout).foregroundStyle(.orange)
                if failure == .needsFullDiskAccess {Button(friday:"打开系统设置") {if let url=URL(string:"x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {NSWorkspace.shared.open(url)}}.buttonStyle(FridayButtonStyle(compact:true))}
            }
            HStack {
                Button(friday:"刷新浏览器列表") {Task {await model.reload();selectSource()}}.buttonStyle(FridayButtonStyle(compact:true)).disabled(model.busy || model.loading)
                Spacer()
                if model.busy {Text(friday:"正在导入…").font(.caption).foregroundStyle(.secondary)}
                Button(friday:"导入 Cookie") {
                    let existing:String?;if case .existing(let id)=target {existing=id}else{existing=nil}
                    let scope=store.serviceId ?? store.connectionIdentity,selectedSource=source,selectedDirectory=directory
                    Task {await model.run(source:selectedSource,directory:selectedDirectory,existing:existing,preferences:preferences,scope:scope)}
                }.buttonStyle(FridayButtonStyle(compact:true)).disabled(!valid)
            }
        }.padding(22).frame(width:580).interactiveDismissDisabled(model.busy)
            .task {await model.reload();selectSource()}
            .onChange(of:source){_,_ in directory=selected?.profiles.first?.directory ?? ""}
    }
    private func selectSource() {
        if !available.contains(where:{$0.id==source}) {source=available.first(where:{$0.unavailable==nil && !$0.profiles.isEmpty})?.id ?? available.first?.id ?? ""}
        if selected?.profiles.contains(where:{$0.directory==directory}) != true {directory=selected?.profiles.first?.directory ?? ""}
    }
}
#endif
