#if os(macOS)
import AppKit
import SwiftUI

/// Observe actual upward wheel/trackpad input in the transcript, rather than
/// geometry changes caused by streaming, scrollTo, or composer animation.
struct TranscriptHistoryScrollGesture: NSViewRepresentable {
    let composerHeight: CGFloat
    let scrolledUp: () -> Void
    let scrolledDown: () -> Void

    func makeNSView(context: Context) -> TranscriptHistoryScrollView { TranscriptHistoryScrollView() }
    func updateNSView(_ view: TranscriptHistoryScrollView, context: Context) {
        view.composerHeight = composerHeight
        view.scrolledUp = scrolledUp
        view.scrolledDown = scrolledDown
    }
    static func dismantleNSView(_ view: TranscriptHistoryScrollView, coordinator: ()) { view.stop() }
}

final class TranscriptHistoryScrollView: NSView {
    var composerHeight: CGFloat = 0
    var scrolledUp: (() -> Void)?
    var scrolledDown: (() -> Void)?
    private var monitor: Any?
    private var notified = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stop()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            self?.observe(event)
            return event
        }
    }

    func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil; notified = false
    }

    private func observe(_ event: NSEvent) {
        if event.phase.contains(.began) { notified = false }
        if event.phase.contains(.ended) || event.phase.contains(.cancelled) { notified = false; return }
        guard event.window === window, NSApp.isActive, !isHiddenOrHasHiddenAncestor,
              event.momentumPhase.isEmpty, event.scrollingDeltaY != 0,
              abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX),
              let scroll = enclosingScrollView, let document = scroll.documentView else { return }
        let viewport = scroll.contentView
        let point = viewport.convert(event.locationInWindow, from: nil)
        guard viewport.bounds.contains(point) else { return }

        // Scrolling the editor itself must not dismiss it. The composer floats
        // over this viewport, so exclude its actual bottom-center footprint.
        let distanceFromBottom = viewport.isFlipped ? viewport.bounds.maxY - point.y : point.y - viewport.bounds.minY
        let composerWidth = min(FridayTheme.contentWidth, max(0, viewport.bounds.width - 48))
        if distanceFromBottom <= composerHeight && abs(point.x - viewport.bounds.midX) <= composerWidth / 2 { return }

        // A bounded mouse-wheel scroll at the bottom may produce no geometry
        // update, but it still means the user has returned to the latest reply.
        if event.scrollingDeltaY < 0 { scrolledDown?(); return }

        // Short conversations stay expanded, including during rubber-band
        // gestures. Collapse only when there is real scrollable history.
        guard document.bounds.height > viewport.bounds.height + 1 else { return }

        let visible = scroll.documentVisibleRect
        let hasEarlierContent = document.isFlipped
            ? visible.minY > document.bounds.minY + 1
            : visible.maxY < document.bounds.maxY - 1
        guard hasEarlierContent, event.phase.isEmpty || !notified else { return }
        notified = true
        scrolledUp?()
    }
}
#endif
