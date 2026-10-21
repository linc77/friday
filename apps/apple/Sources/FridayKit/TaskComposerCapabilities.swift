import SwiftUI

@MainActor final class TaskProviderUsageState: ObservableObject {
    @Published private(set) var limits: TaskProviderUsageLimits?
    @Published private(set) var loading = false
    @Published private(set) var failure: String?
    @Published private(set) var resetting = false
    @Published private(set) var resetStatus: String?
    @Published private(set) var resetPending: TaskProviderResetSubmission?
    private var identity = "", operation = UUID()
    private var resetOperation = UUID()
    func reset() { identity = ""; operation = UUID(); resetOperation = UUID(); limits = nil; loading = false; failure = nil; resetting = false; resetStatus = nil; resetPending = nil }
    func accept(_ value: TaskProviderUsageLimits, identity: String) {
        guard self.identity == identity, let fingerprint = limits?.credentialFingerprint, fingerprint == value.credentialFingerprint else { return }
        if let current = limits, (CodexTranscript.date(current.checkedAt) ?? .distantPast) > (CodexTranscript.date(value.checkedAt) ?? .distantPast) { return }
        limits = value
    }
    private func resetCacheKey(_ store: FridayStore, provider: String, fingerprint: String) -> String { "provider-reset:" + store.connectionIdentity + ":" + provider + ":" + fingerprint }
    func consume(store: FridayStore, provider: String, fingerprint: String, identity: String) async {
        guard !resetting, store.connected, store.deviceId == "owner", store.providerResetCreditsSupported, self.identity == identity, limits?.credentialFingerprint == fingerprint else { return }
        let context = resetCacheKey(store, provider: provider, fingerprint: fingerprint), server = store.connection.server
        let submission = resetPending ?? TaskDraftCache.load(TaskProviderResetSubmission.self, server: server, context: context) ?? .init(provider: provider, fingerprint: fingerprint)
        guard submission.provider == provider, submission.fingerprint == fingerprint else { return }
        resetPending = submission; TaskDraftCache.save(submission, server: server, context: context)
        let token = UUID(); resetOperation = token; resetting = true; resetStatus = nil
        let connection = store.connection, account = store.connectionIdentity, service = store.taskStreamSession
        defer { if resetOperation == token { resetting = false } }
        do {
            let receipt = try await connection.decode(TaskProviderResetReceipt.self, "/api/composer/reset-credit", method: "POST", body: submission.body)
            if TaskDraftCache.load(TaskProviderResetSubmission.self, server: server, context: context)?.requestId == submission.requestId { TaskDraftCache.save(Optional<TaskProviderResetSubmission>.none, server: server, context: context) }
            guard resetOperation == token, self.identity == identity, store.connectionIdentity == account, store.taskStreamSession == service else { return }
            resetPending = nil
            if let value = receipt.limits { accept(value, identity: identity) }
            let messages = ["reset": "重置已生效，当前限流窗口已清除。", "nothingToReset": "当前没有需要重置的限流窗口。", "noCredit": "当前没有可用的重置次数。", "alreadyRedeemed": "此次重置已使用。"]
            resetStatus = receipt.warning ?? receipt.error ?? receipt.outcome.flatMap { messages[$0] }
            await store.refresh()
        } catch {
            if resetOperation == token, self.identity == identity, store.connectionIdentity == account, store.taskStreamSession == service { resetStatus = "重置结果尚未确认，请先检查。重试会查询同一个重置请求。" }
        }
    }
    func refresh(store: FridayStore, provider: String, taskID: String?, identity: String, reload: Bool = false) async {
        guard store.connected, store.snapshotIdentity == store.connectionIdentity, store.taskComposerCommandsSupported else { reset(); return }
        if self.identity != identity { reset(); self.identity = identity }
        if !reload, let limits, let at = CodexTranscript.date(limits.checkedAt), Date().timeIntervalSince(at) < 60 { return }
        let token = UUID(); operation = token; loading = true; failure = nil
        let connection = store.connection, account = store.connectionIdentity, service = store.taskStreamSession
        var body: [String: Any] = ["provider": provider, "reload": reload]; if let taskID { body["taskId"] = taskID }
        defer { if operation == token { loading = false } }
        do {
            let value = try await connection.decode(TaskProviderUsageLimits.self, "/api/composer/usage-limits", method: "POST", body: body)
            guard !Task.isCancelled, operation == token, self.identity == identity, store.connectionIdentity == account, store.taskStreamSession == service else { return }
            limits = value
            if let fingerprint = value.credentialFingerprint { resetPending = TaskDraftCache.load(TaskProviderResetSubmission.self, server: store.connection.server, context: resetCacheKey(store, provider: provider, fingerprint: fingerprint)) }
        } catch { if !Task.isCancelled, operation == token, store.connectionIdentity == account, store.taskStreamSession == service { failure = error.localizedDescription } }
    }
}

struct TaskProviderUsagePanel: View {
    let provider: String
    let limits: TaskProviderUsageLimits?
    let loading: Bool
    let failure: String?
    let reload: () -> Void
    let close: () -> Void
    var canReset = false
    var resetting = false
    var resetStatus: String? = nil
    var hasPendingReset = false
    var consume: ((String) -> Void)? = nil
    @State private var resetFingerprint: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(verbatim: provider).fontWeight(.medium)
                Text(friday: "账号配额").foregroundStyle(.secondary)
                Spacer()
                Button(action: reload) { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 24, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(loading).accessibilityLabel(Text(friday: "刷新账号配额"))
                Button(action: close) { FridaySymbolImage(systemName: "xmark").frame(width: 24, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
            }
            if let limits, limits.offered {
                ForEach(limits.windows) { window in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(fridayString: window.label)
                            Spacer()
                            Text(verbatim: "\(window.remainingPercent)%").monospacedDigit()
                            Text(friday: "剩余")
                        }
                        ProgressView(value: min(1, max(0, window.usedPercent / 100)))
                            .tint(window.usedPercent >= 90 ? .orange : .secondary)
                        if let raw = window.resetsAt, let reset = CodexTranscript.date(raw) {
                            HStack { Text(friday: "重置时间"); Text(reset, style: .relative); Text(reset, style: .time) }.font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                Text(friday: "账号配额由 Provider 报告，与当前会话的上下文窗口分别计算。")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else { Text(friday: loading ? "正在读取账号配额" : "此 Provider 暂无可用配额信息").foregroundStyle(.secondary) }
            if let fingerprint = limits?.credentialFingerprint, limits?.resetCredits != nil || hasPendingReset {
                HStack(spacing: 8) {
                    FridaySymbolImage(systemName: "ticket").accessibilityHidden(true)
                    if let credits = limits?.resetCredits {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(friday: "可用重置次数：\(credits.availableCount)")
                            if let raw = credits.nextExpiresAt, let date = CodexTranscript.date(raw) { HStack { Text(friday: "下一个到期时间"); Text(date, style: .relative) }.font(.caption).foregroundStyle(.secondary) }
                        }
                    } else { Text(friday: "有待确认的配额重置请求") }
                    Spacer()
                    Button(friday: resetting ? "正在使用…" : hasPendingReset ? "检查重置结果" : "使用一次重置") {
                        if hasPendingReset { consume?(fingerprint) } else { resetFingerprint = fingerprint }
                    }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!canReset || resetting)
                }.font(.caption).padding(.top, 4)
            }
            if let resetStatus { Text(fridayString: resetStatus).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if let failure { Text(failure).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
        }.font(.callout).padding(12).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            .confirmationDialog(Text(friday: "使用一次配额重置？"), isPresented: Binding(get: { resetFingerprint != nil }, set: { if !$0 { resetFingerprint = nil } }), titleVisibility: .visible) {
                if let fingerprint = resetFingerprint {
                    Button(friday: "使用一次重置") { resetFingerprint = nil; consume?(fingerprint) }.disabled(!canReset || resetting)
                }
                Button(friday: "取消", role: .cancel) { resetFingerprint = nil }
            } message: { Text(friday: "这会消耗当前账号的一次重置机会，并清除当前限流窗口。此操作不能撤销。") }
            .onChange(of: limits?.credentialFingerprint) { _, _ in resetFingerprint = nil }
    }
}

@MainActor final class TaskComposerCapabilities: ObservableObject {
    @Published private(set) var catalog: TaskComposerCatalog?
    @Published private(set) var loading = false
    @Published private(set) var failure: String?
    private var identity = ""
    private var operation = UUID()
    func reset() { identity = ""; operation = UUID(); catalog = nil; failure = nil; loading = false }
    func refresh(store: FridayStore, scope: [String: Any], provider: String, identity: String, reload: Bool = false) async {
        guard store.connected, store.snapshotIdentity == store.connectionIdentity, store.taskComposerCommandsSupported, !scope.isEmpty else { reset(); return }
        if self.identity != identity { reset(); self.identity = identity }
        if !reload, let catalog, catalog.provider == provider, let checked = CodexTranscript.date(catalog.checkedAt), Date().timeIntervalSince(checked) < 300 { return }
        let token = UUID(); operation = token; loading = true; failure = nil
        let connection = store.connection, account = store.connectionIdentity, service = store.taskStreamSession
        var body = scope; body["provider"] = provider; body["reload"] = reload
        defer { if operation == token { loading = false } }
        do {
            let value = try await connection.decode(TaskComposerCatalog.self, "/api/composer/capabilities", method: "POST", body: body)
            guard !Task.isCancelled, operation == token, self.identity == identity, store.connectionIdentity == account, store.taskStreamSession == service else { return }
            guard value.provider == provider else { throw ConnectionError.message("执行器已经改变，请重新加载") }
            catalog = value
        } catch {
            if !Task.isCancelled, operation == token, store.connectionIdentity == account, store.taskStreamSession == service { failure = error.localizedDescription }
        }
    }
}

struct TaskCompactionSubmission {
    let id = UUID().uuidString
    let taskID: String; let threadID: String; let scope: String
    var body: [String: Any] { ["requestId": id, "threadId": threadID] }
}

@MainActor final class TaskCompactionState: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var failure: String?
    @Published private(set) var pending: TaskCompactionSubmission?
    private var operation = UUID()
    func reset() { operation = UUID(); busy = false; failure = nil; pending = nil }
    func start(store: FridayStore, task: WorkItem, scope: String, accepted: @escaping () -> Void) {
        guard !busy, store.connected, store.snapshotIdentity == store.connectionIdentity, store.taskComposerCommandsSupported, let thread = task.threadId else { return }
        let request: TaskCompactionSubmission
        if let pending, pending.taskID == task.id, pending.threadID == thread, pending.scope == scope { request = pending }
        else { request = TaskCompactionSubmission(taskID: task.id, threadID: thread, scope: scope) }
        pending = request; busy = true; failure = nil
        let token = UUID(); operation = token
        let connection = store.connection, account = store.connectionIdentity, service = store.taskStreamSession
        Task { @MainActor in
            defer { if operation == token { busy = false } }
            do {
                _ = try await connection.data("/api/tasks/\(task.id)/compact", method: "POST", body: request.body)
                guard operation == token, store.connectionIdentity == account, store.taskStreamSession == service else { return }
                pending = nil; accepted(); await store.refresh()
            } catch {
                if operation == token, store.connectionIdentity == account, store.taskStreamSession == service { failure = error.localizedDescription }
            }
        }
    }
}

struct TaskContextWindowControl: View {
    let usage: TaskContextUsage?
    let compacting: Bool
    let canCompact: Bool
    let canRetry: Bool
    let failure: String?
    let showResumePreference: Bool
    let resumeSuggestionsEnabled: Bool
    let toggleResumeSuggestions: () -> Void
    let compact: () -> Void
    let reload: () -> Void
    @State private var showing = false
    var body: some View {
        Button { showing.toggle() } label: {
            if let usage, let fraction = usage.fraction {
                Gauge(value: fraction) { Text(friday: "上下文窗口") }
                    .gaugeStyle(.accessoryCircularCapacity).tint(fraction > 0.9 ? Color.red : .secondary)
                    .scaleEffect(0.5).frame(width: 24, height: 24).accessibilityHidden(true)
            } else {
                FridaySymbolImage(systemName: "circle.dotted").frame(width: 24, height: 24)
            }
        }.buttonStyle(FridaySymbolButtonStyle())
            .help(Text(friday: "上下文窗口"))
            .accessibilityLabel(Text(friday: "上下文窗口"))
            .accessibilityValue(Text(usage.map { TaskContextUsage.format($0.usedTokens) + " / " + TaskContextUsage.format($0.maxTokens) } ?? "—"))
            .popover(isPresented: $showing) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text(friday: "上下文窗口").font(.headline)
                        Spacer()
                        if let value = usage?.percentageText { Text(verbatim: value).monospacedDigit() }
                    }
                    if let usage {
                        HStack { Text(friday: "已使用"); Spacer(); Text(TaskContextUsage.format(usage.usedTokens) + " / " + TaskContextUsage.format(usage.maxTokens)).monospacedDigit() }
                        if let remaining = usage.remainingTokens { HStack { Text(friday: "剩余"); Spacer(); Text(TaskContextUsage.format(remaining)).monospacedDigit() } }
                        ForEach(metrics(usage), id: \.0) { label, value in
                            HStack { Text(fridayString: label); Spacer(); Text(TaskContextUsage.format(value)).monospacedDigit() }
                        }
                        Text(friday: "当前上下文占用来自最近一次 Provider 请求，不代表累计用量。")
                            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    } else { Text(friday: "Provider 尚未报告上下文占用").foregroundStyle(.secondary) }
                    if let failure { Text(failure).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                    if showResumePreference {
                        Toggle(isOn: Binding(get: { resumeSuggestionsEnabled }, set: { _ in toggleResumeSuggestions() })) { Text(friday: "建议恢复前压缩过期历史") }
                            .fridayInteractiveCursor()
                    }
                    HStack {
                        Button(friday: "刷新命令和 Skill", action: reload).buttonStyle(FridayButtonStyle())
                        Spacer()
                        Button(friday: compacting ? "正在压缩上下文" : canRetry ? "重试核对" : "压缩上下文") { compact(); showing = false }
                            .buttonStyle(FridayButtonStyle(prominent: true)).disabled(compacting || !canCompact && !canRetry)
                    }
                }.font(.callout).padding(18).frame(width: 350)
            }
    }
    private func metrics(_ usage: TaskContextUsage) -> [(String, Double)] {
        [("输入 Token", usage.inputTokens), ("缓存 Token", usage.cachedInputTokens), ("输出 Token", usage.outputTokens), ("推理 Token", usage.reasoningOutputTokens)].compactMap { name, value in value.map { (name, $0) } }
    }
}
