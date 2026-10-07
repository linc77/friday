import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NewAgentTaskView: View {
    @ObservedObject var store: FridayStore
    let onCreated: (String) -> Void
    @State private var message = ""
    @State private var projectId = ""
    @State private var requestId = UUID().uuidString
    @State private var sending = false
    @State private var error: String?
    private var project: Project? { store.projects.first { $0.id == projectId } }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Text(friday: "新任务").font(.title3.weight(.semibold))
                Spacer()
                Text("Claude · Codex").font(.callout).foregroundStyle(.secondary)
            }
            SettingsGroup("项目") {
                SettingsRow("工作目录", detail: "本地 Agent 在你选择的项目中执行。") {
                    Picker(selection: $projectId) {
                        Text(friday: "选择项目").tag("")
                        ForEach(store.projects) { project in Text(project.name).tag(project.id) }
                    } label: { Text(friday: "选择项目") }.labelsHidden().frame(maxWidth: 230)
                }
                #if os(macOS)
                if store.deviceId == "owner" {
                    SettingsDivider()
                    SettingsRow("选择其他目录") {
                        Button(friday: "选择目录…") { chooseDirectory() }.disabled(sending || !store.connected)
                    }
                }
                #endif
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            Spacer(minLength: 20)
            Text(friday: "选择模型，把任务交给 Claude 或 Codex。关闭窗口也不影响执行。")
                .font(.caption).foregroundStyle(.secondary)
            AgentTaskComposer(store: store, projectPath: project?.path, requiresProject: true, message: $message, sending: sending, send: send)
        }
        .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FridayTheme.canvas)
    }

    #if os(macOS)
    private func chooseDirectory() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if let existing = store.projects.first(where: { $0.path == url.path }) { projectId = existing.id; return }
        sending = true
        Task {
            do {
                let project = try await store.connection.decode(Project.self, "/api/projects", method: "POST", body: ["name": url.lastPathComponent, "path": url.path])
                await store.refresh(); projectId = project.id; error = nil
            } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
    #endif

    private func send(_ provider: String, _ model: String, _ effort: String) {
        guard let project, !sending else { return }
        let prompt = message; sending = true; error = nil
        Task {
            do {
                let id = try await store.createTask(prompt: prompt, requestId: requestId, projectId: project.id, agent: provider, model: model, reasoningEffort: effort)
                message = ""; requestId = UUID().uuidString; onCreated(id)
            } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}

struct AgentTaskComposer: View {
    @ObservedObject var store: FridayStore
    var task: WorkItem? = nil
    var projectPath: String? = nil
    var requiresProject = false
    @Binding var message: String
    let sending: Bool
    let send: (String, String, String) -> Void
    @State private var states: [String: CodexConnectionState] = [:]
    @State private var provider = "codex"
    @State private var showModels = false
    @State private var model = ""
    @State private var effort = ""
    @State private var error: String?
    @FocusState private var focused: Bool
    @Environment(\.locale) private var locale
    private var state: CodexConnectionState? { states[provider] }
    private var providerName: String { provider == "claude" ? "Claude" : "Codex" }
    private var connectionError: String? { error ?? (state?.enabled == false ? "已停用" : state?.error) }
    private var active: Bool { task?.active == true }
    private var disabled: Bool { sending || !store.connected || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || task?.status == "queued" || (requiresProject && projectPath == nil) || (!active && state?.connected != true) }
    private var selectedModel: CodexProviderModel? { state?.models.first { $0.id == (model.isEmpty ? state?.model : model) } }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom, spacing: 16) {
                TextField(friday: active ? "补充任务要求…" : "这个任务要完成什么…", text: $message, axis: .vertical)
                    .font(.body).lineLimit(2...6).textFieldStyle(.plain).focused($focused)
                    .accessibilityLabel(Text(friday: "任务要求"))
                    .onChatSubmit { if !disabled { send(provider, model, effort) } }
                Button { send(provider, model, effort) } label: {
                    FridaySymbolImage(systemName: "arrow.up").fridaySymbolFeedback()
                }.buttonStyle(FridayButtonStyle(prominent: true, compact: true))
                    .accessibilityLabel(Text(friday: sending ? "发送中" : "发送"))
                    .keyboardShortcut(.return, modifiers: .command).disabled(disabled)
            }
            if let connectionError { Text(fridayString: connectionError).font(.caption).foregroundStyle(.orange).lineLimit(2) }
            HStack(spacing: 12) {
                Button { showModels.toggle() } label: {
                    HStack(spacing: 5) {
                        FridaySymbolImage(systemName: provider == "claude" ? "sparkle" : "cpu").font(.caption)
                        Text(selectedModel?.selectionName ?? (model.isEmpty ? providerName : model)).lineLimit(1)
                        FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9))
                    }
                }.buttonStyle(FridaySymbolButtonStyle()).disabled(active || sending).accessibilityLabel(Text(friday: "任务模型"))
                    .popover(isPresented: $showModels) {
                        TaskModelPicker(server: store.connection.server, states: states, lockedProvider: task?.agent, provider: provider, model: selectedModel?.id ?? model) { choice in
                            provider = choice.provider; model = choice.model.id; effort = ""; showModels = false
                        }.environment(\.locale, locale)
                    }
                Divider().frame(height: 16)
                Menu {
                    Button(friday: "模型默认") { effort = "" }
                    ForEach(selectedModel?.reasoningEfforts ?? [], id: \.self) { value in Button(value.capitalized) { effort = value } }
                } label: {
                    HStack(spacing: 5) {
                        Text(effort.isEmpty ? selectedModel?.defaultReasoningEffort.capitalized ?? "Default" : effort.capitalized)
                        FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9))
                    }
                }.disabled(active || sending || (selectedModel?.reasoningEfforts.isEmpty ?? true)).accessibilityLabel(Text(friday: "推理强度"))
                #if os(macOS)
                .menuStyle(.borderlessButton).menuIndicator(.hidden)
                #endif
                Spacer(minLength: 0)
            }.font(.callout).foregroundStyle(.secondary)
            Divider()
            HStack(spacing: 8) {
                FridaySymbolImage(systemName: "folder").fridaySymbolFeedback().font(.caption)
                Text(fridayString: projectPath ?? task?.cwd ?? "选择项目")
                    .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Spacer(minLength: 8)
                FridaySymbolLabel(friday: "按需确认", systemImage: "lock").fridaySymbolFeedback()
            }.font(.caption).foregroundStyle(.secondary)
        }
        .padding(16).fridayCard(highlighted: focused)
        .task(id: task?.id) { provider = task?.agent ?? "codex"; model = task?.model ?? ""; effort = task?.reasoningEffort ?? "" }
        .task(id: store.connected) {
            guard store.connected else { return }
            for value in ["codex", "claude"] {
                do { states[value] = try await store.connection.decode(CodexConnectionState.self, "/api/agents/\(value)") }
                catch { if value == provider { self.error = error.localizedDescription } }
            }
            if task == nil && states[provider]?.connected != true && states["claude"]?.connected == true { provider = "claude"; model = ""; effort = ""; error = nil }
        }
    }
}
