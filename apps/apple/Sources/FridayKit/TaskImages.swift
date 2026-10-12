import SwiftUI
import UniformTypeIdentifiers

/// Bounded thumbnails shared by the composer and persisted user messages.
struct TaskImageRail: View {
    @ObservedObject var store: FridayStore
    let images: [IdeaImage]
    var remove: ((String) -> Void)? = nil
    var disabled = false
    var wraps = false
    @State private var preview: IdeaImage?
    @State private var previewImages: [IdeaImage] = []

    var body: some View {
        Group {
            if wraps {
                LazyVGrid(columns: [GridItem(.fixed(100), spacing: 10), GridItem(.fixed(100))], alignment: .leading, spacing: 10) {
                    ForEach(images) { image in thumbnail(image) }
                }.frame(width: 210, alignment: .leading)
            } else {
                ScrollView(.horizontal) {
                    HStack(spacing: 10) { ForEach(images) { image in thumbnail(image) } }.padding(.vertical, 2)
                }
                // A horizontal ScrollView has no intrinsic height. The composer
                // measures its ideal height, so reserve the thumbnail and caption.
                .frame(height: 100).scrollIndicators(.hidden)
            }
        }.sheet(item: $preview) { image in TaskImagePreview(store: store, images: previewImages, selected: image.id) }
    }

    private func thumbnail(_ image: IdeaImage) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Button { previewImages = images; preview = image } label: {
                IdeaImageView(store: store, image: image, thumbnail: true)
                    .frame(width: 100, height: 76).clipped()
            }.buttonStyle(FridaySymbolButtonStyle())
                .accessibilityLabel(Text(friday: "预览图片") + Text(verbatim: "，" + image.name))
                .overlay(alignment: .topTrailing) {
                    if let remove {
                        Button { remove(image.id) } label: {
                            FridaySymbolImage(systemName: "xmark").font(.system(size: 9, weight: .semibold))
                                .frame(width: 22, height: 22).background(.regularMaterial, in: Circle())
                        }.buttonStyle(FridaySymbolButtonStyle()).disabled(disabled)
                            .accessibilityLabel(Text(friday: "移除图片") + Text(verbatim: "，" + image.name))
                            .padding(4)
                    }
                }
            if !wraps {
                Text(image.name).font(.system(size: 10)).foregroundStyle(.secondary)
                    .lineLimit(1).frame(width: 100, alignment: .leading)
            }
        }
    }
}

private struct TaskImagePreview: View {
    @ObservedObject var store: FridayStore
    let images: [IdeaImage]
    @State var selected: String
    @State private var zoom: CGFloat = 1
    @GestureState private var magnification: CGFloat = 1
    private var displayedZoom: CGFloat { min(4, max(1, zoom * magnification)) }
    @Environment(\.dismiss) private var dismiss
    private var index: Int { images.firstIndex { $0.id == selected } ?? 0 }
    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Text(images[index].name).font(.headline).lineLimit(1)
                Spacer()
                Text("\(index + 1) / \(images.count)").font(.caption).foregroundStyle(.secondary)
                Button { zoom = max(1, zoom - 0.5) } label: { FridaySymbolImage(systemName: "minus.magnifyingglass").frame(width: 28, height: 28) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(zoom <= 1).accessibilityLabel(Text(friday: "缩小图片"))
                Button { zoom = min(4, zoom + 0.5) } label: { FridaySymbolImage(systemName: "plus.magnifyingglass").frame(width: 28, height: 28) }
                    .buttonStyle(FridaySymbolButtonStyle()).disabled(zoom >= 4).accessibilityLabel(Text(friday: "放大图片"))
                Button { dismiss() } label: { FridaySymbolImage(systemName: "xmark").frame(width: 28, height: 28) }
                    .buttonStyle(FridaySymbolButtonStyle()).accessibilityLabel(Text(friday: "关闭"))
                    .keyboardShortcut(.cancelAction)
            }
            GeometryReader { geometry in
                ScrollView([.horizontal, .vertical]) {
                    IdeaImageView(store: store, image: images[index], maximumHeight: max(1, geometry.size.height * displayedZoom)).id(selected)
                        .frame(width: max(1, geometry.size.width * displayedZoom), height: max(1, geometry.size.height * displayedZoom))
                }
                .simultaneousGesture(MagnificationGesture().updating($magnification) { value, state, _ in state = value }
                    .onEnded { zoom = min(4, max(1, zoom * $0)) })
            }
            if images.count > 1 {
                HStack(spacing: 24) {
                    Button { selected = images[index - 1].id } label: { FridaySymbolImage(systemName: "chevron.left") }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(index == 0).accessibilityLabel(Text(friday: "上一张"))
                    Button { selected = images[index + 1].id } label: { FridaySymbolImage(systemName: "chevron.right") }
                        .buttonStyle(FridaySymbolButtonStyle()).disabled(index == images.count - 1).accessibilityLabel(Text(friday: "下一张"))
                }
            }
        }.padding(20).onChange(of: selected) { _, _ in zoom = 1 }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 760, minHeight: 400, idealHeight: 620)
        #endif
    }
}

enum TaskImageImport {
    static func data(from provider: NSItemProvider) async throws -> (Data, String) {
        // A Finder URL is preferable to the provider's generic file representation.
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let url: URL = try await withCheckedThrowingContinuation { continuation in
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let url = value as? URL { continuation.resume(returning: url) }
                    else if let data = value as? Data, let url = URL(dataRepresentation: data, relativeTo: nil) { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: ConnectionError.message("无法读取图片文件。")) }
                }
            }
            return try read(url)
        }
        guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else {
            throw ConnectionError.message("请选择图片文件。")
        }
        let data: Data = try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: ConnectionError.message("无法读取图片。")) }
            }
        }
        return (data, provider.suggestedName ?? "粘贴的图片.png")
    }
    static func read(_ url: URL) throws -> (Data, String) {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        guard values.contentType?.conforms(to: .image) == true else { throw ConnectionError.message("请选择图片文件。") }
        guard (values.fileSize ?? 0) <= 30 * 1024 * 1024 else { throw ConnectionError.message("请选择小于 30 MB 的图片。") }
        return (try Data(contentsOf: url), url.lastPathComponent)
    }
}
