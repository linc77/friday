import SwiftUI
import AppKit
import FridayKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
}

@main
struct FridayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    var body: some Scene {
        Window("Friday", id: "main") { FridayRootView() }
            .defaultSize(width: 1120, height: 760)
    }
}
