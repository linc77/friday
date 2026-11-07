import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum TaskBrowserAnnotationKeyAction:Equatable {case newline,attach,send,cancel,ignore}
enum TaskBrowserAnnotationKeyboard {
    static func action(key:String,shift:Bool,command:Bool,control:Bool,composing:Bool)->TaskBrowserAnnotationKeyAction {
        guard !composing else{return .ignore}
        if key=="Escape" {return .cancel}
        guard key=="Enter" else{return .ignore}
        if shift {return .newline};return command || control ? .send:.attach
    }
}

@MainActor protocol TaskBrowserAnnotationOwner:TaskBrowserCaptureOwner {
    var annotationSession:TaskBrowserAnnotationSession? {get set}
    var annotationAvailable:Bool {get}
    func annotate(_ composer:TaskBrowserAnnotationComposer)
}

struct TaskBrowserAnnotationEntry<Owner:TaskBrowserAnnotationOwner>:View {
    @ObservedObject var controller:Owner
    @ObservedObject var bridge:TaskFileMentionBridge
    private var identity:String {(bridge.context?.browserAnnotations?.target ?? "")+"\n"+(bridge.context?.scope ?? "")}
    var body:some View {
        Button {if let composer=bridge.context?.browserAnnotations {controller.annotate(composer)}} label:{FridaySymbolImage(systemName:"cursorarrow.click")}
            .help(Text(friday:"选择元素并批注")).disabled(bridge.context?.browserAnnotations?.enabled != true || !controller.annotationAvailable)
            .foregroundStyle(controller.annotationSession==nil ? Color.primary:FridayTheme.accent)
            .onChange(of:identity) {_,_ in controller.annotationSession?.cancel()}
    }
}
struct TaskBrowserAnnotationToolbar:View {
    @ObservedObject var session:TaskBrowserAnnotationSession
    var body:some View {
        HStack(spacing:5) {
            ForEach(TaskBrowserAnnotationTool.allCases) {tool in
                Button {session.choose(tool)} label:{FridaySymbolImage(systemName:tool.symbol).foregroundStyle(session.snapshot?.tool==tool ? FridayTheme.accent:Color.primary)}
                    .help(Text(String(localized:String.LocalizationValue(tool.label),bundle:.module)+" ("+tool.key+")"))
            }
            Spacer(minLength:0)
            Text(friday:"Shift 多选").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            Button {session.inspecting.toggle()} label:{FridaySymbolImage(systemName:"slider.horizontal.3")}.help(Text(friday:"临时调整样式"))
                .disabled(session.snapshot?.elements.isEmpty != false)
                .popover(isPresented:$session.inspecting) {TaskBrowserAnnotationInspector(session:session)}
            Button {session.cancel()} label:{FridaySymbolImage(systemName:"xmark")}.help(Text(friday:"取消批注"))
        }.buttonStyle(FridaySymbolButtonStyle()).disabled(session.capturing || !session.ready).padding(.horizontal,10).padding(.vertical,5).background(.primary.opacity(0.03))
    }
}
struct TaskBrowserAnnotationComment:View {
    @ObservedObject var session:TaskBrowserAnnotationSession
    private var valid:Bool {session.comment.utf16.count<=8000 && session.snapshot?.hasTargets==true && session.ready && !session.capturing}
    var body:some View {
        VStack(alignment:.leading,spacing:8) {
            HStack(spacing:8) {
                counts
                Spacer(minLength:0)
                Button {session.expanded.toggle()} label:{FridaySymbolImage(systemName:session.expanded ? "arrow.down.right.and.arrow.up.left":"arrow.up.left.and.arrow.down.right")}.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:session.expanded ? "收起批注":"展开批注"))
            }
            ZStack(alignment:.topLeading) {
                if session.comment.isEmpty {Text(friday:"描述需要修改的地方（可选）").font(.callout).foregroundStyle(.tertiary).padding(6).allowsHitTesting(false)}
                TaskBrowserAnnotationTextEditor(text:$session.comment,focusRequest:session.focusRequest,enabled:!session.capturing,attach:{session.submit(send:false)},send:{session.submit(send:true)},cancel:session.cancel)
                    .frame(height:session.expanded ? 140:54)
            }.background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:6))
            if let error=session.error {Text(fridayString:error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)}
            if session.comment.utf16.count>8000 {Text(friday:"补充说明最多 8,000 个字符").font(.caption).foregroundStyle(.orange)}
            HStack(spacing:8) {
                if session.capturing {Text(friday:"正在截取…").font(.caption).foregroundStyle(.secondary)}
                Spacer(minLength:0)
                Button(friday:"添加到输入框") {session.submit(send:false)}.buttonStyle(FridayButtonStyle(compact:true)).disabled(!valid).help(Text(verbatim:"Enter"))
                Button {session.submit(send:true)} label:{FridaySymbolImage(systemName:"arrow.up")}.buttonStyle(FridaySymbolButtonStyle()).disabled(!valid).help(Text(friday:"添加并发送")).accessibilityLabel(Text(friday:"添加并发送"))
            }
        }.padding(10).background(.regularMaterial)
    }
    private var counts:some View {
        HStack(spacing:10) {
            if let value=session.snapshot {
                Label(String(value.elements.count),systemImage:"cursorarrow.click")
                Label(String(value.regions.count),systemImage:"rectangle.dashed")
                Label(String(value.strokes.count),systemImage:"pencil.tip")
            }
        }.font(.caption).foregroundStyle(.secondary)
    }
}

#if os(macOS)
private final class TaskBrowserAnnotationNativeText:NSTextView {
    var attach:(()->Void)?;var send:(()->Void)?;var cancel:(()->Void)?
    override func keyDown(with event:NSEvent) {
        let key=event.keyCode==53 ? "Escape":[36,76].contains(event.keyCode) ? "Enter":""
        let action=TaskBrowserAnnotationKeyboard.action(key:key,shift:event.modifierFlags.contains(.shift),command:event.modifierFlags.contains(.command),control:event.modifierFlags.contains(.control),composing:hasMarkedText())
        switch action {case .attach:attach?();case .send:send?();case .cancel:cancel?();case .ignore,.newline:super.keyDown(with:event)}
    }
}
private struct TaskBrowserAnnotationTextEditor:NSViewRepresentable {
    @Binding var text:String
    let focusRequest:Int;let enabled:Bool;let attach:()->Void;let send:()->Void;let cancel:()->Void
    func makeCoordinator()->Coordinator {Coordinator(self)}
    func makeNSView(context:Context)->NSScrollView {
        let scroll=NSScrollView();scroll.hasVerticalScroller=true;scroll.drawsBackground=false
        let view=TaskBrowserAnnotationNativeText();view.isRichText=false;view.allowsUndo=true;view.drawsBackground=false;view.font = .systemFont(ofSize:13);view.textContainerInset=CGSize(width:3,height:6);view.isVerticallyResizable=true;view.isHorizontallyResizable=false;view.autoresizingMask=[.width];view.textContainer?.widthTracksTextView=true;view.delegate=context.coordinator
        scroll.documentView=view;return scroll
    }
    func updateNSView(_ scroll:NSScrollView,context:Context) {
        guard let view=scroll.documentView as? TaskBrowserAnnotationNativeText else{return};context.coordinator.parent=self
        if view.string != text && !view.hasMarkedText() {view.string=text};view.isEditable=enabled;view.attach=attach;view.send=send;view.cancel=cancel
        if focusRequest>0,context.coordinator.focusRequest != focusRequest {context.coordinator.focusRequest=focusRequest;DispatchQueue.main.async {if view.window != nil,enabled {view.window?.makeFirstResponder(view)}}}
    }
    final class Coordinator:NSObject,NSTextViewDelegate {
        var parent:TaskBrowserAnnotationTextEditor;var focusRequest=0
        init(_ parent:TaskBrowserAnnotationTextEditor) {self.parent=parent}
        func textDidChange(_ notification:Notification) {if let view=notification.object as? NSTextView {parent.text=view.string}}
    }
}
#else
private final class TaskBrowserAnnotationNativeText:UITextView {
    var send:(()->Void)?;var cancel:(()->Void)?
    var insertingNewline=false
    override var keyCommands:[UIKeyCommand]? {[
        UIKeyCommand(input:"\r",modifierFlags:.command,action:#selector(sendComment)),UIKeyCommand(input:"\r",modifierFlags:.control,action:#selector(sendComment)),UIKeyCommand(input:"\r",modifierFlags:.shift,action:#selector(newline)),UIKeyCommand(input:"\r",modifierFlags:[.shift,.command],action:#selector(newline)),UIKeyCommand(input:"\r",modifierFlags:[.shift,.control],action:#selector(newline)),UIKeyCommand(input:UIKeyCommand.inputEscape,modifierFlags:[],action:#selector(cancelComment))
    ]}
    @objc private func sendComment() {if markedTextRange==nil {send?()}}
    @objc private func cancelComment() {if markedTextRange==nil {cancel?()}}
    @objc private func newline() {insertingNewline=true;insertText("\n");insertingNewline=false}
}
private struct TaskBrowserAnnotationTextEditor:UIViewRepresentable {
    @Binding var text:String
    let focusRequest:Int;let enabled:Bool;let attach:()->Void;let send:()->Void;let cancel:()->Void
    func makeCoordinator()->Coordinator {Coordinator(self)}
    func makeUIView(context:Context)->TaskBrowserAnnotationNativeText {let view=TaskBrowserAnnotationNativeText();view.backgroundColor = .clear;view.font = .preferredFont(forTextStyle:.subheadline);view.delegate=context.coordinator;return view}
    func updateUIView(_ view:TaskBrowserAnnotationNativeText,context:Context) {context.coordinator.parent=self;if view.text != text && view.markedTextRange==nil {view.text=text};view.isEditable=enabled;view.send=send;view.cancel=cancel}
    final class Coordinator:NSObject,UITextViewDelegate {
        var parent:TaskBrowserAnnotationTextEditor
        init(_ parent:TaskBrowserAnnotationTextEditor) {self.parent=parent}
        func textViewDidChange(_ textView:UITextView) {parent.text=textView.text}
        func textView(_ textView:UITextView,shouldChangeTextIn range:NSRange,replacementText text:String)->Bool {if text=="\n",textView.markedTextRange==nil,(textView as? TaskBrowserAnnotationNativeText)?.insertingNewline != true {parent.attach();return false};return true}
    }
}
#endif
