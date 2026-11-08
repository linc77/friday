import Foundation

/// Geometry arrives at scroll frequency. Keep the previous sample outside
/// SwiftUI state; only semantic changes (following/end/collapse) update the page.
final class TranscriptScrollTracking {
    var previousTop: CGFloat?
    var anchor: String?
    struct Movement { let up: Bool; let down: Bool; let atBottom: Bool }
    func update(_ metrics: TranscriptScrollMetrics) -> Movement {
        let previous = previousTop
        previousTop = metrics.top
        return Movement(up: previous.map { metrics.top > $0 + 3 } ?? false,
                        down: previous.map { metrics.top < $0 } ?? false,
                        atBottom: metrics.bottom <= metrics.viewportHeight + 2)
    }
}
