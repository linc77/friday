import SwiftUI

struct MarkdownVisibleImages: PreferenceKey {
    static let defaultValue: [MarkdownImage] = []
    static func reduce(value: inout [MarkdownImage], nextValue: () -> [MarkdownImage]) { value += nextValue() }
}
struct MarkdownLoadedImage: @unchecked Sendable { let bytes: MarkdownMediaBytes; let image: MarkdownDecodedImage }

struct MarkdownImageView: View {
    let image: MarkdownImage
    let canOpenLocalFiles: Bool
    let workspacePath: String?
    var expanded = false
    var refresh = 0
    var zoom: Binding<Double> = .constant(1)
    var loaded: (MarkdownLoadedImage?) -> Void = { _ in }
    @Environment(\.markdownMediaContext) private var context
    @Environment(\.markdownExpandImage) private var expandImage
    @Environment(\.taskFileOpen) private var fileOpen
    @State private var rendered: MarkdownLoadedImage?
    @State private var failed = false
    @State private var retry = 0
    @State private var width: CGFloat = 600
    @StateObject private var exporter = TaskMediaExportController()
    @GestureState private var magnification: CGFloat = 1
    private struct LoadID: Hashable { let source: MarkdownMediaSource; let scope: String; let retry: Int }
    private var source: MarkdownMediaSource { .classify(image.source, workspacePath: workspacePath) }
    private var actions: TaskMediaActionSource? {
        guard var value = TaskMediaActionSource.image(image, workspace: workspacePath, context: context) else { return nil }
        if let root = context?.workspaceRoot, let fileOpen, root == fileOpen.root, let path = value.reference.text(for: .copyRelativePath) { value.openFile = { fileOpen.open(TaskFileLocation(path: path)) } }
        return value
    }
    private var loadID: LoadID { LoadID(source: source, scope: (context?.id ?? "") + ":" + (context?.revision ?? ""), retry: retry + refresh) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let rendered {
                if expanded { display(rendered.image) }
                else if let link = image.link, !MarkdownImageGallery.isImageLink(link),
                        let target = MarkdownLinkPolicy.target(link, workspacePath: workspacePath, canOpenLocalFiles: canOpenLocalFiles) {
                    Link(destination: target) { display(rendered.image) }.buttonStyle(.plain).fridayInteractiveCursor().accessibilityLabel(description)
                } else {
                    Button { expandImage?(MarkdownImageGallery.previewImage(image)) } label: { display(rendered.image) }
                        .buttonStyle(.plain).fridayInteractiveCursor().accessibilityLabel(description)
                        .preference(key: MarkdownVisibleImages.self, value: [MarkdownImageGallery.previewImage(image)])
                }
            } else if failed {
                VStack(alignment: .leading, spacing: 8) {
                    fallback
                    Button { retry += 1 } label: { FridaySymbolLabel(friday: "重新加载图片", systemImage: "arrow.clockwise") }
                        .buttonStyle(FridaySymbolButtonStyle()).font(.caption)
                }.frame(maxWidth: .infinity, minHeight: expanded ? 120 : 48, alignment: .leading)
            } else {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text(verbatim: image.alt).foregroundStyle(.secondary) }
                    .frame(maxWidth: .infinity, minHeight: expanded ? 120 : 48, alignment: .leading)
            }
        }
        .taskMediaActions(actions, controller: exporter)
        .taskMediaExportStatus(exporter)
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { if $0 > 0 { width = $0 } }
        .task(id: loadID) {
            rendered = nil; failed = false; loaded(nil)
            do {
                let bytes: MarkdownMediaBytes
                switch source {
                case .remote(let url):
                    if GitHubMediaPolicy.supports(url), let context, context.githubRequest != nil { bytes = try await context.githubImage(url, refresh: retry > 0 || refresh > 0) }
                    else { bytes = try await MarkdownMediaLoader.shared.load(URLRequest(url: url), scope: "public", authenticated: false, refresh: retry > 0 || refresh > 0) }
                case .hostFile(let path):
                    guard let context else { throw URLError(.resourceUnavailable) }
                    bytes = try await MarkdownMediaLoader.shared.load(context.request(path), scope: context.id + ":" + context.revision, authenticated: true, refresh: retry > 0 || refresh > 0)
                case .blocked: throw URLError(.badURL)
                }
                let decoded = await Task.detached(priority: .userInitiated) { MarkdownDecodedImage.decode(bytes) }.value
                guard !Task.isCancelled else { return }; guard let decoded else { throw URLError(.cannotDecodeContentData) }
                let result = MarkdownLoadedImage(bytes: bytes, image: decoded); rendered = result; loaded(result)
            } catch { if !Task.isCancelled { failed = true; loaded(nil) } }
        }
    }
    @ViewBuilder private func display(_ value: MarkdownDecodedImage) -> some View {
        switch value {
        case .raster(let raster):
            if expanded {
                GeometryReader { geometry in
                    ScrollView([.horizontal, .vertical]) {
                        Image(decorative: raster, scale: 1).resizable().scaledToFit()
                            .frame(width: max(1, geometry.size.width * zoom.wrappedValue * magnification), height: max(1, geometry.size.height * zoom.wrappedValue * magnification))
                            .frame(minWidth: geometry.size.width, minHeight: geometry.size.height)
                    }.simultaneousGesture(MagnificationGesture().updating($magnification) { value, state, _ in state = value }
                        .onEnded { zoom.wrappedValue = min(8, max(0.25, zoom.wrappedValue * $0)) })
                }
            } else {
                let size = MarkdownVideoLayout.image(natural: CGSize(width: raster.width, height: raster.height), available: width, width: image.width, height: image.height)
                Image(decorative: raster, scale: 1).resizable().scaledToFit().frame(width: size.width, height: size.height).clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(0.12), lineWidth: 1) }
            }
        case .webImage(let diagram):
            if expanded {
                MermaidSVGView(diagram: diagram, expanded: true, embeddedImages: true, zoom: zoom, failure: { _ in failed = true; rendered = nil; loaded(nil) })
            } else {
                let size = MarkdownVideoLayout.image(natural: CGSize(width: diagram.width, height: diagram.height), available: width, width: image.width, height: image.height)
                MermaidSVGView(diagram: diagram, embeddedImages: true, failure: { _ in failed = true; rendered = nil; loaded(nil) })
                    .frame(width: size.width, height: size.height).allowsHitTesting(false)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(0.12), lineWidth: 1) }
            }
        }
    }
    private var description: Text {
        if !image.alt.isEmpty { return Text(verbatim: image.alt) }
        if let title = image.title, !title.isEmpty { return Text(verbatim: title) }; return Text(friday: "图片")
    }
    private var fallback: some View {
        Group {
            if let target = MarkdownLinkPolicy.target(image.link ?? image.source, workspacePath: workspacePath, canOpenLocalFiles: canOpenLocalFiles) {
                Link(destination: target) { FridaySymbolLabel(image.alt.isEmpty ? image.source : image.alt, systemImage: "photo") }.buttonStyle(FridaySymbolButtonStyle())
            } else { FridaySymbolLabel(image.alt.isEmpty ? image.source : image.alt, systemImage: "photo").foregroundStyle(.secondary) }
        }
    }
}
