import SwiftUI

@MainActor final class TaskPooledUsageState: ObservableObject {
    struct Submission: Codable { let target: TaskUsageResetTarget; var requestId = UUID().uuidString; var body: [String: Any] { var body = target.body; body["requestId"] = requestId; return body } }
    @Published private(set) var pools: [TaskUsagePool] = []
    @Published private(set) var notices: [String] = []
    @Published private(set) var loading = false
    @Published private(set) var resetting = false
    @Published private(set) var failure: String?
    @Published private(set) var resetStatus: String?
    @Published private(set) var pending: Submission?
    private var operation = UUID(), resetOperation = UUID()
    private func key(_ store: FridayStore) -> String { "pooled-reset:" + store.connectionIdentity }
    func reset() { operation = UUID(); resetOperation = UUID(); pools = []; notices = []; loading = false; resetting = false; failure = nil; resetStatus = nil; pending = nil }
    func refresh(store: FridayStore, force: Bool = false) async {
        guard store.connected, store.usageLimitSourcesSupported else { return }
        let connection = store.connection, identity = store.connectionIdentity, token = UUID(); operation = token; loading = true; failure = nil
        pending = TaskDraftCache.load(Submission.self, server: connection.server, context: key(store))
        defer { if operation == token { loading = false } }
        do {
            if force { _ = try await connection.data("/api/usage-limit-sources/refresh", method: "POST", body: [:]) }
            let value = try await connection.decode(TaskUsagePoolSnapshot.self, "/api/usage-limits")
            guard operation == token, identity == store.connectionIdentity, !Task.isCancelled else { return }
            pools = value.pools; notices = value.notices
        } catch { if operation == token, identity == store.connectionIdentity, !Task.isCancelled { failure = error.localizedDescription } }
    }
    func consume(store: FridayStore, target: TaskUsageResetTarget) async {
        guard store.connected, store.deviceId == "owner", !resetting else { return }
        let connection = store.connection, identity = store.connectionIdentity, context = key(store), token = UUID()
        let submission = pending ?? TaskDraftCache.load(Submission.self, server: connection.server, context: context) ?? Submission(target: target)
        guard submission.target == target else { resetStatus = "请先检查上次重置的结果。"; return }
        resetOperation = token; resetting = true; resetStatus = nil; pending = submission; TaskDraftCache.save(submission, server: connection.server, context: context)
        defer { if resetOperation == token { resetting = false } }
        do {
            let path = target.sourceId == nil ? "/api/composer/reset-credit" : "/api/usage-limit-sources/reset-credit"
            let receipt = try await connection.decode(TaskProviderResetReceipt.self, path, method: "POST", body: submission.body)
            if TaskDraftCache.load(Submission.self, server: connection.server, context: context)?.requestId == submission.requestId { TaskDraftCache.save(Optional<Submission>.none, server: connection.server, context: context) }
            guard resetOperation == token, identity == store.connectionIdentity else { return }
            pending = nil
            switch receipt.outcome {
            case "reset": resetStatus = "账号配额已重置。"
            case "nothingToReset": resetStatus = "当前配额无需重置。"
            case "noCredit": resetStatus = "当前没有可用的重置次数。"
            case "alreadyRedeemed": resetStatus = "这次重置已经处理，没有重复消费。"
            default: resetStatus = receipt.error ?? "重置结果尚未确认，请先检查。"
            }
            if let warning = receipt.warning { resetStatus = (resetStatus ?? "") + " " + warning }
            await store.refresh(); await refresh(store: store)
        } catch { if resetOperation == token, identity == store.connectionIdentity { resetStatus = error.localizedDescription } }
    }
}

struct TaskPooledUsagePanel: View {
    @ObservedObject var state: TaskPooledUsageState
    let owner: Bool; let connected: Bool; let reload: () -> Void; let close: () -> Void; let consume: (TaskUsageResetTarget) -> Void
    @State private var confirmation: TaskUsageResetTarget?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(friday: "账号配额").fontWeight(.medium); Spacer()
                Button(action: reload) { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).disabled(state.loading || !connected).accessibilityLabel(Text(friday: "刷新账号配额"))
                Button(action: close) { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
            }
            ForEach(state.pools) { pool in poolContent(pool) }
            if state.loading, state.pools.isEmpty { Text(friday: "正在读取…").foregroundStyle(.secondary) }
            if let failure = state.failure { Text(fridayString: failure).foregroundStyle(.orange) }
            ForEach(state.notices, id: \.self) { notice in Text(fridayString: notice).foregroundStyle(.secondary) }
            if let status = state.resetStatus { Text(fridayString: status).foregroundStyle(.secondary) }
            if let pending = state.pending { Button { consume(pending.target) } label: { Text(friday: "检查重置结果") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(state.resetting || !connected || !owner) }
        }.font(.caption).padding(12).background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .confirmationDialog(Text(friday: "使用一次配额重置？"), isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }), titleVisibility: .visible) {
            if let target = confirmation { Button { confirmation = nil; consume(target) } label: { Text(friday: "使用一次重置") } }
            Button(role: .cancel) { confirmation = nil } label: { Text(friday: "取消") }
        } message: { Text(friday: "这会消耗当前账号的一次重置次数，无法撤销。") }
    }
    private func poolContent(_ pool: TaskUsagePool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack { Text(verbatim: pool.driver == "codex" ? "Codex" : "Claude").fontWeight(.medium); Text(verbatim: "\(pool.accounts.count)").foregroundStyle(.secondary); Text(friday: "个账号").foregroundStyle(.secondary) }
            ForEach(pool.windows) { window in
                VStack(alignment: .leading, spacing: 4) {
                    HStack { Text(fridayString: window.label); Spacer(); Text(verbatim: "\(window.remainingPercent)%").monospacedDigit(); Text(friday: "剩余") }
                    ProgressView(value: Double(window.remainingPercent), total: 100).tint(window.remainingPercent < 10 ? .red : .accentColor)
                    if let pace = window.pace { Text(fridayString: pace == "ahead" ? "使用快于重置节奏" : pace == "under" ? "使用低于重置节奏" : "使用节奏适中").font(.caption2).foregroundStyle(.secondary) }
                    if let reset = window.resets.first, let date = CodexTranscript.date(reset.at) { HStack { Text(friday: "下次重置"); Text(date, style: .relative).foregroundStyle(.secondary); Text(verbatim: "+\(reset.restoresPercent)%").foregroundStyle(.secondary) }.font(.caption2) }
                    if window.resets.count > 1 {
                        DisclosureGroup { ForEach(Array(window.resets.enumerated()), id: \.offset) { _, reset in
                            if let date = CodexTranscript.date(reset.at) { HStack { Text(verbatim: pool.accounts.first(where: { $0.key == reset.accountKey })?.displayName ?? "").lineLimit(1); Spacer(); Text(date, style: .relative); Text(verbatim: "+\(reset.restoresPercent)%") }.font(.caption2).foregroundStyle(.secondary) }
                        } } label: { Text(friday: "重置时间") }.fridayInteractiveCursor()
                    }
                }
            }
            ForEach(pool.accounts) { account in
                DisclosureGroup {
                    ForEach(account.limits.windows) { window in HStack { Text(fridayString: window.label); Spacer(); Text(verbatim: "\(window.remainingPercent)%").monospacedDigit() } }
                    if let credits = account.limits.resetCredits {
                        HStack {
                            FridaySymbolImage(systemName: "ticket"); Text(verbatim: "\(credits.availableCount)"); Text(friday: "次重置")
                            Spacer()
                            if let target = account.redeem, credits.availableCount > 0 { Button { confirmation = target } label: { Text(friday: "使用一次重置") }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!owner || !connected || state.resetting || state.pending != nil) }
                        }
                        if let expiry = credits.nextExpiresAt, let date = CodexTranscript.date(expiry) { HStack { Text(friday: "下一个到期时间"); Text(date, style: .relative) }.font(.caption2).foregroundStyle(.secondary) }
                    }
                } label: { HStack { Text(verbatim: account.email ?? account.displayName).lineLimit(1); if let plan = account.plan { Text(verbatim: plan).foregroundStyle(.secondary) }; Spacer(); if let source = account.sourceLabel { Text(verbatim: source).foregroundStyle(.secondary) } } }
                .fridayInteractiveCursor()
            }
        }
    }
}
