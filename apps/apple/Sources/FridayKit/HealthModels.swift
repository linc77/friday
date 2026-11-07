import Foundation

struct HealthDay: Codable, Identifiable {
    let date: String
    let steps: Double?
    let activeEnergyKcal: Double?
    let sleepMinutes: Double?
    let restingHeartRate: Double?
    let workoutMinutes: Double?
    var id: String { date }
}
struct HealthSource: Decodable, Identifiable {
    let deviceId: String; let enabled: Bool; let capturedAt: String?; let receivedAt: String?
    let timezone: String; let days: [HealthDay]
    var id: String { deviceId }
}
struct HealthShareSettings: Codable {
    var enabled: Bool; var modelConsent: Bool; var hour: Int; var minute: Int
    var timezone: String; var sourceDeviceId: String?
    var nextRunAt: Double?
    var generation: Int? = nil
    var focus: String? = nil
    static var initial: Self { .init(enabled: false, modelConsent: false, hour: 8, minute: 30, timezone: TimeZone.current.identifier) }
}
struct HealthDelivery: Decodable, Identifiable {
    let id: String; let status: String; let error: String?
    var statusText: String {
        switch status {
        case "accepted": "通知已交给 Apple"
        case "pending", "retry", "unavailable": "通知等待发送"
        case "awaiting_setup": "等待手机或主机配置通知"
        case "sending": "正在发送通知"
        case "uncertain": "通知发送结果待确认"
        case "expired": "通知已过期"
        case "cancelled": "通知已取消"
        default: "通知发送失败"
        }
    }
}
struct HealthStatus: Decodable {
    let settings: HealthShareSettings; let sources: [HealthSource]; let deliveries: [HealthDelivery]
    let lastRunAt: String?; let lastError: String?; let pushConfigured: Bool; let notificationRegistered: Bool
    let conversationId: String?
}
struct HealthUpload: Codable {
    let uploadId: String; let capturedAt: String; let timezone: String; let days: [HealthDay]
}
struct PushProviderState: Decodable {
    let configured: Bool
    let source: String?
    let keyId: String?
    let teamId: String?
    let topic: String?
    let error: String?
}

// Combine overlapping sleep stages and records, so duplicate sources are not added twice.
func healthIntervalMinutes(_ intervals: [(Date, Date)], within range: (Date, Date)) -> Double? {
    let clipped = intervals.compactMap { start, end -> (Date, Date)? in
        let a = max(start, range.0); let b = min(end, range.1)
        return a < b ? (a, b) : nil
    }.sorted { $0.0 < $1.0 }
    guard var merged = clipped.first else { return nil }
    var seconds: TimeInterval = 0
    for interval in clipped.dropFirst() {
        if interval.0 <= merged.1 { merged.1 = max(merged.1, interval.1) }
        else { seconds += merged.1.timeIntervalSince(merged.0); merged = interval }
    }
    return (seconds + merged.1.timeIntervalSince(merged.0)) / 60
}
