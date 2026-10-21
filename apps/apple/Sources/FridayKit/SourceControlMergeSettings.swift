import SwiftUI

struct SourceControlMergeSettings: View {
    @ObservedObject var store: FridayStore
    @State private var scope: String
    @State private var state = ScopedSettingsState<SourceControlPreferencesSnapshot>()
    @State private var error: String?
    init(store: FridayStore, initialProjectID: String? = nil) { self.store = store; _scope = State(initialValue: initialProjectID ?? "") }
    private var projectID: String? { scope.isEmpty ? nil : scope }
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") }
    private var context: String { identity + "\n" + scope }
    var body: some View {
        SettingsGroup("仓库与 Worktree") {
            SettingsRow("应用到") {
                Picker(selection: $scope) { Text(friday: "此主机").tag(""); ForEach(store.projects) { Text($0.name).tag($0.id) } } label: { Text(friday: "设置范围") }
                    .labelsHidden().fridayInteractiveCursor().disabled(state.busy)
            }
            if let snapshot = state.snapshot {
                SettingsDivider()
                SettingsRow("合并时移除 Agent 署名", detail: "仅清理 GitHub merge／squash 消息中的已识别 Agent 行，保留真人共同作者。适用于自动合并；不修改合并队列、Stack 或已有提交。") {
                    Toggle(isOn: Binding(get: { snapshot.effective.removeAgentCreditsOnMerge == true }, set: { value in save(changes: ["removeAgentCreditsOnMerge": value], owner: state.token) })) { Text(friday: "合并时移除 Agent 署名") }
                        .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                }.disabled(state.busy || !store.connected)
                SettingsDivider()
                SettingsRow("设置来源", detail: snapshot.source == "workspace" ? "此 Workspace" : snapshot.source == "host" ? "主机设置" : "默认设置") {
                    if projectID != nil && snapshot.overrides.removeAgentCreditsOnMerge != nil {
                        Button(friday: "使用主机设置") { save(reset: ["removeAgentCreditsOnMerge"], owner: state.token) }.buttonStyle(FridayButtonStyle(compact: true))
                    } else if projectID == nil && snapshot.effective.removeAgentCreditsOnMerge == true {
                        Button(friday: "恢复默认") { save(reset: ["removeAgentCreditsOnMerge"], owner: state.token) }.buttonStyle(FridayButtonStyle(compact: true))
                    }
                }.disabled(state.busy || !store.connected)
                if snapshot.effective.newWorktreesStartFromOrigin != nil {
                    SettingsDivider()
                    SettingsRow("新 Worktree 默认从 origin 开始", detail: "创建前获取基准分支的最新提交，也可在新任务中单独切换。") {
                        Toggle(isOn: Binding(get: { snapshot.effective.newWorktreesStartFromOrigin == true }, set: { save(changes: ["newWorktreesStartFromOrigin": $0], owner: state.token) })) { Text(friday: "新 Worktree 默认从 origin 开始") }
                            .labelsHidden().toggleStyle(.switch).fridayInteractiveCursor()
                    }.disabled(state.busy || !store.connected)
                    SettingsDivider()
                    SettingsRow("子模块初始化", detail: "只在创建 Worktree 时执行，已有目录保持原状。初始化失败显示警告，随后继续运行 setup。") {
                        Picker(selection: Binding(get: { snapshot.effective.worktreeSubmodules ?? "inherit" }, set: { save(changes: ["worktreeSubmodules": $0 == "inherit" ? NSNull() : $0 as Any], owner: state.token) })) {
                            Text(friday: "跟随 t3.json（默认递归）").tag("inherit")
                            Text(friday: "递归初始化").tag("recursive")
                            Text(friday: "仅顶层子模块").tag("top-level")
                            Text(friday: "不初始化").tag("none")
                        } label: { Text(friday: "子模块初始化") }
                            .labelsHidden().fridayInteractiveCursor()
                    }.disabled(state.busy || !store.connected)
                    if projectID != nil && (snapshot.sources?["newWorktreesStartFromOrigin"] == "workspace" || snapshot.sources?["worktreeSubmodules"] == "workspace") {
                        SettingsDivider()
                        SettingsRow("Worktree 设置来源", detail: "此 Workspace") {
                            Button(friday: "使用主机设置") { save(reset: ["newWorktreesStartFromOrigin", "worktreeSubmodules"], owner: state.token) }.buttonStyle(FridayButtonStyle(compact: true))
                        }.disabled(state.busy || !store.connected)
                    }
                }
            }
            if state.busy { Text(friday: "正在同步设置…").font(.caption).foregroundStyle(.secondary).padding(16) }
            if let error {
                HStack(alignment: .top) { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled); Spacer(); Button(friday: "重新加载") { Task { await load() } }.buttonStyle(FridayButtonStyle(compact: true)).disabled(state.busy || !store.connected) }.padding(16)
            }
        }
        .task(id: context) { await load() }
        .onChange(of: store.sourceControlPreferencesVersion) { _, version in if state.shouldReload(version) { Task { await load() } } }
        .onChange(of: store.connected) { _, connected in if connected && state.snapshot == nil && !state.busy { Task { await load() } } }
        .onChange(of: store.projects.map(\.id)) { _, ids in if !scope.isEmpty && !ids.contains(scope) { scope = "" } }
    }
    private func load() async {
        let connection = store.connection, identity = identity, project = projectID, token = state.begin(identity: identity, projectID: project); error = nil
        do {
            var query = URLComponents(); if let project { query.queryItems = [URLQueryItem(name: "projectId", value: project)] }
            let value = try await connection.decode(SourceControlPreferencesSnapshot.self, "/api/source-control/preferences" + (query.percentEncodedQuery.map { "?" + $0 } ?? ""))
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            guard state.accept(value, token: token, identity: self.identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
            if state.shouldReload(store.sourceControlPreferencesVersion) { await load() }
        } catch { if state.finish(token, identity: self.identity) { self.error = error.localizedDescription } }
    }
    private func save(changes: [String: Any] = [:], reset: [String] = [], owner: UUID) {
        guard store.connected, let snapshot = state.snapshot, let token = state.beginSave(ownerToken: owner) else { return }
        let project = projectID, connection = store.connection
        let body: [String: Any] = ["projectId": project as Any? ?? NSNull(), "expectedVersion": snapshot.version, "changes": changes, "reset": reset]; error = nil
        Task { @MainActor in
            guard state.current(token, identity: self.identity, projectID: projectID) else { return }
            do {
                let next = try await connection.decode(SourceControlPreferencesSnapshot.self, "/api/source-control/preferences", method: "PATCH", body: body)
                guard state.current(token, identity: self.identity, projectID: projectID) else { return }
                guard state.accept(next, token: token, identity: self.identity) else { throw ConnectionError.message("主机返回的设置范围或版本无效") }
                await store.refresh(); if state.current(token, identity: self.identity, projectID: projectID) && state.shouldReload(store.sourceControlPreferencesVersion) { await load() }
            } catch { if state.finish(token, identity: self.identity) { self.error = error.localizedDescription } }
        }
    }
}
