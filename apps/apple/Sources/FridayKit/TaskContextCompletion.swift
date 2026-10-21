import SwiftUI

#if os(macOS)
import AppKit
@MainActor
final class TaskContextCompletion {
    private var panel: CompletionPanel?
    private var host: NSHostingView<TaskContextSuggestionList>?
    func hide() { if let panel { panel.parent?.removeChildWindow(panel); panel.orderOut(nil) } }
    func show(anchor: NSView, caret: CGRect, entries: [TaskFileEntry], selected: Int, loading: Bool, choose: @escaping (TaskFileEntry) -> Void) {
        guard let window = anchor.window else { hide(); return }
        let view = TaskContextSuggestionList(entries: entries, selected: selected, loading: loading, choose: choose)
        let width = min(390, max(260, window.frame.width - 40)); let height = min(280, max(52, Double(entries.count) * 34 + (loading ? 42 : 12)))
        if panel == nil { panel = CompletionPanel(); host = NSHostingView(rootView: view); panel?.contentView = host }
        guard let panel else { return }; host?.rootView = view; panel.appearance = window.effectiveAppearance; panel.title = window.title
        let local = anchor.convert(caret, to: nil); let screenRect = window.convertToScreen(local); let visible = window.screen?.visibleFrame ?? window.frame
        let x = min(max(visible.minX + 6, screenRect.minX), visible.maxX - width - 6)
        let below = screenRect.minY - height - 6; let y = below >= visible.minY ? below : min(visible.maxY - height - 6, screenRect.maxY + 6)
        panel.setFrame(CGRect(x: x, y: y, width: width, height: height), display: true)
        if panel.parent !== window { panel.parent?.removeChildWindow(panel); window.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)
    }
}
private final class CompletionPanel: NSPanel {
    init() {
        super.init(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        isOpaque = false; backgroundColor = .clear; hasShadow = true; hidesOnDeactivate = true; isReleasedWhenClosed = false; level = .floating
        collectionBehavior = [.transient, .ignoresCycle]
    }
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
#else
import UIKit
@MainActor
final class TaskContextCompletion {
    private var host: UIHostingController<TaskContextSuggestionList>?
    func hide() { host?.view.removeFromSuperview() }
    func show(anchor: UIView, caret: CGRect, entries: [TaskFileEntry], selected: Int, loading: Bool, choose: @escaping (TaskFileEntry) -> Void) {
        guard let window = anchor.window else { hide(); return }
        let content = TaskContextSuggestionList(entries: entries, selected: selected, loading: loading, choose: choose)
        if host == nil { host = UIHostingController(rootView: content); host?.view.backgroundColor = .clear }; host?.rootView = content
        guard let host else { return }; let rect = anchor.convert(caret, to: window)
        let width = min(390, window.bounds.width - 24); let height = min(260, max(52, Double(entries.count) * 36 + (loading ? 42 : 12)))
        host.view.frame = CGRect(x: min(max(12, rect.minX), window.bounds.width - width - 12), y: max(window.safeAreaInsets.top + 8, rect.minY - height - 6), width: width, height: height)
        if host.view.superview !== window { window.addSubview(host.view) }
    }
}
#endif
