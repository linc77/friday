import SwiftUI
#if os(macOS)
import AppKit
#endif

struct ProjectsView: View {
    @ObservedObject var store: FridayStore
    @State private var adding = false
    @State private var editing: Project?
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                HStack(alignment: .top, spacing: 20) {
                    PageHeading(title: "项目", subtitle: "把主机目录和项目背景放在一起。")
                    Button { adding = true } label: { FridaySymbolLabel("添加项目", systemImage: "plus") }
                        .buttonStyle(FridayButtonStyle(prominent: true)).disabled(!store.connected)
                }
                if store.projects.isEmpty {
                    EmptyPanel(icon: "folder", title: "先关联一个项目", subtitle: "代码任务会在你选择的主机目录中执行。")
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 18)], alignment: .leading, spacing: 18) {
                    ForEach(store.projects) { project in
                        Button { editing = project } label: {
                            VStack(alignment: .leading, spacing: 16) {
                                HStack {
                                    FridaySymbolImage(systemName: "folder").font(.system(size: 23, weight: .light))
                                        .foregroundStyle(FridayTheme.accent)
                                        .frame(width: 48, height: 48)
                                        .background(FridayTheme.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 15))
                                    Spacer()
                                    FridaySymbolImage(systemName: "arrow.up.right").font(.caption).foregroundStyle(.tertiary)
                                }
                                Text(project.name).font(.headline).lineLimit(2)
                                Text(project.context.isEmpty ? "添加项目背景，让 Friday 更了解这件事。" : project.context)
                                    .font(.callout).foregroundStyle(.secondary).lineLimit(3)
                                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .topLeading)
                                Text(project.path).font(.caption.monospaced()).foregroundStyle(.tertiary)
                                    .lineLimit(1).truncationMode(.middle)
                            }
                            .padding(22).frame(maxWidth: .infinity, alignment: .leading).fridayCard()
                        }.buttonStyle(ProjectCardStyle())
                    }
                }
            }.padding(28).frame(maxWidth: 960).frame(maxWidth: .infinity)
        }.background(FridayTheme.canvas)
        .sheet(isPresented: $adding) { ProjectEditor(store: store, project: nil) }
        .sheet(item: $editing) { ProjectEditor(store: store, project: $0) }
    }
}

private struct ProjectCardStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(RoundedRectangle(cornerRadius: FridayTheme.cornerRadius))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : FridayTheme.motion, value: configuration.isPressed)
            .fridaySymbolFeedback(active: configuration.isPressed)
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
            }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || name.isEmpty || path.isEmpty || !store.connected) }
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
                PageHeading(title: "记住你明确告诉我的事", subtitle: "你的偏好、工作方式和长期背景。你可以随时修改或删除；Friday 会在任务开始时读取。")
                TextEditor(text: $draft).scrollContentBackground(.hidden).frame(minHeight: 90).padding(16).fridayCard().accessibilityLabel("长期记忆")
                HStack { if editingId != nil { Button("取消编辑") { draft = ""; editingId = nil } }; Spacer(); Button(editingId == nil ? "记住这件事" : "保存修改") {
                    busy = true; var body: [String: Any] = ["text": draft]; if let editingId { body["id"] = editingId }
                    Task { if await store.perform("/api/memories", body: body) { draft = ""; editingId = nil }; busy = false }
                }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected) }
                ForEach(store.memories) { memory in
                    HStack(alignment: .top, spacing: 14) {
                        FridaySymbolImage(systemName: "sparkles").foregroundStyle(.secondary).fridaySymbolFeedback()
                        Text(memory.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Menu { Button("编辑") { draft = memory.text; editingId = memory.id }; Button("删除", role: .destructive) { Task { _ = await store.perform("/api/memories/\(memory.id)", method: "DELETE") } } } label: { FridaySymbolImage(systemName: "ellipsis").fridaySymbolFeedback() }
                    }.padding(20).fridayCard()
                }
            }.padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity)
        }
    }
}

struct AgentsView: View {
    @ObservedObject var store: FridayStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                PageHeading(title: "Friday 的执行工具", subtitle: "Friday 自己处理对话和个人事务。需要独立编码时，可以经你确认后调用本机 Codex。")
                ForEach(store.agents) { agent in
                    VStack(alignment: .leading, spacing: 12) {
                        HStack { FridaySymbolLabel(agent.name, systemImage: "terminal").font(.headline).fridaySymbolFeedback(); Spacer(); Text(agent.installed ? (agent.executableSupported ? "可以执行任务" : "已发现 · 尚未接入") : "未安装").font(.caption).foregroundStyle(.secondary) }
                        Text(agent.description).font(.callout).foregroundStyle(.secondary)
                        if let executable = agent.executable { Text(executable).font(.caption.monospaced()).foregroundStyle(.tertiary).textSelection(.enabled) }
                    }.padding(22).fridayCard()
                }
                Button("重新检测") { Task { await store.refresh() } }.buttonStyle(FridayButtonStyle()).disabled(!store.connected)
            }.padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity)
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
                PageHeading(title: "随时找到 Friday", subtitle: "连接你的主机，让进展随时可见。")
                FridaySymbolLabel(store.connected ? "已连接主机" : "主机暂时离线", systemImage: store.connected ? "checkmark.circle.fill" : "wifi.slash").foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                    .fridaySymbolFeedback(active: store.connected)
                Text(store.connection.server).font(.callout.monospaced()).textSelection(.enabled)
                Text("任务在主机上执行。关闭客户端不影响任务；主机需要保持运行。").foregroundStyle(.secondary)
                Button("重新连接") { Task { await store.connect() } }
                Divider()
                ModelSettingsView(store: store)
                if store.deviceId == "owner" {
                    Divider()
                    Text("连接另一台设备").font(.title3.bold())
                    Text("先为主机配置可访问的 HTTPS 地址，例如 Tailscale Serve。然后在另一台设备填写地址和一次性配对码。").font(.callout).foregroundStyle(.secondary)
                    Button("生成配对码") {
                        Task { do { pairing = try await store.connection.decode(PairingCode.self, "/api/pairing", method: "POST", body: [:]); error = nil } catch { self.error = error.localizedDescription } }
                    }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(!store.connected)
                    if let pairing { VStack(alignment: .leading, spacing: 6) { Text(pairing.code).font(.system(size: 36, weight: .medium, design: .monospaced)).textSelection(.enabled); Text("5 分钟内有效，只能使用一次。").font(.caption).foregroundStyle(.secondary) } }
                    ForEach(store.devices) { device in
                        HStack {
                            FridaySymbolLabel(device.name, systemImage: "iphone").fridaySymbolFeedback(); Spacer()
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
                Button("连接") { busy = true; Task { do { try await store.pair(server: server, code: code, name: name); code = ""; error = nil } catch { self.error = error.localizedDescription }; busy = false } }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || server.isEmpty || name.isEmpty || code.count != 6)
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

struct ModelSettingsView: View {
    @ObservedObject var store: FridayStore
    @State private var state: ModelConnectionState?
    @State private var apiKey = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Friday 的模型").font(.title3.bold())
            Text("连接 DeepSeek，让 Friday 与你对话、记住偏好并处理事情。").font(.callout).foregroundStyle(.secondary)
            if let state {
                FridaySymbolLabel(state.connected ? "DeepSeek API Key 已配置" : "尚未配置 DeepSeek API Key", systemImage: state.connected ? "checkmark.circle.fill" : "key").foregroundStyle(state.connected ? FridayTheme.accent : .secondary)
                    .fridaySymbolFeedback(active: state.connected)
                Text(state.model).font(.caption).foregroundStyle(.secondary)
                if store.deviceId == "owner" {
                    SecureField(state.connected ? "输入新的 API Key 以替换" : "DeepSeek API Key", text: $apiKey)
                        .textFieldStyle(.roundedBorder).accessibilityLabel("DeepSeek API Key")
                        .disabled(busy || !store.connected)
                    Text("密钥只保存在主机上。保存前会发送一次简短测试请求，产生少量 API 用量。").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button(busy ? "正在验证…" : "验证并保存") {
                            busy = true; error = nil
                            Task {
                                do {
                                    self.state = try await store.connection.decode(ModelConnectionState.self, "/api/model/key", method: "PUT", body: ["apiKey": apiKey])
                                    apiKey = ""
                                } catch { self.error = error.localizedDescription }
                                busy = false
                            }
                        }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || !store.connected || apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        if state.connected {
                            Button("移除 API Key", role: .destructive) {
                                busy = true; error = nil
                                Task {
                                    do { _ = try await store.connection.data("/api/model/key", method: "DELETE"); apiKey = ""; await refresh() }
                                    catch { self.error = error.localizedDescription }
                                    busy = false
                                }
                            }.disabled(busy || !store.connected)
                        }
                    }
                    Link("获取 DeepSeek API Key", destination: URL(string: "https://platform.deepseek.com/api_keys")!).font(.caption)
                } else { Text("请在主机上配置 DeepSeek API Key，所有已连接设备会共用 Friday。").font(.caption).foregroundStyle(.secondary) }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
        }.task(id: store.connected) { if store.connected { await refresh() } }
        .onDisappear { apiKey = "" }
    }
    private func refresh() async {
        do { state = try await store.connection.decode(ModelConnectionState.self, "/api/model"); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
