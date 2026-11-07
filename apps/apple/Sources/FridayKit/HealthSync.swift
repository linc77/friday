#if os(iOS)
import Foundation
import HealthKit
import CryptoKit
import UIKit
import UserNotifications

@MainActor
final class HealthSync: ObservableObject {
    static let shared = HealthSync()
    @Published private(set) var enabled = false
    @Published private(set) var status = "尚未开启健康同步"
    @Published private(set) var backgroundStatus: String?
    private let health = HKHealthStore()
    private var observers: [HKObserverQuery] = []
    private var observingServer: String?
    private var protectedDataObserver: NSObjectProtocol?
    private var syncing = false
    private var anotherSync = false
    private let types: [HKSampleType] = [HKQuantityType(.stepCount), HKQuantityType(.activeEnergyBurned), HKQuantityType(.restingHeartRate), HKQuantityType(.appleExerciseTime), HKCategoryType(.sleepAnalysis)]
    private func key(_ server: String) -> String { SHA256.hash(data: Data(server.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined() }
    private func enabledKey(_ server: String) -> String { "friday.health.enabled.\(key(server))" }
    private func revokingKey(_ server: String) -> String { "friday.health.revoking.\(key(server))" }
    private func outbox(_ server: String) throws -> URL {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("FridayHealth", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = root; try directory.setResourceValues(values)
        return root.appendingPathComponent(key(server) + ".json")
    }
    func start() {
        if protectedDataObserver == nil {
            protectedDataObserver = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.sync() }
            }
        }
        let server = Connection().server
        enabled = UserDefaults.standard.bool(forKey: enabledKey(server))
        guard enabled, HKHealthStore.isHealthDataAvailable() else {
            observers.forEach(health.stop); observers.removeAll(); observingServer = nil; return
        }
        if observingServer == server { return }
        observers.forEach(health.stop); observers.removeAll(); observingServer = server
        for type in types {
            let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
                Task { @MainActor in
                    if error == nil { await self?.sync() }
                    completion()
                }
            }
            observers.append(query); health.execute(query)
            health.enableBackgroundDelivery(for: type, frequency: .hourly) { [weak self] success, _ in
                if !success { Task { @MainActor in self?.backgroundStatus = "未能启用后台健康更新；仍可前台同步，请检查健康权限与应用签名" } }
            }
        }
    }
    func setEnabled(_ value: Bool) async throws {
        let connection = Connection(); let server = connection.server
        if value {
            guard HKHealthStore.isHealthDataAvailable() else { throw ConnectionError.message("这台设备不支持健康数据") }
            try await health.requestAuthorization(toShare: [], read: Set(types))
            _ = try await connection.data("/api/health/connection", method: "PUT", body: ["enabled": true])
            UserDefaults.standard.set(true, forKey: enabledKey(server)); UserDefaults.standard.removeObject(forKey: revokingKey(server))
            start(); await sync()
        } else {
            UserDefaults.standard.set(false, forKey: enabledKey(server)); UserDefaults.standard.set(true, forKey: revokingKey(server))
            start(); status = "已停止本机健康采集"
            if let file = try? outbox(server) { try? FileManager.default.removeItem(at: file) }
            for type in types { health.disableBackgroundDelivery(for: type) { _, _ in } }
            _ = try await connection.data("/api/health/connection", method: "PUT", body: ["enabled": false])
            UserDefaults.standard.removeObject(forKey: revokingKey(server))
        }
    }
    func sync() async {
        if syncing { anotherSync = true; return }
        syncing = true
        defer {
            syncing = false
            if anotherSync { anotherSync = false; Task { await self.sync() } }
        }
        let connection = Connection(); let server = connection.server
        if UserDefaults.standard.bool(forKey: revokingKey(server)) {
            do {
                _ = try await connection.data("/api/health/connection", method: "PUT", body: ["enabled": false])
                UserDefaults.standard.removeObject(forKey: revokingKey(server))
            } catch { status = "已停止本机采集，等待向主机同步暂停设置" }
            return
        }
        start()
        await registerSavedPushToken()
        guard enabled, !connection.token.isEmpty else { return }
        do {
            let file = try outbox(server)
            if let pending = try? Data(contentsOf: file) {
                let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let envelope = try? JSONDecoder().decode(HealthUpload.self, from: pending), let captured = formatter.date(from: envelope.capturedAt), Date().timeIntervalSince(captured) < 86400 {
                    try await upload(pending, connection: connection)
                }
                try? FileManager.default.removeItem(at: file)
            }
            status = "正在读取健康摘要"
            let snapshot = try await collect()
            guard UserDefaults.standard.bool(forKey: enabledKey(server)), Connection().server == server else { return }
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            try await upload(data, connection: connection)
            try? FileManager.default.removeItem(at: file)
            guard UserDefaults.standard.bool(forKey: enabledKey(server)) else { return }
            status = "健康摘要已同步"
        } catch {
            guard UserDefaults.standard.bool(forKey: enabledKey(server)) else { return }
            if (error as NSError).domain == HKErrorDomain { status = "健康数据暂不可读，解锁后会重试；未获取的指标保持未知" }
            else { status = "等待主机连接，已采集的摘要保留在本机" }
        }
    }
    private func upload(_ data: Data, connection: Connection) async throws {
        guard UserDefaults.standard.bool(forKey: enabledKey(connection.server)) else { return }
        let body = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        _ = try await connection.data("/api/health/snapshot", method: "POST", body: body)
    }
    private func dailyQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, average: Bool = false, start: Date, end: Date, calendar: Calendar) async throws -> [String: Double] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKStatisticsCollectionQuery(quantityType: HKQuantityType(identifier), quantitySamplePredicate: HKQuery.predicateForSamples(withStart: start, end: end), options: average ? .discreteAverage : .cumulativeSum, anchorDate: start, intervalComponents: DateComponents(day: 1))
            query.initialResultsHandler = { _, collection, error in
                if let error { continuation.resume(throwing: error); return }
                var values: [String: Double] = [:]
                collection?.enumerateStatistics(from: start, to: end) { stats, _ in
                    let value = average ? stats.averageQuantity() : stats.sumQuantity()
                    if let value { values[Self.dateKey(stats.startDate, calendar: calendar)] = value.doubleValue(for: unit) }
                }
                continuation.resume(returning: values)
            }
            health.execute(query)
        }
    }
    private func sleeps(start: Date, end: Date) async throws -> [(Date, Date)] {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: start, end: end), limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, error in
                if let error { continuation.resume(throwing: error); return }
                let asleep = Set([HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue, HKCategoryValueSleepAnalysis.asleepCore.rawValue, HKCategoryValueSleepAnalysis.asleepDeep.rawValue, HKCategoryValueSleepAnalysis.asleepREM.rawValue])
                continuation.resume(returning: (samples as? [HKCategorySample] ?? []).filter { asleep.contains($0.value) }.map { ($0.startDate, $0.endDate) })
            }
            health.execute(query)
        }
    }
    nonisolated private static func dateKey(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
    }
    private func collect() async throws -> HealthUpload {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = .current
        let end = Date(); let today = calendar.startOfDay(for: end)
        let start = calendar.date(byAdding: .day, value: -13, to: today)!
        async let steps = dailyQuantity(.stepCount, unit: .count(), start: start, end: end, calendar: calendar)
        async let energy = dailyQuantity(.activeEnergyBurned, unit: .kilocalorie(), start: start, end: end, calendar: calendar)
        async let heart = dailyQuantity(.restingHeartRate, unit: .count().unitDivided(by: .minute()), average: true, start: start, end: end, calendar: calendar)
        async let exercise = dailyQuantity(.appleExerciseTime, unit: .minute(), start: start, end: end, calendar: calendar)
        async let sleep = sleeps(start: calendar.date(byAdding: .hour, value: -12, to: start)!, end: end)
        let (s, e, h, x, z) = try await (steps, energy, heart, exercise, sleep)
        let days = (0..<14).map { offset -> HealthDay in
            let date = calendar.date(byAdding: .day, value: offset, to: start)!; let key = Self.dateKey(date, calendar: calendar)
            let noon = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: date)!
            let priorNoon = calendar.date(byAdding: .day, value: -1, to: noon)!
            return HealthDay(date: key, steps: s[key], activeEnergyKcal: e[key], sleepMinutes: healthIntervalMinutes(z, within: (priorNoon, min(noon, end))), restingHeartRate: h[key], workoutMinutes: x[key])
        }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return HealthUpload(uploadId: UUID().uuidString, capturedAt: formatter.string(from: Date()), timezone: calendar.timeZone.identifier, days: days)
    }
    var pushSupported: Bool { Bundle.main.object(forInfoDictionaryKey: "FridayPushEnabled") as? Bool == true }
    func enableNotifications() async throws {
        guard pushSupported else { throw ConnectionError.message("这个个人签名版本没有启用原生推送；需要使用付费开发者团队签名的 Friday 版本") }
        let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        guard allowed else { throw ConnectionError.message("请在 iPhone 系统设置中允许 Friday 通知") }
        UIApplication.shared.registerForRemoteNotifications()
    }
    func registerSavedPushToken() async {
        guard let token = UserDefaults.standard.string(forKey: "friday.apns.token"), pushSupported else { return }
        _ = try? await Connection().data("/api/notifications/device", method: "PUT", body: ["token": token, "environment": Bundle.main.object(forInfoDictionaryKey: "FridayPushEnvironment") as? String ?? "development"])
    }
}

public final class FridayPhoneDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    public override init() { super.init() }
    public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        HealthSync.shared.start()
        return true
    }
    public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        UserDefaults.standard.removeObject(forKey: "friday.apns.error")
        UserDefaults.standard.set(deviceToken.map { String(format: "%02x", $0) }.joined(), forKey: "friday.apns.token")
        Task { await HealthSync.shared.registerSavedPushToken() }
    }
    public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        UserDefaults.standard.set("手机通知注册失败，请检查签名与推送能力", forKey: "friday.apns.error")
    }
    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound] }
    public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let id = response.notification.request.content.userInfo["taskId"] as? String else { return }
        await MainActor.run {
            UserDefaults.standard.set(id, forKey: "friday.openConversation")
            NotificationCenter.default.post(name: .fridayOpenConversation, object: id)
        }
    }
}
#endif

import Foundation
extension Notification.Name { static let fridayOpenConversation = Notification.Name("friday.openConversation") }
