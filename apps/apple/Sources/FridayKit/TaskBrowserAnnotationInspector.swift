import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct TaskBrowserAnnotationInspector:View {
    @ObservedObject var session:TaskBrowserAnnotationSession
    @State private var locked=true
    @State private var ratio=1.0
    var body:some View {
        VStack(alignment:.leading,spacing:10) {
            HStack {Text(friday:"临时调整样式").font(.headline);Spacer();Button {session.inspecting=false} label:{FridaySymbolImage(systemName:"xmark")}.buttonStyle(FridaySymbolButtonStyle())}
            Text(friday:"样式只在本次批注中预览，结束后还原。").font(.caption).foregroundStyle(.secondary)
            ScrollView {
                VStack(spacing:9) {
                    field("字体", "font-family");field("字号", "font-size");field("字重", "font-weight");field("行高", "line-height")
                    Divider();field("文字颜色", "color");field("背景颜色", "background-color");field("不透明度", "opacity")
                    Divider();field("圆角", "border-radius");field("边框颜色", "border-color");field("边框宽度", "border-width")
                    Divider()
                    HStack {Text(friday:"尺寸").font(.caption);Spacer();Button {locked.toggle()} label:{FridaySymbolImage(systemName:locked ? "link":"link.badge.plus")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"锁定宽高比")).accessibilityValue(Text(friday:locked ? "已锁定":"未锁定"))}
                    field("宽度", "width");field("高度", "height")
                    field("内边距", "padding");field("外边距", "margin");field("间距", "gap")
                    Divider();field("布局", "display");field("排列方向", "flex-direction");field("交叉轴对齐", "align-items");field("主轴对齐", "justify-content")
                }.padding(.trailing,3)
            }.frame(maxHeight:410).disabled(session.capturing || session.snapshot?.elements.isEmpty != false)
        }.padding(14).frame(width:330).onAppear {rememberRatio()}.onChange(of:session.snapshot?.elements.first?.id) {_,_ in rememberRatio()}
    }
    private func field(_ label:String,_ property:String)->some View {
        TaskBrowserAnnotationStyleField(label:label,value:session.snapshot?.styleValues[property] ?? "",color:["color","background-color","border-color"].contains(property)) {input in
            let dimensional=["font-size","border-radius","border-width","width","height"].contains(property)
            let value=dimensional && Double(input) != nil ? input+"px":input
            session.style(property,value)
            if property=="border-width" {session.style("border-style","solid")}
            if locked,ratio>0,let number=Double(value.replacingOccurrences(of:"px",with:"").trimmingCharacters(in:.whitespaces)),number>0 {
                if property=="width" {session.style("height",String(Int(max(1,(number/ratio).rounded())))+"px")}
                if property=="height" {session.style("width",String(Int(max(1,(number*ratio).rounded())))+"px")}
            }
        }
    }
    private func rememberRatio() {if let rect=session.snapshot?.elements.first?.rect,rect.height>0 {ratio=rect.width/rect.height}}
}
private struct TaskBrowserAnnotationStyleField:View {
    let label:String;let value:String;let color:Bool;let commit:(String)->Void
    @State private var draft=""
    @FocusState private var focused:Bool
    var body:some View {
        HStack(spacing:8) {
            Text(fridayString:label).font(.caption).frame(width:88,alignment:.leading)
            if color {ColorPicker("",selection:Binding(get:{cssColor(draft)},set:{draft=cssText($0);apply()}),supportsOpacity:false).labelsHidden().frame(width:26).fridayInteractiveCursor().accessibilityLabel(Text(fridayString:label))}
            TextField("",text:$draft).textFieldStyle(.roundedBorder).font(.system(.caption,design:.monospaced)).focused($focused).onSubmit {apply()}
                .accessibilityLabel(Text(fridayString:label)).onChange(of:focused) {_,focus in if !focus {apply()}}
        }.onAppear {draft=value}.onChange(of:value) {_,new in if !focused {draft=new}}
    }
    private func apply() {let text=TaskBrowserAnnotationText.trim(draft);if !text.isEmpty,text != value,text.utf16.count<=2048 {commit(text)}}
    private func cssColor(_ value:String)->Color {
        let text=value.trimmingCharacters(in:.whitespacesAndNewlines)
        if text.hasPrefix("#"),text.count==7,let code=Int(text.dropFirst(),radix:16) {return Color(red:Double(code>>16 & 255)/255,green:Double(code>>8 & 255)/255,blue:Double(code & 255)/255)}
        let parts=text.components(separatedBy:CharacterSet(charactersIn:"0123456789.").inverted).compactMap(Double.init)
        if text.hasPrefix("rgb"),parts.count>=3 {return Color(red:parts[0]/255,green:parts[1]/255,blue:parts[2]/255)};return .black
    }
    private func cssText(_ color:Color)->String {
        #if os(macOS)
        let rgb=NSColor(color).usingColorSpace(.deviceRGB) ?? .black
        return String(format:"#%02x%02x%02x",Int((rgb.redComponent*255).rounded()),Int((rgb.greenComponent*255).rounded()),Int((rgb.blueComponent*255).rounded()))
        #else
        var r:CGFloat=0,g:CGFloat=0,b:CGFloat=0,a:CGFloat=0;UIColor(color).getRed(&r,green:&g,blue:&b,alpha:&a)
        return String(format:"#%02x%02x%02x",Int((r*255).rounded()),Int((g*255).rounded()),Int((b*255).rounded()))
        #endif
    }
}
