import SwiftUI

private enum TextGenerationField: String, Identifiable {
    case titles = "textGenerationModelSelection", sourceControl = "sourceControlWriterModelSelection", guide = "reviewGuideModelSelection"
    var id: String { rawValue }
    var title: String { self == .titles ? "文字生成模型" : self == .guide ? "审查 Guide 模型" : "提交与 PR 说明模型" }
}

struct TextGenerationSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var scope: String
    @State private var state = TextGenerationSettingsState()
    @State private var states: [String: CodexConnectionState] = [:]
    @State private var failure: String?
    @State private var picking: TextGenerationField?
    @State private var customInstructions = ""
    @State private var guideInstructions = ""
    @FocusState private var editingGuide: Bool
    @FocusState private var editingInstructions: Bool
    #if os(macOS)
    @Environment(\.fridayModelJump) private var modelJump
    #endif

    init(store: FridayStore, initialProjectId: String? = nil) {
        self.store = store; _scope = State(initialValue: initialProjectId ?? "")
    }
    private var projectID: String? { scope.isEmpty ? nil : scope }
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") }
    private var context: String { identity + "\n" + scope }

    var body: some View {
        SettingsPage(title: "文字生成", subtitle: "用于任务标题和其他自动生成的文字；提交与 PR 说明可单独选择模型。") {
            SettingsGroup("设置范围") {
                SettingsRow("应用到") {
                    Picker(selection: $scope) {
                        Text(friday: "此主机").tag("")
                        ForEach(store.projects) { project in Text(project.name).tag(project.id) }
                    } label: { Text(friday: "设置范围") }
                    .labelsHidden().fridayInteractiveCursor()
                }
            }
            if let snapshot = state.snapshot {
                SettingsGroup("模型") {
                    modelRow(.titles, snapshot: snapshot)
                    SettingsDivider()
                    modelRow(.sourceControl, snapshot: snapshot)
                }.disabled(state.busy || !store.connected)
                guideSettings(snapshot).disabled(state.busy || !store.connected)
                writingStyle(snapshot).disabled(state.busy || !store.connected)
            }
            if state.busy { Text(friday: "正在同步设置…").font(.caption).foregroundStyle(.secondary) }
            if let failure {
                HStack(alignment: .top) {
                    Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                    Spacer()
                    Button { Task { await load() } } label: { FridaySymbolLabel(friday: "重新加载", systemImage: "arrow.clockwise") }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(state.busy || !store.connected)
                }
            }
            if store.deviceId != "owner" { Text(friday: "Provider 的账号与连接需在主机的 Providers 中配置。").font(.caption).foregroundStyle(.secondary) }
        }
        .task(id: context) { await load() }
        .onChange(of: store.textGenerationSettingsVersion) { old, value in
            if old != value, state.shouldReload(value) { Task { await load() } }
        }
        .onChange(of: store.projects.map(\.id)) { _, ids in if !scope.isEmpty && !ids.contains(scope) { scope = "" } }
        .popover(item: $picking) { field in
            if let snapshot = state.snapshot {
                let pickerToken = state.token
                let selection = selected(field, snapshot)
                TaskModelPicker(server: store.connection.server, scope: context, states: states, lockedProvider: nil, provider: selection.agent, model: selection.model, instances: store.providerInstances.filter { $0.driver != "acp-registry" && states[$0.id]?.supportsTextGeneration != false && (field.rawValue != "reviewGuideModelSelection" || ["codex", "claude"].contains($0.driver)) }, instanceId: selection.providerInstanceId ?? selection.agent) { choice in
                    guard state.current(pickerToken, identity: identity, projectID: projectID), !state.busy else { return }
                    picking = nil
                    let selected = TextGenerationModelSelection(providerInstanceId: choice.selectionId, agent: choice.provider, model: choice.model.id, reasoningEffort: choice.model.defaultReasoningEffort)
                    save(changes: [field.rawValue: selected.body], ownerToken: pickerToken)
                }.presentationCompactAdaptation(.sheet)
            }
        }
        #if os(macOS)
        .focusedSceneValue(\.fridayTaskNavigation, picking == nil ? nil : TaskNavigationActions(rows: [], selected: nil, model: modelJump.wrappedValue, editingTitle: false, open: { _ in }))
        #endif
    }

    private func selected(_ field: TextGenerationField, _ value: TextGenerationSettingsSnapshot) -> TextGenerationModelSelection {
        field == .titles ? value.effective.textGenerationModelSelection : field == .guide ? value.effective.reviewGuideModelSelection ?? value.effective.sourceControlWriterModelSelection : value.effective.sourceControlWriterModelSelection
    }
    private func source(_ value: String?) -> String {
        switch value {
        case "workspace": "此 Workspace"
        case "host": "主机设置"
        case "fallback": "已启用的 Provider"
        case "text_generation": "跟随文字生成模型"
        case "source_control": "跟随提交与 PR 说明模型"
        default: "默认设置"
        }
    }
    private func modelRow(_ field: TextGenerationField, snapshot: TextGenerationSettingsSnapshot) -> some View {
        let owner = state.token
        let selection = selected(field, snapshot)
        let model = states[selection.providerInstanceId ?? selection.agent]?.models.first { $0.id == selection.model }
        let efforts = model?.reasoningEfforts ?? []
        return SettingsRow(field.title, detail: source(snapshot.sources[field.rawValue])) {
            VStack(alignment: .trailing, spacing: 10) {
                HStack(spacing: 8) {
                    Button { picking = field } label: {
                        HStack(spacing: 7) {
                            AgentProviderIcon(provider: selection.agent, size: 16)
                            Text(model?.selectionName ?? selection.model).lineLimit(2)
                            FridaySymbolImage(systemName: "chevron.down").font(.system(size: 9))
                        }
                    }.buttonStyle(FridayButtonStyle(compact: true)).accessibilityLabel(Text(fridayString: field.title))
                    if !efforts.isEmpty {
                        Picker(selection: Binding(get: { selection.reasoningEffort }, set: { effort in
                            guard effort != selection.reasoningEffort else { return }
                            var next = selection; next.reasoningEffort = effort; save(changes: [field.rawValue: next.body], ownerToken: owner)
                        })) {
                            Text(friday: "模型默认").tag("")
                            ForEach(efforts, id: \.self) { effort in Text(effort.capitalized).tag(effort) }
                            if !selection.reasoningEffort.isEmpty && !efforts.contains(selection.reasoningEffort) { Text(selection.reasoningEffort).tag(selection.reasoningEffort) }
                        } label: { Text(friday: "推理强度") }.labelsHidden().fridayInteractiveCursor()
                    }
                }
                HStack(spacing: 12) {
                    if field != .titles {
                        Button(friday: field == .guide ? "跟随提交与 PR 说明模型" : "跟随文字生成模型") { save(changes: [field.rawValue: NSNull()], ownerToken: owner) }
                            .buttonStyle(FridayButtonStyle(compact: true))
                    }
                    if projectID != nil {
                        let overridden = field == .titles ? snapshot.overrides.textGenerationModelSelection != nil : field == .guide ? snapshot.overrides.hasReviewGuideOverride : snapshot.overrides.hasSourceControlWriterOverride
                        if overridden { Button(friday: "使用主机设置") { save(reset: [field.rawValue], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
                    } else if field == .titles {
                        Button(friday: "恢复默认模型") { save(reset: [field.rawValue], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }
            }.frame(maxWidth: 340, alignment: .trailing)
        }
    }

    private func guideSettings(_ snapshot: TextGenerationSettingsSnapshot) -> some View {
        let owner = state.token
        return SettingsGroup("审查 Guide") {
            if projectID == nil {
                SettingsRow("启用审查 Guide", detail: "让模型只读调查 PR／MR，并生成按阅读顺序组织的代码导览。") {
                    Toggle(isOn: Binding(get: { snapshot.effective.reviewGuidesEnabled ?? false }, set: { save(changes: ["reviewGuidesEnabled": $0], ownerToken: owner) })) { Text(friday: "启用审查 Guide") }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }
                SettingsDivider()
            }
            modelRow(.guide, snapshot: snapshot)
            SettingsDivider()
            VStack(alignment: .leading, spacing: 10) {
                Text(friday: "Guide 阅读偏好").font(.callout.weight(.medium))
                TextEditor(text: $guideInstructions).font(.body).frame(minHeight: 90, maxHeight: 150).focused($editingGuide).accessibilityLabel(Text(friday: "Guide 阅读偏好"))
                    .onChange(of: editingGuide) { _, value in if !value, guideInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != (snapshot.effective.reviewGuideInstructions ?? "") { save(changes: ["reviewGuideInstructions": guideInstructions], ownerToken: owner) } }
                HStack {
                    if projectID != nil, snapshot.overrides.reviewGuideInstructions != nil { Button(friday: "使用主机设置") { save(reset: ["reviewGuideInstructions"], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
                    Spacer()
                    if guideInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != (snapshot.effective.reviewGuideInstructions ?? "") { Button(friday: "保存说明") { save(changes: ["reviewGuideInstructions": guideInstructions], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
                }
            }.padding(16)
        }
    }

    private func writingStyle(_ snapshot: TextGenerationSettingsSnapshot) -> some View {
        let owner = state.token
        let key = "sourceControlWritingStyle"
        let style = snapshot.effective.sourceControlWritingStyle ?? .standard
        let detail = style.mode == "conventional_commits" ? "提交标题使用 Conventional Commits 前缀；PR 标题保持简洁。" : style.mode == "custom" ? "将自定义说明用于提交与 PR 的文字生成。" : "参考仓库最近的提交标题和本地说明，沿用已有写作习惯。"
        return SettingsGroup("Source Control 写作") {
            SettingsRow("写作风格", detail: detail) {
                VStack(alignment: .trailing, spacing: 10) {
                    Picker(selection: Binding(get: { style.mode }, set: { mode in save(changes: [key: ["mode": mode]], ownerToken: owner) })) {
                        Text(friday: "仓库惯例").tag("repo_conventions")
                        Text("Conventional Commits").tag("conventional_commits")
                        Text(friday: "自定义说明").tag("custom")
                    } label: { Text(friday: "写作风格") }.labelsHidden().fridayInteractiveCursor()
                    Text(fridayString: source(snapshot.sources[key])).font(.caption).foregroundStyle(.secondary)
                    if projectID != nil {
                        if snapshot.overrides.sourceControlWritingStyle != nil {
                            Button(friday: "使用主机设置") { save(reset: [key], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true))
                        }
                    } else if style != .standard {
                        Button(friday: "恢复默认风格") { save(reset: [key], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }.frame(maxWidth: 340, alignment: .trailing)
            }
            if style.mode == "custom" {
                SettingsDivider()
                VStack(alignment: .leading, spacing: 10) {
                    Text(friday: "自定义说明").font(.callout.weight(.medium))
                    TextEditor(text: $customInstructions).font(.body).frame(minHeight: 110, maxHeight: 180)
                        .focused($editingInstructions).accessibilityLabel(Text(friday: "自定义说明"))
                        .onChange(of: editingInstructions) { _, focused in
                            if !focused, customInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != style.customInstructions {
                                save(changes: [key: ["customInstructions": customInstructions]], ownerToken: owner)
                            }
                        }
                    if customInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != style.customInstructions {
                        HStack { Spacer(); Button(friday: "保存说明") { save(changes: [key: ["customInstructions": customInstructions]], ownerToken: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
                    }
                }.padding(16)
            }
            SettingsDivider()
            SettingsRow("遵循 PR 模板", detail: "使用目标分支中的仓库 PR 模板填写说明。") {
                Toggle(isOn: Binding(get: { style.followChangeRequestTemplates }, set: { value in save(changes: [key: ["followChangeRequestTemplates": value]], ownerToken: owner) })) { Text(friday: "遵循 PR 模板") }
                    .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
            }
        }
    }

    private func load() async {
        let identity = identity; let project = projectID; let token = state.begin(identity: identity, projectID: project); let connection = store.connection
        picking = nil; failure = nil; states = [:]; editingInstructions = false; customInstructions = ""
        do {
            var query = URLComponents(); if let project { query.queryItems = [URLQueryItem(name: "projectId", value: project)] }
            let path = "/api/text-generation/settings" + (query.percentEncodedQuery.map { "?" + $0 } ?? "")
            let request = try connection.request(path)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            if (response as? HTTPURLResponse)?.statusCode == 404 { throw ConnectionError.message("当前主机不支持文字生成设置") }
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw ConnectionError.message((try? JSONDecoder().decode(APIError.self, from: data).error) ?? "无法读取文字生成设置") }
            let snapshot = try JSONDecoder().decode(TextGenerationSettingsSnapshot.self, from: data)
            guard state.accept(snapshot, token: token, identity: self.identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
            customInstructions = (snapshot.effective.sourceControlWritingStyle ?? .standard).customInstructions
            guideInstructions = snapshot.effective.reviewGuideInstructions ?? ""
            await store.loadProviderInstances()
            for instance in store.providerInstances.filter({ $0.driver != "acp-registry" && $0.enabled }) {
                guard state.current(token, identity: self.identity, projectID: projectID) else { return }
                if let value = try? await connection.decode(CodexConnectionState.self, TaskProviderCatalog.endpoint(instance.driver, instance: instance.id)), state.current(token, identity: self.identity, projectID: projectID) { states[instance.id] = value }
            }
            if state.current(token, identity: self.identity, projectID: projectID), state.shouldReload(store.textGenerationSettingsVersion) { await load() }
        } catch { if state.finish(token, identity: self.identity) { failure = error.localizedDescription } }
    }

    private func save(changes: [String: Any] = [:], reset: [String] = [], ownerToken: UUID) {
        guard let snapshot = state.snapshot, let token = state.beginSave(ownerToken: ownerToken) else { return }
        let identity = identity; let project = projectID; let connection = store.connection
        var changes = changes
        let styleKey = "sourceControlWritingStyle"
        // A model or style control may blur the editor before its callback can
        // save. Include that draft in the same versioned write, preserving IME.
        if !reset.contains(styleKey), customInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != (snapshot.effective.sourceControlWritingStyle ?? .standard).customInstructions {
            var style = changes[styleKey] as? [String: Any] ?? [:]; style["customInstructions"] = customInstructions; changes[styleKey] = style
        }
        if !reset.contains("reviewGuideInstructions"), guideInstructions.trimmingCharacters(in: .whitespacesAndNewlines) != (snapshot.effective.reviewGuideInstructions ?? "") { changes["reviewGuideInstructions"] = guideInstructions }
        let body: [String: Any] = ["projectId": project as Any? ?? NSNull(), "expectedVersion": snapshot.version, "changes": changes, "reset": reset]
        failure = nil
        Task { @MainActor in
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            do {
                let next = try await connection.decode(TextGenerationSettingsSnapshot.self, "/api/text-generation/settings", method: "PATCH", body: body)
                guard state.current(token, identity: self.identity, projectID: projectID) else { return }
                guard state.accept(next, token: token, identity: identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
                customInstructions = (next.effective.sourceControlWritingStyle ?? .standard).customInstructions
                guideInstructions = next.effective.reviewGuideInstructions ?? ""
                await store.refresh()
                if state.current(token, identity: self.identity, projectID: projectID), state.shouldReload(store.textGenerationSettingsVersion) { await load() }
            } catch { if state.finish(token, identity: self.identity) { failure = error.localizedDescription } }
        }
    }
}
