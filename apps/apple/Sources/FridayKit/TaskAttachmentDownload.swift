import SwiftUI
import UniformTypeIdentifiers
import CryptoKit

private struct TaskAttachmentDocument: FileDocument {
    static var readableContentTypes: [UTType] { [.data] }
    var bytes: Data
    init(bytes: Data) { self.bytes = bytes }
    init(configuration: ReadConfiguration) throws { bytes = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: bytes) }
}
struct TaskAttachmentDownload: View {
    @ObservedObject var store: FridayStore
    let reference: TaskContextReference
    let scope: TaskContextScope
    @State private var downloading = false
    @State private var exporting = false
    @State private var bytes = Data()
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: (reference.mediaType ?? "application/octet-stream") + " · " + ByteCountFormatter.string(fromByteCount: Int64(reference.byteLength), countStyle: .file))
                .font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button {
                    guard !downloading else { return }
                    let identity = store.connectionIdentity; downloading = true; error = nil
                    Task { @MainActor in
                        defer { if identity == store.connectionIdentity { downloading = false } }
                        do {
                            let data = try await store.connection.data("/api/task-contexts/\(reference.id)/content?\(scope.query)", timeout: 180)
                            let digest = await Task.detached(priority: .userInitiated) { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }.value
                            guard identity == store.connectionIdentity else { return }
                            guard data.count == reference.byteLength, digest == reference.digest else { throw ConnectionError.message("附件内容已改变，请重新添加") }
                            bytes = data; exporting = true
                        } catch { if identity == store.connectionIdentity { self.error = error.localizedDescription } }
                    }
                } label: { FridaySymbolLabel(friday: "保存附件", systemImage: "arrow.down.doc") }
                    .buttonStyle(FridayButtonStyle(compact: true)).disabled(downloading || !store.connected)
                if downloading { ProgressView().controlSize(.small) }
            }
            if let error { Text(fridayString: error).font(.caption).foregroundStyle(.orange) }
        }
        .fileExporter(isPresented: $exporting, document: TaskAttachmentDocument(bytes: bytes), contentType: UTType(mimeType: reference.mediaType ?? "") ?? .data, defaultFilename: reference.attachmentName ?? reference.label) { result in
            bytes = Data()
            if case .failure(let failure) = result { error = failure.localizedDescription }
        }
        .onChange(of: store.connectionIdentity) { _, _ in exporting = false; downloading = false; bytes = Data(); error = nil }
    }
}
