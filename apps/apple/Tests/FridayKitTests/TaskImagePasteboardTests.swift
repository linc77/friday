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

        let binary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".pdf")
        try Data([0, 255, 10, 128, 42]).write(to: binary)
        defer { try? FileManager.default.removeItem(at: binary) }
        pasteboard.clearContents(); pasteboard.writeObjects([binary as NSURL])
        precondition(TaskImagePasteboard.containsImages(in: pasteboard), "Copied ordinary files must enable Paste")
        let files = TaskImagePasteboard.providers(from: pasteboard)
        precondition(files.count == 1)
        let importedFile = try await TaskAttachmentImport.input(from: files[0])
        precondition(importedFile.data == Data([0, 255, 10, 128, 42]) && !importedFile.isImage && importedFile.mediaType == "application/pdf")
        precondition(importedFile.name.hasSuffix(".pdf"))
        pasteboard.clearContents(); pasteboard.writeObjects([FileManager.default.temporaryDirectory as NSURL])
        precondition(!TaskImagePasteboard.containsImages(in: pasteboard), "A folder must not become an upload")
        do { _ = try TaskAttachmentImport.read(FileManager.default.temporaryDirectory); preconditionFailure("Directories cannot be uploaded") } catch {}
        let empty = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".bin")
        FileManager.default.createFile(atPath: empty.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: empty) }
        do { _ = try TaskAttachmentImport.read(empty); preconditionFailure("Empty files cannot be uploaded") } catch {}
        let handle = try FileHandle(forWritingTo: empty); try handle.truncate(atOffset: UInt64(TaskAttachmentImport.maximumBytes + 1)); try handle.close()
        do { _ = try TaskAttachmentImport.read(empty); preconditionFailure("Oversized files must be rejected before reading") } catch {}

        pasteboard.clearContents(); pasteboard.setString("Plain text", forType: .string)
        precondition(!TaskImagePasteboard.containsImages(in: pasteboard))
        precondition(TaskImagePasteboard.providers(from: pasteboard).isEmpty)
        print("Task attachment clipboard data checks passed (PNG, TIFF, JPEG, multiple images, file uploads, folder exclusion, text)")
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
