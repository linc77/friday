import SwiftUI
import CryptoKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum IdeaImageCache {
    private static func url(_ id: String) throws -> URL {
        guard id.count == 64, id.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw ConnectionError.message("图片 ID 无效") }
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Friday/ClientImages", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return root.appendingPathComponent(id)
    }
    /// Note autosave checks metadata only; typing must not read every BLOB.
    static func prepareLocalData(_ id: String) throws -> Bool {
        let database = try ClientNoteDatabase.shared.get()
        if try database.imageByteCount(id) != nil { return true }
        let data: Data
        do { data = try Data(contentsOf: url(id)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return false }
        try database.storeImage(data, id: id)
        return true
    }
    static func localData(_ id: String) -> Data? {
        guard (try? prepareLocalData(id)) == true else { return nil }
        return try? ClientNoteDatabase.shared.get().image(id)
    }
    static func byteCount(_ id: String) -> Int {
        guard (try? prepareLocalData(id)) == true else { return 0 }
        return (try? ClientNoteDatabase.shared.get().imageByteCount(id)) ?? 0
    }
    static func store(_ data: Data, id: String) throws { try ClientNoteDatabase.shared.get().storeImage(data, id: id) }

    @MainActor static func importImage(_ data: Data, name: String) throws -> IdeaImage {
        guard data.count <= 30 * 1024 * 1024 else { throw ConnectionError.message("请选择小于 30 MB 的图片。") }
        #if os(macOS)
        guard let original = NSImage(data: data), original.size.width > 0, original.size.height > 0 else { throw ConnectionError.message("无法读取这张图片。") }
        #else
        guard let original = UIImage(data: data), original.size.width > 0, original.size.height > 0 else { throw ConnectionError.message("无法读取这张图片。") }
        #endif
        let mediaType: String? = data.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? "image/png"
            : data.starts(with: [0xff, 0xd8, 0xff]) ? "image/jpeg"
            : data.starts(with: Data("GIF87a".utf8)) || data.starts(with: Data("GIF89a".utf8)) ? "image/gif"
            : data.starts(with: Data("RIFF".utf8)) && data.dropFirst(8).starts(with: Data("WEBP".utf8)) ? "image/webp" : nil
        if let mediaType, data.count <= 10 * 1024 * 1024 {
            let id = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            try store(data, id: id)
            return IdeaImage(id: id, name: String(name.prefix(255)), mediaType: mediaType)
        }
        let ratio = min(1, 2000 / max(original.size.width, original.size.height))
        #if os(macOS)
        let size = NSSize(width: max(1, original.size.width * ratio), height: max(1, original.size.height * ratio))
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { throw ConnectionError.message("无法处理这张图片。") }
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        original.draw(in: NSRect(origin: .zero, size: size)); NSGraphicsContext.restoreGraphicsState()
        guard let normalized = bitmap.representation(using: .png, properties: [:]) else { throw ConnectionError.message("无法处理这张图片。") }
        #else
        let size = CGSize(width: max(1, original.size.width * ratio), height: max(1, original.size.height * ratio))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let scaled = UIGraphicsImageRenderer(size: size, format: format).image { _ in original.draw(in: CGRect(origin: .zero, size: size)) }
        guard let normalized = scaled.pngData() else { throw ConnectionError.message("无法处理这张图片。") }
        #endif
        guard normalized.count <= 10 * 1024 * 1024 else { throw ConnectionError.message("处理后的图片仍超过 10 MB，请选择较小的图片。") }
        let id = SHA256.hash(data: normalized).map { String(format: "%02x", $0) }.joined()
        try store(normalized, id: id)
        return IdeaImage(id: id, name: String(name.prefix(255)), mediaType: "image/png")
    }
}

struct IdeaImageView: View {
    @Bindable var store: FridayStore
    let image: IdeaImage
    var thumbnail = false
    var thumbnailHeight: CGFloat = 120
    var maximumHeight: CGFloat = 700
    var onImageSize: ((CGSize) -> Void)? = nil
    @State private var rendered: Image?
    @State private var failed = false
    @State private var retry = 0
    var body: some View {
        Group {
            if let rendered {
                if thumbnail { rendered.resizable().scaledToFill().frame(height: thumbnailHeight).clipped() }
                else { rendered.resizable().scaledToFit().frame(maxHeight: maximumHeight) }
            } else if failed {
                Button { retry += 1 } label: { FridaySymbolLabel(friday: "重新加载图片", systemImage: "arrow.clockwise") }
                    .buttonStyle(FridayButtonStyle(compact: true)).frame(maxWidth: .infinity, minHeight: thumbnail ? thumbnailHeight : 100)
            } else { ProgressView().frame(maxWidth: .infinity, minHeight: thumbnail ? thumbnailHeight : 100) }
        }
        .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .accessibilityLabel(image.name)
        .task(id: "\(image.id)-\(retry)-\(store.connected)") {
            guard rendered == nil else { return }; failed = false
            do {
                let data = try await store.imageData(image.id)
                #if os(macOS)
                guard let native = NSImage(data: data) else { throw ConnectionError.message("图片无法显示") }
                rendered = Image(nsImage: native)
                onImageSize?(native.size)
                #else
                guard let native = UIImage(data: data) else { throw ConnectionError.message("图片无法显示") }
                rendered = Image(uiImage: native)
                onImageSize?(native.size)
                #endif
            } catch { failed = true }
        }
    }
}
