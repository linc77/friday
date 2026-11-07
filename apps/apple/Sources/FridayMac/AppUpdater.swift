import AppKit
import Combine
import Sparkle
import SwiftUI
import FridayKit

@MainActor
final class AppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate, SPUStandardUserDriverDelegate {
    static let shared = AppUpdater()
    @Published var canCheck = false
    @Published var automaticChecks = false {
        didSet { controller?.updater.automaticallyChecksForUpdates = automaticChecks }
    }
    private(set) var installing = false
    private var controller: SPUStandardUpdaterController?
    func start() {
        guard controller == nil, Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") != nil else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: self)
        self.controller = controller
        controller.updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        automaticChecks = controller.updater.automaticallyChecksForUpdates
        controller.startUpdater()
        if automaticChecks { controller.updater.checkForUpdatesInBackground() }
    }
    func check() { controller?.checkForUpdates(nil) }

    // Keep scheduled checks quiet. A click brings Sparkle's existing announcement,
    // skip-version and installation UI to the front without starting another check.
    var supportsGentleScheduledUpdateReminders: Bool { true }
    func standardUserDriverShouldHandleShowingScheduledUpdate(_ update: SUAppcastItem, andInImmediateFocus immediateFocus: Bool) -> Bool { false }
    func standardUserDriverWillHandleShowingUpdate(_ handleShowingUpdate: Bool, forUpdate update: SUAppcastItem, state: SPUUserUpdateState) {
        FridayUpdateNotice.shared.present(version: update.displayVersionString) { [weak self] in self?.check() }
    }
    func standardUserDriverWillFinishUpdateSession() {
        FridayUpdateNotice.shared.clear()
    }
    func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) { installing = true }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        installing = false
        FridayUpdateNotice.shared.clear()
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
                Text("\(FridayAppName.displayName) \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版")")
                Toggle("自动检查新版本", isOn: $updater.automaticChecks)
                Button("检查更新…") { updater.check() }.disabled(!updater.canCheck)
                Button("查看更新公告…") { ReleaseAnnouncement.shared.show() }
                    .fridayInteractiveCursor()
                    .disabled(!ReleaseAnnouncement.shared.available)
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
