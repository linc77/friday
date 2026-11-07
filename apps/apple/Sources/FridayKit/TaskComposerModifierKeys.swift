#if os(macOS)
import SwiftUI
import AppKit

struct TaskComposerModifierKeys: ViewModifier {
    @Binding var alternate: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.onModifierKeysChanged(mask: [.command, .control]) { _, flags in alternate = !flags.isEmpty }
        } else {
            content.background(LegacyComposerModifierKeys(changed: { alternate = $0 }))
        }
    }
}

private struct LegacyComposerModifierKeys: NSViewRepresentable {
    let changed: (Bool) -> Void
    func makeNSView(context: Context) -> ComposerModifierView { ComposerModifierView() }
    func updateNSView(_ view: ComposerModifierView, context: Context) { view.changed = changed }
}

private final class ComposerModifierView: NSView {
    var changed: ((Bool) -> Void)?
    private var monitor: Any?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
        guard window != nil else {
            DispatchQueue.main.async { [weak self] in self?.changed?(false) }
            return
        }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.changed?(!event.modifierFlags.intersection([.command, .control]).isEmpty)
            return event
        }
    }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
#endif
