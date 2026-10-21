import SwiftUI
import WebKit

struct TaskBrowserFloatingPreview:ViewModifier {
    @ObservedObject var store:FridayStore
    let task:WorkItem
    @Binding var browser:TaskBrowserPanelState
    @Binding var activePanel:String
    @ObservedObject private var sessions=TaskBrowserSessions.shared
    private var scope:String {TaskBrowserSessionScope.value(owner:store.browserClientID,connection:store.connectionIdentity,task:task.id)}
    func body(content:Content)->some View {
        content.overlay(alignment:.topLeading) {
            if let state=sessions.floating[scope],state.host,let controller=TaskHostBrowserSessions.shared.existing(scope:scope,id:state.tabID),browser.tabs.contains(where:{$0.id==state.tabID}) {
                GeometryReader {geometry in
                    TaskHostBrowserFloatingSurface(controller:controller,state:state,container:.init(width:geometry.size.width,height:geometry.size.height),scope:scope,restore:{
                        guard browser.tabs.contains(where:{$0.id==state.tabID}) else{return};sessions.closeFloat(scope:scope,id:state.tabID);browser.selected=state.tabID;browser.visible=true;activePanel="browser"
                    },popup:{value in
                        guard sessions.floating[scope]?.tabID==state.tabID,let source=browser.tabs.first(where:{$0.id==state.tabID}),!browser.tabs.contains(where:{$0.id==value.tabId}) else{return false}
                        var tab=TaskBrowserTab(id:value.tabId,url:TaskBrowserPolicy.url(value.url)?.absoluteString ?? source.url,zoom:source.zoom,appearance:source.appearance,profile:source.profile,incognito:source.incognito,hostBrowser:true,hostGeneration:value.generation)
                        tab.deviceToolbar=source.deviceToolbar;browser.tabs.append(tab);browser.selected=tab.id;browser.visible=true;sessions.closeFloat(scope:scope,id:state.tabID);activePanel="browser";return true
                    }).id(scope+"\n"+state.tabID+"-host")
                }
            }else if let state=sessions.floating[scope],let controller=sessions.existing(scope:scope,id:state.tabID),browser.tabs.contains(where:{$0.id==state.tabID}) {
                GeometryReader {geometry in
                    TaskBrowserFloatingSurface(controller:controller,state:state,container:.init(width:geometry.size.width,height:geometry.size.height),scope:scope,restore:{
                        guard browser.tabs.contains(where:{$0.id==state.tabID}) else{return};sessions.closeFloat(scope:scope,id:state.tabID);browser.selected=state.tabID;browser.visible=true;activePanel="browser"
                    },popup:{configuration,url in
                        guard sessions.floating[scope]?.tabID==state.tabID,let source=browser.tabs.first(where:{$0.id==state.tabID}) else{return nil}
                        var tab=browser.open(url?.absoluteString ?? "about:blank",profile:source.profile,incognito:source.incognito);tab.zoom=source.zoom;tab.appearance=source.appearance;tab.viewportWidth=source.viewportWidth;tab.viewportHeight=source.viewportHeight;tab.mobile=source.mobile;tab.deviceToolbar=source.deviceToolbar
                        if let index=browser.tabs.firstIndex(where:{$0.id==tab.id}) {browser.tabs[index]=tab}
                        let child=sessions.controller(scope:scope,profileScope:store.serviceId ?? store.connectionIdentity,tab:tab,configuration:configuration);child.apply(tab,server:store.connection.server)
                        sessions.closeFloat(scope:scope,id:state.tabID);activePanel="browser";return child.view
                    }).id(scope+"\n"+state.tabID)
                }
            }
        }
    }
}
private struct TaskBrowserFloatingSurface:View {
    @ObservedObject var controller:TaskBrowserController
    let state:TaskBrowserFloatingState
    let container:TaskBrowserMiniSize
    let scope:String
    let restore:()->Void
    let popup:(WKWebViewConfiguration,URL?)->WKWebView?
    @State private var hovering=false
    @State private var tools=false
    @State private var start:TaskBrowserMiniFrame?
    @State private var owner=UUID()
    private let sessions=TaskBrowserSessions.shared
    private var source:TaskBrowserMiniSize {controller.preferredViewport.map {.init(width:$0.width,height:$0.height)} ?? state.source}
    private var frame:TaskBrowserMiniFrame {TaskBrowserMiniLayout.resolve(width:state.width,position:state.position,source:source,container:container)}
    var body:some View {
        let f=frame
        ZStack(alignment:.topLeading) {
            RoundedRectangle(cornerRadius:12).fill(FridayTheme.canvas).shadow(color:.black.opacity(0.22),radius:14,y:5)
            Group {
                if controller.detached {
                    VStack(spacing:8) {Text(friday:"网页已在独立窗口中打开");Button(friday:"返回浮动预览") {
                        #if os(macOS)
                        controller.returnInline()
                        #endif
                    }.buttonStyle(FridayButtonStyle(compact:true))}.padding()
                } else {
                    TaskBrowserNativeView(controller:controller,floating:true).frame(width:source.width,height:source.height).scaleEffect(f.width/source.width,anchor:.topLeading).frame(width:f.width,height:f.height)
                }
            }.clipShape(RoundedRectangle(cornerRadius:12))
            RoundedRectangle(cornerRadius:12).strokeBorder(.primary.opacity(0.18),lineWidth:1).allowsHitTesting(false)
            handles(f)
            HStack(spacing:3) {
                FridaySymbolImage(systemName:"circle.fill").font(.system(size:8)).foregroundStyle(controller.recordingSession==nil ? Color.primary.opacity(0.25):.red).padding(2).contentShape(Rectangle()).fridayInteractiveCursor().gesture(move(f)).accessibilityLabel(Text(friday:controller.recordingSession==nil ? "移动浮动预览":"正在录屏，可拖动浮动预览"))
                    .onTapGesture {tools.toggle()}
                if hovering || tools {
                    #if os(macOS)
                    Button {controller.toggleMiniPlayer()} label:{FridaySymbolImage(systemName:"pip")}.help(Text(friday:"置顶小预览"))
                    #endif
                    Button(action:restore) {FridaySymbolImage(systemName:"sidebar.right")}.help(Text(friday:"返回任务侧栏"))
                    Button {sessions.closeFloat(scope:scope,id:state.tabID)} label:{FridaySymbolImage(systemName:"xmark")}.help(Text(friday:"关闭浮动预览"))
                }
            }.buttonStyle(FridaySymbolButtonStyle()).padding(hovering || tools ? 2:0).background(.regularMaterial,in:RoundedRectangle(cornerRadius:8)).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topTrailing)
        }.frame(width:f.width,height:f.height).offset(x:f.x,y:f.y).onHover {hovering=$0}
            .onAppear {controller.popup=popup;controller.popupOwner=owner}
            .onDisappear {if controller.popupOwner==owner {controller.popup=nil;controller.popupOwner=nil};controller.annotationSession?.cancel()}
    }
    private func move(_ frame:TaskBrowserMiniFrame)->some Gesture {
        DragGesture(minimumDistance:6).onChanged {gesture in
            if start==nil {start=frame};guard let start else{return}
            let p=TaskBrowserMiniLayout.clamp(.init(x:start.x+gesture.translation.width,y:start.y+gesture.translation.height),container:container,player:start.size)
            sessions.moveFloat(scope:scope,id:state.tabID,point:p)
        }.onEnded {_ in start=nil}
    }
    private func handles(_ frame:TaskBrowserMiniFrame)->some View {
        ZStack(alignment:.topLeading) {
            ForEach(["north","south","west","east","northwest","northeast","southwest","southeast"],id:\.self) {direction in
                let corner=direction.count>5,north=direction.contains("north"),south=direction.contains("south"),west=direction.contains("west"),east=direction.contains("east")
                Color.clear.contentShape(Rectangle()).frame(width:corner ? 16:(east || west) ? 8:max(1,frame.width-16),height:corner ? 16:(north || south) ? 8:max(1,frame.height-16))
                    .position(x:west ? 0:east ? frame.width:frame.width/2,y:north ? 0:south ? frame.height:frame.height/2).fridayInteractiveCursor()
                    .gesture(DragGesture(minimumDistance:1).onChanged {gesture in
                        if start==nil {start=frame};guard let start else{return}
                        let result=TaskBrowserMiniLayout.resize(start:start,direction:direction,delta:.init(x:gesture.translation.width,y:gesture.translation.height),source:source,container:container)
                        sessions.resizeFloat(scope:scope,id:state.tabID,frame:result)
                    }.onEnded {_ in start=nil})
                    .accessibilityLabel(Text(friday:"调整浮动预览大小"))
                    .accessibilityAdjustableAction {action in let d=action == .increment ? 40.0:-40.0;let result=TaskBrowserMiniLayout.resize(start:frame,direction:"southeast",delta:.init(x:d,y:d),source:source,container:container);sessions.resizeFloat(scope:scope,id:state.tabID,frame:result)}
            }
        }
    }
}
