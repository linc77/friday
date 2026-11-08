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
struct FridaySidebarSymbolImage: View {
    let systemName: String
    let motion: FridaySymbolMotion
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

/// Ordinary product icons stay static and do not subscribe to animation triggers.
struct FridaySymbolImage: View {
    let systemName: String

    var body: some View { Image(systemName: systemName) }
}

/// Keep the native Label layout and accessibility with a static symbol.
struct FridaySymbolLabel: View {
    let title: Text
    let systemImage: String

    init(_ title: String, systemImage: String) {
        self.title = Text(title)
        self.systemImage = systemImage
    }

    init(friday title: String, systemImage: String) {
        self.title = Text(fridayString: title)
        self.systemImage = systemImage
    }

    var body: some View {
        Label { title } icon: { FridaySymbolImage(systemName: systemImage) }
    }
}

/// Only the macOS Ideas and Settings sidebar buttons install this trigger.
private struct FridaySidebarSymbolFeedback<Value: Equatable>: ViewModifier {
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
            .onChange(of: value) { _, _ in
                if canAnimate { trigger += 1 }
            }
    }
}

/// Plain controls retain the shared cursor without animation state or observers.
struct FridaySymbolButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fridayInteractiveCursor()
    }
}

extension View {
    func fridaySidebarSymbolFeedback<Value: Equatable>(value: Value) -> some View {
        modifier(FridaySidebarSymbolFeedback(value: value))
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
            .accessibilityHidden(true)
    }
}
