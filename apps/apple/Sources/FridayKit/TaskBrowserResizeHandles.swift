import SwiftUI

struct TaskBrowserResizeHandles:View {
    let width:Int;let height:Int;let scale:Double
    let resize:(Int,Int)->Void
    @State private var start:(Int,Int,Double)?
    var body:some View {
        ZStack(alignment:.topLeading) {
            handle(.width).frame(width:7,height:40).position(x:CGFloat(width)*scale+6,y:CGFloat(height)*scale/2)
            handle(.height).frame(width:40,height:7).position(x:CGFloat(width)*scale/2,y:CGFloat(height)*scale+6)
            handle(.both).frame(width:10,height:10).position(x:CGFloat(width)*scale+6,y:CGFloat(height)*scale+6)
        }.frame(width:CGFloat(width)*scale,height:CGFloat(height)*scale)
    }
    private func handle(_ axis:TaskBrowserPolicy.ResizeAxis)->some View {
        RoundedRectangle(cornerRadius:3).fill(.primary.opacity(0.25)).contentShape(Rectangle()).fridayInteractiveCursor()
            .gesture(DragGesture(minimumDistance:1).onChanged {gesture in
                if start==nil {start=(width,height,scale)}
                let value=TaskBrowserPolicy.resized(width:start?.0 ?? width,height:start?.1 ?? height,dx:gesture.translation.width,dy:gesture.translation.height,scale:start?.2 ?? scale,axis:axis);resize(value.width,value.height)
            }.onEnded {_ in start=nil})
            .accessibilityLabel(Text(friday:axis == .width ? "调整网页宽度":axis == .height ? "调整网页高度":"调整网页视口"))
            .accessibilityValue(Text(verbatim:"\(width) × \(height)"))
            .accessibilityAdjustableAction {direction in let delta=direction == .increment ? 40.0 : -40.0;let value=TaskBrowserPolicy.resized(width:width,height:height,dx:delta,dy:delta,scale:1,axis:axis);resize(value.width,value.height)}
    }
}
