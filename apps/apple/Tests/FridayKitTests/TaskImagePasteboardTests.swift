import AppKit
import UniformTypeIdentifiers

@main
struct TaskImagePasteboardTests {
    @MainActor static func main() async throws {
        // A private pasteboard keeps these data tests away from the user's clipboard.
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let red = NSColor(deviceRed: 1, green: 0, blue: 0, alpha: 1)
        for x in 0..<2 { for y in 0..<2 { bitmap.setColor(red, atX: x, y: y) } }
        let png = bitmap.representation(using: .png, properties: [:])!
        let tiff = bitmap.tiffRepresentation!
        let jpeg = bitmap.representation(using: .jpeg, properties: [:])!

        for (type, data) in [(NSPasteboard.PasteboardType.png, png), (.tiff, tiff), (NSPasteboard.PasteboardType(UTType.jpeg.identifier), jpeg)] {
            pasteboard.clearContents(); pasteboard.setData(data, forType: type)
            precondition(TaskImagePasteboard.containsImages(in: pasteboard))
            let providers = TaskImagePasteboard.providers(from: pasteboard)
            precondition(providers.count == 1)
            let imported = try await bytes(from: providers[0], type: type.rawValue)
            precondition(imported == data)
        }

        let first = NSPasteboardItem(); first.setData(png, forType: .png); first.setData(tiff, forType: .tiff)
        let second = NSPasteboardItem(); second.setData(jpeg, forType: NSPasteboard.PasteboardType(UTType.jpeg.identifier))
        pasteboard.clearContents(); pasteboard.writeObjects([first, second])
        let multiple = TaskImagePasteboard.providers(from: pasteboard)
        precondition(multiple.count == 2, "Alternate formats must not duplicate an attachment")
        let preferred = try await bytes(from: multiple[0], type: UTType.png.identifier)
        precondition(preferred == png)

        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try png.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        pasteboard.clearContents(); pasteboard.writeObjects([file as NSURL])
        precondition(TaskImagePasteboard.containsImages(in: pasteboard))
        precondition(TaskImagePasteboard.providers(from: pasteboard).count == 1)

        pasteboard.clearContents(); pasteboard.setString("Plain text", forType: .string)
        precondition(!TaskImagePasteboard.containsImages(in: pasteboard))
        precondition(TaskImagePasteboard.providers(from: pasteboard).isEmpty)
        print("Task image clipboard data checks passed (PNG, TIFF, JPEG, multiple images, file URL, text)")
    }

    private static func bytes(from provider: NSItemProvider, type: String) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                if let error { continuation.resume(throwing: error) }
                else if let data { continuation.resume(returning: data) }
                else { continuation.resume(throwing: CocoaError(.fileReadUnknown)) }
            }
        }
    }
}
