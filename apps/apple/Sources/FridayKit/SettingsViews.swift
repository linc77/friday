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
                    Button { adding = true } label: { FridaySymbolLabel(friday: "添加项目", systemImage: "plus") }
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
                                Group {
                                    if project.context.isEmpty { Text(friday: "添加项目背景，让 Friday 更了解这件事。") }
                                    else { Text(project.context) }
                                }
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
            HStack { Text(fridayString: project == nil ? "添加项目" : "项目背景").font(.title2.bold()); Spacer(); Button(friday: "取消") { dismiss() } }
            TextField(friday: "项目名称", text: $name).textFieldStyle(.roundedBorder)
            HStack {
                TextField(friday: "主机上的绝对目录", text: $path).textFieldStyle(.roundedBorder).disabled(project != nil)
                #if os(macOS)
                if project == nil { Button(friday: "选择目录") { let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false; if panel.runModal() == .OK, let url = panel.url { path = url.path; if name.isEmpty { name = url.lastPathComponent } } } }
                #endif
            }
            Text(friday: "项目背景与约定").font(.headline)
            TextEditor(text: $context).frame(minHeight: 150).padding(8).overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
            Text(friday: "目标、当前进展、你的偏好。每次关联该项目的任务都会读取这些内容。").font(.caption).foregroundStyle(.secondary)
            if let error = store.error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
            HStack { Spacer(); Button(friday: "保存项目") {
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
                TextEditor(text: $draft).scrollContentBackground(.hidden).frame(minHeight: 90).padding(16).fridayCard().accessibilityLabel(Text(friday: "长期记忆"))
                HStack { if editingId != nil { Button(friday: "取消编辑") { draft = ""; editingId = nil } }; Spacer(); Button(friday: editingId == nil ? "记住这件事" : "保存修改") {
                    busy = true; var body: [String: Any] = ["text": draft]; if let editingId { body["id"] = editingId }
                    Task { if await store.perform("/api/memories", body: body) { draft = ""; editingId = nil }; busy = false }
                }.buttonStyle(FridayButtonStyle(prominent: true)).disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.connected) }
                ForEach(store.memories) { memory in
                    HStack(alignment: .top, spacing: 14) {
                        FridaySymbolImage(systemName: "sparkles").foregroundStyle(.secondary).fridaySymbolFeedback()
                        Text(memory.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                        Menu { Button(friday: "编辑") { draft = memory.text; editingId = memory.id }; Button(friday: "删除", role: .destructive) { Task { _ = await store.perform("/api/memories/\(memory.id)", method: "DELETE") } } } label: { FridaySymbolImage(systemName: "ellipsis").fridaySymbolFeedback() }
                    }.padding(20).fridayCard()
                }
            }.padding(28).frame(maxWidth: FridayTheme.contentWidth + 56).frame(maxWidth: .infinity)
        }
    }
}

enum ConnectionSettingsSection {
    case all, host, devices

    var title: String { self == .devices ? "设备管理" : "主机连接" }
    var subtitle: String {
        self == .devices ? "管理可以访问 Friday 的设备。" : "连接你的主机，随时查看任务与进展。"
    }
}

struct ConnectionView: View {
    @ObservedObject var store: FridayStore
    var section: ConnectionSettingsSection = .all
    @State private var server = ""
    @State private var code = ""
    @State private var name = ""
    @State private var pairing: PairingCode?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        SettingsPage(title: section.title, subtitle: section.subtitle) {
            if section != .devices {
                hostSettings
            }
            if section != .host {
                deviceSettings
            }
            if section != .devices {
                pairingSettings
            }
            if let error = error ?? store.error {
                Text(fridayString: error).font(.caption).foregroundStyle(.orange)
            }
        }.onAppear {
            server = store.connection.server
            #if os(macOS)
            name = Host.current().localizedName ?? "我的 Mac"
            #else
            name = "我的 iPhone"
            #endif
        }
    }

    private var hostSettings: some View {
        SettingsGroup("当前主机") {
            SettingsRow("连接状态", detail: "任务在主机上执行，关闭客户端不影响任务。") {
                FridaySymbolLabel(friday: store.connected ? "已连接" : "离线", systemImage: store.connected ? "checkmark.circle" : "wifi.slash")
                    .font(.system(size: 12)).foregroundStyle(store.connected ? FridayTheme.accent : .orange)
                    .fixedSize()
                    .fridaySymbolFeedback(value: store.connected)
            }
            SettingsDivider()
            SettingsRow("主机地址") {
                Text(store.connection.server).font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(.secondary).textSelection(.enabled)
                    .lineLimit(2).truncationMode(.middle)
            }
            SettingsDivider()
            SettingsRow("重新连接", detail: "主机需要保持运行，才能继续处理任务。") {
                Button(friday: "重新连接") { Task { await store.connect() } }
            }
        }
    }

    @ViewBuilder private var deviceSettings: some View {
        if store.deviceId == "owner" {
            SettingsGroup("添加设备") {
                SettingsRow("连接另一台设备", detail: "在另一台设备输入主机 HTTPS 地址与一次性配对码。") {
                    Button(friday: "生成配对码") {
                        Task {
                            do {
                                pairing = try await store.connection.decode(PairingCode.self, "/api/pairing", method: "POST", body: [:])
                                error = nil
                            } catch { self.error = error.localizedDescription }
                        }
                    }.disabled(!store.connected)
                }
                if let pairing {
                    SettingsDivider()
                    SettingsRow("一次性配对码", detail: "5 分钟内有效，只能使用一次。") {
                        Text(pairing.code).font(.system(size: 24, weight: .medium, design: .monospaced))
                            .textSelection(.enabled)
                    }
                }
            }
            Text(friday: "远程访问需要可用的 HTTPS 地址，例如通过 Tailscale Serve 连接你的主机。")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            SettingsGroup("已连接的设备") {
                if store.devices.isEmpty {
                    SettingsRow("还没有配对设备", detail: "添加设备后，你可以在这里管理访问权限。") { EmptyView() }
                }
                ForEach(Array(store.devices.enumerated()), id: \.element.id) { index, device in
                    if index > 0 { SettingsDivider() }
                    SettingsRow(verbatim: device.name) {
                        Button(friday: "撤销访问", role: .destructive) {
                            Task { _ = await store.perform("/api/devices/\(device.id)", method: "DELETE") }
                        }.disabled(!store.connected)
                    }
                }
            }
        } else {
            SettingsGroup("设备访问") {
                SettingsRow("在主机上管理设备", detail: "请在主机客户端生成配对码或撤销其他设备的访问权限。") { EmptyView() }
            }
        }
    }

    private var pairingSettings: some View {
        SettingsGroup("配对到主机") {
            SettingsRow("主机地址", detail: "远程连接请使用 HTTPS。") {
                TextField(friday: "https://你的主机地址", text: $server).textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 250).accessibilityLabel(Text(friday: "主机地址"))
            }
            SettingsDivider()
            SettingsRow("设备名称") {
                TextField(friday: "设备名称", text: $name).textFieldStyle(.roundedBorder).frame(maxWidth: 250)
                    .accessibilityLabel(Text(friday: "设备名称"))
            }
            SettingsDivider()
            SettingsRow("配对码", detail: "在主机的“设备管理”中生成。") {
                TextField(friday: "6 位配对码", text: $code).textFieldStyle(.roundedBorder).frame(width: 120)
                    .accessibilityLabel(Text(friday: "配对码"))
            }
            SettingsDivider()
            SettingsRow("连接到主机", detail: "配对后，这台设备可以查看和管理 Friday。") {
                Button(friday: busy ? "正在连接…" : "连接") {
                    busy = true
                    Task {
                        do { try await store.pair(server: server, code: code, name: name); code = ""; error = nil }
                        catch { self.error = error.localizedDescription }
                        busy = false
                    }
                }.disabled(busy || server.isEmpty || name.isEmpty || code.count != 6)
            }
        }
    }
}
