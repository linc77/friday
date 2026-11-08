#if os(iOS)
import SwiftUI

private struct FridayMobileHomeKey: EnvironmentKey { static let defaultValue = false }
private struct FridayMobileTabSelectionKey: EnvironmentKey { static let defaultValue: Binding<Int>? = nil }
private struct FridayMobileKeyboardKey: EnvironmentKey { static let defaultValue = false }

extension EnvironmentValues {
    var fridayMobileHome: Bool {
        get { self[FridayMobileHomeKey.self] }
        set { self[FridayMobileHomeKey.self] = newValue }
    }
    var fridayMobileTabSelection: Binding<Int>? {
        get { self[FridayMobileTabSelectionKey.self] }
        set { self[FridayMobileTabSelectionKey.self] = newValue }
    }
    var fridayMobileKeyboardVisible: Bool {
        get { self[FridayMobileKeyboardKey.self] }
        set { self[FridayMobileKeyboardKey.self] = newValue }
    }
}

extension View {
    func fridayMobileHomeNavigation(hasComposer: Bool = true) -> some View {
        modifier(FridayMobileHomeNavigation(hasComposer: hasComposer))
    }

    func fridayMobileBottomBar<Bar: View>(@ViewBuilder content: () -> Bar) -> some View {
        safeAreaInset(edge: .bottom, spacing: 0, content: content)
    }
}

private struct FridayMobileHomeNavigation: ViewModifier {
    let hasComposer: Bool
    @Environment(\.fridayMobileKeyboardVisible) private var keyboardVisible

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !hasComposer, !keyboardVisible {
                    FridayMobileComposerDock(showsComposer: false) { EmptyView() }
                }
            }
            .environment(\.fridayMobileHome, true)
            .toolbar(.hidden, for: .tabBar)
            .ignoresSafeArea(.container, edges: .bottom)
    }
}
#endif
