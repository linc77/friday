import SwiftUI

extension FridayStore {
    func changeRequestCreationContext(_ id: String, selection: [String: String]) async throws -> TaskChangeRequestCreationContext {
        try await connection.decode(TaskChangeRequestCreationContext.self, "/api/tasks/\(id)/git/change-request-context", method: "POST", body: selection)
    }
}
struct TaskChangeRequestCreationDialog: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let review: TaskGitStatus; let submitting: Bool; let submissionError: String?
    var initialNewBranch = false
    var initialName = ""
    let cancel: () -> Void; let submit: (Bool, String, [String: String]) -> Void
    @State private var initialized = false
    @State private var context: TaskChangeRequestCreationContext?
    @State private var target: String?
    @State private var base: String?
    @State private var newBranch = false
    @State private var branchEdited = false
    @State private var name = ""
    @State private var loading = false
    @State private var error: String?
    @State private var loadedKey = ""
    @State private var owner = UUID()
    private var scope: String { store.connectionIdentity + "|" + taskID + "|" + review.fingerprint }
    private var selectionKey: String { scope + "|" + (target ?? "") + "|" + (base ?? "") }
    private var needsFeatureBranch: Bool { guard let context else { return review.isDefaultBranch }; return !context.isCrossRepository && context.sourceBranch == context.baseBranch }
    private var ready: Bool { !submitting && !loading && error == nil && store.connected && loadedKey == selectionKey && context != nil && (newBranch || !needsFeatureBranch) }
    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            Text(friday: review.sourceControl?.provider == "gitlab" ? "推送并创建 MR" : "推送并创建 PR").font(.headline)
            if let context {
                VStack(alignment: .leading, spacing: 6) {
                    Text(friday: "本地分支").font(.caption).foregroundStyle(.secondary)
                    Text(review.branch ?? "HEAD").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(friday: "源仓库与分支").font(.caption).foregroundStyle(.secondary)
                    Text("\(context.source.path):\(newBranch ? name.isEmpty ? "…" : name : context.sourceBranch)").font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                    Picker(selection: Binding(get: { target ?? "" }, set: { target = $0.isEmpty ? nil : $0; base = nil })) {
                        Text(friday: "跟随仓库默认目标").tag("")
                        ForEach(context.choices, id: \.name) { choice in Text("\(choice.name) · \(choice.repository)").tag(choice.name) }
                    } label: { Text(friday: "目标仓库") }.fridayInteractiveCursor()
                    Text(context.target.path).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                    TextField(friday: "目标分支", text: Binding(get: { base ?? context.baseBranch }, set: { base = $0 })).textFieldStyle(.roundedBorder)
                    if context.isCrossRepository { Text(friday: "将源分支推送到 Fork，再向所选目标仓库创建合并请求。").font(.caption).foregroundStyle(.secondary) }
                }
                Toggle(isOn: Binding(get: { newBranch }, set: { branchEdited = true; newBranch = $0 })) { Text(friday: "先新建功能分支") }.fridayInteractiveCursor()
                if newBranch { TextField(friday: "新分支名称（可选）", text: $name).textFieldStyle(.roundedBorder) }
                if needsFeatureBranch, !newBranch { Text(friday: "向同一仓库创建 PR／MR 前，需要先创建功能分支。").font(.caption).foregroundStyle(.secondary) }
            } else { Text(friday: "正在读取 PR／MR 源与目标…").foregroundStyle(.secondary) }
            if loading, context != nil { Text(friday: "正在核对源与目标…").font(.caption).foregroundStyle(.secondary) }
            if let error = error ?? submissionError { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            HStack {
                Button(friday: "取消", action: cancel).buttonStyle(FridayButtonStyle(compact: true)).keyboardShortcut(.cancelAction)
                if error != nil { Button(friday: "刷新") { Task { await load() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(loading || submitting || !store.connected) }
                Spacer()
                Button(friday: review.sourceControl?.provider == "gitlab" ? "推送并创建 MR" : "推送并创建 PR") {
                    guard ready, let context else { return }
                    var selection = ["fingerprint": context.fingerprint]
                    if let target { selection["targetRemote"] = target }; if let base { selection["baseBranch"] = base }
                    submit(newBranch, name, selection)
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true)).disabled(!ready).keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(minWidth: 340, idealWidth: 560).disabled(submitting).interactiveDismissDisabled(submitting)
        .onAppear { if !initialized { initialized = true; newBranch = initialNewBranch; name = initialName; branchEdited = initialNewBranch || !initialName.isEmpty } }
        .task(id: selectionKey) { if context != nil { try? await Task.sleep(for: .milliseconds(450)) }; if !Task.isCancelled { await load() } }
        .onDisappear { owner = UUID() }
    }
    @MainActor private func load() async {
        let token = UUID(), identity = selectionKey; owner = token; loading = true
        defer { if owner == token, selectionKey == identity { loading = false } }
        do {
            var selection: [String: String] = [:]; if let target { selection["targetRemote"] = target }; if let base { selection["baseBranch"] = base }
            let value = try await store.changeRequestCreationContext(taskID, selection: selection)
            guard !Task.isCancelled, owner == token, selectionKey == identity else { return }
            context = value; loadedKey = identity; error = nil
            if !branchEdited { newBranch = needsFeatureBranch }
        } catch { if !Task.isCancelled, owner == token, selectionKey == identity { self.error = error.localizedDescription } }
    }
}
