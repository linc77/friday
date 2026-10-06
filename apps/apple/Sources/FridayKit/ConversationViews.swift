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
    private var canSend: Bool { !sending && store.connected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    var body: some View {
        VStack {
            Spacer(minLength: 30)
            VStack(alignment: .leading, spacing: 24) {
                PageHeading(title: "想到什么，直接说。", subtitle: "一个想法，一件想推进的事。")
                VStack(alignment: .leading, spacing: 12) {
                    ZStack(alignment: .topLeading) {
                        if draft.isEmpty { Text(friday: "告诉 Friday 你想做什么…").foregroundStyle(.tertiary).padding(.leading, 5).padding(.top, 8).allowsHitTesting(false) }
                        TextEditor(text: $draft).font(.body).frame(height: 90).scrollContentBackground(.hidden).focused($focused).accessibilityLabel(Text(friday: "告诉 Friday 你想做什么"))
                            .onChatSubmit(send)
                    }
                    HStack {
                        Spacer()
                        if sending { ProgressView().controlSize(.small) }
                        Button(friday: "发送", systemImage: "arrow.up", action: send).buttonStyle(FridayButtonStyle(prominent: true)).keyboardShortcut(.return, modifiers: .command)
                            .disabled(!canSend)
                    }
                }.padding(20).fridayCard(highlighted: focused)
                if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth: 660).padding(28)
            Spacer(minLength: 80)
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(FridayTheme.canvas)
        .onAppear { focused = true }
        .onChange(of: draft) { _, _ in if !sending { requestId = UUID().uuidString } }
    }
    private func send() {
        guard canSend else { return }
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

extension View {
    func onChatSubmit(_ action: @escaping () -> Void) -> some View {
        #if os(macOS)
        onKeyPress(.return, phases: .down) { key in
            guard key.modifiers.intersection([.option, .control]).isEmpty else { return .ignored }
            guard let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return .ignored }
            // Return must finish input-method composition before it can send a message.
            guard !editor.hasMarkedText() else { return .ignored }
            if key.modifiers.contains(.shift) {
                // A field editor treats Shift-Return as ending the edit. Insert after key dispatch.
                guard editor.isFieldEditor else { return .ignored }
                let selection = editor.selectedRange()
                DispatchQueue.main.async { [weak editor] in
                    editor?.insertText("\n", replacementRange: selection)
                }
                return .handled
            }
            action()
            return .handled
        }
        #else
        self
        #endif
    }
}

struct WorkspaceChoice: View {
    @ObservedObject var store: FridayStore
    let task: WorkItem
    @State private var busy = false
    @State private var path = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(friday: "选择要处理的项目").font(.headline)
            ForEach(store.projects) { project in
                Button { choose(projectId: project.id) } label: {
                    HStack {
                        Image(systemName: "folder")
                        VStack(alignment: .leading, spacing: 3) { Text(project.name); Text(project.path).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                        Spacer(); Image(systemName: "chevron.right").font(.caption)
                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                }.buttonStyle(FridayButtonStyle())
            }
            #if os(macOS)
            if store.deviceId == "owner" {
                Button(friday: "选择其他目录…") {
                    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
                    if panel.runModal() == .OK, let url = panel.url { choose(path: url.path) }
                }
            } else { remotePath }
            #else
            remotePath
            #endif
            Text(friday: "选择后，Friday 会在这里继续处理你的请求。").font(.caption).foregroundStyle(.secondary)
            if busy { ProgressView().controlSize(.small) }
        }.padding(22).fridayCard().disabled(busy || !store.connected)
    }
    private var remotePath: some View {
        HStack {
            TextField(friday: "或填写主机上的目录", text: $path).textFieldStyle(.roundedBorder)
            Button(friday: "继续") { choose(path: path) }.disabled(path.isEmpty)
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
