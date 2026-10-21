import SwiftUI

struct TaskHostBrowserFloatingSurface:View {
    @ObservedObject var controller:TaskHostBrowserController
    let state:TaskBrowserFloatingState
    let container:TaskBrowserMiniSize
    let scope:String
    let restore:()->Void
    let popup:(TaskHostBrowserSnapshot.Popup)->Bool
    @State private var hovering=false
    @State private var tools=false
    @State private var start:TaskBrowserMiniFrame?
    @State private var owner=UUID()
    private let sessions=TaskBrowserSessions.shared
    private var source:TaskBrowserMiniSize {.init(width:controller.viewport.width,height:controller.viewport.height)}
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
                    TaskHostBrowserCanvas(controller:controller).frame(width:f.width,height:f.height)
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
            .onAppear {controller.popup=popup;controller.popupOwner=owner;controller.acquireSurface(owner)}
            .onDisappear {if controller.popupOwner==owner {controller.popup=nil;controller.popupOwner=nil};controller.releaseSurface(owner)}
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
