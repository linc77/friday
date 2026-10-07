#if os(macOS)
import AppKit
import SwiftUI

/// A local monitor sees trackpad scrolling over the SwiftUI ScrollView without
/// an overlay stealing clicks, focus, or vertical scrolling from its children.
struct WorkspaceScrollGesture: NSViewRepresentable {
    let changed: (Double) -> Void
    let ended: (WorkspaceSwipe, Bool) -> Void

    func makeNSView(context: Context) -> WorkspaceScrollView { WorkspaceScrollView() }
    func updateNSView(_ view: WorkspaceScrollView, context: Context) {
        view.changed = changed; view.ended = ended
    }
    static func dismantleNSView(_ view: WorkspaceScrollView, coordinator: ()) { view.stop() }
}

final class WorkspaceScrollView: NSView {
    var changed: ((Double) -> Void)?
    var ended: ((WorkspaceSwipe, Bool) -> Void)?
    private var monitor: Any?
    private var swipe = WorkspaceSwipe()
    private var tracking = false
    private var consumesMomentum = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            return self.handle(event)
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil; tracking = false; consumesMomentum = false; swipe = WorkspaceSwipe()
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window, NSApp.isActive, !isHiddenOrHasHiddenAncestor else { return event }
        if !event.momentumPhase.isEmpty {
            let consume = consumesMomentum
            if event.momentumPhase.contains(.ended) { consumesMomentum = false }
            return consume ? nil : event
        }
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        if event.phase.contains(.began) {
            consumesMomentum = false; tracking = inside && event.hasPreciseScrollingDeltas
            swipe = WorkspaceSwipe()
        }
        guard tracking else { return event }
        let horizontal = swipe.update(x: event.scrollingDeltaX, y: event.scrollingDeltaY)
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) {
            tracking = false; consumesMomentum = horizontal
            if horizontal { ended?(swipe, event.phase.contains(.cancelled)) }
        } else if horizontal {
            changed?(swipe.x)
        }
        return horizontal ? nil : event
    }
}
#endif
