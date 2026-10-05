import SwiftUI
#if os(macOS)
import AppKit
#endif

struct NewConversationView: View {
    @ObservedObject var store: FridayStore
    let onCreated: (String) -> Void
    @AppStorage("friday.chatDraft") private var draft = ""
    @State private var requestId = UUID().uuidString
    @State private var sending = false
    @State private var error: String?
    @FocusState private var focused: Bool
    var body: some View {
        VStack {
            Spacer(minLength: 30)
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("想到什么，直接说。").font(.largeTitle.weight(.semibold))
                    Text("一个想法，一件想推进的事。").foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 12) {
                    ZStack(alignment: .topLeading) {
                        if draft.isEmpty { Text("告诉 Friday 你想做什么…").foregroundStyle(.tertiary).padding(.leading, 5).padding(.top, 8).allowsHitTesting(false) }
                        TextEditor(text: $draft).font(.body).frame(height: 90).scrollContentBackground(.hidden).focused($focused).accessibilityLabel("告诉 Friday 你想做什么")
                    }
                    HStack {
                        #if os(macOS)
                        Text("⌘ ↵ 发送").font(.caption).foregroundStyle(.secondary)
                        #endif
                        Spacer()
                        if sending { ProgressView().controlSize(.small) }
                        Button("发送", action: send).buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                            .disabled(sending || !store.connected || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }.padding(16).background(.background, in: RoundedRectangle(cornerRadius: 14)).overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary))
                if let error { Text(error).font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth: 660).padding(28)
            Spacer(minLength: 80)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { focused = true }
        .onChange(of: draft) { _, _ in if !sending { requestId = UUID().uuidString } }
    }
    private func send() {
        let prompt = draft; sending = true; error = nil
        Task {
            do {
                let id = try await store.createTask(prompt: prompt, requestId: requestId)
                if draft == prompt { draft = "" }
                onCreated(id)
            } catch { self.error = error.localizedDescription }
            sending = false
        }
    }
}

struct WorkspaceChoice: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var busy = false
    @State private var path = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("选择要处理的项目").font(.headline)
            ForEach(store.projects) { project in
                Button { choose(projectId: project.id) } label: {
                    HStack {
                        Image(systemName: "folder")
                        VStack(alignment: .leading, spacing: 3) { Text(project.name); Text(project.path).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        Spacer(); Image(systemName: "chevron.right").font(.caption)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(.bordered)
            }
            #if os(macOS)
            if store.deviceId == "owner" {
                Button("选择其他目录…") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
                    if panel.runModal() == .OK, let url = panel.url { choose(path: url.path) }
                }
            } else { remotePath }
            #else
            remotePath
            #endif
            Text("选择后，Friday 会在这里继续处理你的请求。").font(.caption).foregroundStyle(.secondary)
            if busy { ProgressView().controlSize(.small) }
        }.padding(18).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 14)).disabled(busy || !store.connected)
    }
    private var remotePath: some View {
        HStack {
            TextField("或填写主机上的目录", text: $path).textFieldStyle(.roundedBorder)
            Button("继续") { choose(path: path) }.disabled(path.isEmpty)
        }
    }
    private func choose(projectId: String? = nil, path: String? = nil) {
        busy = true
        // The selection identifies the retry, so a lost response never enqueues it twice.
        var body: [String: Any] = ["requestId": "workspace-\(task.id)-\(task.durableId ?? 0)"]
        if let projectId { body["projectId"] = projectId }; if let path { body["path"] = path }
        Task { _ = await store.perform("/api/tasks/\(task.id)/workspace", body: body); busy = false }
    }
}
