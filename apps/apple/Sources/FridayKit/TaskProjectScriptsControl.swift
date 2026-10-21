import SwiftUI

struct TaskProjectScriptsControl: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    var updateSetup: (TaskWorktreeSetupSnapshot?) -> Void = { _ in }
    @State private var setup: TaskWorktreeSetupSnapshot?
    @State private var scripts: [ProjectScript] = []
    @State private var keybindings: [String: String] = [:]
    @State private var preferred: String?
    @State private var runs: [ProjectScriptRun] = []
    @State private var selected: ProjectScriptIdentifier?
    @State private var autoPreviewID: String?
    @State private var settings = false
    @State private var busy = false
    @State private var error: String?
    @State private var pending: PendingProjectScript?
    @State private var context = ""
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + task.id + "\n" + (task.projectId ?? "") }
    private var primary: ProjectScript? { ProjectScript.primary(scripts, preferred: preferred) }
    private var preferredCache: String { "project-script-last-invoked:" + (task.projectId ?? task.id) }
    private var cache: String { "project-script-pending:" + task.id }
    var body: some View {
        HStack(spacing: 2) {
            if let primary {
                Button { start(primary) } label: { FridaySymbolImage(systemName: primary.symbol).frame(width: 24, height: 24) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(busy || pending != nil || !store.connected)
                    .accessibilityLabel(Text(verbatim: primary.name)).help(Text(verbatim: primary.name))
            }
            Menu {
                ForEach(scripts) { script in
                    Button { start(script) } label: { Label(script.name + (keybindings[script.id].flatMap(ProjectScriptShortcut.init).map { "  " + $0.label } ?? ""), systemImage: script.symbol) }
                        .disabled(busy || pending != nil || !store.connected)
                }
                if let pending { Button(friday: "核对脚本运行") { send(pending) }.disabled(busy || !store.connected) }
                if !runs.isEmpty {
                    Divider()
                    ForEach(Array(runs.suffix(12).reversed())) { run in
                        Button { autoPreviewID = nil; selected = ProjectScriptIdentifier(id: run.id) } label: { Text(verbatim: run.script.name); Text(fridayString: run.label) }
                    }
                }
                if let error { Text(fridayString: error) }
                Divider()
                Button(friday: "项目脚本设置…") { settings = true }.disabled(task.projectId == nil)
            } label: { FridaySymbolImage(systemName: primary == nil ? "play" : "chevron.down").frame(width: primary == nil ? 24 : 14, height: 24) }
                #if os(macOS)
                .menuStyle(.borderlessButton)
                #endif
                .fixedSize().fridayInteractiveCursor().accessibilityLabel(Text(friday: "项目脚本"))
        }
        .modifier(ProjectScriptKeyboardActions(scripts: scripts, keybindings: keybindings, enabled: store.connected && !busy && pending == nil && context == identity, run: start))
        .sheet(item: $selected) { ProjectScriptRunView(store: store, id: $0.id, autoPreview: $0.id == autoPreviewID).id(store.connectionIdentity + "\n" + $0.id) }
        .sheet(isPresented: $settings) {
            VStack(spacing: 0) {
                HStack { Spacer(); Button(friday: "完成") { settings = false } }.padding(12)
                ProjectScriptsSettingsView(store: store, initialProjectId: task.projectId)
            }
            #if os(macOS)
            .frame(width: 720, height: 650)
            #endif
        }
        .task(id: identity) {
            let scope = identity; context = scope; scripts = []; runs = []; busy = false; error = nil; selected = nil; settings = false
            setup = nil; updateSetup(nil)
            pending = TaskDraftCache.load(PendingProjectScript.self, server: store.connection.server, context: cache)
            preferred = TaskDraftCache.load(String.self, server: store.connection.server, context: preferredCache)
            while !Task.isCancelled && context == scope {
                if store.connected { await load(scope) }
                do { try await Task.sleep(for: .seconds(runs.contains { $0.active } || setup?.active == true || task.preparingWorkspace != nil ? 1 : 3)) } catch { break }
            }
        }
    }
    private func load(_ scope: String) async {
        do {
            let value = try await store.connection.decode(TaskProjectScriptsSnapshot.self, "/api/tasks/\(task.id)/scripts")
            guard context == scope, identity == scope, !Task.isCancelled else { return }; scripts = value.scripts; keybindings = value.keybindings ?? [:]
            if runs != value.runs { runs = value.runs }
            if let snapshot = value.worktreeSetup, !snapshot.belongs(to: task) { return }
            let next = value.worktreeSetup
            if setup?.runId == next?.runId, setup?.attempt == next?.attempt, let previous = setup?.sequence, let following = next?.sequence, following < previous { return }
            let changed = setup == nil ? next != nil : next.map { !setup!.samePresentation(as: $0) } ?? true
            setup = next
            if changed { updateSetup(next) }
            preferred = TaskDraftCache.load(String.self, server: store.connection.server, context: preferredCache)
            if let pending, let run = runs.first(where: { $0.requestId == pending.requestId && $0.script.id == pending.scriptId }) { complete(run.id) }
        } catch { if context == scope && identity == scope { self.error = error.localizedDescription } }
    }
    private func start(_ script: ProjectScript) {
        guard !busy, pending == nil, store.connected else { return }
        preferred = script.id; TaskDraftCache.save(script.id, server: store.connection.server, context: preferredCache)
        let value = PendingProjectScript(scriptId: script.id, requestId: UUID().uuidString); pending = value
        TaskDraftCache.save(value, server: store.connection.server, context: cache); send(value)
    }
    private func send(_ value: PendingProjectScript) {
        guard !busy, store.connected else { return }; busy = true; error = nil
        let scope = identity, connection = store.connection, taskID = task.id
        Task { @MainActor in
            guard context == scope, identity == scope else { return }
            do {
                let receipt = try await connection.decode(ProjectScriptIdentifier.self, "/api/tasks/\(taskID)/scripts", method: "POST", body: ["scriptId": value.scriptId, "requestId": value.requestId])
                guard context == scope, identity == scope else { return }; complete(receipt.id); await load(scope)
            } catch { if context == scope && identity == scope { self.error = error.localizedDescription } }
            if context == scope && identity == scope { busy = false }
        }
    }
    private func complete(_ id: String) {
        pending = nil; TaskDraftCache.save(Optional<PendingProjectScript>.none, server: store.connection.server, context: cache); autoPreviewID = id; selected = ProjectScriptIdentifier(id: id)
    }
}

struct ProjectScriptRunView: View {
    @ObservedObject var store: FridayStore
    let id: String
    var autoPreview = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.taskBrowserOpen) private var openPreview
    @Environment(\.openURL) private var openURL
    @State private var receipt: ProjectScriptRunReceipt?
    @State private var error: String?
    @State private var busy = false
    @State private var context = ""
    @State private var confirmation = false
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + id }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(receipt?.run.script.name ?? "").font(.headline).lineLimit(1); Spacer()
                Button(friday: "关闭") { dismiss() }.buttonStyle(FridayButtonStyle(compact: true))
            }
            if let receipt {
                HStack(spacing: 12) {
                    Text(fridayString: receipt.run.label).foregroundStyle(receipt.run.status == "failed" || receipt.run.status == "interrupted" ? .orange : .secondary)
                    if let code = receipt.run.exitCode { Text(verbatim: "exit \(code)").font(.system(.caption, design: .monospaced)) }
                    Spacer()
                    if let text = receipt.run.script.previewUrl, let url = TaskBrowserPolicy.url(text) {
                        Button(friday: "网页预览") { preview(url) }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                    if receipt.run.active { Button(friday: "停止脚本") { Task { await cancel() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                    else if receipt.terminal?.canType == true { Button(friday: "关闭终端") { confirmation = true }.buttonStyle(FridayButtonStyle(compact: true)).disabled(busy || !store.connected) }
                }.font(.caption)
                Text(verbatim: receipt.run.cwd).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let terminal = receipt.terminal {
                    ProjectScriptTerminal(connection: store.connection, metadata: terminal).id(identity)
                } else { Text(friday: "正在打开终端…").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
                if let problem = receipt.run.error { Text(fridayString: problem).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            } else { Text(friday: "正在读取脚本运行…").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }.padding(16).frame(idealWidth: 820, idealHeight: 500)
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 340)
        #endif
        .task(id: identity) {
            let scope = identity; context = scope; receipt = nil; error = nil; busy = false
            while !Task.isCancelled && identity == scope {
                await load(scope)
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .confirmationDialog(Text(friday: "停止终端中的程序？"), isPresented: $confirmation, titleVisibility: .visible) {
            Button(friday: "停止并关闭", role: .destructive) { Task { await closeTerminal() } }
            Button(friday: "取消", role: .cancel) {}
        }
    }
    private func preview(_ url: URL) { if openPreview?(url) != true { openURL(url) }; dismiss() }
    private func load(_ scope: String) async {
        do {
            let value = try await store.connection.decode(ProjectScriptRunReceipt.self, "/api/project-scripts/runs/\(id)")
            guard identity == scope, context == scope, !Task.isCancelled else { return }; receipt = value; error = nil
            if autoPreview && value.run.startedAt != nil && value.run.script.autoOpenPreview == true, let text = value.run.script.previewUrl, let url = TaskBrowserPolicy.url(text) {
                let key = "project-script-preview:" + id
                if TaskDraftCache.load(Bool.self, server: store.connection.server, context: key) != true, openPreview?(url) == true { TaskDraftCache.save(true, server: store.connection.server, context: key) }
            }
        } catch { if identity == scope && context == scope { self.error = error.localizedDescription } }
    }
    private func cancel() async {
        guard !busy, receipt?.run.active == true else { return }; let scope = identity; busy = true
        do { _ = try await store.connection.data("/api/project-scripts/runs/\(id)/cancel", method: "POST", body: [:]); if identity == scope { await load(scope) } }
        catch { if identity == scope { self.error = error.localizedDescription } }; if identity == scope { busy = false }
    }
    private func closeTerminal() async {
        guard !busy, let row = receipt?.terminal else { return }; let scope = identity; busy = true
        do { _ = try await store.connection.data("/api/tasks/\(row.taskId)/terminals", method: "POST", body: ["action": "close", "terminalId": row.id, "requestId": UUID().uuidString, "force": true]); if identity == scope { await load(scope) } }
        catch { if identity == scope { self.error = error.localizedDescription } }; if identity == scope { busy = false }
    }
}

private struct ProjectScriptTerminal: View {
    @StateObject private var session: TaskTerminalSession
    let metadata: TaskTerminalSummary
    @AppStorage("friday.terminal.fontSize") private var fontSize = 13.0
    init(connection: Connection, metadata: TaskTerminalSummary) {
        self.metadata = metadata; _session = StateObject(wrappedValue: TaskTerminalSession(connection: connection, terminal: metadata))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TaskTerminalSurface(session: session).frame(maxWidth: .infinity, maxHeight: .infinity)
            if let issue = session.inputProblem { HStack { Text(fridayString: issue).font(.caption).foregroundStyle(.orange); Button(friday: "继续输入") { session.resumeInput() } } }
            else if let issue = session.error { Text(fridayString: issue).font(.caption).foregroundStyle(.orange) }
        }
        .onAppear { session.sync(metadata); session.setFontSize(fontSize); session.attach() }
        .onChange(of: metadata) { _, value in session.sync(value) }
        .onChange(of: fontSize) { _, value in session.setFontSize(value) }
        .onDisappear { session.detach() }
    }
}
