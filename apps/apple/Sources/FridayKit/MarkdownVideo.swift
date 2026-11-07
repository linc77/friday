import SwiftUI

enum MarkdownMediaKind {
    static func link(_ raw: String, workspace: String?) -> URL? {
        switch MarkdownMediaSource.classify(raw, workspacePath: workspace) {
        case .remote(let url): return url
        case .hostFile(let path): return URL(string: URL(fileURLWithPath: path).absoluteString + fragment(raw))
        case .blocked: return nil
        }
    }
    static func video(_ raw: String) -> Bool {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let unwrapped = value.hasPrefix("<") && value.hasSuffix(">") ? String(value.dropFirst().dropLast()) : value
        let path = URLComponents(string: unwrapped)?.path ?? String(unwrapped.prefix { $0 != "?" && $0 != "#" }).removingPercentEncoding ?? unwrapped
        return ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
    }
    static func fragment(_ raw: String) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = value.hasPrefix("<") && value.hasSuffix(">") ? String(value.dropFirst().dropLast()) : value
        return text.firstIndex(of: "#").map { String(text[$0...]) } ?? ""
    }
}
struct MarkdownMediaDimension: Decodable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let number: Double?
        if let numeric = try? container.decode(Double.self) { number = numeric }
        else if let string = try? container.decode(String.self) { number = Self.number(string) }
        else { number = nil }
        value = number.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
    }
    static func number(_ input: String) -> Double? {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        for (prefix, radix) in [("0x", 16), ("0b", 2), ("0o", 8)] where value.hasPrefix(prefix) { return UInt64(value.dropFirst(2), radix: radix).map(Double.init) }
        return Double(value)
    }
}
enum MarkdownVideoLayout {
    static func near(frame: CGRect, viewport: CGRect) -> Bool { near([(frame, viewport)]) }
    static func near(_ clippings: [(frame: CGRect, viewport: CGRect)]) -> Bool {
        !clippings.isEmpty && clippings.enumerated().allSatisfy { index, clip in
            let viewport = index == clippings.count - 1 ? clip.viewport.insetBy(dx: -200, dy: -200) : clip.viewport
            return !clip.frame.isEmpty && !viewport.isEmpty && clip.frame.intersects(viewport)
        }
    }
    static func size(available: Double, width: Double?, height: Double?) -> CGSize {
        let w = width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }, h = height.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let authored = w != nil && h != nil ? w! / h! : 16.0 / 9
        let ratio = authored.isFinite && authored > 0 ? authored : 16.0 / 9
        let limit = min(480, max(1, available), w ?? 480, min(480, w == nil ? h ?? 480 : 480) * ratio)
        return CGSize(width: limit, height: limit / ratio)
    }
    static func image(natural: CGSize, available: Double, width: Double?, height: Double?) -> CGSize {
        let authoredWidth = width.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }, authoredHeight = height.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        if let authoredWidth, let authoredHeight { return size(available: available, width: authoredWidth, height: authoredHeight) }
        guard natural.width > 0, natural.height > 0, natural.width.isFinite, natural.height.isFinite else { return .zero }
        let ratio = natural.width / natural.height
        let w = min(max(1, available), 480, natural.width, authoredWidth ?? 480, min(480, authoredHeight ?? 480) * ratio)
        return CGSize(width: w, height: w / ratio)
    }
}
struct MarkdownVideoPreview: Identifiable { let id = UUID(); let image: MarkdownImage }

struct MarkdownVideoView: View {
    let image: MarkdownImage
    let workspacePath: String?
    var expanded = false
    @Environment(\.markdownMediaContext) private var context
    @Environment(\.taskFileOpen) private var fileOpen
    @State private var url: URL?
    @State private var loadedKey = ""
    @State private var failure: String?
    @State private var sourceFailed = false
    @State private var retry = 0
    @State private var refreshedAfterFailure = false
    @State private var width: CGFloat = 480
    @StateObject private var exporter = TaskMediaExportController()
    private var source: MarkdownMediaSource { .classify(image.source, workspacePath: workspacePath) }
    private var githubSource: URL? {
        if case .remote(let url) = source, GitHubMediaPolicy.supports(url), context?.githubRequest != nil { return url }; return nil
    }
    private var identity: String { (context?.id ?? "public") + ":" + image.source }
    // ChatMarkdown's video has stable playback identity; signing or a new turn
    // may refresh the URL but must not reset an already-started playhead.
    private var revision: String { String(retry) }
    private var requestID: String { identity + ":" + (source.isHostFile ? context?.revision ?? "" : "public") + ":\(retry)" }
    private var actions: TaskMediaActionSource? {
        switch source {
        case .remote(let url):
            if githubSource != nil, let context { return TaskMediaActionSource(kind: .video, reference: .remote(url), name: url.lastPathComponent.isEmpty ? "video" : url.lastPathComponent,
                prepare: { TaskMediaExportRequest(request: URLRequest(url: try await context.githubAssetURL(url, refresh: true)), publicRedirects: false) }) }
            return TaskMediaActionSource(kind: .video, reference: .remote(url), name: url.lastPathComponent.isEmpty ? "video" : url.lastPathComponent,
            prepare: { TaskMediaExportRequest(request: URLRequest(url: url), publicRedirects: true) })
        case .hostFile(let path):
            let request = try? context?.assetRequest?(path)
            var result = TaskMediaActionSource(kind: .video, reference: .file(path, root: context?.workspaceRoot), name: URL(fileURLWithPath: path).lastPathComponent,
                prepare: request.map { request in { TaskMediaExportRequest(request: URLRequest(url: try await MarkdownMediaContext.assetURL(request, root: context?.workspaceRoot)), publicRedirects: false) } })
            if let root = context?.workspaceRoot, let fileOpen, root == fileOpen.root, let path = result.reference.text(for: .copyRelativePath) { result.openFile = { fileOpen.open(TaskFileLocation(path: path)) } }
            return result
        case .blocked: return nil
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let url = loadedKey == identity ? url : nil, failure == nil {
                TaskWorkspaceMediaView(url: url, revision: revision, name: image.alt.isEmpty ? "video" : image.alt, video: true, sourceFailed: sourceFailed, failure: mediaFailed, actions: actions, requiresCapability: source.isHostFile || githubSource != nil, inline: !expanded, exporterOverride: exporter)
                    .frame(width: expanded ? nil : MarkdownVideoLayout.size(available: width, width: image.width, height: image.height).width,
                           height: expanded ? nil : MarkdownVideoLayout.size(available: width, width: image.width, height: image.height).height)
                    .frame(maxWidth: expanded ? .infinity : 480, maxHeight: expanded ? .infinity : 480, alignment: .leading)
            } else if failure != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text(friday: "视频暂时无法加载").foregroundStyle(.secondary)
                    if !image.alt.isEmpty { Text(verbatim: image.alt).font(.caption) }
                    Button(friday: "重新加载") { url = nil; loadedKey = ""; failure = nil; retry += 1 }.buttonStyle(FridayButtonStyle(compact: true))
                    if let target = source.isHostFile ? url : MarkdownLinkPolicy.remoteImage(image.source) {
                        Link(destination: target) { Text(friday: "打开原链接") }.environment(\.openURL, OpenURLAction { .systemAction($0) })
                    }
                }.padding(16).frame(maxWidth: expanded ? .infinity : 480, alignment: .leading)
                    .taskMediaActions(actions, controller: exporter).taskMediaExportStatus(exporter)
            } else { ProgressView().controlSize(.small).frame(width: min(width, 480), height: min(width, 480) * 9 / 16) }
        }.frame(maxWidth: .infinity, maxHeight: expanded ? .infinity : nil, alignment: .leading)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { if $0 > 0 { width = $0 } }
            .task(id: requestID) {
                if loadedKey != identity { url = nil; refreshedAfterFailure = false }; failure = nil; sourceFailed = false
                let key = identity, fragment = MarkdownMediaKind.fragment(image.source)
                do {
                    let resolved: URL
                    switch source {
                    case .remote(let value):
                        if githubSource != nil, let context {
                            let asset = try await context.githubAssetURL(value, refresh: retry > 0)
                            guard let target = URL(string: asset.absoluteString + fragment) else { throw URLError(.badURL) }; resolved = target
                        } else { resolved = value }
                    case .hostFile(let path):
                        guard let context, let request = try context.assetRequest?(path) else { throw TaskMediaExportError.unavailable }
                        let asset = try await MarkdownMediaContext.assetURL(request, root: context.workspaceRoot)
                        guard let value = URL(string: asset.absoluteString + fragment) else { throw URLError(.badURL) }; resolved = value
                    case .blocked: throw URLError(.badURL)
                    }
                    guard !Task.isCancelled, identity == key else { return }; url = resolved; loadedKey = key
                } catch {
                    if !Task.isCancelled, identity == key {
                        if url != nil, loadedKey == key { sourceFailed = true }
                        else { failure = error.localizedDescription }
                    }
                }
            }
    }
    private func mediaFailed(_ message: String) {
        if githubSource != nil && !refreshedAfterFailure { refreshedAfterFailure = true; retry += 1 }
        else { failure = message }
    }
}
extension MarkdownMediaSource { var isHostFile: Bool { if case .hostFile = self { true } else { false } } }

struct MarkdownVideoPreviewView: View {
    let preview: MarkdownVideoPreview; let workspacePath: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 12) {
            HStack { Text(verbatim: preview.image.alt.isEmpty ? "video" : preview.image.alt).font(.headline).lineLimit(1); Spacer(); Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭")).keyboardShortcut(.cancelAction) }
            MarkdownVideoView(image: preview.image, workspacePath: workspacePath, expanded: true)
        }.padding(20)
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 1000, minHeight: 320, idealHeight: 720)
        #endif
    }
}
