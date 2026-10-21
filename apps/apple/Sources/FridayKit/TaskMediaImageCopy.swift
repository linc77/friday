import Foundation
import ImageIO
@preconcurrency import WebKit

/// Same PNG clipboard contract and 64-million-pixel ceiling as T3's readMediaPng.
enum TaskMediaImageCopy {
    static func rasterPNG(_ file: TaskMediaDownloadedFile) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let bytes = try Data(contentsOf: file.url, options: .mappedIfSafe)
            if file.mimeType == "image/png" { return bytes }
            guard let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = props[kCGImagePropertyPixelWidth] as? NSNumber, let height = props[kCGImagePropertyPixelHeight] as? NSNumber,
                  width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 64_000_000 else { throw TaskMediaExportError.invalidFile }
            guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil), let png = MarkdownImageFile.png(image) else { throw TaskMediaExportError.invalidFile }
            return png
        }.value
    }
    @MainActor static func png(_ file: TaskMediaDownloadedFile) async throws -> Data {
        if file.mimeType == "image/svg+xml" {
            let bytes = try Data(contentsOf: file.url, options: .mappedIfSafe)
            guard MarkdownSVGImage.document(bytes) != nil else { throw TaskMediaExportError.invalidFile }
            return try await TaskMediaSVGCopy().convert(bytes)
        }
        return try await rasterPNG(file)
    }
}

@MainActor private final class TaskMediaSVGCopy: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    private var view: WKWebView?
    private var continuation: CheckedContinuation<Data, Error>?
    private var timeout: Task<Void, Never>?
    private let id = UUID().uuidString
    func convert(_ bytes: Data) async throws -> Data {
        try await withTaskCancellationHandler(operation: {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let configuration = WKWebViewConfiguration(); configuration.userContentController.add(self, name: "png")
                let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration); self.view = view; view.navigationDelegate = self
                let html = """
                <!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-\(id)'"><script nonce="\(id)">
                (()=>{const done=png=>window.webkit.messageHandlers.png.postMessage({id:'\(id)',png});const image=new Image();image.onload=()=>{try{const w=image.naturalWidth,h=image.naturalHeight;if(w<=0||h<=0||w*h>64000000){done('');return}const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const context=canvas.getContext('2d');if(!context){done('');return}context.drawImage(image,0,0);done(canvas.toDataURL('image/png'))}catch{done('')}};image.onerror=()=>done('');image.src='data:image/svg+xml;base64,\(bytes.base64EncodedString())'})();</script>
                """
                view.loadHTMLString(html, baseURL: nil)
                timeout = Task { [weak self] in do { try await Task.sleep(for: .seconds(20)) } catch { return }; self?.finish(.failure(TaskMediaExportError.invalidFile)) }
            }
        }, onCancel: { Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) } })
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: String], body["id"] == id else { return }
        guard let value = body["png"], value.hasPrefix("data:image/png;base64,"), let data = Data(base64Encoded: String(value.dropFirst(22))), !data.isEmpty else { finish(.failure(TaskMediaExportError.invalidFile)); return }
        finish(.success(data))
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) { decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) { finish(.failure(error)) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(.failure(TaskMediaExportError.invalidFile)) }
    private func finish(_ result: Result<Data, Error>) {
        guard let continuation else { return }; self.continuation = nil
        timeout?.cancel(); timeout = nil; view?.configuration.userContentController.removeScriptMessageHandler(forName: "png"); view?.navigationDelegate = nil; view?.stopLoading(); view = nil
        continuation.resume(with: result)
    }
}
