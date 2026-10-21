import SwiftUI

struct TaskChangeRequestCheckoutPreview: Decodable {
    let pullRequest: TaskPullRequest; let headSha: String; let localBranch: String; let worktreeBranch: String
    let fingerprint: String; let localFingerprint: String; let dirty: Bool
}
struct TaskChangeRequestCheckoutReceipt: Decodable {
    struct Plan: Decodable { let cwd: String; struct Submodules: Decodable { let status: String; let detail: String? }; let submodules: Submodules? }
    let id: String; let projectId: String; let status: String; let mode: String; let branch: String
    let pullRequest: TaskPullRequest; let plan: Plan?; let isOnHead: Bool?; let error: String?
    let setupRunId: String?
    let setupWarning: String?
    var active: Bool { status == "queued" || status == "running" }
    var selection: TaskWorkspaceSelection {
        var value = TaskWorkspaceSelection(); value.mode = mode; value.preparationId = id
        value.preparedBranch = branch; value.preparedPath = plan?.cwd; value.preparedURL = pullRequest.url; value.preparedOnHead = isOnHead
        return value
    }
}
struct TaskChangeRequestDraftHandoff: Identifiable {
    let id = UUID(); let identity: String; let result: TaskChangeRequestCheckoutReceipt
}

@MainActor private final class ChangeRequestCheckoutSession: ObservableObject {
    private static var sessions: [String: ChangeRequestCheckoutSession] = [:]
    static func forScope(_ scope: String, initialReference: String) -> ChangeRequestCheckoutSession {
        if let value = sessions[scope] { return value }
        let value = ChangeRequestCheckoutSession(); value.reference = initialReference; sessions[scope] = value; return value
    }
    @Published var reference = ""
    @Published var mode = "worktree"
    @Published var force = false
    @Published var preview: TaskChangeRequestCheckoutPreview?
    @Published var operation: TaskChangeRequestCheckoutReceipt?
    @Published var operationID: String?
    @Published var loading = false
    @Published var sending = false
    @Published var error: String?
    var pending: [String: Any]?
}

struct TaskChangeRequestCheckoutDialog: View {
    @ObservedObject var store: FridayStore
    let project: Project
    var initialReference = ""
    let prepared: (TaskChangeRequestCheckoutReceipt) -> Void
    var body: some View {
        TaskChangeRequestCheckoutContent(store: store, project: project, prepared: prepared,
            session: ChangeRequestCheckoutSession.forScope(store.connectionIdentity + ":" + project.id + ":" + initialReference, initialReference: initialReference))
            .id(store.connectionIdentity + ":" + project.id + ":" + initialReference)
    }
}
private struct TaskChangeRequestCheckoutContent: View {
    @ObservedObject var store: FridayStore
    let project: Project; let prepared: (TaskChangeRequestCheckoutReceipt) -> Void
    @ObservedObject fileprivate var session: ChangeRequestCheckoutSession
    @Environment(\.dismiss) private var dismiss
    @State private var scriptOutput: ProjectScriptIdentifier?
    private var base: String { "/api/projects/\(project.id)/change-request" }
    private var locked: Bool { session.sending || session.pending != nil || session.operation?.active == true }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(friday: "从 PR／MR 开始").font(.headline)
                Spacer()
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 26, height: 26) }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭"))
            }
            Text(project.name).foregroundStyle(.secondary)
            TextField(text: $session.reference) { Text(friday: "PR／MR 地址、编号或 checkout 命令") }
                .textFieldStyle(.roundedBorder).disabled(locked)
            Picker(selection: $session.mode) {
                Text(friday: "当前目录").tag("checkout"); Text("Worktree").tag("worktree")
            } label: { Text(friday: "执行位置") }.pickerStyle(.segmented).disabled(locked)
            if let preview = session.preview {
                Text("#\(preview.pullRequest.number) · \(preview.pullRequest.title)").font(.callout).textSelection(.enabled)
                Text(session.mode == "checkout" ? preview.localBranch : preview.worktreeBranch).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                if session.mode == "checkout" {
                    if preview.dirty { Text(friday: "当前目录有未提交改动，使用 Worktree 可以保留这些改动。").font(.caption).foregroundStyle(.orange) }
                    Toggle(isOn: $session.force) { Text(friday: "允许丢弃当前目录和所选本地分支的改动，重置到 PR／MR 提交") }.font(.caption).disabled(locked)
                }
            }
            if session.loading || session.sending || session.operation?.active == true {
                HStack { ProgressView().controlSize(.small); Text(friday: "正在准备执行目录…").font(.caption) }
            }
            if let error = session.error ?? session.operation?.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let warning = session.operation?.setupWarning { Text(fridayString: warning).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let modules = session.operation?.plan?.submodules, modules.status == "warning", let detail = modules.detail { Text(fridayString: detail).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            if let runID = session.operation?.setupRunId { Button(friday: "查看初始化脚本") { scriptOutput = ProjectScriptIdentifier(id: runID) }.buttonStyle(FridayButtonStyle(compact: true)) }
            if session.operation?.status == "ready" {
                if session.operation?.isOnHead == false { Text(friday: "保留了已有 Worktree 的本地状态，尚未对齐 PR／MR 最新提交").font(.caption).foregroundStyle(.orange) }
                Text(session.operation?.plan?.cwd ?? "").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            HStack {
                if session.operation?.active == true {
                    Button(friday: "停止准备") { Task { await cancel() } }.buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected)
                } else if let operation = session.operation, operation.status != "ready" {
                    Button(friday: "重新准备") { session.operation = nil; session.operationID = nil; session.pending = nil; session.preview = nil; session.error = nil; Task { await resolve() } }.buttonStyle(FridaySymbolButtonStyle())
                }
                Spacer()
                Button(friday: session.operation?.status == "ready" ? "打开任务草稿" : session.pending != nil ? "核对准备结果" : "准备并打开草稿") {
                    if let result = session.operation, result.status == "ready" { prepared(result) }
                    else { Task { await start() } }
                }.buttonStyle(BorderedProminentButtonStyle()).fridayInteractiveCursor().disabled(!store.connected || session.sending || session.operation?.active == true || session.operation != nil && session.operation?.status != "ready" || session.preview == nil && session.pending == nil || session.mode == "checkout" && session.preview?.dirty == true && !session.force && session.pending == nil)
            }
        }.padding(24).frame(idealWidth: 520)
            .sheet(item: $scriptOutput) { ProjectScriptRunView(store: store, id: $0.id).id(store.connectionIdentity + "\n" + $0.id) }
            .task(id: session.reference + ":" + store.connectionIdentity) {
                guard !locked, session.operation == nil else { return }
                session.preview = nil; session.error = nil
                do { try await Task.sleep(for: .milliseconds(450)); try Task.checkCancellation(); await resolve() } catch {}
            }
            .task(id: session.operationID) { if session.operationID != nil { await poll() } }
    }
    private func resolve() async {
        guard session.pending == nil, session.operation == nil, !session.reference.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let identity = store.connectionIdentity, reference = session.reference
        session.loading = true; defer { if session.reference == reference { session.loading = false } }
        do {
            let preview = try await store.connection.decode(TaskChangeRequestCheckoutPreview.self, base + "/resolve", method: "POST", body: ["reference": reference])
            guard !Task.isCancelled, store.connectionIdentity == identity, session.reference == reference, session.pending == nil else { return }
            session.preview = preview; session.error = nil
        } catch { if !Task.isCancelled, store.connectionIdentity == identity, session.reference == reference { session.error = error.localizedDescription } }
    }
    private func start() async {
        guard !session.sending else { return }; let identity = store.connectionIdentity
        if session.pending == nil, let preview = session.preview {
            session.pending = ["reference": session.reference, "mode": session.mode, "fingerprint": preview.fingerprint, "localFingerprint": preview.localFingerprint, "force": session.force, "requestId": UUID().uuidString]
        }
        guard let body = session.pending else { return }; session.sending = true; session.error = nil
        defer { session.sending = false }
        do {
            let (data, response) = try await URLSession.shared.data(for: store.connection.request(base + "/prepare", method: "POST", body: body))
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                if let http = response as? HTTPURLResponse, (400..<500).contains(http.statusCode), store.connectionIdentity == identity { session.pending = nil; session.preview = nil; await resolve() }
                throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "目录准备结果尚未确认，请核对准备结果")
            }
            let result = try JSONDecoder().decode(IDResponse.self, from: data)
            guard store.connectionIdentity == identity else { return }; session.operationID = result.id; session.pending = nil
            // Polling is keyed by the persisted operation ID and reads local receipts only.
        } catch {
            guard store.connectionIdentity == identity else { return }; session.error = error.localizedDescription
        }
    }
    private func poll() async {
        guard let id = session.operationID else { return }; let identity = store.connectionIdentity
        while !Task.isCancelled, store.connectionIdentity == identity, session.operationID == id {
            do {
                let result = try await store.connection.decode(TaskChangeRequestCheckoutReceipt.self, base + "/preparations/" + id)
                guard !Task.isCancelled, store.connectionIdentity == identity, session.operationID == id else { return }
                session.operation = result; session.error = nil
                if !result.active { if result.status == "ready" { prepared(result) }; return }
                try await Task.sleep(for: .milliseconds(500))
            } catch { if !Task.isCancelled, store.connectionIdentity == identity { session.error = error.localizedDescription }; return }
        }
    }
    private func cancel() async {
        guard let id = session.operationID else { return }; let identity = store.connectionIdentity
        do { _ = try await store.connection.data(base + "/preparations/" + id + "/cancel", method: "POST", body: [:]); if store.connectionIdentity == identity { await poll() } }
        catch { if store.connectionIdentity == identity { session.error = error.localizedDescription } }
    }
}
