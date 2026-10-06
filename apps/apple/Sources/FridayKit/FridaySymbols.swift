import SwiftUI

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

#if os(macOS)
struct FridaySettingsLink: View {
    @State private var hoverTrigger = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsLink {
            Label { Text("设置") } icon: { animatedIcon }
        }
        .buttonStyle(FridayToolbarButtonStyle())
        .help("设置（⌘,）")
        .onHover { inside in
            if inside, !reduceMotion, scenePhase == .active { hoverTrigger += 1 }
        }
    }

    private var icon: some View {
        Image(systemName: "gear")
            .symbolRenderingMode(.monochrome)
            .font(.system(size: 17, weight: .light))
    }

    @ViewBuilder private var animatedIcon: some View {
        #if compiler(>=6.0)
        if #available(macOS 15.0, *) {
            icon.symbolEffect(.rotate, options: .nonRepeating.speed(1.5), value: hoverTrigger)
                .symbolEffectsRemoved(reduceMotion || scenePhase != .active)
        } else {
            icon
        }
        #else
        icon
        #endif
    }
}
#endif
