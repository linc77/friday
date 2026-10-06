#if os(macOS)
import SwiftUI

/// The main and settings windows observe the same client connection and state.
@MainActor
public struct FridayDesktopScene: Scene {
    @StateObject private var store = FridayStore()
    @State private var settingsSection: FridaySettingsSection = .agents

    public init() {}

    public var body: some Scene {
        Window("Friday", id: "main") {
            FridayRootView(store: store) { settingsSection = .connection }
        }
        .defaultSize(width: 1180, height: 780)
        .windowToolbarStyle(.unifiedCompact)

        Settings {
            FridaySettingsView(store: store, selection: $settingsSection)
        }
    }
}

enum FridaySettingsSection: Hashable {
    case agents, connection
}

struct FridaySettingsView: View {
    @ObservedObject var store: FridayStore
    @Binding var selection: FridaySettingsSection

    var body: some View {
        TabView(selection: $selection) {
            AgentsView(store: store)
                .tabItem { Label("工具", systemImage: "terminal") }
                .tag(FridaySettingsSection.agents)
            ConnectionView(store: store)
                .tabItem { Label("连接", systemImage: "network") }
                .tag(FridaySettingsSection.connection)
        }
        .frame(width: 660, height: 560)
        .background(FridayTheme.canvas)
        .tint(FridayTheme.accent)
        .symbolRenderingMode(.monochrome)
    }
}
#endif
