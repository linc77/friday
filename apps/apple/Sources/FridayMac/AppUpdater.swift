import AppKit
import Combine
import Sparkle
import SwiftUI

@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = AppUpdater()
    @Published var canCheck = false
    @Published var automaticChecks = false {
        didSet { controller?.updater.automaticallyChecksForUpdates = automaticChecks }
    }
    private(set) var installing = false
    private var controller: SPUStandardUpdaterController?
    func start() {
        guard controller == nil, Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        controller.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        automaticChecks = controller.updater.automaticallyChecksForUpdates
        controller.startUpdater()
    }
    func check() { controller?.checkForUpdates(nil) }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { installing = true }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        installing = false
        Task { await ServiceController.shared.recoverAfterCancelledUpdate() }
    }
}

struct UpdateMenu: View {
    @ObservedObject var updater = AppUpdater.shared
    var body: some View { Button("检查更新…") { updater.check() }.disabled(!updater.canCheck) }
}

struct ServiceSettings: View {
    @ObservedObject var service = ServiceController.shared
    @ObservedObject var updater = AppUpdater.shared
    var body: some View {
        Form {
            Section("软件更新") {
                Text("Friday \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")")
                Toggle("自动检查新版本", isOn: $updater.automaticChecks)
                Button("检查更新…") { updater.check() }.disabled(!updater.canCheck)
            }
            Section("后台服务") {
                Text(service.status).font(.callout).textSelection(.enabled)
                HStack {
                    Button("启用后台服务") { Task { await service.start(force: true) } }
                    Button("停止后台服务") { Task { await service.stop() } }
                }.disabled(service.busy || service.isDevelopment)
                HStack {
                    Button("系统登录项设置") { service.openLoginSettings() }
                    Button("打开日志目录") { service.openLogs() }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 510, height: 340)
        .task { await service.start() }
    }
}
