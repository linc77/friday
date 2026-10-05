import SwiftUI
#if os(macOS)
import AppKit
#endif

struct ProjectsView: View {
    @ObservedObject var store: FridayStore
    @State private var adding = false
    @State private var editing: Project?
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { VStack(alignment: .leading, spacing: 6) { Text("项目").font(.largeTitle.bold()); Text("把主机目录和项目背景放在一起。").foregroundStyle(.secondary) }; Spacer(); Button("添加项目") { adding = true }.buttonStyle(.borderedProminent).disabled(!store.connected) }
            if store.projects.isEmpty { EmptyPanel(icon: "folder", title: "先关联一个项目", subtitle: "代码任务会在你选择的主机目录中执行。") }
            List(store.projects) { project in
                Button { editing = project } label: {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(project.name, systemImage: "folder").font(.headline)
                        Text(project.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        if !project.context.isEmpty { Text(project.context).font(.callout).lineLimit(3).foregroundStyle(.secondary) }
                    }.padding(.vertical, 10).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.plain)
            }.listStyle(.plain)
        }.padding(24)
        .sheet(isPresented: $adding) { ProjectEditor(store: store, project: nil) }
        .sheet(item: $editing) { ProjectEditor(store: store, project: $0) }
    }
}

struct ProjectEditor: View {
    @ObservedObject var store: FridayStore
    let project: Project?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var path = ""
    @State private var context = ""
    @State private var busy = false
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text(project == nil ? "添加项目" : "项目背景").font(.title2.bold()); Spacer(); Button("取消") { dismiss() } }
            TextField("项目名称", text: $name).textFieldStyle(.roundedBorder)
            HStack {
                TextField("主机上的绝对目录", text: $path).textFieldStyle(.roundedBorder).disabled(project != nil)
                #if os(macOS)
                if project == nil { Button("选择目录") { let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; if panel.runModal() == .OK, let url = panel.url { path = url.path; if name.isEmpty { name = url.lastPathComponent } } } }
                #endif
            }
            Text("项目背景与约定").font(.headline)
            TextEditor(text: $context).frame(minHeight: 150).padding(8).overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            Text("目标、当前进展、你的偏好。每次关联该项目的任务都会读取这些内容。").font(.caption).foregroundStyle(.secondary)
            if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange) }
            HStack { Spacer(); Button("保存项目") {
                busy = true
                Task { if await store.perform(project.map { "/api/projects/\($0.id)" } ?? "/api/projects", method: project == nil ? "POST" : "PUT", body: ["name": name, "path": path, "context": context]) { dismiss() }; busy = false }
            }.buttonStyle(.borderedProminent).disabled(busy || name.isEmpty || path.isEmpty || !store.connected) }
        }.padding(26)
        #if os(macOS)
        .frame(width: 560)
        #endif
        .onAppear { if let project { name = project.name; path = project.path; context = project.context } }
    }
}

struct MemoriesView: View {
    @ObservedObject var store: FridayStore
    @State private var draft = ""
    @State private var editingId: String?
    @State private var busy = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("记住你明确告诉我的事").font(.largeTitle.bold())
                Text("你的偏好、工作方式和长期背景。你可以随时修改或删除；Friday 会在任务开始时读取。").foregroundStyle(.secondary)
                TextEditor(text: $draft).frame(minHeight: 90).padding(10).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary)).accessibilityLabel("长期记忆")
                HStack { if editingId != nil { Button("取消编辑") { draft = ""; editingId = nil } }; Spacer(); Button(editingId == nil ? "记住这件事" : "保存修改") {
                    busy = true; var body: [String: Any] = ["text": draft]; if let editingId { body["id"] = editingId }
                    Task { if await store.perform("/api/memories", body: body) { draft = ""; editingId = nil }; busy = false }
                }.buttonStyle(.borderedProminent).disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected) }
                ForEach(store.memories) { memory in
                    HStack(alignment: .top, spacing: 14) {
                        Image(systemName: "sparkles").foregroundStyle(.secondary)
                        Text(memory.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Menu { Button("编辑") { draft = memory.text; editingId = memory.id }; Button("删除", role: .destructive) { Task { _ = await store.perform("/api/memories/\(memory.id)", method: "DELETE") } } } label: { Image(systemName: "ellipsis") }
                    }.padding(18).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 12))
                }
            }.padding(28).frame(maxWidth: 850).frame(maxWidth: .infinity)
        }
    }
}

struct AgentsView: View {
    @ObservedObject var store: FridayStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                Text("Friday 的执行工具").font(.largeTitle.bold())
                Text("使用主机上已有的工具和登录状态。第一版通过 Codex 处理任务。").foregroundStyle(.secondary)
                ForEach(store.agents) { agent in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { Label(agent.name, systemImage: "terminal").font(.headline); Spacer(); Text(agent.installed ? (agent.executableSupported ? "可以执行任务" : "已发现 · 尚未接入") : "未安装").font(.caption).foregroundStyle(agent.installed && agent.executableSupported ? .green : .secondary) }
                        Text(agent.description).font(.callout).foregroundStyle(.secondary)
                        if let executable = agent.executable { Text(executable).font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled) }
                    }.padding(20).background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14))
                }
                Button("重新检测") { Task { await store.refresh() } }.disabled(!store.connected)
            }.padding(28).frame(maxWidth: 850).frame(maxWidth: .infinity)
        }
    }
}

struct ConnectionView: View {
    @ObservedObject var store: FridayStore
    @State private var server = ""
    @State private var code = ""
    @State private var name = ""
    @State private var pairing: PairingCode?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("随时找到 Friday").font(.largeTitle.bold())
                Label(store.connected ? "已连接主机" : "主机暂时离线", systemImage: store.connected ? "checkmark.circle.fill" : "wifi.slash").foregroundStyle(store.connected ? .green : .orange)
                Text(store.connection.server).font(.callout.monospaced()).textSelection(.enabled)
                Text("任务在主机上执行。关闭客户端不影响任务；主机需要保持运行。").foregroundStyle(.secondary)
                Button("重新连接") { Task { await store.connect() } }
                if store.deviceId == "owner" {
                    Divider()
                    Text("连接另一台设备").font(.title3.bold())
                    Text("先为主机配置可访问的 HTTPS 地址，例如 Tailscale Serve。然后在另一台设备填写地址和一次性配对码。").font(.callout).foregroundStyle(.secondary)
                    Button("生成配对码") {
                        Task { do { pairing = try await store.connection.decode(PairingCode.self, "/api/pairing", method: "POST", body: [:]); error = nil } catch { self.error = error.localizedDescription } }
                    }.buttonStyle(.borderedProminent).disabled(!store.connected)
                    if let pairing { VStack(alignment: .leading, spacing: 6) { Text(pairing.code).font(.system(size: 36, weight: .medium, design: .monospaced)).textSelection(.enabled); Text("5 分钟内有效，只能使用一次。").font(.caption).foregroundStyle(.secondary) } }
                    ForEach(store.devices) { device in
                        HStack {
                            Label(device.name, systemImage: "iphone"); Spacer()
                            Button("撤销访问", role: .destructive) { Task { _ = await store.perform("/api/devices/\(device.id)", method: "DELETE") } }
                        }
                    }
                }
                Divider()
                Text("配对到主机").font(.title3.bold())
                TextField("https://你的主机地址", text: $server).textFieldStyle(.roundedBorder)
                TextField("设备名称", text: $name).textFieldStyle(.roundedBorder)
                TextField("6 位配对码", text: $code).textFieldStyle(.roundedBorder)
                if let error = error ?? store.error { Text(error).font(.caption).foregroundStyle(.orange) }
                Button("连接") { busy = true; Task { do { try await store.pair(server: server, code: code, name: name); code = ""; error = nil } catch { self.error = error.localizedDescription }; busy = false } }.buttonStyle(.borderedProminent).disabled(busy || server.isEmpty || name.isEmpty || code.count != 6)
            }.padding(28).frame(maxWidth: 760).frame(maxWidth: .infinity)
        }.onAppear {
            server = store.connection.server
            #if os(macOS)
            name = Host.current().localizedName ?? "我的 Mac"
            #else
            name = "我的 iPhone"
            #endif
        }
    }
}
