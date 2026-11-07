import SwiftUI
@preconcurrency import WebKit

struct MermaidSVGView {
    let diagram: MermaidDiagram
    var expanded = false
    var embeddedImages = false
    var zoom: Binding<Double> = .constant(1)
    var failure: (String) -> Void = { _ in }

    @MainActor final class Coordinator: NSObject, WKNavigationDelegate {
        weak var view: WKWebView?
        var html = "", loadedHTML = ""
        var ruleReady = false, pageReady = false, expanded = false
        var zoom: Binding<Double> = .constant(1)
        private var navigation: WKNavigation?
        var failure: (String) -> Void = { _ in }
        var observation: NSKeyValueObservation?
        func create() -> WKWebView {
            let configuration = WKWebViewConfiguration(); configuration.websiteDataStore = .nonPersistent()
            configuration.defaultWebpagePreferences.allowsContentJavaScript = false
            configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
            let view = WKWebView(frame: .zero, configuration: configuration); self.view = view
            view.navigationDelegate = self; view.underPageBackgroundColor = .clear
            #if os(macOS)
            observation = view.observe(\.magnification, options: .new) { [weak self] view, _ in
                Task { @MainActor in self?.setZoom(Double(view.magnification)) }
            }
            #else
            view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.backgroundColor = .clear
            view.scrollView.minimumZoomScale = 0.25; view.scrollView.maximumZoomScale = 8
            observation = view.scrollView.observe(\.zoomScale, options: .new) { [weak self] scroll, _ in
                Task { @MainActor in self?.setZoom(Double(scroll.zoomScale)) }
            }
            #endif
            Task { [weak self, weak view] in
                do {
                    let rules = try await WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "Friday.Mermaid.no-network.v1", encodedContentRuleList: MermaidWebPolicy.networkRules)
                    guard let self, let view, self.view === view else { return }
                    guard let rules else { self.failure("图表暂时无法显示"); return }
                    view.configuration.userContentController.add(rules); self.ruleReady = true; self.load()
                } catch { self?.failure("图表暂时无法显示") }
            }
            return view
        }
        func update(diagram: MermaidDiagram, expanded: Bool, embeddedImages: Bool, zoom: Binding<Double>, failure: @escaping (String) -> Void) {
            html = MermaidWebPolicy.svgHTML(diagram, expanded: expanded, embeddedImages: embeddedImages); self.expanded = expanded; self.zoom = zoom; self.failure = failure
            #if os(macOS)
            view?.allowsMagnification = expanded
            #else
            view?.scrollView.isScrollEnabled = expanded
            #endif
            load(); applyZoom()
        }
        private func load() {
            guard ruleReady, let view, html != loadedHTML else { return }; loadedHTML = html; pageReady = false
            navigation = view.loadHTMLString(html, baseURL: nil)
        }
        private func setZoom(_ value: Double) {
            guard expanded, pageReady, value.isFinite, abs(zoom.wrappedValue - value) > 0.001 else { return }; zoom.wrappedValue = value
        }
        private func applyZoom() {
            guard pageReady, let view else { return }; let value = expanded ? min(8, max(0.25, zoom.wrappedValue)) : 1
            #if os(macOS)
            if abs(view.magnification - value) > 0.001 { view.setMagnification(value, centeredAt: CGPoint(x: view.bounds.midX, y: view.bounds.midY)) }
            #else
            if abs(view.scrollView.zoomScale - value) > 0.001 { view.scrollView.setZoomScale(value, animated: false) }
            #endif
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { guard webView === view, navigation === self.navigation else { return }; pageReady = true; applyZoom() }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(MermaidWebPolicy.navigationAllowed(navigationAction.request.url) ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled, navigation === self.navigation { failure("图表暂时无法显示") } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled, navigation === self.navigation { failure("图表暂时无法显示") } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { failure("图表暂时无法显示") }
    }
}
#if os(macOS)
extension MermaidSVGView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.create() }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.update(diagram: diagram, expanded: expanded, embeddedImages: embeddedImages, zoom: zoom, failure: failure) }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading(); coordinator.observation = nil; coordinator.view = nil }
}
#else
extension MermaidSVGView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.create() }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.update(diagram: diagram, expanded: expanded, embeddedImages: embeddedImages, zoom: zoom, failure: failure) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { view.navigationDelegate = nil; view.stopLoading(); coordinator.observation = nil; coordinator.view = nil }
}
#endif
