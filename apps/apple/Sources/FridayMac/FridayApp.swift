import SwiftUI
import AppKit
import FridayKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var preparingUpdate = false
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApplication.shared.setActivationPolicy(.regular)
        // Development app bundles can retain the generic icon in Launch Services.
        if let iconURL = Bundle.main.url(forResource: "Friday", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApplication.shared.applicationIconImage = icon
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
        AppUpdater.shared.start()
        Task { await ServiceController.shared.start() }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard AppUpdater.shared.installing else { return .terminateNow }
        guard !preparingUpdate else { return .terminateLater }
        preparingUpdate = true
        Task {
            do {
                try await ServiceController.shared.prepareForUpdate()
                sender.reply(toApplicationShouldTerminate: true)
            } catch {
                await ServiceController.shared.recoverAfterCancelledUpdate()
                preparingUpdate = false
                sender.reply(toApplicationShouldTerminate: false)
                let alert = NSAlert(); alert.messageText = "暂时无法安装更新"; alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: "好"); alert.runModal()
            }
        }
        return .terminateLater
    }
}

@main
struct FridayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @Environment(\.openWindow) private var openWindow
    var body: some Scene {
        FridayDesktopScene()
            .commands {
                CommandGroup(after: .appInfo) {
                    UpdateMenu()
                    Button("软件更新与后台服务…") { openWindow(id: "service-settings") }
                }
            }
        Window(Text("\(FridayAppName.displayName) · 软件更新与后台服务"), id: "service-settings") { ServiceSettings() }
            .windowResizability(.contentSize)
    }
}
