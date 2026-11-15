import SwiftUI

struct TaskHtmlPreview: View {
    @Bindable var store: FridayStore
    let taskID: String
    let eventID: String
    let page: TaskHtmlReference
    @State private var expanded = false
    @State private var height: CGFloat = 480
    @State private var revision = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(verbatim: page.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                Button { revision += 1 } label: { FridaySymbolImage(systemName: "arrow.clockwise") }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected)
                    .accessibilityLabel(Text(friday: "重新加载交互预览")).help(Text(friday: "重新加载交互预览"))
                Button { expanded = true } label: { FridaySymbolImage(systemName: "arrow.up.left.and.arrow.down.right") }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "展开交互预览"))
                    .help(Text(friday: "展开交互预览"))
            }
            TaskHtmlPage(store: store, taskID: taskID, eventID: eventID, contentHeight: { height = $0 })
                .id(revision)
                .frame(height: height)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(.primary.opacity(0.1), lineWidth: 1))
        }
        .onAppear { height = CGFloat(min(900, max(180, page.height))) }
        .sheet(isPresented: $expanded) {
            VStack(spacing: 12) {
                HStack {
                    Text(verbatim: page.title).font(.headline).lineLimit(1)
                    Spacer()
                    Button { expanded = false } label: { FridaySymbolImage(systemName: "xmark") }
                        .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭预览"))
                }
                TaskHtmlPage(store: store, taskID: taskID, eventID: eventID)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }.padding(16)
            #if os(macOS)
                .frame(minWidth: 600, idealWidth: 960, minHeight: 480, idealHeight: 720)
            #else
                .presentationDetents([.large])
            #endif
        }
    }
}

private struct TaskHtmlPage: View {
    @Bindable var store: FridayStore
    let taskID: String
    let eventID: String
    var contentHeight: ((CGFloat) -> Void)? = nil
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    @State private var url: URL?
    @State private var error: String?
    @State private var revision = 0
    private var active: Bool { visible && scenePhase == .active }
    private var identity: String { store.connectionIdentity + ":" + taskID + ":" + eventID }
    private var loadKey: String { identity + ":\(active):\(store.connected):\(revision)" }

    var body: some View {
        ZStack {
            if active, let url, error == nil {
                TaskWorkspaceDocumentView(url: url, pdf: false, interactive: true, contentHeight: contentHeight, failure: { error = $0 })
            } else {
                VStack(spacing: 12) {
                    Text(fridayString: error ?? (store.connected ? "正在加载交互预览…" : "连接服务后查看交互预览"))
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if error != nil {
                        Button { revision += 1 } label: { FridaySymbolLabel(friday: "重新加载", systemImage: "arrow.clockwise") }
                            .buttonStyle(FridaySymbolButtonStyle()).disabled(!store.connected)
                    }
                }.padding(20)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { visible = true }
        // Removing the WebView stops authored animation/scripts. Nothing runs
        // just because an old event exists in the persisted conversation.
        .onDisappear { visible = false; url = nil }
        .task(id: loadKey) {
            url = nil; error = nil
            guard active, store.connected else { return }
            let key = loadKey
            do {
                let asset = try await store.connection.decode(TaskFileAssetURL.self, "/api/task-html/asset-url", method: "POST", body: ["taskId": taskID, "eventId": eventID])
                guard !Task.isCancelled, key == loadKey else { return }
                guard asset.url.hasPrefix("/file-assets/html/"), let target = try store.connection.request(asset.url).url else { throw URLError(.badURL) }
                url = target
            } catch { if !Task.isCancelled, key == loadKey { self.error = error.localizedDescription } }
        }
    }
}
