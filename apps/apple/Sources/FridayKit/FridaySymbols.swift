import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum FridaySymbols {
    static let chat: String = {
        #if os(macOS)
        NSImage(systemSymbolName: "ellipsis.message", accessibilityDescription: nil) != nil ? "ellipsis.message" : "ellipsis.bubble"
        #else
        UIImage(systemName: "ellipsis.message") != nil ? "ellipsis.message" : "ellipsis.bubble"
        #endif
    }()
}

enum FridaySymbolMotion {
    case bounce, wiggle, rotate, pulse
}

/// Native symbol feedback shared by navigation, controls, and standalone icons.
/// Only interactions change the trigger; rebuilding a view never replays an animation.
private struct FridaySymbolFeedback: ViewModifier {
    let motion: FridaySymbolMotion
    let active: Bool
    @State private var trigger = 0
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var canAnimate: Bool { isEnabled && !reduceMotion && scenePhase == .active }

    func body(content: Content) -> some View {
        content
            .modifier(FridaySymbolAnimation(motion: motion, trigger: trigger))
            .symbolEffectsRemoved(!canAnimate)
            .onHover { inside in
                if inside && !hovering && canAnimate { trigger += 1 }
                hovering = inside
            }
            .onChange(of: active) { _, active in
                if active && canAnimate { trigger += 1 }
            }
    }
}

private struct FridaySymbolAnimation: ViewModifier {
    let motion: FridaySymbolMotion
    let trigger: Int

    @ViewBuilder func body(content: Content) -> some View {
        switch motion {
        case .bounce:
            content.symbolEffect(.bounce.up.byLayer, options: .nonRepeating, value: trigger)
        case .pulse:
            content.symbolEffect(.pulse.byLayer, options: .nonRepeating, value: trigger)
        case .wiggle, .rotate:
            #if compiler(>=6.0)
            if #available(macOS 15.0, iOS 18.0, *) {
                if motion == .wiggle {
                    content.symbolEffect(.wiggle.byLayer, options: .nonRepeating, value: trigger)
                } else {
                    content.symbolEffect(.rotate.byLayer, options: .nonRepeating.speed(1.5), value: trigger)
                }
            } else {
                content.symbolEffect(.bounce.up.byLayer, options: .nonRepeating, value: trigger)
            }
            #else
            content.symbolEffect(.bounce.up.byLayer, options: .nonRepeating, value: trigger)
            #endif
        }
    }
}

extension View {
    func fridaySymbolFeedback(_ motion: FridaySymbolMotion = .bounce, active: Bool = false) -> some View {
        modifier(FridaySymbolFeedback(motion: motion, active: active))
    }
}

/// Shared by task rows and details so both describe the same execution state.
struct FridayTaskStatusIcon: View {
    let status: String
    @State private var completionTrigger = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var symbol: String {
        switch status {
        case "queued": "clock"
        case "running": "sparkle"
        case "waiting": "hand.raised"
        case "needs_project": "folder.badge.questionmark"
        case "completed": "checkmark.circle"
        case "failed": "exclamationmark.circle"
        case "cancelled": "xmark.circle"
        case "interrupted": "pause.circle"
        default: "circle"
        }
    }

    var body: some View {
        Image(systemName: symbol)
            .symbolRenderingMode(.monochrome)
            .modifier(FridayProcessingEffect(active: status == "running" && !reduceMotion && scenePhase == .active))
            .symbolEffect(.bounce, options: .nonRepeating.speed(1.25), value: completionTrigger)
            .symbolEffectsRemoved(reduceMotion || scenePhase != .active)
            .fridaySymbolFeedback(.pulse)
            .accessibilityHidden(true)
            .onChange(of: status) { previous, current in
                // Initial snapshots and view recreation must not celebrate old results.
                if previous != "completed", current == "completed", !reduceMotion, scenePhase == .active {
                    completionTrigger += 1
                }
            }
    }
}

private struct FridayProcessingEffect: ViewModifier {
    let active: Bool

    @ViewBuilder func body(content: Content) -> some View {
        #if compiler(>=6.0)
        if #available(macOS 15.0, iOS 18.0, *) {
            content.symbolEffect(.breathe.plain, options: .speed(0.8), isActive: active)
        } else {
            content.symbolEffect(.pulse, options: .speed(0.8), isActive: active)
        }
        #else
        content.symbolEffect(.pulse, options: .speed(0.8), isActive: active)
        #endif
    }
}
