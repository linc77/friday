import SwiftUI

struct ProjectScriptsSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var scope: String
    @State private var snapshot: ProjectScriptSettingsSnapshot?
    @State private var scripts: [ProjectScript] = []
    @State private var keybindings: [String: String] = [:]
    @State private var inherited = false
    @State private var busy = false
    @State private var error: String?
    @State private var request = UUID()
    @State private var pending: [String: Any]?
    @State private var imports: [ProjectScript]?
    init(store: FridayStore, initialProjectId: String? = nil) { self.store = store; _scope = State(initialValue: initialProjectId ?? "") }
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + scope }
    private var editable: Bool { !busy && pending == nil && store.connected && snapshot != nil }
    private var dirty: Bool { snapshot.map { scripts != $0.scripts || keybindings.filter { !$0.value.isEmpty } != ($0.keybindings ?? [:]) || inherited != ($0.source == "default" && !scope.isEmpty) } ?? false }
    var body: some View {
        SettingsPage(title: "项目脚本", subtitle: "在任务终端运行常用命令，也可在创建 Worktree 或收起任务时运行。") {
            SettingsGroup("设置范围") {
                SettingsRow("应用到") {
                    Picker(selection: $scope) { Text(friday: "此主机").tag(""); ForEach(store.projects) { Text($0.name).tag($0.id) } } label: { Text(friday: "设置范围") }
                        .labelsHidden().fridayInteractiveCursor().disabled(busy || pending != nil)
                }
                if !scope.isEmpty {
                    SettingsDivider()
                    SettingsRow("使用主机脚本") { Toggle(isOn: $inherited) { Text(friday: "使用主机脚本") }.labelsHidden().fridayInteractiveCursor() }
                        .disabled(!editable)
                }
            }
            ProjectScriptActivityGroup(store: store, projectID: scope.isEmpty ? nil : scope)
            if inherited && !scope.isEmpty {
                Text(friday: "此 Workspace 使用主机脚本；关闭继承后可单独编辑或清空。").font(.caption).foregroundStyle(.secondary)
            }
            ForEach($scripts) { $script in
                ProjectScriptEditor(script: $script, shortcut: Binding(get: { keybindings[script.id] ?? "" }, set: { keybindings[script.id] = $0 }), claim: { setup, enabled in ProjectScript.claimRole(script.id, setup: setup, enabled: enabled, in: &scripts) }, remove: { scripts.removeAll { $0.id == script.id }; keybindings.removeValue(forKey: script.id) })
                    .disabled(!editable || inherited && !scope.isEmpty)
            }
            HStack {
                Button(friday: "添加脚本", systemImage: "plus") { scripts.append(ProjectScript()) }.disabled(!editable || inherited && !scope.isEmpty || scripts.count >= 50)
                if !scope.isEmpty { Button(friday: "从 t3.json 导入") { Task { await readImports() } }.disabled(!editable || inherited) }
                Spacer()
                Button(friday: pending == nil ? "保存" : "核对保存结果") { save() }
                    .buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || !store.connected || snapshot == nil || pending == nil && (!dirty || !inherited && !scripts.allSatisfy(\.valid)))
            }
            if let imports {
                SettingsGroup("可导入脚本") {
                    ForEach(imports) { value in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { Text(value.name).font(.headline); Spacer(); Button(friday: "导入") { scripts.append(value); self.imports?.removeAll { $0.id == value.id } }.disabled(!editable || scripts.count >= 50) }
                            Text(verbatim: value.command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        }.padding(14)
                    }
                }
            }
            if busy { Text(friday: "正在同步设置…").font(.caption).foregroundStyle(.secondary) }
            if let error { HStack(alignment: .top) { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled); Spacer(); Button(friday: "重新加载") { pending = nil; Task { await load() } }.disabled(busy) } }
        }
        .task(id: identity) { await load() }
        .onChange(of: store.projects.map(\.id)) { _, ids in if !scope.isEmpty && !ids.contains(scope) { scope = "" } }
    }
    private func accept(_ value: ProjectScriptSettingsSnapshot) {
        snapshot = value; scripts = value.scripts; keybindings = value.keybindings ?? [:]; inherited = value.source == "default" && !scope.isEmpty; pending = nil
    }
    private func load() async {
        let owner = UUID(), context = identity, connection = store.connection, project = scope; request = owner; busy = true; snapshot = nil; error = nil; imports = nil; pending = nil
        do {
            var query = URLComponents(); if !project.isEmpty { query.queryItems = [URLQueryItem(name: "projectId", value: project)] }
            let value = try await connection.decode(ProjectScriptSettingsSnapshot.self, "/api/project-scripts/settings" + (query.percentEncodedQuery.map { "?" + $0 } ?? ""))
            guard request == owner, identity == context else { return }; accept(value)
        } catch { if request == owner && identity == context { self.error = error.localizedDescription } }
        if request == owner && identity == context { busy = false }
    }
    private func save() {
        guard !busy, let snapshot, store.connected else { return }
        let ids = Set(scripts.map(\.id) + snapshot.scripts.map(\.id))
        let keys = Dictionary(uniqueKeysWithValues: ids.map { id in (id, (keybindings[id]?.isEmpty == false ? keybindings[id] as Any? : nil) ?? NSNull()) })
        let body = pending ?? ["projectId": scope.isEmpty ? NSNull() : scope as Any, "version": snapshot.version, "requestId": UUID().uuidString, "scripts": inherited && !scope.isEmpty ? NSNull() : scripts.map(\.body) as Any, "keybindings": keys]
        pending = body; busy = true; error = nil; let owner = request, context = identity, connection = store.connection
        Task { @MainActor in
            guard request == owner, identity == context else { return }
            do {
                let value = try await connection.decode(ProjectScriptSettingsSnapshot.self, "/api/project-scripts/settings", method: "PATCH", body: body)
                guard request == owner, identity == context else { return }; accept(value)
            } catch { if request == owner && identity == context { self.error = error.localizedDescription } }
            if request == owner && identity == context { busy = false }
        }
    }
    private func readImports() async {
        let context = identity, connection = store.connection, project = scope; busy = true; error = nil
        do {
            let value = try await connection.decode(ProjectScriptImport.self, "/api/projects/\(project)/scripts/import")
            guard identity == context else { return }; imports = value.scripts.filter { file in !scripts.contains { $0.command == file.command || $0.name.lowercased() == file.name.lowercased() } }
        } catch { if identity == context { self.error = error.localizedDescription } }
        if identity == context { busy = false }
    }
}

private struct ProjectScriptEditor: View {
    @Binding var script: ProjectScript
    @Binding var shortcut: String
    let claim: (Bool, Bool) -> Void
    let remove: () -> Void
    var body: some View {
        SettingsGroup("脚本") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Picker(selection: $script.icon) { ForEach(["play","test","lint","configure","build","debug"], id: \.self) { Text($0).tag($0) } } label: { Text(friday: "图标") }.frame(width: 130).fridayInteractiveCursor()
                    TextField(friday: "脚本名称", text: $script.name).textFieldStyle(.roundedBorder)
                    Button(action: remove) { FridaySymbolImage(systemName: "trash") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "删除脚本"))
                }
                TextEditor(text: $script.command).font(.system(.body, design: .monospaced)).frame(minHeight: 90).padding(6).overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
                ProjectScriptShortcutField(value: $shortcut)
                Toggle(isOn: Binding(get: { script.runOnWorktreeCreate }, set: { claim(true, $0) })) { Text(friday: "创建 Worktree 时运行") }.fridayInteractiveCursor()
                if script.runOnWorktreeCreate { Toggle(isOn: Binding(get: { script.async == false }, set: { script.async = !$0 })) { Text(friday: "等待初始化脚本结束再启动 Agent") }.fridayInteractiveCursor() }
                Toggle(isOn: Binding(get: { script.runOnSettle == true }, set: { claim(false, $0) })) { Text(friday: "收起 Worktree 任务时运行") }.fridayInteractiveCursor()
                TextField(friday: "预览地址（可选）", text: Binding(get: { script.previewUrl ?? "" }, set: { script.previewUrl = $0.isEmpty ? nil : $0 })).textFieldStyle(.roundedBorder)
                if script.previewUrl?.isEmpty == false { Toggle(isOn: Binding(get: { script.autoOpenPreview == true }, set: { script.autoOpenPreview = $0 })) { Text(friday: "运行后打开网页预览") }.fridayInteractiveCursor() }
            }.padding(16)
        }
    }
}
