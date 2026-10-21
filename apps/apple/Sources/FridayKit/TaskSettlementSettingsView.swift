import SwiftUI

struct TaskSettlementSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var scope = ""
    @State private var state = TaskSettlementSettingsState()
    @State private var draft = ""
    @State private var failure: String?
    @FocusState private var editingDays: Bool
    private var projectID: String? { scope.isEmpty ? nil : scope }
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") }
    private var context: String { identity + "\n" + scope }
    private let key = "sidebarAutoSettleAfterDays"

    var body: some View {
        SettingsGroup("自动结束跟进") {
            SettingsRow("应用到") {
                Picker(selection: $scope) {
                    Text(friday: "此主机").tag("")
                    ForEach(store.projects) { project in Text(project.name).tag(project.id) }
                } label: { Text(friday: "设置范围") }.labelsHidden().fridayInteractiveCursor()
            }
            if let snapshot = state.snapshot {
                let owner = state.token
                let days = snapshot.effective.sidebarAutoSettleAfterDays
                SettingsDivider()
                SettingsRow("自动结束不活跃任务", detail: "由主机服务处理；关闭窗口后继续生效。") {
                    Toggle(isOn: Binding(get: { days != nil }, set: { value in save(days: value ? 3 : nil, owner: owner) })) { Text(friday: "自动结束不活跃任务") }
                        .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }.disabled(state.busy || !store.connected)
                if days != nil {
                    SettingsDivider()
                    SettingsRow("无活动天数", detail: "输入 1–90 天，回车或结束编辑时保存；新活动会恢复自动判断。") {
                        HStack(spacing: 8) {
                            TextField(friday: "天数", text: $draft).frame(width: 72).textFieldStyle(.roundedBorder)
                                .focused($editingDays).onSubmit { editingDays = false; commitDays(owner: owner) }
                                .onChange(of: editingDays) { _, value in if !value { commitDays(owner: owner) } }
                            Text(friday: "天").foregroundStyle(.secondary)
                        }
                    }.disabled(state.busy || !store.connected)
                }
                SettingsDivider()
                SettingsRow("PR 合并后自动结束", detail: "所有有效关联均已合并或关闭，且没有更新的用户要求时结束；关闭不活跃计时后仍可生效。") {
                    HStack {
                        Toggle(isOn: Binding(get: { snapshot.effective.sidebarAutoSettleOnMerge ?? true }, set: { save(changes: ["sidebarAutoSettleOnMerge": $0], owner: owner) })) { Text(friday: "PR 合并后自动结束") }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                        resetButton("sidebarAutoSettleOnMerge", overridden: snapshot.overrides.sidebarAutoSettleOnMerge != nil, nondefault: snapshot.defaults.sidebarAutoSettleOnMerge == false, owner: owner)
                    }
                }.disabled(state.busy || !store.connected)
                SettingsDivider()
                SettingsRow("保留关联 PR 的不活跃任务", detail: "有关联 PR／MR 的任务不因时间经过而结束；已确认的合并或关闭仍按终态规则处理。") {
                    HStack {
                        Toggle(isOn: Binding(get: { snapshot.effective.sidebarAutoSettleKeepPullRequests ?? false }, set: { save(changes: ["sidebarAutoSettleKeepPullRequests": $0], owner: owner) })) { Text(friday: "保留关联 PR 的不活跃任务") }.labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                        resetButton("sidebarAutoSettleKeepPullRequests", overridden: snapshot.overrides.sidebarAutoSettleKeepPullRequests != nil, nondefault: snapshot.defaults.sidebarAutoSettleKeepPullRequests == true, owner: owner)
                    }
                }.disabled(state.busy || !store.connected)
                SettingsDivider()
                SettingsRow("设置来源", detail: snapshot.source == "workspace" ? "此 Workspace" : snapshot.source == "host" ? "主机设置" : "默认设置") {
                    if projectID != nil {
                        if snapshot.overrides.hasDaysOverride { Button(friday: "使用主机设置") { save(reset: true, owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
                    } else if snapshot.defaults.sidebarAutoSettleAfterDays != 3 {
                        Button(friday: "恢复默认") { save(reset: true, owner: owner) }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }.disabled(state.busy || !store.connected)
            }
            if state.busy { Text(friday: "正在同步设置…").font(.caption).foregroundStyle(.secondary).padding(16) }
            if let failure {
                HStack(alignment: .top) {
                    Text(fridayString: failure).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
                    Spacer()
                    Button(friday: "重新加载") { Task { await load() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(state.busy || !store.connected)
                }.padding(16)
            }
        }
        .task(id: context) { await load() }
        .onChange(of: store.taskSettlementSettingsVersion) { _, version in if state.shouldReload(version) { Task { await load() } } }
        .onChange(of: store.connected) { _, connected in if connected && state.snapshot == nil && !state.busy { Task { await load() } } }
        .onChange(of: store.projects.map(\.id)) { _, ids in if !scope.isEmpty && !ids.contains(scope) { scope = "" } }
    }
    private func dayText(_ value: Double?) -> String { value.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? "" }
    private func commitDays(owner: UUID) {
        guard store.connected, state.current(owner, identity: identity, projectID: projectID), let snapshot = state.snapshot else { return }
        guard let value = Double(draft.trimmingCharacters(in: .whitespacesAndNewlines)), value.isFinite, value.rounded() == value, (1...90).contains(value) else {
            draft = dayText(snapshot.effective.sidebarAutoSettleAfterDays); return
        }
        if snapshot.effective.sidebarAutoSettleAfterDays != value { save(days: value, owner: owner) }
    }
    private func load() async {
        let identity = identity; let project = projectID; let connection = store.connection; let token = state.begin(identity: identity, projectID: project)
        failure = nil; editingDays = false; draft = ""
        do {
            var parameters = URLComponents(); if let project { parameters.queryItems = [URLQueryItem(name: "projectId", value: project)] }
            let path = "/api/task-settlement/settings" + (parameters.percentEncodedQuery.map { "?" + $0 } ?? "")
            let snapshot = try await connection.decode(TaskSettlementSettingsSnapshot.self, path)
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            guard state.accept(snapshot, token: token, identity: self.identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
            draft = dayText(snapshot.effective.sidebarAutoSettleAfterDays)
            if state.shouldReload(store.taskSettlementSettingsVersion) { await load() }
        } catch { if state.finish(token, identity: self.identity) { failure = error.localizedDescription } }
    }
    private func save(days: Double? = nil, reset: Bool = false, owner: UUID) {
        save(changes: reset ? [:] : [key: days as Any? ?? NSNull()], reset: reset ? [key] : [], owner: owner)
    }
    @ViewBuilder private func resetButton(_ field: String, overridden: Bool, nondefault: Bool, owner: UUID) -> some View {
        if projectID != nil, overridden { Button(friday: "使用主机设置") { save(changes: [:], reset: [field], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
        else if projectID == nil, nondefault { Button(friday: "恢复默认") { save(changes: [:], reset: [field], owner: owner) }.buttonStyle(FridayButtonStyle(compact: true)) }
    }
    private func save(changes: [String: Any], reset: [String] = [], owner: UUID) {
        guard store.connected, let snapshot = state.snapshot, let token = state.beginSave(ownerToken: owner) else { return }
        let identity = identity; let project = projectID; let connection = store.connection
        let body: [String: Any] = ["projectId": project as Any? ?? NSNull(), "expectedVersion": snapshot.version,
            "changes": changes, "reset": reset]
        failure = nil
        Task { @MainActor in
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            do {
                let next = try await connection.decode(TaskSettlementSettingsSnapshot.self, "/api/task-settlement/settings", method: "PATCH", body: body)
                guard state.current(token, identity: self.identity, projectID: projectID) else { return }
                guard state.accept(next, token: token, identity: identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
                draft = dayText(next.effective.sidebarAutoSettleAfterDays); await store.refresh()
                if state.current(token, identity: self.identity, projectID: projectID), state.shouldReload(store.taskSettlementSettingsVersion) { await load() }
            } catch { if state.finish(token, identity: self.identity) { failure = error.localizedDescription } }
        }
    }
}
