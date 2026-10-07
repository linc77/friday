#if os(macOS)
import AppKit
import SwiftUI

/// Place inside the gallery's ScrollView to resolve its native viewport. The
/// passive probe leaves card clicks, text selection, and ordinary scrolls alone.
struct NotePullScrollGesture: NSViewRepresentable {
    let changed: (Double) -> Void
    let create: () -> Void

    func makeNSView(context: Context) -> NotePullScrollView { NotePullScrollView() }
    func updateNSView(_ view: NotePullScrollView, context: Context) {
        view.changed = changed; view.create = create
    }
    static func dismantleNSView(_ view: NotePullScrollView, coordinator: ()) { view.stop() }
}

final class NotePullScrollView: NSView {
    var changed: ((Double) -> Void)?
    var create: (() -> Void)?
    private var monitor: Any?
    private var inactiveObserver: NSObjectProtocol?
    private var gesture = NotePullGesture()
    private var distance: Double = 0

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self else { return event }
            return self.handle(event)
        }
        inactiveObserver = NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cancel() }
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let inactiveObserver { NotificationCenter.default.removeObserver(inactiveObserver) }
        monitor = nil; inactiveObserver = nil
        gesture = NotePullGesture(); distance = 0
    }

    private func cancel() {
        gesture = NotePullGesture()
        if distance != 0 { distance = 0; changed?(0) }
    }

    private func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window, NSApp.isActive, !isHiddenOrHasHiddenAncestor,
              let scroll = enclosingScrollView, let document = scroll.documentView else { return event }
        let viewport = scroll.contentView
        let inside = viewport.bounds.contains(viewport.convert(event.locationInWindow, from: nil))
        let visible = scroll.documentVisibleRect
        let atTop = document.isFlipped
            ? visible.minY <= document.bounds.minY + 1
            : visible.maxY >= document.bounds.maxY - 1
        let momentum = !event.momentumPhase.isEmpty
        let phase = momentum ? event.momentumPhase : event.phase
        let state: NotePullGesture.Phase = phase.contains(.cancelled) ? .cancelled
            : phase.contains(.ended) ? .ended
            : phase.contains(.began) ? .began
            : phase.contains(.changed) ? .changed : .none
        let update = gesture.update(x: event.scrollingDeltaX, y: event.scrollingDeltaY,
                                    phase: state, precise: event.hasPreciseScrollingDeltas,
                                    momentum: momentum, canStart: inside && atTop)
        if distance != update.distance { distance = update.distance; changed?(distance) }
        if update.shouldCreate { create?() }
        return update.consumed ? nil : event
    }
}
#endif
