import SwiftUI

struct HealthSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var settings = HealthShareSettings.initial
    @State private var state: HealthStatus?
    @State private var busy = false
    @State private var error: String?
    @State private var requestId = UUID().uuidString
    #if os(iOS)
    @ObservedObject private var sync = HealthSync.shared
    #endif
    private var selectedSource: HealthSource? { state?.sources.first { $0.deviceId == settings.sourceDeviceId } }
    private var time: Binding<Date> {
        Binding(get: { Calendar.current.date(bySettingHour: settings.hour, minute: settings.minute, second: 0, of: Date()) ?? Date() },
                set: { settings.hour = Calendar.current.component(.hour, from: $0); settings.minute = Calendar.current.component(.minute, from: $0) })
    }
    var body: some View {
        Form {
            Section {
                Text(friday: "让 Friday 持续关注你的作息与活动，在约定时间主动与你分享。")
                    .foregroundStyle(.secondary)
                #if os(iOS)
                Toggle(isOn: Binding(get: { sync.enabled }, set: { value in action { try await sync.setEnabled(value); await load() } })) {
                    Text(friday: "同步这台 iPhone 的健康摘要")
                }.disabled(busy || !store.connected).fridayInteractiveCursor()
                Text(fridayString: sync.status).font(.caption).foregroundStyle(.secondary)
                if let issue = sync.backgroundStatus { Text(fridayString: issue).font(.caption).foregroundStyle(.orange) }
                Button(friday: "立即同步") { action { await sync.sync(); await load() } }
                    .disabled(busy || !sync.enabled).fridayInteractiveCursor()
                #else
                Text(friday: "在已配对 iPhone 的「健康与主动分享」中开启健康同步。手机解锁并连通主机后会补同步，系统后台运行不保证准点。")
                    .font(.caption).foregroundStyle(.secondary)
                #endif
                Text(friday: "只读取睡眠、步数、活动能量、静息心率和运动分钟。缺失数据保持未知；健康摘要与明确保存的长期记忆分开。")
                    .font(.caption).foregroundStyle(.secondary)
            } header: { Text(friday: "健康数据") }
            Section {
                Toggle(isOn: $settings.enabled) { Text(friday: "每天主动分享") }.fridayInteractiveCursor()
                DatePicker(selection: time, displayedComponents: .hourAndMinute) { Text(friday: "每日时间") }.fridayInteractiveCursor()
                TextField(friday: "时区", text: $settings.timezone)
                TextField(friday: "关注内容", text: Binding(get: { settings.focus ?? "" }, set: { settings.focus = $0 }))
                if !settings.modelConsent {
                    Text(friday: "本机模式整理固定的可用数字；关注内容会在启用模型分析后用于个性化分享。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let sources = state?.sources, !sources.isEmpty {
                    Picker(selection: $settings.sourceDeviceId) {
                        Text(friday: "选择健康来源").tag(String?.none)
                        ForEach(sources.filter(\.enabled)) { source in
                            Text(store.devices.first { $0.id == source.deviceId }?.name ?? "iPhone").tag(Optional(source.deviceId))
                        }
                    } label: { Text(friday: "健康来源") }
                    .disabled(store.deviceId != "owner").fridayInteractiveCursor()
                }
                Toggle(isOn: $settings.modelConsent) { Text(friday: "允许当前模型分析健康摘要") }.fridayInteractiveCursor()
                Text(friday: "关闭时由本机整理数字。开启后，每日健康对话及你主动询问健康时读取的摘要会发送给当前模型服务（默认 DeepSeek），用于趋势分享和交流。停止同步会清除主机上的该设备摘要，已有对话仍保留。")
                    .font(.caption).foregroundStyle(.secondary)
                Button(friday: "保存分享设置") { action { try await save() } }
                    .disabled(busy || !store.connected).fridayInteractiveCursor()
                if let next = state?.settings.nextRunAt {
                    LabeledContent { Text(Date(timeIntervalSince1970: next / 1000), style: .date); Text(Date(timeIntervalSince1970: next / 1000), style: .time) } label: { Text(friday: "下次分享") }
                }
                Button(friday: "现在分享一次") {
                    action {
                        let response = try await store.connection.decode(IDResponse.self, "/api/health/share", method: "POST", body: ["requestId": requestId])
                        requestId = UUID().uuidString
                        NotificationCenter.default.post(name: .fridayOpenConversation, object: response.id)
                        await load()
                    }
                }.disabled(busy || state?.settings.enabled != true || !store.connected).fridayInteractiveCursor()
                if let message = state?.lastError { Text(fridayString: message).font(.caption).foregroundStyle(.orange) }
                Text(friday: "主机需要保持运行。休眠恢复后补处理四小时内的分享，过期内容留待下次，避免连续打扰。")
                    .font(.caption).foregroundStyle(.secondary)
            } header: { Text(friday: "主动分享") }
            Section {
                #if os(macOS)
                if store.deviceId == "owner" { HealthPushSettingsView(store: store, onSaved: refreshPushStatus) }
                #endif
                #if os(iOS)
                Button(friday: "允许手机通知") { action { try await sync.enableNotifications(); await sync.registerSavedPushToken(); await load() } }
                    .disabled(busy || !sync.pushSupported).fridayInteractiveCursor()
                if !sync.pushSupported {
                    Text(friday: "当前个人签名版本支持健康同步。Friday 原生推送需要付费开发者团队签名，并在主机配置 APNs。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let issue = UserDefaults.standard.string(forKey: "friday.apns.error") { Text(fridayString: issue).font(.caption).foregroundStyle(.orange) }
                #endif
                Text(fridayString: state?.pushConfigured == true ? "主机已配置推送" : "主机尚未配置 APNs，分享仍会保存在对话中")
                    .font(.caption).foregroundStyle(.secondary)
                if let delivery = state?.deliveries.last { Text(fridayString: delivery.statusText).font(.caption); if let reason = delivery.error { Text(fridayString: reason).font(.caption).foregroundStyle(.secondary) } }
                Text(friday: "锁屏通知只提示分享已准备好，不展示健康数字。点开后进入「健康与作息」对话。")
                    .font(.caption).foregroundStyle(.secondary)
            } header: { Text(friday: "手机通知") }
            if let source = selectedSource {
                Section {
                    if let captured = source.capturedAt { LabeledContent { Text(captured).font(.caption).textSelection(.enabled) } label: { Text(friday: "最近采集") } }
                    ForEach(Array(source.days.reversed().prefix(7))) { day in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(day.date).font(.subheadline)
                            Text("步数 \(number(day.steps)) · 睡眠 \(number(day.sleepMinutes)) 分钟 · 静息心率 \(number(day.restingHeartRate))")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Text(friday: "睡眠按前一天中午至当天中午归档，重叠记录只计一次。健康来源未提供的指标显示为「—」。")
                        .font(.caption).foregroundStyle(.secondary)
                } header: { Text(friday: "最近摘要") }
            }
            Section {
                if busy { ProgressView().controlSize(.small) }
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
                Button(friday: "刷新") { action { await load() } }.disabled(busy).fridayInteractiveCursor()
            }
        }
        .formStyle(.grouped)
        .navigationTitle(Text(friday: "健康与主动分享"))
        .task { await load() }
    }
    private func number(_ value: Double?) -> String { value.map { String(Int($0.rounded())) } ?? "—" }
    private func action(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task { do { try await operation() } catch { self.error = error.localizedDescription }; busy = false }
    }
    private func load() async {
        do {
            let result = try await store.connection.decode(HealthStatus.self, "/api/health")
            state = result; settings = result.settings
            if settings.sourceDeviceId == nil { settings.sourceDeviceId = result.sources.first(where: \.enabled)?.deviceId }
        } catch { self.error = error.localizedDescription }
    }
    private func save() async throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any] ?? [:]
        state = try await store.connection.decode(HealthStatus.self, "/api/health/settings", method: "PUT", body: body)
        if let state { settings = state.settings }
    }
    private func refreshPushStatus() async {
        do { state = try await store.connection.decode(HealthStatus.self, "/api/health") }
        catch { self.error = error.localizedDescription }
    }
}
