import SwiftUI

struct PreparedProjectScriptControl: View {
    @ObservedObject var store: FridayStore
    let projectID: String; let preparationID: String
    @State private var runID: String?
    @State private var error: String?
    @State private var selected: ProjectScriptIdentifier?
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + projectID + "\n" + preparationID }
    var body: some View {
        VStack(spacing: 6) {
            if let runID { Button(friday: "查看初始化脚本", systemImage: "terminal") { selected = ProjectScriptIdentifier(id: runID) }.buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected) }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .sheet(item: $selected) { ProjectScriptRunView(store: store, id: $0.id).id(store.connectionIdentity + "\n" + $0.id) }
        .task(id: identity) {
            let context = identity; runID = nil; error = nil; selected = nil
            while !Task.isCancelled && identity == context {
                if store.connected {
                    do {
                        let value = try await store.connection.decode(TaskChangeRequestCheckoutReceipt.self, "/api/projects/\(projectID)/change-request/preparations/\(preparationID)")
                        guard !Task.isCancelled, context == identity, value.projectId == projectID, value.id == preparationID else { return }
                        runID = value.setupRunId; error = value.error
                        if !value.active { return }
                    } catch { if context == identity { self.error = error.localizedDescription } }
                }
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
    }
}

struct ProjectScriptActivityGroup: View {
    @ObservedObject var store: FridayStore
    let projectID: String?
    @State private var runs: [ProjectScriptRun] = []
    @State private var selected: ProjectScriptIdentifier?
    @State private var error: String?
    private var identity: String { store.connectionIdentity + "\n" + (store.taskStreamSession ?? "legacy") + "\n" + (projectID ?? "") }
    var body: some View {
        Group {
            if !runs.isEmpty {
                SettingsGroup("脚本终端") {
                    ForEach(runs) { run in
                        SettingsRow(verbatim: run.script.name) {
                            Text(fridayString: run.label).font(.caption).foregroundStyle(.secondary)
                            Button(friday: "查看输出") { selected = ProjectScriptIdentifier(id: run.id) }.buttonStyle(FridayButtonStyle(compact: true))
                        }
                    }
                }
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
        }
        .sheet(item: $selected) { ProjectScriptRunView(store: store, id: $0.id).id(store.connectionIdentity + "\n" + $0.id) }
        .task(id: identity) {
            let context = identity; runs = []; selected = nil; error = nil
            while !Task.isCancelled && context == identity {
                if store.connected {
                    do {
                        var query = URLComponents(); if let projectID { query.queryItems = [URLQueryItem(name: "projectId", value: projectID)] }
                        let value = try await store.connection.decode(ProjectScriptRunsSnapshot.self, "/api/project-scripts/runs" + (query.percentEncodedQuery.map { "?" + $0 } ?? ""))
                        guard context == identity, !Task.isCancelled else { return }; runs = value.runs; error = nil
                    } catch { if context == identity && !Task.isCancelled { self.error = error.localizedDescription } }
                }
                do { try await Task.sleep(for: .seconds(3)) } catch { break }
            }
        }
    }
}
