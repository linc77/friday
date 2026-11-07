import Foundation
import UniformTypeIdentifiers

struct TaskAttachmentInput: Sendable {
    let data: Data
    let name: String
    let mediaType: String
    let isImage: Bool
}
enum TaskAttachmentImport {
    static let maximumBytes = 50 * 1024 * 1024
    static let maximumCount = 100
    private static func failure(_ message: String) -> CocoaError { CocoaError(.fileReadUnknown, userInfo: [NSLocalizedDescriptionKey: message]) }
    static func read(_ url: URL) throws -> TaskAttachmentInput {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey, .isRegularFileKey])
        guard url.isFileURL, values.isRegularFile == true else { throw failure("请选择普通文件。") }
        guard let size = values.fileSize, size > 0, size <= maximumBytes else { throw failure("附件不能为空，且不能超过 50 MB") }
        let handle = try FileHandle(forReadingFrom: url); defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard !data.isEmpty, data.count <= maximumBytes else { throw failure("附件不能为空，且不能超过 50 MB") }
        let mediaType = values.contentType?.preferredMIMEType ?? "application/octet-stream"
        return TaskAttachmentInput(data: data, name: url.lastPathComponent, mediaType: mediaType, isImage: values.contentType?.conforms(to: .image) == true && mediaType != "image/svg+xml")
    }
    static func input(from provider: NSItemProvider) async throws -> TaskAttachmentInput {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            let url: URL = try await withCheckedThrowingContinuation { continuation in
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { value, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let url = value as? URL { continuation.resume(returning: url) }
                    else if let bytes = value as? Data, let url = URL(dataRepresentation: bytes, relativeTo: nil) { continuation.resume(returning: url) }
                    else { continuation.resume(throwing: failure("无法读取附件文件。")) }
                }
            }
            return try await Task.detached(priority: .userInitiated) { try read(url) }.value
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else { throw failure("无法读取图片。") }
            let data: Data = try await withCheckedThrowingContinuation { continuation in
                provider.loadDataRepresentation(forTypeIdentifier: type) { data, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let data { continuation.resume(returning: data) }
                    else { continuation.resume(throwing: failure("无法读取图片。")) }
                }
            }
            guard !data.isEmpty, data.count <= maximumBytes else { throw failure("附件不能为空，且不能超过 50 MB") }
            let mediaType = UTType(type)?.preferredMIMEType ?? "image/png"
            return TaskAttachmentInput(data: data, name: provider.suggestedName ?? "粘贴的图片.png", mediaType: mediaType, isImage: mediaType != "image/svg+xml")
        }
        guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) else { throw failure("无法读取附件文件。") }
        // A provider's file representation is temporary: copy its bytes while
        // inside the callback, with the same size/regular-file checks as a picker.
        return try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url else { continuation.resume(throwing: failure("无法读取附件文件。")); return }
                do { continuation.resume(returning: try read(url)) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }
}
