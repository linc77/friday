import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NewAgentTaskView: View {
    @ObservedObject var store: FridayStore
    var project: Project? = nil
    let onCreated: (String) -> Void
    @Binding var drafts: [String: AgentTaskDraft]
    @State private var sending = false
    @State private var error: String?

    private var draftKey: String { project?.id ?? "" }
    private var message: Binding<String> {
        Binding(get: { drafts[draftKey]?.message ?? "" }, set: { value in
            if drafts[draftKey] == nil { drafts[draftKey] = AgentTaskDraft() }
            drafts[draftKey]?.message = value
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            #if !os(macOS)
            HStack {
                if let project {
                    Text(project.name).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    Text("/").foregroundStyle(.tertiary)
                }
                Text(friday: "新任务").font(.title3.weight(.semibold))
                Spacer()
            }
            #endif
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            Spacer(minLength: 20)
            VStack(spacing: 10) {
                if let project {
                    Text(friday: "在 \(project.name) 中开始新任务").font(.title2.weight(.medium))
                    Text(friday: "选择模型，把任务交给 Claude Code 或 Codex。")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    Text(friday: "从一个 Workspace 开始").font(.title2.weight(.medium))
                    Text(friday: "在任务侧栏选择 Workspace，再把任务交给 Agent。")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity)
            Spacer(minLength: 20)
            AgentTaskComposer(store: store, projectPath: project?.path, requiresProject: true, message: message, sending: sending, send: send)
        }
        .padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FridayTheme.canvas)
    }

    private func send(_ provider: String, _ model: String, _ effort: String) {
        guard let project, !sending else { return }
        let draft = drafts[project.id] ?? AgentTaskDraft()
        guard !draft.message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        drafts[project.id] = draft
        sending = true; error = nil
        Task {
            do {
                let id = try await store.createTask(prompt: draft.message, requestId: draft.requestId, projectId: project.id, agent: provider, model: model, reasoningEffort: effort)
                drafts[project.id] = nil; onCreated(id)
            } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}

struct AgentTaskDraft {
    var message = ""
    let requestId = UUID().uuidString
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
                    .disabled(sending || (requiresProject && projectPath == nil))
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
                        AgentProviderIcon(provider: provider, size: 14)
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
