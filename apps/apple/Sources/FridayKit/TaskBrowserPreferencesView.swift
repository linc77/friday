import SwiftUI

struct TaskBrowserPreferencesView:View {
    @ObservedObject var store:FridayStore
    @ObservedObject var preferences:TaskBrowserPreferences
    var close:(()->Void)?=nil
    @State private var pending:TaskBrowserProfile?
    @State private var removing=false
    @State private var message:String?
    #if os(macOS)
    @State private var importingCookies=false
    #endif
    @AppStorage("friday.browser.autoFloat") private var autoFloat=true
    private func change(_ update:(inout TaskBrowserDefaults)->Void) {var value=preferences.defaults;update(&value);preferences.update(value)}
    var body:some View {
        VStack(spacing:0) {
            HStack {Text(friday:"浏览器").font(.title2.weight(.semibold));Spacer();if let close {Button(action:close){FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"关闭"))}}.padding(20)
            Divider()
            ScrollView {
                VStack(alignment:.leading,spacing:18) {
                    Text(friday:"浏览默认值").font(.headline)
                    Picker(String(localized:"默认浏览配置",bundle:.module),selection:Binding(get:{preferences.defaults.profile},set:{value in change{$0.profile=value}})) {
                        ForEach(preferences.profiles.filter {$0.id != "incognito"}) {profile in if profile.builtIn {Text(fridayString:profile.name).tag(profile.id)}else{Text(verbatim:profile.name).tag(profile.id)}}
                    }.fridayInteractiveCursor()
                    Picker(String(localized:"网页外观",bundle:.module),selection:Binding(get:{preferences.defaults.appearance},set:{value in change{$0.appearance=value}})) {Text(friday:"跟随系统").tag("system");Text(friday:"浅色").tag("light");Text(friday:"深色").tag("dark")}.fridayInteractiveCursor()
                    Picker(String(localized:"网页缩放",bundle:.module),selection:Binding(get:{preferences.defaults.zoom},set:{value in change{$0.zoom=value}})) {ForEach([0.25,0.33,0.5,0.67,0.75,0.8,0.9,1,1.1,1.25,1.5,1.75,2,2.5,3,4,5],id:\.self) {zoom in Text(verbatim:"\(Int(zoom*100))%").tag(zoom)}}.fridayInteractiveCursor()
                    HStack {
                        Text(friday:"设备视口");Spacer()
                        Menu {
                            Button(friday:"填充面板") {change{$0.width=nil;$0.height=nil;$0.mobile=false}}
                            ForEach(TaskBrowserViewportPreset.all) {preset in Button(preset.label) {change{$0.width=preset.width;$0.height=preset.height;$0.mobile=preset.mobile}}}
                        } label:{if let width=preferences.defaults.width,let height=preferences.defaults.height {Text(verbatim:"\(width) × \(height)")}else{Text(friday:"填充面板")}}.fridayInteractiveCursor()
                    }
                    if let width=preferences.defaults.width,let height=preferences.defaults.height {
                        TaskBrowserDefaultDimensions(width:width,height:height) {w,h in
                            guard (240...3840).contains(w),(240...3840).contains(h),w*h<=3840*2160 else{message="视口面积不能超过 3840 × 2160";return}
                            change{$0.width=w;$0.height=h}
                        }
                    }
                    Toggle(isOn:$autoFloat) {Text(friday:"收起网页面板时浮动预览")}.fridayInteractiveCursor()
                    Text(friday:"默认值应用于新标签页，已有页面保持当前设置。").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    HStack {Text(friday:"浏览配置").font(.headline);Spacer();Button(friday:"新增浏览配置") {_=preferences.create(String(localized:"New profile",bundle:.module))}.buttonStyle(FridayButtonStyle(compact:true)).disabled(preferences.userProfiles.count>=24)}
                    #if os(macOS)
                    Button {importingCookies=true} label:{FridaySymbolLabel(friday:"导入浏览器 Cookie",systemImage:"arrow.down.doc")}.buttonStyle(FridayButtonStyle(compact:true)).disabled(!store.connected)
                    #endif
                    ForEach(preferences.profiles) {profile in
                        HStack(spacing:10) {
                            FridaySymbolImage(systemName:profile.id=="incognito" ? "eye.slash":"person.crop.circle").foregroundStyle(.secondary)
                            if profile.builtIn {Text(fridayString:profile.name).frame(maxWidth:.infinity,alignment:.leading)}else{TaskBrowserProfileNameField(profile:profile,save:{preferences.rename(profile.id,to:$0)})}
                            if profile.id==preferences.defaults.profile {Text(friday:"默认").font(.caption).foregroundStyle(.secondary)}
                            Button(friday:"清除数据") {removing=false;pending=profile}.buttonStyle(FridayButtonStyle(compact:true))
                            if !profile.builtIn {Button {removing=true;pending=profile} label:{FridaySymbolImage(systemName:"trash")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"删除浏览配置"))}
                        }.padding(10).background(.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:8))
                    }
                    Text(friday:"最多 24 个自定义配置，名称最多 48 个字符。无痕配置不能设为默认。").font(.caption).foregroundStyle(.secondary)
                    if let message {Text(fridayString:message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)}
                }.padding(20).frame(maxWidth:720,alignment:.leading).frame(maxWidth:.infinity)
            }.disabled(preferences.busy)
        }
        #if os(macOS)
        .frame(minWidth:420,idealWidth:660,minHeight:400,idealHeight:660)
        #else
        .frame(maxWidth:.infinity,minHeight:400)
        #endif
        #if os(macOS)
        .sheet(isPresented:$importingCookies) {TaskBrowserImportView(store:store,preferences:preferences,close:{importingCookies=false})}
        #endif
        .confirmationDialog(Text(friday:removing ? "删除浏览配置":"清除浏览数据"),isPresented:Binding(get:{pending != nil},set:{if !$0 {pending=nil}}),titleVisibility:.visible) {
            Button(friday:removing ? "删除浏览配置":"清除数据",role:.destructive) {if let profile=pending {act(profile,remove:removing)};pending=nil}
            Button(friday:"取消",role:.cancel) {pending=nil}
        } message:{Text(friday:pending?.id=="incognito" ? "将清除此设备的无痕浏览数据。":"将清除 Cookie、网站存储和缓存，并关闭使用此配置的主机页面。此操作不能撤销。")}
    }
    private func act(_ profile:TaskBrowserProfile,remove:Bool) {
        Task {
            do {
                if remove {try await preferences.remove(profile.id){try await TaskBrowserProfileData.clear(store:store,profile:profile.id)}}else{try await preferences.clear(profile.id){try await TaskBrowserProfileData.clear(store:store,profile:profile.id)}}
                message=remove ? "浏览配置已删除":"浏览数据已清除"
            }catch {message=error.localizedDescription}
        }
    }
}
private struct TaskBrowserDefaultDimensions:View {
    let width:Int;let height:Int;let save:(Int,Int)->Void
    @State private var w=""
    @State private var h=""
    var body:some View {
        HStack {Text(friday:"尺寸");Spacer();TextField(friday:"宽度",text:$w).frame(width:70);Text(verbatim:"×");TextField(friday:"高度",text:$h).frame(width:70)}.textFieldStyle(.roundedBorder)
            .onAppear{w=String(width);h=String(height)}.onChange(of:width){_,value in w=String(value)}.onChange(of:height){_,value in h=String(value)}
            .onSubmit {if let width=Int(w),let height=Int(h) {save(width,height)}}
    }
}
private struct TaskBrowserProfileNameField:View {
    let profile:TaskBrowserProfile
    let save:(String)->Void
    @State private var draft=""
    @FocusState private var focused:Bool
    var body:some View {
        TextField(friday:"配置名称",text:$draft).textFieldStyle(.roundedBorder).focused($focused).onSubmit{save(draft)}.onChange(of:focused){_,value in if !value {save(draft)}}.onAppear{draft=profile.name}.onChange(of:profile.name){_,value in if !focused {draft=value}}
    }
}
@MainActor enum TaskBrowserProfileData {
    static func clear(store:FridayStore,profile:String)async throws {
        let scope=store.serviceId ?? store.connectionIdentity
        var request=try store.connection.request("/api/task-browser/profiles/clear");request.httpMethod="POST";request.httpBody=try JSONSerialization.data(withJSONObject:["profile":profile]);request.setValue("application/json",forHTTPHeaderField:"Content-Type")
        let (data,response)=try await URLSession.shared.data(for:request)
        guard let http=response as? HTTPURLResponse,http.statusCode==200 else{throw ConnectionError.message((try? JSONDecoder().decode(APIError.self,from:data).error) ?? "无法清除主机浏览数据")}
        await TaskBrowserSessions.shared.clearProfileData(profileScope:scope,profile:profile)
    }
}
