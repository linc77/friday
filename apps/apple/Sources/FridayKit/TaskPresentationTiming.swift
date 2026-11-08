import Foundation
import SwiftUI
#if os(macOS)
import OSLog
#endif

/// Opt-in, payload-free timing from selection to content appearance
/// and layout. AX command/observation latency is not a rendering metric.
@MainActor enum TaskPresentationTiming {
    #if os(macOS)
    private static let enabled: Bool = {
        #if DEBUG
        return true
        #else
        return ["1", "changes"].contains(ProcessInfo.processInfo.environment["FRIDAY_PERFORMANCE"] ?? "")
        #endif
    }()
    private static let logger = Logger(subsystem: "dev.friday.performance", category: "task-navigation")
    private static var pending: (id: String, start: ContinuousClock.Instant, ready: Bool)?
    private static let logsChanges = ProcessInfo.processInfo.environment["FRIDAY_PERFORMANCE"] == "changes"
    #endif

    /// Opt-in dependency diagnostics. SwiftUI records property names, never their values.
    static func changes<V: View>(_ view: V.Type) {
        #if os(macOS)
        if logsChanges, #available(macOS 14.1, *) { V._logChanges() }
        #endif
    }

    static func selected(_ id: String) {
        #if os(macOS)
        guard enabled else { return }
        pending = (id, .now, false)
        #endif
    }

    static func resized(rootUpdates: Int, layouts: Int) {
        #if os(macOS)
        guard enabled else { return }
        logger.info("panel-resize root_updates=\(rootUpdates, privacy: .public) layouts=\(layouts, privacy: .public)")
        #endif
    }

    static func contentReady(_ id: String) {
        #if os(macOS)
        if let pending, pending.id == id {
            self.pending?.ready = true
            logger.info("task-content-ready duration_ms=\(milliseconds(since: pending.start), privacy: .public)")
        }
        #endif
    }

    static func didLayout(_ id: String?) {
        #if os(macOS)
        guard let pending, pending.id == id, pending.ready else { return }
        logger.info("task-selection-layout duration_ms=\(milliseconds(since: pending.start), privacy: .public)")
        self.pending = nil
        #endif
    }

    #if os(macOS)
    private static func milliseconds(since start: ContinuousClock.Instant) -> Double {
        let duration = start.duration(to: .now).components
        return Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15
    }
    #endif
}
