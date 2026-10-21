import SwiftUI
@preconcurrency import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor private final class TaskMediaWebView: WKWebView {
    var geometryChanged: (() -> Void)?
    #if os(macOS)
    override func layout() { super.layout(); geometryChanged?() }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); geometryChanged?() }
    #else
    override func layoutSubviews() { super.layoutSubviews(); geometryChanged?() }
    override func didMoveToWindow() { super.didMoveToWindow(); geometryChanged?() }
    #endif
}

/// Media content uses WebKit's system playback controls, like T3's audio/video elements.
/// Only an exact-file read capability reaches the player, never the connection credential.
struct TaskWorkspaceMediaView: View {
    let url: URL; let revision: String; let name: String; let video: Bool; let sourceFailed: Bool
    let failure: (String) -> Void
    var actions: TaskMediaActionSource? = nil
    var requiresCapability = true
    var inline = false
    var exporterOverride: TaskMediaExportController? = nil
    @StateObject private var exporter = TaskMediaExportController()
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        TaskWorkspaceMediaNativeView(url: url, revision: revision, name: name, video: video, sourceFailed: sourceFailed, background: scenePhase == .background, failure: failure, actions: actions, exporter: exporterOverride ?? exporter, requiresCapability: requiresCapability, inline: inline)
            .taskMediaExportStatus(exporterOverride ?? exporter)
    }
}
private struct TaskWorkspaceMediaNativeView {
    let url: URL; let revision: String; let name: String; let video: Bool; let sourceFailed: Bool; let background: Bool
    let failure: (String) -> Void
    let actions: TaskMediaActionSource?; let exporter: TaskMediaExportController
    let requiresCapability: Bool; let inline: Bool
    @MainActor final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
        weak var view: WKWebView?
        var state = TaskMediaPlaybackState(), documentID = "", name = "", video = false, background = false, sourceFailed = false
        var failure: (String) -> Void = { _ in }
        var actions: TaskMediaActionSource?, exporter: TaskMediaExportController?
        var requiresCapability = true, inline = false
        var documentReady = false, preloaded = ""
        var viewportIDs: [ObjectIdentifier] = []
        #if os(macOS)
        var viewportObservers: [NSObjectProtocol] = []
        #else
        var viewportObservers: [NSKeyValueObservation] = []
        #endif
        let contextMenu = TaskMediaContextMenu()
        func makeView() -> WKWebView {
            let configuration = WKWebViewConfiguration(); configuration.userContentController.add(self, name: "fridayMedia")
            configuration.mediaTypesRequiringUserActionForPlayback = .all
            #if os(macOS)
            configuration.preferences.isElementFullscreenEnabled = true
            #else
            configuration.allowsInlineMediaPlayback = true; configuration.allowsPictureInPictureMediaPlayback = true
            #endif
            let view = TaskMediaWebView(frame: .zero, configuration: configuration); self.view = view
            view.geometryChanged = { [weak self] in self?.updatePreload() }
            view.navigationDelegate = self; view.uiDelegate = self; view.underPageBackgroundColor = .clear
            #if os(macOS)
            view.setValue(false, forKey: "drawsBackground")
            #else
            view.isOpaque = false; view.backgroundColor = .clear; view.scrollView.isScrollEnabled = false
            #endif
            return view
        }
        func update(_ input: TaskWorkspaceMediaNativeView) {
            name = input.name; video = input.video; failure = input.failure; sourceFailed = input.sourceFailed
            actions = input.actions; exporter = input.exporter
            requiresCapability = input.requiresCapability; inline = input.inline
            #if os(macOS)
            view?.toolTip = actions?.reference.tooltip
            #endif
            let replacement = state.update(TaskMediaSource(url: input.url, revision: input.revision))
            if !sourceFailed || state.hasPlayed, let replacement { load(replacement) }
            if input.background && !background { pause() }; background = input.background
            if sourceFailed && !state.hasPlayed {
                let id = documentID
                Task { @MainActor [weak self] in
                    guard let self, self.documentID == id, self.sourceFailed, !self.state.hasPlayed else { return }
                    self.fail()
                }
            }
            updatePreload()
        }
        func load(_ source: TaskMediaSource) {
            documentID = UUID().uuidString
            documentReady = false; preloaded = ""
            guard let html = TaskWorkspaceMediaPolicy.wrapper(url: source.url, name: name, video: video, documentID: documentID, actions: video && actions != nil, requiresCapability: requiresCapability, inline: inline) else { fail(); return }
            view?.loadHTMLString(html, baseURL: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["id"] as? String == documentID, body["event"] as? String == "context",
               let x = body["x"] as? Double, let y = body["y"] as? Double, x.isFinite, y.isFinite, let view, x >= 0, y >= 0, x <= view.bounds.width, y <= view.bounds.height,
               video, let actions, let exporter { contextMenu.show(at: CGPoint(x: x, y: y), in: view, source: actions, controller: exporter); return }
            guard message.frameInfo.isMainFrame, let value = message.body as? [String: String], value["id"] == documentID, let event = value["event"], ["play", "pause", "ended", "error"].contains(event) else { return }
            let replacement = state.event(event)
            if sourceFailed && !state.hasPlayed { fail() }
            else if let replacement { load(replacement) }
            else if event == "error" { fail() }
        }
        func pause() { view?.evaluateJavaScript("document.getElementById('media')?.pause()", completionHandler: nil) }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { documentReady = true; updatePreload() }
        func updatePreload() {
            guard inline, documentReady, preloaded != documentID, let view, view.window != nil, !view.bounds.isEmpty else { return }
            #if os(macOS)
            guard view.window?.isVisible == true else { return }
            var scrolls: [NSScrollView] = [], ancestor = view.superview
            while let current = ancestor { if let scroll = current as? NSScrollView { scrolls.append(scroll) }; ancestor = current.superview }
            if viewportIDs != scrolls.map(ObjectIdentifier.init) {
                unbindViewport(); viewportIDs = scrolls.map(ObjectIdentifier.init)
                for scroll in scrolls { scroll.contentView.postsBoundsChangedNotifications = true; viewportObservers.append(NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification, object: scroll.contentView, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.updatePreload() } }) }
            }
            let near = scrolls.isEmpty ? !view.visibleRect.isEmpty : MarkdownVideoLayout.near(scrolls.map { (view.convert(view.bounds, to: $0.contentView), $0.contentView.bounds) })
            #else
            var scrolls: [UIScrollView] = [], ancestor = view.superview
            while let current = ancestor { if let scroll = current as? UIScrollView { scrolls.append(scroll) }; ancestor = current.superview }
            if viewportIDs != scrolls.map(ObjectIdentifier.init) {
                unbindViewport(); viewportIDs = scrolls.map(ObjectIdentifier.init)
                for scroll in scrolls { viewportObservers.append(scroll.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in MainActor.assumeIsolated { self?.updatePreload() } }) }
            }
            let near = scrolls.isEmpty ? view.window.map { view.convert(view.bounds, to: $0).intersects($0.bounds) } ?? false : MarkdownVideoLayout.near(scrolls.map { (view.convert(view.bounds, to: $0), $0.bounds) })
            #endif
            if near {
                preloaded = documentID; unbindViewport()
                view.evaluateJavaScript("(()=>{const m=document.getElementById('media');if(m){m.preload='metadata';if(m.readyState===0&&m.paused&&!m.played.length)m.load()}})()", completionHandler: nil)
            }
        }
        func unbindViewport() {
            #if os(macOS)
            for observer in viewportObservers { NotificationCenter.default.removeObserver(observer) }; viewportObservers = []
            #else
            viewportObservers.forEach { $0.invalidate() }; viewportObservers = []
            #endif
            viewportIDs = []
        }
        func fail() { failure(video ? "视频暂时无法加载" : "音频暂时无法加载") }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { fail() } }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { if (error as NSError).code != NSURLErrorCancelled { fail() } }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail() }
        func dismantle(_ view: WKWebView) {
            unbindViewport(); (view as? TaskMediaWebView)?.geometryChanged = nil
            documentID = ""; pause(); view.stopLoading(); view.navigationDelegate = nil; view.uiDelegate = nil
            view.configuration.userContentController.removeScriptMessageHandler(forName: "fridayMedia"); self.view = nil; failure = { _ in }
            #if !os(macOS)
            contextMenu.detach()
            #endif
            actions = nil; exporter = nil
        }
    }
}
#if os(macOS)
extension TaskWorkspaceMediaNativeView: NSViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateNSView(_ view: WKWebView, context: Context) { context.coordinator.update(self) }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) { coordinator.dismantle(view) }
}
#else
extension TaskWorkspaceMediaNativeView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> WKWebView { context.coordinator.makeView() }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.update(self) }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.dismantle(view) }
}
#endif
