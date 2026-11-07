import AppKit
import Foundation
import SwiftUI

enum InstallFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(message) = self { return message }; return nil }
}

// Filesystem work is separate from the launcher so replacement and rollback can
// be verified in temporary directories without installing or launching an app.
enum DmgInstallation {
    static func validateDestination(_ destination: URL, identifier: String) throws {
        let files = FileManager.default
        let values = try? destination.resourceValues(forKeys: [.isSymbolicLinkKey])
        guard values?.isSymbolicLink != true else {
            throw InstallFailure.message("安装位置是符号链接，请先移走该链接后重试。")
        }
        if files.fileExists(atPath: destination.path) {
            guard Bundle(url: destination)?.bundleIdentifier == identifier else {
                throw InstallFailure.message("应用程序中已有同名的其他应用，请先移走该应用后重试。")
            }
        }
    }

    static func install(
        source: URL, destination: URL, identifier: String,
        verify: (URL) throws -> Void = verifySignature,
        move: (URL, URL) throws -> Void = { try FileManager.default.moveItem(at: $0, to: $1) }
    ) throws {
        let files = FileManager.default
        try validateDestination(destination, identifier: identifier)
        let parent = destination.deletingLastPathComponent()
        try files.createDirectory(at: parent, withIntermediateDirectories: true)
        // Stage and backup beside the destination so each move stays on one volume.
        let work = parent.appendingPathComponent(".friday-install-" + UUID().uuidString)
        try files.createDirectory(at: work, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let staged = work.appendingPathComponent(destination.lastPathComponent)
        let backup = work.appendingPathComponent("previous.app")
        var previousMoved = false
        var preserveBackup = false
        defer { if !preserveBackup { try? files.removeItem(at: work) } }
        try files.copyItem(at: source, to: staged)
        try verify(staged)
        // Recheck after copying; never replace an unrelated app that appeared meanwhile.
        try validateDestination(destination, identifier: identifier)
        if files.fileExists(atPath: destination.path) {
            try move(destination, backup)
            previousMoved = true
        }
        do { try move(staged, destination) }
        catch {
            if previousMoved {
                do { try move(backup, destination) }
                catch {
                    preserveBackup = true
                    throw InstallFailure.message("安装未完成，旧版本保留在 \(backup.path)。请从该位置恢复。")
                }
            }
            throw error
        }
    }

    static func verifySignature(_ app: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--verify", "--deep", "--strict", app.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw InstallFailure.message("安装包校验失败，请重新下载安装包。原有应用未被替换。")
        }
    }
}

#if !FRIDAY_INSTALLER_TEST
@MainActor
final class DmgInstallerDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, ObservableObject {
    enum Phase { case ready, installing, installed, opening, failed }
    @Published private(set) var phase: Phase = .ready
    @Published private(set) var message = "若 Friday 正在运行，请先退出"
    private var window: NSWindow?
    private var installedURL: URL?

    var busy: Bool { phase == .installing || phase == .opening }
    var productName: String {
        Bundle.main.object(forInfoDictionaryKey: "FridayProductName") as? String ?? "Friday"
    }
    var headline: String {
        switch phase {
        case .ready: return "双击 Friday 图标即可安装"
        case .installing: return "正在安装 Friday…"
        case .installed: return "双击图标打开 Friday"
        case .opening: return "正在打开 Friday…"
        case .failed: return "双击图标重新安装"
        }
    }
    var actionLabel: String { installedURL == nil ? "安装 Friday" : "打开 Friday" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = productName + " · 安装"
        window.contentMinSize = NSSize(width: 480, height: 340)
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.delegate = self
        let hosting = NSHostingView(rootView: DmgInstallerWindow(model: self))
        hosting.sizingOptions = []
        window.contentView = hosting
        self.window = window
        configureMenu()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        busy ? .terminateCancel : .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func windowShouldClose(_ sender: NSWindow) -> Bool { !busy }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func activate() {
        guard !busy else { return }
        // Claim the action synchronously; a second activation cannot start another copy.
        if let installedURL {
            phase = .opening
            Task { await openInstalled(installedURL) }
        } else {
            phase = .installing
            message = "正在复制并校验应用，请稍候"
            Task { await install() }
        }
    }

    private func install() async {
        do {
            let resources = Bundle.main.resourceURL!
            guard let payloadName = Bundle.main.object(forInfoDictionaryKey: "FridayPayloadName") as? String,
                  payloadName == (payloadName as NSString).lastPathComponent else {
                throw InstallFailure.message("安装包不完整，请重新下载。")
            }
            let source = resources.appendingPathComponent("Payload/" + payloadName)
            guard let payload = Bundle(url: source), let identifier = payload.bundleIdentifier else {
                throw InstallFailure.message("安装包不完整，请重新下载。")
            }
            let system = URL(fileURLWithPath: "/Applications", isDirectory: true).appendingPathComponent(payloadName)
            let personal = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/" + payloadName)
            let destination: URL
            if FileManager.default.fileExists(atPath: system.path) { destination = system }
            else if FileManager.default.fileExists(atPath: personal.path) { destination = personal }
            else { destination = FileManager.default.isWritableFile(atPath: "/Applications") ? system : personal }

            try DmgInstallation.validateDestination(destination, identifier: identifier)
            try Self.requireStoppedProcess(identifier: identifier)
            guard !FileManager.default.fileExists(atPath: destination.path) || FileManager.default.isWritableFile(atPath: destination.deletingLastPathComponent().path) else {
                throw InstallFailure.message("没有权限替换此应用，请使用有权限的账户安装。")
            }
            try await Task.detached {
                try DmgInstallation.install(source: source, destination: destination, identifier: identifier, verify: { app in
                    try DmgInstallation.verifySignature(app)
                    // The existing app/service must still be stopped when copying finishes.
                    try Self.requireStoppedProcess(identifier: identifier)
                })
            }.value
            installedURL = destination
            phase = .opening
            await openInstalled(destination)
        } catch {
            phase = .failed
            message = error.localizedDescription
        }
    }

    private func openInstalled(_ destination: URL) async {
        do {
            // A failed launch leaves the verified installation in place; do not
            // repeat a launch or roll back files under a possibly started app.
            let configuration = NSWorkspace.OpenConfiguration()
            _ = try await NSWorkspace.shared.openApplication(at: destination, configuration: configuration)
            message = "安装完成，Friday 已打开。你可以关闭此窗口。"
        } catch {
            message = "Friday 已安装到 \(destination.path)，但未能打开。可双击图标重试，或从应用程序中手动打开。"
        }
        phase = .installed
    }

    nonisolated private static func requireStoppedProcess(identifier: String) throws {
        if NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: { !$0.isTerminated }) {
            throw InstallFailure.message("Friday 正在运行。请先退出 Friday，再双击图标安装。")
        }
        // A production background service outlives the client window. Its existing
        // owner-only stop flow drains tasks and backs up data; never bypass it here.
        if identifier == "dev.friday.mac" {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["print", "gui/\(getuid())/dev.friday.app.server"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run(); process.waitUntilExit()
            if process.terminationStatus == 0 {
                throw InstallFailure.message("Friday 的后台服务仍在运行。请在 Friday → 软件更新与后台服务中停止后台服务，退出 Friday 后再安装。")
            }
        }
    }

    private func configureMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出安装器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let windowItem = NSMenuItem()
        windowItem.title = "窗口"
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }
}

@main
enum FridayDmgInstaller {
    @MainActor static func main() {
        let application = NSApplication.shared
        application.setActivationPolicy(.regular)
        let delegate = DmgInstallerDelegate()
        application.delegate = delegate
        withExtendedLifetime(delegate) { application.run() }
    }
}
#endif
