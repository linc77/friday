import SwiftUI
import UniformTypeIdentifiers
import ImageIO
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct MarkdownImagePreview: Identifiable {
    let id = UUID(); let images: [MarkdownImage]; let index: Int
}
enum MarkdownImageGallery {
    static func wrapped(_ index: Int, count: Int) -> Int { count > 0 ? ((index % count) + count) % count : 0 }
    static func isImageLink(_ link: String) -> Bool {
        let path = URLComponents(string: link)?.path ?? String(link.prefix { $0 != "?" && $0 != "#" })
        return ["avif", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"].contains(URL(fileURLWithPath: path).pathExtension.lowercased())
    }
    static func previewImage(_ image: MarkdownImage) -> MarkdownImage {
        guard let link = image.link, isImageLink(link), MarkdownLinkPolicy.remoteImage(link) != nil else { return image }
        return MarkdownImage(source: link, alt: image.alt, title: image.title, link: nil, galleryID: image.galleryID, width: image.width, height: image.height)
    }
    static func selection(_ image: MarkdownImage, visible: [MarkdownImage]) -> MarkdownImagePreview {
        guard let index = visible.firstIndex(where: { image.galleryID != nil ? $0.galleryID == image.galleryID : $0 == image }) else { return MarkdownImagePreview(images: [image], index: 0) }
        return MarkdownImagePreview(images: visible, index: index)
    }
    static func markdown(_ image: MarkdownImage) -> String {
        let alt = image.alt.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
        let title = image.title.map { " \"" + $0.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\"" } ?? ""
        return "![\(alt)](\(image.source)\(title))"
    }
}

struct MarkdownImageGalleryView: View {
    let preview: MarkdownImagePreview
    let workspacePath: String?
    let canOpenLocalFiles: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var zoom = 1.0
    @State private var loaded: MarkdownLoadedImage?
    @Environment(\.markdownMediaContext) private var mediaContext
    @StateObject private var exporter = TaskMediaExportController()
    @State private var copied = false
    @State private var copyID = UUID()
    @State private var refresh: [Int: Int] = [:]
    private var image: MarkdownImage { preview.images[index] }
    private var actions: TaskMediaActionSource? { .image(image, workspace: workspacePath, context: mediaContext) }
    private var type: UTType { UTType(mimeType: loaded?.bytes.mimeType ?? "") ?? (MarkdownImageGallery.isImageLink(image.source) ? UTType(filenameExtension: URL(fileURLWithPath: image.source).pathExtension) : nil) ?? .data }
    private var name: String {
        let path = URLComponents(string: image.source)?.path ?? image.source
        let name = URL(fileURLWithPath: path).lastPathComponent
        return name.isEmpty ? "image." + (type.preferredFilenameExtension ?? "png") : name
    }
    init(preview: MarkdownImagePreview, workspacePath: String?, canOpenLocalFiles: Bool) {
        self.preview = preview; self.workspacePath = workspacePath; self.canOpenLocalFiles = canOpenLocalFiles
        _index = State(initialValue: MarkdownImageGallery.wrapped(preview.index, count: preview.images.count))
    }
    var body: some View {
        VStack(spacing: 14) {
            HStack(spacing: 14) {
                Text(verbatim: image.alt.isEmpty ? name : image.alt).font(.headline).lineLimit(1).truncationMode(.middle)
                Spacer()
                if preview.images.count > 1 { Text("\(index + 1) / \(preview.images.count)").font(.caption).monospacedDigit().foregroundStyle(.secondary) }
                Button { refresh[index, default: 0] += 1 } label: { FridaySymbolImage(systemName: "arrow.clockwise") }.buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "重新加载图片"))
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark") }.buttonStyle(FridaySymbolButtonStyle()).keyboardShortcut(.cancelAction).accessibilityLabel(Text(friday: "关闭"))
            }
            MarkdownImageView(image: image, canOpenLocalFiles: canOpenLocalFiles, workspacePath: workspacePath, expanded: true, refresh: refresh[index] ?? 0, zoom: $zoom, loaded: { loaded = $0 })
                .id(index).frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack(spacing: 18) {
                if preview.images.count > 1 {
                    Button { move(-1) } label: { FridaySymbolImage(systemName: "chevron.left") }.accessibilityLabel(Text(friday: "上一张"))
                    Button { move(1) } label: { FridaySymbolImage(systemName: "chevron.right") }.accessibilityLabel(Text(friday: "下一张"))
                }
                Spacer()
                Button { zoom = max(0.25, zoom / 1.25) } label: { FridaySymbolImage(systemName: "minus.magnifyingglass") }.disabled(zoom <= 0.25).accessibilityLabel(Text(friday: "缩小"))
                Button { zoom = 1 } label: { Text("\(Int(zoom * 100))%").monospacedDigit() }.accessibilityLabel(Text(friday: "适应窗口"))
                Button { zoom = min(8, zoom * 1.25) } label: { FridaySymbolImage(systemName: "plus.magnifyingglass") }.disabled(zoom >= 8).accessibilityLabel(Text(friday: "放大"))
                Spacer()
                Menu {
                    Button(friday: "复制图片") { if let actions { exporter.perform(.copyImage, source: actions) } }.disabled(exporter.busy || actions?.prepare == nil)
                    Button(friday: "复制图片链接") { copyAgentText(image.source); copied = true; copyID = UUID() }
                    Button(friday: "复制为 Markdown") { copyAgentText(MarkdownImageGallery.markdown(image)); copied = true; copyID = UUID() }
                } label: { FridaySymbolImage(systemName: copied ? "checkmark" : "doc.on.doc") }.fridayInteractiveCursor().accessibilityLabel(Text(friday: copied ? "已复制" : "复制图片"))
                Button { if let actions { exporter.perform(.save, source: actions) } } label: { FridaySymbolImage(systemName: "square.and.arrow.down") }.disabled(exporter.busy || actions?.prepare == nil).accessibilityLabel(Text(friday: "保存图片"))
            }.buttonStyle(FridaySymbolButtonStyle()).font(.callout)
        }.padding(20).focusable().onKeyPress(.leftArrow) { move(-1); return .handled }.onKeyPress(.rightArrow) { move(1); return .handled }
        .task(id: copyID) { if copied { try? await Task.sleep(for: .milliseconds(1200)); if !Task.isCancelled { copied = false } } }
        .taskMediaExportStatus(exporter)
        #if os(macOS)
        .frame(minWidth: 420, idealWidth: 1000, minHeight: 360, idealHeight: 720)
        #endif
    }
    private func move(_ offset: Int) { index = MarkdownImageGallery.wrapped(index + offset, count: preview.images.count); zoom = 1; loaded = nil; copied = false }
}
struct MarkdownImageFile: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
    static func png(_ image: CGImage) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, nil); return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
