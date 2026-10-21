import SwiftUI
import WebKit

struct TaskChangeRequestFileView: View {
    @ObservedObject var store: FridayStore
    let taskID: String; let url: String; let target: TaskChangeRequestFileTarget
    @State private var side = "new"
    @State private var contents: TaskChangeRequestFileContents?
    @State private var loading = false
    @State private var error: String?
    @State private var generation = UUID()
    @State private var wrapping = false
    @Environment(\.dismiss) private var dismiss
    init(store: FridayStore, taskID: String, url: String, target: TaskChangeRequestFileTarget) {
        self.store = store; self.taskID = taskID; self.url = url; self.target = target; _side = State(initialValue: target.initialSide)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(contents?.path ?? target.path).font(.headline).lineLimit(2).textSelection(.enabled)
                    Text(contents?.revision ?? target.commit ?? target.head).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Toggle(isOn: $wrapping) { Text(friday: "自动换行") }.toggleStyle(.switch).controlSize(.mini).fixedSize().fridayInteractiveCursor()
                Button { Task { await load() } } label: { FridaySymbolImage(systemName: "arrow.clockwise").frame(width: 26, height: 26) }.buttonStyle(FridaySymbolButtonStyle()).disabled(loading || !store.connected).help(Text(friday: "刷新"))
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 26, height: 26) }.buttonStyle(FridaySymbolButtonStyle()).help(Text(friday: "关闭"))
            }.padding(12)
            Picker(selection: $side) { Text(friday: "变更前").tag("old"); Text(friday: "变更后").tag("new") } label: { Text(friday: "文件版本") }
                .pickerStyle(.segmented).frame(maxWidth: 260).padding(10).fridayInteractiveCursor()
            Divider()
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange).textSelection(.enabled).padding(12) }
            if loading { ProgressView().padding() }
            if let contents {
                if contents.kind == "text" {
                    TaskSourceFileView(source: contents.text ?? "", language: (contents.path as NSString).pathExtension, identity: target.id + ":" + side, line: nil, reveal: 0, wrapping: wrapping)
                } else if contents.kind == "image", let base64 = contents.base64 {
                    TaskRevisionImageView(mimeType: contents.mimeType, base64: base64).id((contents.revision ?? "") + ":" + side + ":" + contents.path).accessibilityLabel(Text(contents.path))
                } else {
                    Spacer(); Text(fridayString: contents.kind == "absent" ? "此版本中不存在该文件" : contents.reason == "oversized" ? "文件过大，无法加载完整内容" : contents.reason == "symlink" ? "此文件是符号链接或子模块，未跟随其目标" : "此文件不是可预览的文本或图片").foregroundStyle(.secondary).padding(24); Spacer()
                }
            } else { Spacer() }
        }
        #if os(macOS)
        .frame(minWidth: 580, idealWidth: 920, minHeight: 460, idealHeight: 700)
        #endif
        .task(id: store.connectionIdentity + ":" + target.id + ":" + side) { await load() }
        .onDisappear { generation = UUID() }
    }
    @MainActor private func load() async {
        let owner = UUID(), identity = store.connectionIdentity, requestedSide = side
        generation = owner; loading = true; error = nil; contents = nil
        defer { if generation == owner { loading = false } }
        do {
            let value = try await store.taskChangeRequestFileContents(taskID, url: url, target: target, side: requestedSide)
            guard !Task.isCancelled, generation == owner, store.connectionIdentity == identity, side == requestedSide else { return }
            guard value.requestHeadSha == target.head, value.scopeCommit == target.commit, value.side == requestedSide else { throw TaskChangeRequestRejection(message: "平台返回的文件版本不一致") }
            if let base = target.base, value.requestBaseSha != base { throw TaskChangeRequestRejection(message: "平台返回的文件版本不一致") }
            contents = value
        } catch { if !Task.isCancelled, generation == owner, store.connectionIdentity == identity { self.error = error.localizedDescription } }
    }
}

private final class TaskRevisionImageNavigation: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }
}
private struct TaskRevisionImageView {
    let mimeType: String; let base64: String
    func makeCoordinator() -> TaskRevisionImageNavigation { TaskRevisionImageNavigation() }
    private func make(_ delegate: TaskRevisionImageNavigation) -> WKWebView {
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent(); config.defaultWebpagePreferences.allowsContentJavaScript = false
        let view = WKWebView(frame: .zero, configuration: config); view.navigationDelegate = delegate
        let allowed = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/x-icon", "image/svg+xml"]
        if allowed.contains(mimeType), base64.range(of: #"^[A-Za-z0-9+/=]*$"#, options: .regularExpression) != nil {
            view.loadHTMLString("<meta name='viewport' content='width=device-width,initial-scale=1'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox\"><style>html,body{margin:0;height:100%;background:transparent}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:100%;object-fit:contain}</style><img src='data:" + mimeType + ";base64," + base64 + "'>", baseURL: nil)
        }
        return view
    }
}
#if os(macOS)
extension TaskRevisionImageView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
#else
extension TaskRevisionImageView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ view: WKWebView, context: Context) {}
}
#endif
