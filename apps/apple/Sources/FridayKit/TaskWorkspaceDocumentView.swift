import SwiftUI
@preconcurrency import WebKit

enum WorkspaceDocumentPolicy {
    static func wrapper(url: URL, pdf: Bool) -> String? {
        guard ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
        func escape(_ text: String) -> String { text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
        let source = escape(url.absoluteString + (pdf ? "#toolbar=0&view=FitH" : ""))
        let sandbox = pdf ? "" : " sandbox=\"allow-scripts allow-forms allow-popups allow-downloads\""
        return """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src https: http: data: blob:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;width:100%;height:100%;background:white}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="File preview" referrerpolicy="no-referrer" src="\(source)"\(sandbox)></iframe></body></html>
        """
    }
}

/// Uses an ordinary, short-lived HTTP asset capability like T3code. Module
/// scripts and fetch keep browser semantics, inside an opaque sandboxed frame.
struct TaskWorkspaceDocumentView {
    let url: URL; let pdf: Bool
    var failure: (String) -> Void
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        var failure: (String) -> Void = { _ in }
        private var loadedURL: URL?
        func makeView() -> WKWebView {
            let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = true; configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            let view = WKWebView(frame: .zero, configuration: configuration); view.navigationDelegate = self; return view
        }
        func update(_ view: WKWebView, url: URL, pdf: Bool, failure: @escaping (String) -> Void) {
            self.failure = failure
            guard loadedURL != url, let html = WorkspaceDocumentPolicy.wrapper(url: url, pdf: pdf) else { return }; loadedURL = url
            view.loadHTMLString(html, baseURL: nil)
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            let allowed = url?.absoluteString == "about:blank"
                || (navigationAction.targetFrame?.isMainFrame == false && ["https", "http", "data", "blob"].contains(url?.scheme?.lowercased() ?? ""))
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { failure("文件预览暂时无法加载") } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { failure("文件预览暂时无法加载") } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failure("文件预览暂时无法加载") }
    }
}
#if os(macOS)
extension TaskWorkspaceDocumentView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.update(view, url: url, pdf: pdf, failure: failure) }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading() }
}
#else
extension TaskWorkspaceDocumentView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.update(view, url: url, pdf: pdf, failure: failure) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading() }
}
#endif
