import SwiftUI

#if os(iOS)
private struct FridayMobileTabSelectionKey: EnvironmentKey {
    static let defaultValue: Binding<Int>? = nil
}

private struct FridayMobileNewConversationKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
    var fridayMobileTabSelection: Binding<Int>? {
        get { self[FridayMobileTabSelectionKey.self] }
        set { self[FridayMobileTabSelectionKey.self] = newValue }
    }

    var fridayMobileNewConversation: (() -> Void)? {
        get { self[FridayMobileNewConversationKey.self] }
        set { self[FridayMobileNewConversationKey.self] = newValue }
    }
}

extension View {
    /// Retain each section's navigation and drafts without creating a system tab bar.
    func fridayMobilePage(isSelected: Bool) -> some View {
        modifier(FridayMobilePage(isSelected: isSelected))
    }
}

private struct FridayMobilePage: ViewModifier {
    let isSelected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            // Animate compositing only, not the page's lists, editors or safe-area layout.
            .animation(reduceMotion || scenePhase != .active ? nil : .easeOut(duration: 0.18)) { page in
                page.opacity(isSelected ? 1 : 0)
            }
            .zIndex(isSelected ? 1 : 0)
            .allowsHitTesting(isSelected)
            .disabled(!isSelected)
            .accessibilityHidden(!isSelected)
            .environment(\.fridayMobilePageIsSelected, isSelected)
    }
}

/// The chat home shares one surface for composing and navigation. Detail composers
/// remain standalone, and only the editor follows the keyboard.
struct FridayMobileComposerDock<Composer: View>: View {
    var notice: String? = nil
    @ViewBuilder let composer: () -> Composer
    @Environment(\.fridayMobileNavigationInComposer) private var includesNavigation
    @Environment(\.fridayMobileKeyboardVisible) private var keyboardVisible
    @Environment(\.fridayMobileNavigationCollapsed) private var collapsed
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var isCollapsed: Bool { includesNavigation && !keyboardVisible && collapsed?.wrappedValue == true }
    private var motion: Animation? {
        reduceMotion || scenePhase != .active ? nil : .smooth(duration: isCollapsed ? 0.24 : 0.42)
    }

    var body: some View {
        VStack(spacing: notice == nil ? 0 : 6) {
            // Reserve the expanded footprint; the visible notice follows the surface below.
            noticeView.hidden()
            expandedContent
                .animation(motion) { content in content.opacity(isCollapsed ? 0 : 1) }
                .allowsHitTesting(!isCollapsed)
                .accessibilityHidden(isCollapsed)
                .background {
                    GeometryReader { geometry in
                        VStack(spacing: notice == nil ? 0 : 6) {
                            noticeView.frame(width: geometry.size.width)
                            Color.clear
                                .frame(width: isCollapsed ? FridayMobileDockMetrics.compactWidth(availableWidth: geometry.size.width) : geometry.size.width,
                                       height: isCollapsed ? FridayMobileDockMetrics.compactHeight : geometry.size.height)
                                .modifier(FridayMobileDockSurface(cornerRadius: isCollapsed ? 17 : (includesNavigation ? FridayMobileDockMetrics.composerCornerRadius : 28)))
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: geometry.size.width, height: geometry.size.height, alignment: .bottom)
                        .animation(motion, value: isCollapsed)
                    }
                }
                .overlay {
                    if includesNavigation {
                        GeometryReader { geometry in
                            FridayMobileCompactNavigationButton(section: .chat,
                                width: FridayMobileDockMetrics.compactWidth(availableWidth: geometry.size.width),
                                expand: { collapsed?.wrappedValue = false })
                                .animation(motion) { button in button.opacity(isCollapsed ? 1 : 0) }
                                .allowsHitTesting(isCollapsed)
                                .accessibilityHidden(!isCollapsed)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                        }
                        .allowsHitTesting(isCollapsed)
                    }
                }
        }
        .frame(maxWidth: includesNavigation ? 600 : .infinity)
        .padding(.horizontal, FridayMobileDockMetrics.horizontalInset)
        .padding(.top, 8)
        .padding(.bottom, includesNavigation && !keyboardVisible ? FridayMobileDockMetrics.bottomInset : 6)
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder private var noticeView: some View {
        if let notice {
            Text(fridayString: notice)
                .font(.caption)
                .foregroundStyle(.orange)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 8)
        }
    }

    private var expandedContent: some View {
        VStack(spacing: 0) {
            VStack(spacing: 8) { composer() }
                .padding(8)
            if includesNavigation, !keyboardVisible {
                FridayMobileNavigationBar(collapsed: .constant(false), embedded: true)
            }
        }
    }
}

struct FridayMobileComposer: View {
    @Binding var message: String
    let placeholder: String
    let sending: Bool
    let disabled: Bool
    let send: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(friday: placeholder, text: $message, axis: .vertical)
                .font(.body)
                .lineLimit(1...5)
                .textFieldStyle(.plain)
                .focused($focused)
                .accessibilityLabel(Text(friday: "告诉 Friday 你想做什么"))
                .padding(.vertical, 12)
                .padding(.leading, 16)
            Button(action: send) {
                ZStack {
                    Circle().fill(FridayTheme.accent.opacity(disabled ? 0.12 : 1))
                    if sending {
                        ProgressView().tint(FridayTheme.onAccent).controlSize(.small)
                    } else {
                        FridaySymbolImage(systemName: "arrow.up")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(disabled ? Color.secondary : FridayTheme.onAccent)
                    }
                }
                .frame(width: 32, height: 32)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(FridaySymbolButtonStyle())
            .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(disabled)
        }
        .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 22))
        .overlay {
            RoundedRectangle(cornerRadius: 22)
                .strokeBorder(.primary.opacity(focused ? 0.22 : 0.09), lineWidth: 0.5)
                .allowsHitTesting(false)
        }
        .onDisappear { focused = false }
    }
}

struct FridayMobileTopFade: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        Group {
            if reduceTransparency {
                FridayTheme.canvas.ignoresSafeArea(.container, edges: .top).allowsHitTesting(false)
            } else {
                Rectangle().fill(.regularMaterial)
                    .mask {
                        LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.5), .init(color: .clear, location: 1)], startPoint: .top, endPoint: .bottom)
                    }
                    .ignoresSafeArea(.container, edges: .top)
                    .allowsHitTesting(false)
            }
        }
        .frame(height: 24)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
#endif
