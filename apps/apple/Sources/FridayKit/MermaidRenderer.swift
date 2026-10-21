import Foundation
@preconcurrency import WebKit

/// Pure drawing on one isolated WebKit worker. The worker has no service
/// credentials, command bridge, persistent browser data, or network access.
@MainActor final class MermaidRenderer: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = MermaidRenderer()
    private var worker: WKWebView?
    private var ready = false
    private var preparing = false
    private var generation = UUID()
    private var active: (id: String, key: MermaidRequest)?
    private var cache = MermaidRenderCache()
    private var pending: [MermaidRequest: [CheckedContinuation<MermaidResult, Never>]] = [:]
    private var queue: [MermaidRequest] = []
    private var startup: [CheckedContinuation<Bool, Never>] = []

    func png(_ diagram: MermaidDiagram) async -> Data? {
        if !ready {
            let available = await withCheckedContinuation { continuation in startup.append(continuation); prepare() }
            guard available else { return nil }
        }
        guard let worker else { return nil }
        do {
            let result = try await worker.callAsyncJavaScript("return await globalThis.fridayMermaid.png(svg);", arguments: ["svg": diagram.svg], in: nil, contentWorld: .defaultClient)
            guard let string = result as? String, string.utf8.count <= 48 * 1024 * 1024, let data = Data(base64Encoded: string), data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) else { return nil }
            return data
        } catch { return nil }
    }

    func render(source: String, dark: Bool, retry: Bool = false) async -> MermaidResult {
        let key = MermaidRequest(source: source, dark: dark)
        guard !key.source.isEmpty else { return .failure("图表内容为空", retryable: false) }
        guard key.source.utf16.count <= 50_000 else { return .failure("图表内容过长，源码已保留", retryable: false) }
        if retry { cache.remove(key) }
        if let cached = cache.read(key) { return cached }
        return await withCheckedContinuation { continuation in
            if pending[key] != nil { pending[key]!.append(continuation); return }
            pending[key] = [continuation]; queue.append(key); advance()
        }
    }
    private func advance() {
        guard active == nil, !queue.isEmpty else { return }
        guard ready, let worker else { prepare(); return }
        let key = queue.removeFirst(), id = UUID().uuidString
        active = (id, key)
        Task { [weak self, weak worker] in
            guard let worker else { return }
            do { _ = try await worker.callAsyncJavaScript("await globalThis.fridayMermaid.render({id, source, dark});", arguments: ["id": id, "source": key.source, "dark": key.dark], in: nil, contentWorld: .defaultClient) }
            catch { if self?.active?.id == id { self?.finish(.failure("图表暂时无法加载", retryable: true)) } }
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard let self, self.active?.id == id else { return }
            self.resetWorker(); self.finish(.failure("图表绘制超时，源码已保留", retryable: true))
        }
    }
    private func prepare() {
        guard !preparing else { return }; preparing = true
        let nonce = UUID(); generation = nonce
        Task { [weak self] in
            do {
                guard let url = Bundle.module.url(forResource: "MermaidRenderer", withExtension: "js") else { throw CocoaError(.fileNoSuchFile) }
                let source = try await Task.detached(priority: .userInitiated) { try String(contentsOf: url, encoding: .utf8) }.value
                let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "Friday.Mermaid.no-network.v1", encodedContentRuleList: MermaidWebPolicy.networkRules)
                guard let self, self.generation == nonce, let rules else { return }
                let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
                configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
                configuration.userContentController.add(rules)
                configuration.userContentController.add(self, contentWorld: .defaultClient, name: "fridayMermaid")
                configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
                let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1000, height: 1000), configuration: configuration)
                view.navigationDelegate = self; self.worker = view
                view.loadHTMLString(MermaidWebPolicy.workerHTML, baseURL: nil)
            } catch { if self?.generation == nonce { self?.failAll("图表暂时无法加载") } }
        }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard let self, self.generation == nonce, !self.ready else { return }; self.failAll("图表暂时无法加载")
        }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let worker, message.webView === worker, message.frameInfo.isMainFrame, JSONSerialization.isValidJSONObject(message.body),
              let data = try? JSONSerialization.data(withJSONObject: message.body), let value = try? JSONDecoder().decode(MermaidWorkerMessage.self, from: data) else { return }
        if value.type == "ready" {
            ready = true; preparing = false; let waiting = startup; startup.removeAll(); for continuation in waiting { continuation.resume(returning: true) }; advance(); return
        }
        guard value.id == active?.id, active != nil else { return }
        if let diagram = value.diagram { finish(.rendered(diagram)) }
        else if value.type == "error" { finish(.failure(value.message ?? "无法绘制图表", retryable: value.retryable == true)) }
        else { finish(.failure("无法绘制图表", retryable: false)) }
    }
    private func finish(_ result: MermaidResult) {
        guard let current = active else { return }; active = nil; cache.store(current.key, result: result)
        let waiting = pending.removeValue(forKey: current.key) ?? []; for continuation in waiting { continuation.resume(returning: result) }
        advance()
    }
    private func resetWorker() {
        generation = UUID(); worker?.configuration.userContentController.removeScriptMessageHandler(forName: "fridayMermaid", contentWorld: .defaultClient)
        worker?.navigationDelegate = nil; worker?.stopLoading(); worker = nil; ready = false; preparing = false
    }
    private func failAll(_ message: String) {
        resetWorker(); active = nil; queue.removeAll(); let waiting = pending; pending.removeAll()
        let starting = startup; startup.removeAll(); for continuation in starting { continuation.resume(returning: false) }
        let result = MermaidResult.failure(message, retryable: true)
        for (key, continuations) in waiting { cache.store(key, result: result); for continuation in continuations { continuation.resume(returning: result) } }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(MermaidWebPolicy.navigationAllowed(navigationAction.request.url) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { if webView === worker { failAll("图表暂时无法加载") } }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { if webView === worker { failAll("图表暂时无法加载") } }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { if webView === worker { failAll("图表暂时无法加载") } }
}
