import SwiftUI

struct TaskChangeRequestStackView: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String; let detail: TaskChangeRequestDetail; let refreshID: UUID
    let busy: Bool; let draft: TaskChangeRequestDraft
    let navigate: (String) -> Void; let submit: (TaskChangeRequestSubmission) -> Void
    @State private var stack: TaskChangeRequestStack?
    @State private var fresh = false
    @State private var loading = false
    @State private var opening = false
    @State private var error: String?
    @State private var owner = UUID()
    @State private var confirmation: TaskStackActionPlan?
    private var saved: TaskChangeRequestStack? { store.taskDetail(taskID)?.changeRequestStacks?[url] ?? nil }
    private var shown: TaskChangeRequestStack? { fresh ? stack : stack ?? saved }
    private var scope: String { store.connectionIdentity + "|" + taskID + "|" + url }
    var body: some View {
        Group {
            if let value = shown {
                HStack(spacing: 8) {
                    Menu {
                        Text("Stack #\(value.number)")
                        if !fresh { Text(friday: error == nil ? "正在刷新堆叠…" : "堆叠信息可能已过时") }
                        ForEach(value.layers.reversed()) { layer in
                            Button { open(layer, stack: value) } label: {
                                Label("#\(layer.number) \(layer.title ?? layer.headBranch)", systemImage: layer.number == detail.pullRequest.number ? "checkmark" : layer.state == "merged" ? "arrow.triangle.merge" : layer.state == "closed" ? "xmark.circle" : "arrow.triangle.pull")
                            }.disabled(opening || busy || !store.connected)
                        }
                        Text("↳ \(value.base)")
                        Divider()
                        Button(friday: "刷新堆叠", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(loading || !store.connected)
                        if detail.stackRebase == true {
                            Button(friday: "整栈变基") { confirmation = value.plan(action: "update-branch", current: detail.pullRequest.number, method: "rebase") }.disabled(!available || value.plan(action: "update-branch", current: detail.pullRequest.number, method: "rebase") == nil)
                        }
                    } label: {
                        Label("\((value.layers.firstIndex { $0.number == detail.pullRequest.number } ?? -1) + 1)/\(value.layers.count)", systemImage: "square.stack")
                    }.fridayInteractiveCursor()
                    if detail.actions.contains("merge") {
                        Button(friday: "合并堆叠", systemImage: "arrow.triangle.merge") { confirmation = value.plan(action: "merge", current: detail.pullRequest.number, method: detail.mergeMethods.first ?? "merge") }
                            .buttonStyle(FridayButtonStyle(compact: true)).disabled(!available || value.plan(action: "merge", current: detail.pullRequest.number, method: detail.mergeMethods.first ?? "merge") == nil)
                    }
                    if !fresh { Text(friday: loading ? "正在刷新堆叠…" : "堆叠信息可能已过时").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                }.padding(.horizontal, 12).padding(.vertical, 6)
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(.horizontal, 12) }
            } else if let error {
                HStack { Text(fridayString: error).font(.caption).foregroundStyle(.orange); Button(friday: "重试") { Task { await load() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loading || !store.connected); Spacer() }.padding(.horizontal, 12)
            }
        }
        .task(id: scope + "|" + refreshID.uuidString) { await load() }
        .onDisappear { owner = UUID() }
        .sheet(item: $confirmation) { plan in
            VStack(alignment: .leading, spacing: 14) {
                Text(fridayString: plan.label).font(.headline)
                Text(friday: detail.pullRequest.provider == "gitcafe" ? (plan.action == "merge" ? "由平台将所选层及下方尚未合并的 PR 合入堆叠基线。" : "由平台更新整栈分支，会改写历史并可能重跑检查。") : plan.action == "merge" ? "将所选层及下方尚未合并的 PR 合入堆叠基线。GitHub 检查分支规则后合并或加入队列，并调整剩余层。" : "从底层向上变基远端分支，会改写历史并可能重跑检查。某层失败时，之前完成的更新会保留。")
                Text("Stack #\(plan.stackNumber) → \(plan.base)").font(.system(.caption, design: .monospaced))
                ScrollView { VStack(alignment: .leading, spacing: 7) { ForEach(plan.layers) { layer in Text("#\(layer.number) \(layer.title ?? layer.headBranch)").frame(maxWidth: .infinity, alignment: .leading) } } }.frame(maxHeight: 180)
                if plan.action == "merge" {
                    Picker(selection: Binding(get: { confirmation?.mergeMethod ?? plan.mergeMethod }, set: { confirmation?.mergeMethod = $0 })) {
                        ForEach(detail.mergeMethods, id: \.self) { method in Text(friday: method == "squash" ? "压缩合并" : method == "rebase" ? "变基合并" : "合并").tag(method) }
                    } label: { Text(friday: "合并方式") }.fridayInteractiveCursor()
                }
                HStack {
                    Button(friday: "取消") { confirmation = nil }.buttonStyle(FridayButtonStyle(compact: true))
                    Spacer()
                    Button(friday: plan.label) {
                        guard let frozen = confirmation, available else { return }
                        var input = TaskChangeRequestSubmission(url: url, headSha: frozen.headSha, action: frozen.action, mergeMethod: frozen.action == "merge" ? frozen.mergeMethod : nil, draft: draft)
                        input.stackNumber = frozen.stackNumber; input.targetNumber = frozen.targetNumber; input.expectedStackHeads = frozen.heads
                        if frozen.action == "update-branch" { input.updateMethod = "rebase" }
                        submit(input); confirmation = nil
                    }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(!available)
                }
            }.padding(20).frame(minWidth: 340, idealWidth: 460)
        }
    }
    private var available: Bool { fresh && !loading && !opening && !busy && store.connected }
    @MainActor private func load() async {
        let token = UUID(), identity = scope; owner = token; loading = true; fresh = false; opening = false
        defer { if owner == token, scope == identity { loading = false } }
        do { let response = try await store.taskChangeRequestStack(taskID, url: url); guard !Task.isCancelled, owner == token, scope == identity else { return }; stack = response.stack; fresh = true; error = nil }
        catch { if !Task.isCancelled, owner == token, scope == identity { self.error = error.localizedDescription } }
    }
    private func open(_ layer: TaskChangeRequestStack.Layer, stack: TaskChangeRequestStack) {
        guard !opening, !busy, store.connected, layer.number != detail.pullRequest.number else { return }
        opening = true; let token = owner, identity = scope
        Task { @MainActor in
            defer { if owner == token, scope == identity { opening = false } }
            do { let value = try await store.openTaskStackLayer(taskID, url: url, number: layer.number, stackNumber: stack.number); guard owner == token, scope == identity else { return }; navigate(value) }
            catch { if owner == token, scope == identity { self.error = error.localizedDescription } }
        }
    }
}
