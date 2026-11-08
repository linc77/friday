import Foundation

/// Geometry arrives at scroll frequency. Keep the previous sample outside
/// SwiftUI state; only semantic changes (following/end/collapse) update the page.
final class TranscriptScrollTracking {
    var previousTop: CGFloat?
    private var previousContentHeight: CGFloat?
    private var previousViewportHeight: CGFloat?
    var anchor: String?
    struct Movement { let up: Bool; let down: Bool; let atBottom: Bool }
    func update(_ metrics: TranscriptScrollMetrics) -> Movement {
        let previous = previousTop
        let contentHeight = metrics.bottom - metrics.top
        // Content growth, wrapping and viewport resize can move the offset even
        // with no input. They must not reverse the user's follow/fold intent.
        let layoutChanged = (previousContentHeight.map { abs($0 - contentHeight) > 1 } ?? false)
            || (previousViewportHeight.map { abs($0 - metrics.viewportHeight) > 1 } ?? false)
        previousTop = metrics.top
        previousContentHeight = contentHeight
        previousViewportHeight = metrics.viewportHeight
        return Movement(up: !layoutChanged && (previous.map { metrics.top > $0 + 3 } ?? false),
                        down: !layoutChanged && (previous.map { metrics.top < $0 } ?? false),
                        atBottom: metrics.bottom <= metrics.viewportHeight + 2)
    }
}
