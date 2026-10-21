import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif
import ImageIO
import CoreGraphics

enum MarkdownDecodedImage: @unchecked Sendable {
    case raster(CGImage), webImage(MermaidDiagram)
    static func decode(_ bytes: MarkdownMediaBytes) -> Self? {
        if let source = CGImageSourceCreateWithData(bytes.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
           let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
               kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: 4096, kCGImageSourceShouldCacheImmediately: true] as CFDictionary) {
            let kind = CGImageSourceGetType(source).map { $0 as String } ?? ""
            let mime = ["com.compuserve.gif": "image/gif", "public.png": "image/png", "org.webmproject.webp": "image/webp", "public.avif": "image/avif"][kind]
            if CGImageSourceGetCount(source) > 1, let mime, let animated = MarkdownSVGImage.embedded(bytes.data, mime: mime, width: Double(image.width), height: Double(image.height)) { return .webImage(animated) }
            return .raster(image)
        }
        guard let svg = MarkdownSVGImage.document(bytes.data) else { return nil }; return .webImage(svg)
    }
}

/// SVG stays an image resource, never inline authored markup. The surrounding
/// WebKit view has scripts disabled and no access to the filesystem or network.
enum MarkdownSVGImage {
    private final class Dimensions: NSObject, XMLParserDelegate {
        var size: (Double, Double)?
        func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes: [String: String]) {
            defer { parser.abortParsing() }
            guard elementName == "svg", namespaceURI == nil || namespaceURI == "" || namespaceURI == "http://www.w3.org/2000/svg" else { return }
            let viewBox = attributes["viewBox"]?.split(whereSeparator: { $0.isWhitespace || $0 == "," }).compactMap { Double($0) }
            func length(_ value: String?) -> Double? {
                guard var value else { return nil }; if value.hasSuffix("px") { value.removeLast(2) }; return Double(value)
            }
            let width = length(attributes["width"]) ?? (viewBox?.count == 4 ? viewBox?[2] : nil) ?? 300
            let height = length(attributes["height"]) ?? (viewBox?.count == 4 ? viewBox?[3] : nil) ?? 150
            guard width.isFinite, height.isFinite, width > 0, height > 0, width <= 100_000, height <= 100_000 else { return }
            size = (width, height)
        }
        func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? { nil }
    }
    static func document(_ data: Data) -> MermaidDiagram? {
        guard data.count <= 6 * 1024 * 1024 else { return nil }
        let parser = XMLParser(data: data), delegate = Dimensions()
        parser.delegate = delegate; parser.shouldProcessNamespaces = true; parser.shouldResolveExternalEntities = false; parser.externalEntityResolvingPolicy = .never
        _ = parser.parse()
        guard let (width, height) = delegate.size else { return nil }
        return embedded(data, mime: "image/svg+xml", width: width, height: height)
    }
    static func embedded(_ data: Data, mime: String, width: Double, height: Double) -> MermaidDiagram? {
        guard data.count <= 6 * 1024 * 1024 - 512, ["image/svg+xml", "image/gif", "image/png", "image/webp", "image/avif"].contains(mime) else { return nil }
        let wrapper = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 \(width) \(height)\" width=\"\(width)\" height=\"\(height)\"><image width=\"\(width)\" height=\"\(height)\" href=\"data:\(mime);base64,\(data.base64EncodedString())\"/></svg>"
        return MermaidDiagram(svg: wrapper, width: width, height: height)
    }
}
