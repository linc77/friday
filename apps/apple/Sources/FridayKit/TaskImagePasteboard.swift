#if os(macOS)
import AppKit
import UniformTypeIdentifiers

/// Declares the same image formats to AppKit that the attachment importer reads.
enum TaskImagePasteboard {
    static let readableTypes: [NSPasteboard.PasteboardType] = [.png, .tiff, .fileURL,
        NSPasteboard.PasteboardType(UTType.jpeg.identifier),
        NSPasteboard.PasteboardType(UTType.heic.identifier),
        NSPasteboard.PasteboardType(UTType.gif.identifier),
        NSPasteboard.PasteboardType(UTType.webP.identifier)]

    static func containsImages(in pasteboard: NSPasteboard) -> Bool {
        pasteboard.types?.contains(where: { UTType($0.rawValue)?.conforms(to: .image) == true }) == true
            || !imageURLs(from: pasteboard).isEmpty
    }

    static func providers(from pasteboard: NSPasteboard) -> [NSItemProvider] {
        let urls = imageURLs(from: pasteboard)
        if !urls.isEmpty { return urls.compactMap { NSItemProvider(contentsOf: $0) } }
        return (pasteboard.pasteboardItems ?? []).compactMap { item in
            // Prefer PNG/TIFF over another representation of the same image.
            let types = [.png, .tiff] + item.types
            guard let type = types.first(where: {
                item.types.contains($0) && UTType($0.rawValue)?.conforms(to: .image) == true
            }), let data = item.data(forType: type) else { return nil }
            let provider = NSItemProvider()
            provider.registerDataRepresentation(forTypeIdentifier: type.rawValue, visibility: .all) { completion in
                completion(data, nil); return nil
            }
            return provider
        }
    }

    private static func imageURLs(from pasteboard: NSPasteboard) -> [URL] {
        let urls = (pasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
        return urls.filter { (try? $0.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) == true }
    }
}
#endif
