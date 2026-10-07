import Foundation

/// Personal previews use a user LaunchAgent. Developer ID releases can move
/// registration to SMAppService after that signature path has been validated.
@MainActor
final class UserLaunchAgent {
    enum Status { case enabled, notRegistered }
    private let label = "dev.friday.app.server"
    private var domain: String { "gui/\(getuid())" }
    private var plist: URL { URL(fileURLWithPath: NSHomeDirectory() + "/Library/LaunchAgents/" + label + ".plist") }
    var status: Status { command(["print", domain + "/" + label]) == 0 ? .enabled : .notRegistered }

    func register() throws {
        if status == .enabled { return }
        let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/FridayService").path
        let config: [String: Any] = [
            "Label": label, "ProgramArguments": [executable], "RunAtLoad": true,
            "KeepAlive": true, "ThrottleInterval": 10, "ExitTimeOut": 30,
            "ProcessType": "Background", "AssociatedBundleIdentifiers": [Bundle.main.bundleIdentifier ?? "dev.friday.mac"]
        ]
        try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(fromPropertyList: config, format: .xml, options: 0)
        try data.write(to: plist, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: plist.path)
        guard command(["bootstrap", domain, plist.path]) == 0 else {
            throw NSError(domain: "Friday.LaunchAgent", code: 1, userInfo: [NSLocalizedDescriptionKey: "无法启动后台服务。请检查系统设置 → 通用 → 登录项中的 Friday 后台权限。"])
        }
    }
    func unregister() async throws {
        let result: Int32 = await withCheckedContinuation { continuation in
            let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["bootout", domain + "/" + label]
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch { continuation.resume(returning: -1) }
        }
        guard result == 0 || status == .notRegistered else {
            throw NSError(domain: "Friday.LaunchAgent", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法停止后台服务，已取消本次操作。"])
        }
        if FileManager.default.fileExists(atPath: plist.path) { try FileManager.default.removeItem(at: plist) }
    }
    private func command(_ arguments: [String]) -> Int32 {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/launchctl"); process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus } catch { return -1 }
    }
}
