import SwiftUI
@preconcurrency import WebKit

enum WorkspaceDocumentPolicy {
    static func wrapper(url: URL, pdf: Bool, interactiveID: String? = nil) -> String? {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
        func escape(_ text: String) -> String { text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
        let source = escape(url.absoluteString + (pdf ? "#toolbar=0&view=FitH" : ""))
        let interactive = interactiveID != nil
        let sandbox = pdf ? "" : interactive ? " sandbox=\"allow-scripts\"" : " sandbox=\"allow-scripts allow-forms allow-popups allow-downloads\""
        // Only messages from the trusted outer document are accepted by the
        // native handler. The opaque child supplies a bounded height hint.
        let bridge: String
        if let interactiveID, UUID(uuidString: interactiveID) != nil {
            bridge = """
            <script>addEventListener('message',event=>{const frame=document.querySelector('iframe');if(event.source!==frame.contentWindow||event.data?.type!=='friday-html-height')return;const height=event.data.height;if(typeof height==='number'&&Number.isFinite(height)&&height>0)window.webkit.messageHandlers.fridayHtmlHeight.postMessage({id:'\(interactiveID)',height:Math.min(900,Math.max(180,height))})});</script>
            """
        } else { bridge = "" }
        let scripts = interactive ? " script-src 'unsafe-inline';" : ""
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';\(scripts) style-src 'unsafe-inline'; frame-src https: http: data: blob:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;background:white}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="File preview" referrerpolicy="no-referrer" src="\(source)"\(sandbox)></iframe>\(bridge)</body></html>
        """
    }
}

/// Uses an ordinary, short-lived HTTP asset capability like T3code. Module
/// scripts and fetch keep browser semantics, inside an opaque sandboxed frame.
struct TaskWorkspaceDocumentView {
    let url: URL; let pdf: Bool
    var interactive = false
    var contentHeight: ((CGFloat) -> Void)? = nil
    var failure: (String) -> Void
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var failure: (String) -> Void = { _ in }
        var contentHeight: ((CGFloat) -> Void)?
        private var interactive = false
        private var documentID = UUID().uuidString
        private var lastHeight: CGFloat?
        private var loadedURL: URL?
        func makeView() -> WKWebView {
            let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = true; configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            configuration.userContentController.add(self, name: "fridayHtmlHeight")
            let view = WKWebView(frame: .zero, configuration: configuration); view.navigationDelegate = self; return view
        }
        func update(_ view: WKWebView, url: URL, pdf: Bool, interactive: Bool, contentHeight: ((CGFloat) -> Void)?, failure: @escaping (String) -> Void) {
            self.failure = failure; self.contentHeight = contentHeight
            guard loadedURL != url || self.interactive != interactive else { return }
            self.interactive = interactive; documentID = UUID().uuidString; lastHeight = nil
            guard let html = WorkspaceDocumentPolicy.wrapper(url: url, pdf: pdf, interactiveID: interactive ? documentID : nil) else { return }; loadedURL = url
            view.loadHTMLString(html, baseURL: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard interactive, message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["id"] as? String == documentID,
                  let height = body["height"] as? Double, height.isFinite, height > 0 else { return }
            let fitted = CGFloat(min(900, max(180, height)))
            guard lastHeight != fitted else { return }; lastHeight = fitted
            contentHeight?(fitted)
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            if interactive {
                // Generated pages cannot escape through self-navigation, popups,
                // custom schemes or the application's authenticated origin.
                let samePage = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }.map { value in
                    var value = value; value.fragment = nil; return value.url == loadedURL
                } ?? false
                let allowed = navigationAction.targetFrame?.isMainFrame == true ? url?.absoluteString == "about:blank" : navigationAction.targetFrame != nil && samePage
                decisionHandler(allowed ? .allow : .cancel); return
            }
            let allowed = url?.absoluteString == "about:blank"
                || (navigationAction.targetFrame?.isMainFrame == false && ["https", "http", "data", "blob"].contains(url?.scheme?.lowercased() ?? ""))
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { failure("文件预览暂时无法加载") } }
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if interactive, let response = navigationResponse.response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
                failure("交互预览暂时不可用，请重新加载"); decisionHandler(.cancel)
            } else { decisionHandler(.allow) }
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { failure("文件预览暂时无法加载") } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failure("文件预览暂时无法加载") }
    }
}
#if os(macOS)
extension TaskWorkspaceDocumentView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.update(view, url: url, pdf: pdf, interactive: interactive, contentHeight: contentHeight, failure: failure) }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "fridayHtmlHeight"); view.loadHTMLString("", baseURL: nil) }
}
#else
extension TaskWorkspaceDocumentView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.update(view, url: url, pdf: pdf, interactive: interactive, contentHeight: contentHeight, failure: failure) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading(); view.configuration.userContentController.removeScriptMessageHandler(forName: "fridayHtmlHeight"); view.loadHTMLString("", baseURL: nil) }
}
#endif
