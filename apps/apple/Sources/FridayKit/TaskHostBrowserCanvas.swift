import SwiftUI
import CoreGraphics
#if os(macOS)
import AppKit

struct TaskHostBrowserCanvas:NSViewRepresentable {
    @ObservedObject var controller:TaskHostBrowserController
    var keyboardRequested=false
    func makeNSView(context:Context)->TaskHostBrowserNativeCanvas {let view=TaskHostBrowserNativeCanvas();view.drawsBackground=false;view.isRichText=false;view.isAutomaticQuoteSubstitutionEnabled=false;view.isAutomaticDashSubstitutionEnabled=false;view.isAutomaticTextReplacementEnabled=false;view.isAutomaticSpellingCorrectionEnabled=false;view.controller=controller;return view}
    func updateNSView(_ view:TaskHostBrowserNativeCanvas,context:Context) {view.controller=controller;view.needsDisplay=true}
}
final class TaskHostBrowserNativeCanvas:NSTextView {
    weak var controller:TaskHostBrowserController?
    private var tracking:NSTrackingArea?
    private var pointer=CGPoint.zero
    override var isFlipped:Bool {true}
    private var viewport:CGSize {controller?.viewport ?? CGSize(width:1280,height:800)}
    private var content:CGRect {TaskHostBrowserGeometry.frame(container:bounds.size,viewport:viewport)}
    override func updateTrackingAreas() {super.updateTrackingAreas();if let tracking {removeTrackingArea(tracking)};let area=NSTrackingArea(rect:.zero,options:[.activeInKeyWindow,.inVisibleRect,.mouseMoved,.mouseEnteredAndExited],owner:self,userInfo:nil);addTrackingArea(area);tracking=area}
    override func draw(_ dirtyRect:NSRect) {
        NSColor.windowBackgroundColor.setFill();bounds.fill()
        guard let image=controller?.image else{return}
        NSImage(cgImage:image,size:NSSize(width:image.width,height:image.height)).draw(in:content,from:.zero,operation:.copy,fraction:1,respectFlipped:true,hints:nil)
        if hasMarkedText(),!string.isEmpty {let label=NSAttributedString(string:string,attributes:[.font:NSFont.systemFont(ofSize:14),.foregroundColor:NSColor.labelColor,.backgroundColor:NSColor.windowBackgroundColor,.underlineStyle:NSUnderlineStyle.single.rawValue]);label.draw(at:CGPoint(x:min(max(0,pointer.x),max(0,bounds.width-160)),y:min(pointer.y+16,max(0,bounds.height-30))))}
    }
    private func modifiers(_ event:NSEvent)->Int {let f=event.modifierFlags;return (f.contains(.option) ? 1:0)|(f.contains(.control) ? 2:0)|(f.contains(.command) ? 4:0)|(f.contains(.shift) ? 8:0)}
    private func mouse(_ event:NSEvent,phase:String,button:String,clamped:Bool=false) {
        guard let controller,controller.canOperate else{return};pointer=convert(event.locationInWindow,from:nil)
        guard let point=TaskHostBrowserGeometry.point(pointer,frame:content,viewport:viewport,clamped:clamped) else{return}
        let buttons=Int(NSEvent.pressedMouseButtons)&7
        controller.send(["type":"pointer","phase":phase,"x":point.x,"y":point.y,"button":button,"buttons":buttons,"modifiers":modifiers(event),"clicks":min(3,max(0,event.clickCount))])
    }
    override func mouseDown(with event:NSEvent) {window?.makeFirstResponder(self);mouse(event,phase:"down",button:"left")}
    override func mouseUp(with event:NSEvent) {mouse(event,phase:"up",button:"left",clamped:true)}
    override func mouseDragged(with event:NSEvent) {mouse(event,phase:"move",button:"left",clamped:true)}
    override func rightMouseDown(with event:NSEvent) {mouse(event,phase:"down",button:"right")}
    override func rightMouseUp(with event:NSEvent) {mouse(event,phase:"up",button:"right",clamped:true)}
    override func rightMouseDragged(with event:NSEvent) {mouse(event,phase:"move",button:"right",clamped:true)}
    override func otherMouseDown(with event:NSEvent) {mouse(event,phase:"down",button:"middle")}
    override func otherMouseUp(with event:NSEvent) {mouse(event,phase:"up",button:"middle",clamped:true)}
    override func otherMouseDragged(with event:NSEvent) {mouse(event,phase:"move",button:"middle",clamped:true)}
    override func mouseMoved(with event:NSEvent) {mouse(event,phase:"move",button:"none")}
    override func scrollWheel(with event:NSEvent) {
        guard let controller,controller.canOperate,let point=TaskHostBrowserGeometry.point(convert(event.locationInWindow,from:nil),frame:content,viewport:viewport) else{return}
        let scale=event.hasPreciseScrollingDeltas ? 1.0:16.0
        controller.send(["type":"wheel","x":point.x,"y":point.y,"dx":max(-10000,min(10000,-event.scrollingDeltaX*scale)),"dy":max(-10000,min(10000,-event.scrollingDeltaY*scale)),"modifiers":modifiers(event)])
    }
    private func key(_ event:NSEvent,phase:String) {
        guard let controller,controller.canOperate else{return}
        let special:[UInt16:(String,String,Int)]=[36:("Enter","Enter",13),48:("Tab","Tab",9),51:("Backspace","Backspace",8),53:("Escape","Escape",27),115:("Home","Home",36),116:("PageUp","PageUp",33),117:("Delete","Delete",46),119:("End","End",35),121:("PageDown","PageDown",34),123:("ArrowLeft","ArrowLeft",37),124:("ArrowRight","ArrowRight",39),125:("ArrowDown","ArrowDown",40),126:("ArrowUp","ArrowUp",38)]
        let characters=event.charactersIgnoringModifiers ?? "",ascii=characters.uppercased().unicodeScalars.first?.value ?? 0
        let value=special[event.keyCode] ?? (characters,characters.count==1 && ascii>=65 && ascii<=90 ? "Key"+characters.uppercased():characters.count==1 && ascii>=48 && ascii<=57 ? "Digit"+characters:characters==" " ? "Space":"",Int(min(255,ascii)))
        controller.send(["type":"key","phase":phase,"key":value.0,"code":value.1,"keyCode":value.2,"modifiers":modifiers(event),"repeat":event.isARepeat])
    }
    override func keyDown(with event:NSEvent) {guard controller?.canOperate==true else{return};key(event,phase:"down");if !event.modifierFlags.contains(.command),!event.modifierFlags.contains(.control) {interpretKeyEvents([event])}}
    override func keyUp(with event:NSEvent) {key(event,phase:"up")}
    override func doCommand(by selector:Selector) { /* Control keys already travel through CDP; preserve the native IME editor only. */ }
    override func insertText(_ insertString:Any,replacementRange:NSRange) {
        let text=(insertString as? NSAttributedString)?.string ?? insertString as? String ?? ""
        super.unmarkText();string="";needsDisplay=true
        if !text.isEmpty {controller?.send(["type":"text","text":String(text.prefix(8192))])}
    }
    override func setMarkedText(_ string:Any,selectedRange:NSRange,replacementRange:NSRange) {super.setMarkedText(string,selectedRange:selectedRange,replacementRange:replacementRange);needsDisplay=true}
    override func firstRect(forCharacterRange range:NSRange,actualRange:NSRangePointer?)->NSRect {actualRange?.pointee=range;guard let window else{return .zero};return window.convertToScreen(convert(NSRect(x:pointer.x,y:pointer.y+20,width:1,height:18),to:nil))}
    override func performKeyEquivalent(with event:NSEvent)->Bool {
        guard window?.firstResponder===self,event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command),let key=event.charactersIgnoringModifiers?.lowercased(),["v","c","x","a","z"].contains(key) else{return super.performKeyEquivalent(with:event)}
        if key=="v" {controller?.pasteClipboard()}else{self.key(event,phase:"down");self.key(event,phase:"up")};return true
    }
    override func resignFirstResponder()->Bool {if hasMarkedText() {super.unmarkText();string=""};return super.resignFirstResponder()}
}
#else
import UIKit

struct TaskHostBrowserCanvas:UIViewRepresentable {
    @ObservedObject var controller:TaskHostBrowserController
    var keyboardRequested=false
    func makeUIView(context:Context)->TaskHostBrowserNativeCanvas {let view=TaskHostBrowserNativeCanvas();view.controller=controller;return view}
    func updateUIView(_ view:TaskHostBrowserNativeCanvas,context:Context) {view.controller=controller;view.setNeedsDisplay();if keyboardRequested,!view.isFirstResponder {view.becomeFirstResponder()}else if !keyboardRequested,view.isFirstResponder {view.resignFirstResponder()}}
}
final class TaskHostBrowserNativeCanvas:UIView,UIKeyInput {
    weak var controller:TaskHostBrowserController?
    private var touching=false
    override init(frame:CGRect) {super.init(frame:frame);isMultipleTouchEnabled=false;isAccessibilityElement=true;accessibilityLabel=String(localized:"主机网页画面",bundle:.module);accessibilityTraits=[.allowsDirectInteraction]}
    required init?(coder:NSCoder) {fatalError("init(coder:) has not been implemented")}
    override var canBecomeFirstResponder:Bool {true}
    var hasText:Bool {true}
    var autocorrectionType:UITextAutocorrectionType {.no}
    var autocapitalizationType:UITextAutocapitalizationType {.none}
    var keyboardAppearance:UIKeyboardAppearance {.default}
    private var viewport:CGSize {controller?.viewport ?? CGSize(width:1280,height:800)}
    private var content:CGRect {TaskHostBrowserGeometry.frame(container:bounds.size,viewport:viewport)}
    override func draw(_ rect:CGRect) {guard let context=UIGraphicsGetCurrentContext() else{return};UIColor.systemBackground.setFill();context.fill(bounds);if let image=controller?.image {UIImage(cgImage:image).draw(in:content)}}
    private func point(_ value:CGPoint)->CGPoint? {TaskHostBrowserGeometry.point(value,frame:content,viewport:viewport,clamped:true)}
    private func touch(_ position:CGPoint,phase:String) {guard let p=point(position) else{return};controller?.send(["type":"touch","phase":phase,"x":p.x,"y":p.y])}
    override func touchesBegan(_ touches:Set<UITouch>,with event:UIEvent?) {guard let p=touches.first?.location(in:self),content.contains(p),controller?.canOperate==true else{return};touching=true;touch(p,phase:"start")}
    override func touchesMoved(_ touches:Set<UITouch>,with event:UIEvent?) {if touching,let p=touches.first?.location(in:self) {touch(p,phase:"move")}}
    override func touchesEnded(_ touches:Set<UITouch>,with event:UIEvent?) {if touching {touch(touches.first?.location(in:self) ?? .zero,phase:"end")};touching=false}
    override func touchesCancelled(_ touches:Set<UITouch>,with event:UIEvent?) {if touching {touch(.zero,phase:"cancel")};touching=false}
    func insertText(_ text:String) {if text=="\n" || text=="\r" {press("Enter",code:13)}else if !text.isEmpty {controller?.send(["type":"text","text":String(text.prefix(8192))])}}
    func deleteBackward() {press("Backspace",code:8)}
    private func press(_ key:String,code:Int) {for phase in ["down","up"] {controller?.send(["type":"key","phase":phase,"key":key,"code":key,"keyCode":code,"modifiers":0,"repeat":false])}}
    override var keyCommands:[UIKeyCommand]? {[UIKeyCommand(input:UIKeyCommand.inputEscape,modifierFlags:[],action:#selector(keyCommand(_:))),UIKeyCommand(input:UIKeyCommand.inputUpArrow,modifierFlags:[],action:#selector(keyCommand(_:))),UIKeyCommand(input:UIKeyCommand.inputDownArrow,modifierFlags:[],action:#selector(keyCommand(_:))),UIKeyCommand(input:UIKeyCommand.inputLeftArrow,modifierFlags:[],action:#selector(keyCommand(_:))),UIKeyCommand(input:UIKeyCommand.inputRightArrow,modifierFlags:[],action:#selector(keyCommand(_:))),UIKeyCommand(input:"\t",modifierFlags:[],action:#selector(keyCommand(_:)))]}
    @objc private func keyCommand(_ command:UIKeyCommand) {let keys:[String:(String,Int)]=[UIKeyCommand.inputEscape:("Escape",27),UIKeyCommand.inputUpArrow:("ArrowUp",38),UIKeyCommand.inputDownArrow:("ArrowDown",40),UIKeyCommand.inputLeftArrow:("ArrowLeft",37),UIKeyCommand.inputRightArrow:("ArrowRight",39),"\t":("Tab",9)];if let value=keys[command.input ?? ""] {press(value.0,code:value.1)}}
}
#endif
