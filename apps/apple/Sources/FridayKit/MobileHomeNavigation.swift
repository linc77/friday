#if os(iOS)
import SwiftUI

private struct FridayMobileKeyboardVisibleKey: EnvironmentKey {
    static let defaultValue = false
}

private struct FridayMobilePageIsSelectedKey: EnvironmentKey {
    static let defaultValue = true
}

private struct FridayMobileNavigationCollapsedKey: EnvironmentKey {
    static let defaultValue: Binding<Bool>? = nil
}

private struct FridayMobileNavigationInComposerKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var fridayMobileKeyboardVisible: Bool {
        get { self[FridayMobileKeyboardVisibleKey.self] }
        set { self[FridayMobileKeyboardVisibleKey.self] = newValue }
    }

    var fridayMobilePageIsSelected: Bool {
        get { self[FridayMobilePageIsSelectedKey.self] }
        set { self[FridayMobilePageIsSelectedKey.self] = newValue }
    }

    var fridayMobileNavigationCollapsed: Binding<Bool>? {
        get { self[FridayMobileNavigationCollapsedKey.self] }
        set { self[FridayMobileNavigationCollapsedKey.self] = newValue }
    }

    var fridayMobileNavigationInComposer: Bool {
        get { self[FridayMobileNavigationInComposerKey.self] }
        set { self[FridayMobileNavigationInComposerKey.self] = newValue }
    }
}

extension View {
    /// Attach to the actual root content, never to a NavigationStack or a detail page.
    func fridayMobileHomeNavigation(inComposer: Bool = false) -> some View {
        modifier(FridayMobileHomeNavigation(inComposer: inComposer))
    }

    /// Attach directly to a home's List/ScrollView; nested details have no navigation binding.
    func fridayMobileHomeScroll() -> some View {
        modifier(FridayMobileHomeScroll())
    }
}

private struct FridayMobileHomeNavigation: ViewModifier {
    let inComposer: Bool
    @Environment(\.fridayMobileKeyboardVisible) private var keyboardVisible
    @Environment(\.fridayMobilePageIsSelected) private var isSelected
    @Environment(\.fridayMobileTabSelection) private var selection
    @State private var collapsed = false

    func body(content: Content) -> some View {
        content
            .environment(\.fridayMobileNavigationCollapsed, $collapsed)
            .environment(\.fridayMobileNavigationInComposer, inComposer)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // Keep each retained page's dock and bottom inset alive across tab switches.
                // Removing the outgoing dock also relayouts its entire scroll viewport.
                if selection != nil, !inComposer, !keyboardVisible {
                    FridayMobileNavigationBar(collapsed: $collapsed)
                }
            }
            // The bar owns its spacing from the physical bottom edge. Keyboard avoidance remains enabled
            // for the page and its composer, but navigation is removed before it can lift.
            .ignoresSafeArea(.container, edges: .bottom)
            .onChange(of: isSelected) { _, _ in collapsed = false }
            .onChange(of: keyboardVisible) { _, _ in collapsed = false }
    }
}

private struct FridayMobileHomeScrollMetrics: Equatable {
    let offset: CGFloat
    let range: CGFloat
    let height: CGFloat

    @available(iOS 18.0, *)
    init(_ geometry: ScrollGeometry) {
        range = max(0, geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom - geometry.containerSize.height)
        offset = min(max(0, geometry.contentOffset.y + geometry.contentInsets.top), range)
        height = geometry.containerSize.height
    }
}

private struct FridayMobileHomeScroll: ViewModifier {
    @Environment(\.fridayMobileNavigationCollapsed) private var collapsed
    @Environment(\.fridayMobileKeyboardVisible) private var keyboardVisible
    @Environment(\.fridayMobilePageIsSelected) private var isSelected
    @Environment(\.scenePhase) private var scenePhase
    @State private var interacting = false
    @State private var travel: CGFloat = 0

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollGeometryChange(for: FridayMobileHomeScrollMetrics.self) { geometry in
                    FridayMobileHomeScrollMetrics(geometry)
                } action: { old, new in
                    guard let collapsed, isSelected, !keyboardVisible, scenePhase == .active,
                          interacting, new.range > 0,
                          abs(new.range - old.range) < 1, abs(new.height - old.height) < 1 else {
                        travel = 0
                        return
                    }
                    // Clamp overscroll and ignore programmatic scrolling, streaming updates,
                    // keyboard/layout changes, and deceleration's elastic bounce.
                    if new.offset <= 1 {
                        collapsed.wrappedValue = false
                        travel = 0
                        return
                    }
                    let delta = new.offset - old.offset
                    guard abs(delta) > 0.1 else { return }
                    if delta * travel < 0 { travel = 0 }
                    travel += delta
                    if travel >= 24 { collapsed.wrappedValue = true; travel = 0 }
                    if travel <= -16 { collapsed.wrappedValue = false; travel = 0 }
                }
                .onScrollPhaseChange { _, phase in
                    interacting = phase == .interacting
                    travel = 0
                }
        } else {
            // Keep navigation expanded on systems without native scroll phase observation.
            content
        }
    }
}
#endif
