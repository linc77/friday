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
        Window(Text(FridayAppName.displayName), id: "main") {
            FridayRootView(store: store, navigation: navigation)
        }
        .defaultSize(width: 1180, height: 780)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            FridayConversationCommands()
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

private struct FridayNewConversationKey: FocusedValueKey {
    typealias Value = () -> Void
}

extension FocusedValues {
    var newFridayConversation: (() -> Void)? {
        get { self[FridayNewConversationKey.self] }
        set { self[FridayNewConversationKey.self] = newValue }
    }
}

private struct FridayConversationCommands: Commands {
    @FocusedValue(\.newFridayConversation) private var newConversation
    @AppStorage(FridayPreferenceKeys.language) private var language: FridayLanguage = .chinese

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button(friday: "新对话") { newConversation?() }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(newConversation == nil)
                .environment(\.locale, language.locale)
        }
    }
}

#endif
