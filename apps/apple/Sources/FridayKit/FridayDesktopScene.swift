#if os(macOS)
import SwiftUI

/// All pages share the main window's client connection and navigation state.
@MainActor
public struct FridayDesktopScene: Scene {
    @StateObject private var store = FridayStore()
    @StateObject private var navigation = FridayNavigation()
    @Environment(\.openWindow) private var openWindow
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese

    public init() {}

    public var body: some Scene {
        Window("Friday", id: "main") {
            FridayRootView(store: store, navigation: navigation)
        }
        .defaultSize(width: 1180, height: 780)
        .windowToolbarStyle(.unifiedCompact)

        .commands {
            CommandGroup(replacing: .appSettings) {
                Button(friday: "设置…") {
                    navigation.section = .settings
                    openWindow(id: "main")
                }
                .keyboardShortcut(",", modifiers: .command)
                .environment(\.locale, language.locale)
            }
        }
    }
}

#endif
