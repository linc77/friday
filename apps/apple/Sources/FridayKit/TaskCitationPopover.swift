import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor final class TaskCitationCommentState: ObservableObject {
    @Published var draft: String
    @Published private(set) var stale = false
    private(set) var target: TaskCitationEditingTarget
    private let original: TaskAssistantCitation
    private let composer: TaskCitationComposer
    var dismiss: (() -> Void)?
    private var finished = false
    var valid: Bool { draft.utf16.count <= 8_000 }
    init(target: TaskCitationEditingTarget, composer: TaskCitationComposer) { self.target=target; original=target.citation; draft=target.citation.comment ?? ""; self.composer=composer }
    func changed() {
        guard !finished, valid, !stale else { return }
        if let updated=composer.replace(target,draft) { target=updated } else { stale=true }
    }
    @discardableResult func finish(send: Bool = false, cancel: Bool = false) -> Bool {
        guard !finished else { return true }; guard cancel || valid else { return false }
        if cancel, !stale, let updated=composer.replace(target,original.comment ?? "") { target=updated }
        else if !cancel { changed() }
        finished=true; composer.finish(target,send && !stale); return true
    }
    func save(send: Bool = false) { if finish(send:send) { dismiss?() } }
    func cancel() { if finish(cancel:true) { dismiss?() } }
    func navigate() { if finish() { dismiss?();composer.navigate(target.citation) } }
}
private struct TaskCitationCommentEditor: View {
    @ObservedObject var state: TaskCitationCommentState
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack { Text(friday:"引用回答").font(.headline); Spacer(); Button { state.navigate() } label: { FridaySymbolImage(systemName:"arrow.up.right") }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday:"返回原消息")) }
            ScrollView { Text(verbatim:state.target.citation.text).font(.callout).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading) }.frame(maxHeight:140)
            Divider()
            ZStack(alignment:.topLeading) {
                if state.draft.isEmpty { Text(friday:"补充说明（可选）").foregroundStyle(.tertiary).padding(.top,8).padding(.leading,5).allowsHitTesting(false) }
                TextEditor(text:$state.draft).font(.body).focused($focused).frame(height:90)
                    .onChange(of:state.draft) { _,_ in state.changed() }
                    .onKeyPress(.escape) { state.cancel(); return .handled }
                    .onKeyPress(keys:[.return],phases:.down) { key in
                        if key.modifiers.contains(.shift) { return .ignored }
                        state.save(send:key.modifiers.contains(.command) || key.modifiers.contains(.control)); return .handled
                    }
            }
            if !state.valid { Text(friday:"补充说明最多 8,000 个字符").font(.caption).foregroundStyle(.orange) }
            if state.stale { Text(friday:"引用已被修改，请关闭后重新打开").font(.caption).foregroundStyle(.orange) }
            HStack { Spacer(); Button(friday:"取消") { state.cancel() }.buttonStyle(FridayButtonStyle(compact:true)); Button(friday:"保存") { state.save() }.buttonStyle(FridayButtonStyle(compact:true)).disabled(!state.valid || state.stale) }
        }.padding(16).frame(width:360).onAppear { focused=true }
    }
}

#if os(macOS)
@MainActor final class TaskCitationPopover: NSObject, NSPopoverDelegate {
    private var popover: NSPopover?
    private var state: TaskCitationCommentState?
    var shown: Bool { popover?.isShown == true }
    func show(target:TaskCitationEditingTarget,composer:TaskCitationComposer,anchor:NSView,rect:CGRect) {
        close(); let state=TaskCitationCommentState(target:target,composer:composer), popover=NSPopover()
        self.state=state; self.popover=popover; state.dismiss={ [weak self] in self?.popover?.performClose(nil) }
        popover.delegate=self; popover.behavior = .transient; popover.contentViewController=NSHostingController(rootView:TaskCitationCommentEditor(state:state))
        popover.show(relativeTo:rect,of:anchor,preferredEdge:.maxY)
    }
    func popoverShouldClose(_ popover:NSPopover) -> Bool { state?.finish() ?? true }
    func popoverDidClose(_ notification:Notification) { state=nil; popover=nil }
    func close() { if state?.finish() != false { popover?.close(); state=nil; popover=nil } }
}
#else
@MainActor final class TaskCitationPopover: NSObject, UIPopoverPresentationControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private var controller: UIViewController?
    private var state: TaskCitationCommentState?
    var shown:Bool { controller?.presentingViewController != nil }
    func show(target:TaskCitationEditingTarget,composer:TaskCitationComposer,anchor:UIView,rect:CGRect) {
        close(); var responder:UIResponder?=anchor
        while responder != nil && !(responder is UIViewController) { responder=responder?.next }
        guard let parent=responder as? UIViewController else { return }
        let state=TaskCitationCommentState(target:target,composer:composer), controller=UIHostingController(rootView:TaskCitationCommentEditor(state:state))
        self.state=state; self.controller=controller; state.dismiss={ [weak self] in self?.close() }
        controller.modalPresentationStyle = .popover; controller.preferredContentSize=CGSize(width:392,height:360)
        controller.popoverPresentationController?.sourceView=anchor; controller.popoverPresentationController?.sourceRect=rect
        controller.popoverPresentationController?.delegate=self; controller.presentationController?.delegate=self
        parent.present(controller,animated:true)
    }
    func adaptivePresentationStyle(for controller:UIPresentationController) -> UIModalPresentationStyle { .none }
    func popoverPresentationControllerShouldDismissPopover(_ controller:UIPopoverPresentationController) -> Bool { state?.finish() ?? true }
    func presentationControllerShouldDismiss(_ presentationController:UIPresentationController) -> Bool { state?.finish() ?? true }
    func presentationControllerDidDismiss(_ presentationController:UIPresentationController) { state=nil; controller=nil }
    func close() { guard state?.finish() != false else { return }; controller?.dismiss(animated:true); state=nil; controller=nil }
}
#endif
