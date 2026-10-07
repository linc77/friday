import AppKit
import Foundation
import ServiceManagement

@MainActor
final class ServiceController: ObservableObject {
    static let shared = ServiceController()
    @Published var status = "正在检查后台服务…"
    @Published var busy = false
    private let service = UserLaunchAgent()
    private let files = FileManager.default
    private var stoppedForUpdate = false
    private var barrierHeld = false
    private var directory: URL {
        URL(fileURLWithPath: NSHomeDirectory() + "/Library/Application Support/Friday", isDirectory: true)
    }
    var isDevelopment: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["FRIDAY_SERVER_URL"] != nil || env["FRIDAY_DATA_DIR"] != nil || !files.fileExists(atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path)
    }
    private var installed: Bool {
        let parent = Bundle.main.bundleURL.deletingLastPathComponent().standardizedFileURL.path
        return parent == "/Applications" || parent == NSHomeDirectory() + "/Applications"
    }
    private struct Health: Decodable { let name: String; let build: String? }
    private struct State: Decodable {
        struct Task: Decodable { let status: String }
        let tasks: [Task]
    }
    private func request(_ path: String, method: String = "GET") async throws -> Data {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4317" + path)!)
        request.timeoutInterval = 15; request.httpMethod = method
        if path.hasPrefix("/api/") {
            let token = try String(contentsOf: directory.appendingPathComponent("owner-token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        }
        if method == "POST" { request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = Data("{}".utf8) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "后台服务未响应，请稍后重试。"
            throw failure(message)
        }
        return data
    }
    private func health() async -> Health? {
        guard let data = try? await request("/health") else { return nil }
        return try? JSONDecoder().decode(Health.self, from: data)
    }
    private func requireIdle() async throws {
        let state = try JSONDecoder().decode(State.self, from: await request("/api/state"))
        if state.tasks.contains(where: { ["queued", "running", "waiting"].contains($0.status) }) {
            throw failure("仍有任务正在执行或等待处理。请完成或停止任务后再更新后台服务。")
        }
    }
    private func failure(_ message: String) -> NSError { NSError(domain: "Friday.Service", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func waitUntilStopped() async throws {
        for _ in 0..<100 {
            if await health() == nil {
                // HTTP closes before Durable flushes. Wait for its SQLite ownership
                // lease as well before taking a cold database backup.
                let lease = directory.appendingPathComponent("owner.sqlite").path
                if !files.fileExists(atPath: lease) { return }
                let node = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
                let probe = "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); try { db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE; ROLLBACK'); db.close(); } catch { process.exit(1); }"
                if await Self.run(node, ["-e", probe, lease]) == 0 { return }
            }
            try await Task.sleep(for: .milliseconds(200))
        }
        throw failure("旧服务仍在退出，已取消本次更新。请稍后重试。")
    }
    private func backupDatabases() throws {
        let sources = try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter {
            $0.lastPathComponent != "owner.sqlite" && ($0.pathExtension == "sqlite" || $0.lastPathComponent.hasSuffix(".sqlite-wal") || $0.lastPathComponent.hasSuffix(".sqlite-shm"))
        }
        guard !sources.isEmpty else { return }
        let destination = directory.appendingPathComponent("backups/pre-update-" + UUID().uuidString)
        try files.createDirectory(at: destination, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        for source in sources { try files.copyItem(at: source, to: destination.appendingPathComponent(source.lastPathComponent)) }
    }
    func start(force: Bool = false) async {
        guard !busy else { return }
        if isDevelopment { status = "开发连接：后台服务由开发环境管理"; return }
        if force { UserDefaults.standard.set(true, forKey: "friday.backgroundEnabled") }
        else if UserDefaults.standard.object(forKey: "friday.backgroundEnabled") as? Bool == false {
            status = "后台服务已停止，数据已保留"; return
        }
        guard installed else { status = "请先将 Friday 拖入「应用程序」，再从那里打开。"; return }
        busy = true; defer { busy = false }
        var savedLegacy: URL?
        do {
            let running = await health()
            let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
            if running == nil && service.status == .enabled {
                throw failure("已注册的后台服务暂时无法响应。请查看日志，当前进程已保留。")
            }
            if running?.name == "Friday", running?.build == build {
                status = "后台服务正在运行"; return
            }
            let legacy = URL(fileURLWithPath: NSHomeDirectory() + "/Library/LaunchAgents/dev.friday.server.plist")
            if running != nil {
                guard files.fileExists(atPath: legacy.path) || service.status == .enabled else {
                    throw failure("端口 4317 已由其他服务使用。请先停止开发服务，再启用内置服务。")
                }
                if running?.build != nil {
                    _ = try await request("/api/service/update", method: "POST"); barrierHeld = true
                } else { try await requireIdle() }
            }
            if files.fileExists(atPath: legacy.path) {
                let result = await Self.launchctl(["bootout", "gui/\(getuid())/dev.friday.server"])
                if result != 0 && running != nil { throw failure("无法停止旧版服务，请稍后重试。") }
                try await waitUntilStopped()
                try files.createDirectory(at: directory, withIntermediateDirectories: true)
                let saved = directory.appendingPathComponent("legacy-launch-agent-" + UUID().uuidString + ".plist")
                try files.moveItem(at: legacy, to: saved)
                savedLegacy = saved
                try backupDatabases()
            } else if service.status == .enabled {
                try await service.unregister(); try await waitUntilStopped(); try backupDatabases()
            }
            barrierHeld = false
            try service.register()
            for _ in 0..<60 {
                if let running = await health(), running.build == build { status = "后台服务正在运行"; return }
                try await Task.sleep(for: .milliseconds(250))
            }
            throw failure("后台服务尚未就绪。请检查登录项中的 Friday 权限或服务日志。")
        } catch {
            if barrierHeld { _ = try? await request("/api/service/update", method: "DELETE"); barrierHeld = false }
            if let savedLegacy {
                try? await service.unregister()
                let legacy = URL(fileURLWithPath: NSHomeDirectory() + "/Library/LaunchAgents/dev.friday.server.plist")
                try? files.moveItem(at: savedLegacy, to: legacy)
                _ = await Self.launchctl(["bootstrap", "gui/\(getuid())", legacy.path])
            }
            status = error.localizedDescription
        }
    }
    func stop() async {
        guard !busy, !isDevelopment else { return }
        busy = true; defer { busy = false }
        do {
            try await prepareForUpdate()
            stoppedForUpdate = false
            UserDefaults.standard.set(false, forKey: "friday.backgroundEnabled")
            status = "后台服务已停止，数据已保留"
        } catch { await recoverAfterCancelledUpdate(); status = error.localizedDescription }
    }
    func prepareForUpdate() async throws {
        guard !isDevelopment else { return }
        guard installed else { throw failure("请先从「应用程序」中的 Friday 安装更新。") }
        let running = await health()
        if running == nil && service.status == .enabled {
            throw failure("后台服务暂时无法响应，无法确认任务状态，已取消更新。")
        }
        if let running {
            guard running.build != nil, service.status == .enabled else { throw failure("请先启用安装版的后台服务，再安装更新。") }
            _ = try await request("/api/service/update", method: "POST"); barrierHeld = true
        }
        if service.status == .enabled {
            try await service.unregister(); stoppedForUpdate = true
        }
        try await waitUntilStopped()
        barrierHeld = false
        if files.fileExists(atPath: directory.path) { try backupDatabases() }
    }
    func recoverAfterCancelledUpdate() async {
        if barrierHeld { _ = try? await request("/api/service/update", method: "DELETE"); barrierHeld = false }
        if stoppedForUpdate { stoppedForUpdate = false; try? service.register() }
    }
    func openLoginSettings() { SMAppService.openSystemSettingsLoginItems() }
    func openLogs() { NSWorkspace.shared.open(directory) }
    private nonisolated static func launchctl(_ arguments: [String]) async -> Int32 {
        await run("/bin/launchctl", arguments)
    }
    private nonisolated static func run(_ executable: String, _ arguments: [String]) async -> Int32 {
        await withCheckedContinuation { continuation in
            let process = Process(); process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
            process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
            process.terminationHandler = { continuation.resume(returning: $0.terminationStatus) }
            do { try process.run() } catch { continuation.resume(returning: -1) }
        }
    }
}
