import SwiftUI

private struct PersonalWorkspaceState: Decodable {
    let path: String
    let version: Int
}

struct PersonalWorkspaceSettings: View {
    @Bindable var store: FridayStore
    @State private var state: PersonalWorkspaceState?
    @State private var path = ""
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?

    private var editable: Bool { store.connected && store.deviceId == "owner" && state != nil && !busy }

    var body: some View {
        SettingsGroup("Friday Workspace") {
            VStack(alignment: .leading, spacing: 12) {
                Text(friday: "Friday 放置日常文件的默认目录，也用于解析相对路径。Friday 可以访问主机上的其他目录。")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                TextField(friday: "主机上的目录路径", text: $path)
                    .textFieldStyle(.roundedBorder).disabled(!editable)
                    .accessibilityLabel(Text(friday: "Friday 默认 Workspace"))
                Text(friday: "填写已存在的目录，可使用 ~/。保存后从下一轮对话生效；已关联项目的对话继续使用项目目录。已有文件不会自动搬迁。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button(friday: "重新加载") { Task { await refresh() } }
                        .buttonStyle(FridayButtonStyle(compact: true)).disabled(!store.connected || busy)
                    Spacer()
                    Button(friday: "保存 Workspace") { save() }
                        .buttonStyle(FridayButtonStyle(compact: true))
                        .disabled(!editable || path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || path == state?.path)
                }
                if store.deviceId != "owner" {
                    Text(friday: "请在主机上修改默认 Workspace，所有已连接设备共用此设置。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let notice { Text(fridayString: notice).font(.caption).foregroundStyle(.secondary) }
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled) }
            }.padding(16)
        }
        .task(id: "\(store.connectionIdentity):\(store.connected)") {
            state = nil; path = ""; error = nil; notice = nil; busy = false
            if store.connected { await refresh() }
        }
    }

    private func refresh() async {
        let identity = store.connectionIdentity
        busy = true
        defer { if identity == store.connectionIdentity { busy = false } }
        do {
            let value = try await store.connection.decode(PersonalWorkspaceState.self, "/api/personal-workspace")
            guard identity == store.connectionIdentity, !Task.isCancelled else { return }
            state = value; path = value.path; error = nil; notice = nil
        } catch { if identity == store.connectionIdentity, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func save() {
        guard let state, editable else { return }
        let identity = store.connectionIdentity
        let body: [String: Any] = ["path": path, "expectedVersion": state.version]
        busy = true; error = nil; notice = nil
        Task {
            defer { if identity == store.connectionIdentity { busy = false } }
            do {
                let value = try await store.connection.decode(PersonalWorkspaceState.self, "/api/personal-workspace", method: "PUT", body: body)
                guard identity == store.connectionIdentity else { return }
                self.state = value; path = value.path; notice = "默认 Workspace 已保存。"
            } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
        }
    }
}
