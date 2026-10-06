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
    case drawOn, rotate
}

private struct FridaySymbolDrawTriggerKey: EnvironmentKey {
    static let defaultValue: Int? = nil
}

private extension EnvironmentValues {
    var fridaySymbolDrawTrigger: Int? {
        get { self[FridaySymbolDrawTriggerKey.self] }
        set { self[FridaySymbolDrawTriggerKey.self] = newValue }
    }
}

/// Draw On is an insertion effect. Replace only the image when an interaction
/// triggers it, preserving the surrounding button's identity and focus.
struct FridaySymbolImage: View {
    let systemName: String
    var motion: FridaySymbolMotion = .drawOn
    @Environment(\.fridaySymbolDrawTrigger) private var drawTrigger
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var canAnimate: Bool { isEnabled && !reduceMotion && scenePhase == .active }

    var body: some View {
        switch motion {
        case .drawOn: drawingImage
        case .rotate: rotatingImage
        }
    }

    @ViewBuilder private var rotatingImage: some View {
        #if compiler(>=6.0)
        if #available(macOS 15.0, iOS 18.0, *), let drawTrigger {
            Image(systemName: systemName)
                .symbolEffect(.rotate.clockwise.wholeSymbol, options: .nonRepeating, value: drawTrigger)
                .symbolEffectsRemoved(!canAnimate)
        } else {
            Image(systemName: systemName)
        }
        #else
        Image(systemName: systemName)
        #endif
    }

    @ViewBuilder private var drawingImage: some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, iOS 26.0, *), let drawTrigger {
            ZStack {
                Image(systemName: systemName)
                    .id(drawTrigger)
                    .transition(AsymmetricTransition(
                        insertion: .symbolEffect(.drawOn.wholeSymbol, options: .nonRepeating),
                        removal: .identity
                    ))
            }
            .animation(canAnimate ? .default : nil, value: drawTrigger)
            .symbolEffectsRemoved(!canAnimate)
        } else {
            Image(systemName: systemName)
        }
        #else
        Image(systemName: systemName)
        #endif
    }
}

/// Keep the native Label layout and accessibility while allowing its image to redraw.
struct FridaySymbolLabel: View {
    let title: Text
    let systemImage: String
    let motion: FridaySymbolMotion

    init(_ title: String, systemImage: String, motion: FridaySymbolMotion = .drawOn) {
        self.title = Text(title)
        self.systemImage = systemImage
        self.motion = motion
    }

    init(friday title: String, systemImage: String, motion: FridaySymbolMotion = .drawOn) {
        self.title = Text(fridayString: title)
        self.systemImage = systemImage
        self.motion = motion
    }

    var body: some View {
        Label { title } icon: { FridaySymbolImage(systemName: systemImage, motion: motion) }
    }
}

/// Native symbol feedback shared by navigation, controls, and standalone icons.
/// Only activation or live state changes redraw; hovering and rebuilding stay still.
private struct FridaySymbolFeedback<Value: Equatable>: ViewModifier {
    let active: Bool
    let value: Value
    @State private var trigger = 0
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var canAnimate: Bool { isEnabled && !reduceMotion && scenePhase == .active }

    func body(content: Content) -> some View {
        content
            .environment(\.fridaySymbolDrawTrigger, trigger)
            .symbolEffectsRemoved(!canAnimate)
            .onChange(of: active) { _, active in
                if active && canAnimate { trigger += 1 }
            }
            .onChange(of: value) { _, _ in
                if canAnimate { trigger += 1 }
            }
    }
}

/// Plain controls still provide symbol feedback on each press, including reselecting.
struct FridaySymbolButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fridaySymbolFeedback(active: configuration.isPressed)
    }
}

extension View {
    func fridaySymbolFeedback(active: Bool = false) -> some View {
        fridaySymbolFeedback(active: active, value: 0)
    }

    func fridaySymbolFeedback<Value: Equatable>(active: Bool = false, value: Value) -> some View {
        modifier(FridaySymbolFeedback(active: active, value: value))
    }
}

/// Shared by task rows and details so both describe the same execution state.
struct FridayTaskStatusIcon: View {
    let status: String

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
        FridaySymbolImage(systemName: symbol)
            .symbolRenderingMode(.monochrome)
            // Only a live status change redraws; initial/history snapshots stay still.
            .fridaySymbolFeedback(value: status)
            .accessibilityHidden(true)
    }
}
