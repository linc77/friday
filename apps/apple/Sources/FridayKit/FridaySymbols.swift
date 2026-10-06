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
    @Environment(\.fridaySymbolDrawTrigger) private var drawTrigger
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var canAnimate: Bool { isEnabled && !reduceMotion && scenePhase == .active }

    var body: some View {
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
    let title: String
    let systemImage: String

    init(_ title: String, systemImage: String) {
        self.title = title
        self.systemImage = systemImage
    }

    var body: some View {
        Label { Text(title) } icon: { FridaySymbolImage(systemName: systemImage) }
    }
}

/// Native symbol feedback shared by navigation, controls, and standalone icons.
/// Only interactions change the trigger; rebuilding a view never replays an animation.
private struct FridaySymbolFeedback<Value: Equatable>: ViewModifier {
    let active: Bool
    let value: Value
    @State private var trigger = 0
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var canAnimate: Bool { isEnabled && !reduceMotion && scenePhase == .active }

    func body(content: Content) -> some View {
        content
            .environment(\.fridaySymbolDrawTrigger, trigger)
            .symbolEffectsRemoved(!canAnimate)
            .onHover { inside in
                if inside && !hovering && canAnimate { trigger += 1 }
                hovering = inside
            }
            .onChange(of: active) { _, active in
                if active && canAnimate { trigger += 1 }
            }
            .onChange(of: value) { _, _ in
                if canAnimate { trigger += 1 }
            }
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

#if os(macOS)
struct FridaySettingsLink: View {
    var body: some View {
        SettingsLink {
            Label { Text("设置") } icon: {
                FridaySymbolImage(systemName: "gear")
                    .symbolRenderingMode(.monochrome)
                    .font(.system(size: 17, weight: .light))
            }
        }
        .buttonStyle(FridayToolbarButtonStyle())
        .help("设置（⌘,）")
    }
}
#endif
