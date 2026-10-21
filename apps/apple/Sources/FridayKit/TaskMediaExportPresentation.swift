import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
typealias TaskMediaExportWindow = NSWindow
#else
import UIKit
typealias TaskMediaExportWindow = UIWindow
#endif

@MainActor final class TaskMediaExportController: ObservableObject {
    @Published private(set) var busy = false
    @Published private(set) var fraction: Double?
    @Published private(set) var status: String?
    @Published var error: String?
    private var operation: Task<Void, Never>?
    func cancel() { operation?.cancel() }
    func perform(_ action: TaskMediaAction, source: TaskMediaActionSource, window: TaskMediaExportWindow? = nil) {
        if action == .openFile { source.openFile?(); return }
        if let text = source.reference.text(for: action) {
            #if os(macOS)
            NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            #else
            UIPasteboard.general.string = text
            #endif
            status = action == .copyURL ? "链接已复制" : "路径已复制"; dismissStatusLater(); return
        }
        guard !busy, let prepare = source.prepare else { return }
        let presenter = TaskMediaExportDestination(window: window)
        presenter.onClose = { [weak self] in self?.cancel() }
        busy = true; error = nil; fraction = nil; status = action == .copyImage ? "正在复制图片…" : "正在准备下载…"
        operation = Task { [self] in
            defer { busy = false; operation = nil; dismissStatusLater() }
            do {
                let request = try await prepare(); try Task.checkCancellation()
                let file = try await TaskMediaDownload.load(request) { [weak self] fraction in Task { @MainActor in self?.fraction = fraction } }
                defer { file.remove() }; try Task.checkCancellation()
                if action == .copyImage {
                    let png = try await TaskMediaImageCopy.png(file); try Task.checkCancellation()
                    #if os(macOS)
                    NSPasteboard.general.clearContents(); guard NSPasteboard.general.setData(png, forType: .png) else { throw TaskMediaExportError.invalidFile }
                    #else
                    UIPasteboard.general.setData(png, forPasteboardType: UTType.png.identifier)
                    #endif
                    status = "图片已复制"
                } else {
                    status = "选择保存位置"
                    let saved = try await presenter.save(file, name: TaskMediaExportFile.name(source.name, mimeType: file.mimeType))
                    status = saved ? "文件已保存" : nil
                }
            } catch is CancellationError { status = nil }
            catch { if !Task.isCancelled { self.error = error.localizedDescription }; status = nil }
        }
    }
    private func dismissStatusLater() {
        let value = status
        Task { [weak self] in try? await Task.sleep(for: .seconds(3)); if let self, !self.busy, self.status == value { self.status = nil } }
    }
}

private struct TaskMediaExportStatus: ViewModifier {
    @ObservedObject var controller: TaskMediaExportController
    func body(content: Content) -> some View {
        content.overlay(alignment: .bottomTrailing) {
          Group {
            if let error = controller.error {
                HStack { Text(fridayString: error).textSelection(.enabled); Spacer(); Button(friday: "关闭") { controller.error = nil } }.font(.caption).padding(8).buttonStyle(FridayButtonStyle(compact: true))
            } else if let status = controller.status {
                HStack(spacing: 8) {
                    if controller.busy { if let fraction = controller.fraction { ProgressView(value: fraction).frame(maxWidth: 160) } else { ProgressView().controlSize(.small) } }
                    Text(fridayString: status).font(.caption); Spacer()
                    if controller.busy { Button(friday: "取消") { controller.cancel() }.buttonStyle(FridayButtonStyle(compact: true)) }
                }.padding(8)
            }
          }.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8)).padding(8)
        }
    }
}
extension View {
    func taskMediaExportStatus(_ controller: TaskMediaExportController) -> some View { modifier(TaskMediaExportStatus(controller: controller)) }
    func taskMediaActions(_ source: TaskMediaActionSource?, controller: TaskMediaExportController) -> some View {
        contextMenu {
            if let source { ForEach(source.actions, id: \.self) { action in
                Button { controller.perform(action, source: source) } label: { FridaySymbolLabel(friday: action.label(kind: source.kind), systemImage: action.symbol) }
                    .disabled([TaskMediaAction.save, .copyImage].contains(action) && (controller.busy || source.prepare == nil))
            } }
        }.help(source?.reference.tooltip ?? "")
    }
}
extension TaskMediaAction {
    func localizedLabel(kind: TaskMediaActionKind) -> String {
        let language = UserDefaults.standard.string(forKey: FridayPreferenceKeys.language) ?? "zh-Hans"
        let bundle = Bundle.module.path(forResource: language, ofType: "lproj").flatMap(Bundle.init(path:)) ?? .module
        let key = label(kind: kind); return bundle.localizedString(forKey: key, value: key, table: nil)
    }
    func label(kind: TaskMediaActionKind) -> String {
        switch self { case .copyFullPath: "复制绝对路径"; case .copyRelativePath: "复制相对路径"; case .copyURL: "复制链接"; case .copyImage: "复制图片"; case .openFile: "在文件预览中打开"; case .save: kind == .image ? "保存图片" : "保存视频" }
    }
    var symbol: String { switch self { case .copyFullPath, .copyRelativePath, .copyURL: "doc.on.doc"; case .save: "square.and.arrow.down"; case .copyImage: "photo.on.rectangle"; case .openFile: "doc.text.magnifyingglass" } }
}

@MainActor private final class TaskMediaExportDestination: NSObject {
    private weak var window: TaskMediaExportWindow?
    private var observer: NSObjectProtocol?
    private var closed = false
    var onClose: (() -> Void)?
    #if !os(macOS)
    private var continuation: CheckedContinuation<Bool, Error>?
    #endif
    init(window: TaskMediaExportWindow?) {
        #if os(macOS)
        self.window = window ?? NSApplication.shared.keyWindow
        #else
        self.window = window ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow)
        #endif
        super.init()
        #if os(macOS)
        if let window = self.window { observer = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: window, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.closed = true; self?.onClose?() } } }
        #else
        if let scene = self.window?.windowScene { observer = NotificationCenter.default.addObserver(forName: UIScene.didDisconnectNotification, object: scene, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.closed = true; self?.onClose?() } } }
        #endif
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    private func visibleWindow() async throws -> TaskMediaExportWindow {
        while true {
            try Task.checkCancellation(); guard let window, !closed else { throw CancellationError() }
            #if os(macOS)
            if window.isVisible && !window.isMiniaturized && !NSApplication.shared.isHidden { return window }
            #else
            guard window.windowScene?.activationState != .unattached else { throw CancellationError() }
            if window.windowScene?.activationState == .foregroundActive && !window.isHidden { return window }
            #endif
            try await Task.sleep(for: .milliseconds(250))
        }
    }
    func save(_ file: TaskMediaDownloadedFile, name: String) async throws -> Bool {
        let window = try await visibleWindow()
        #if os(macOS)
        let panel = NSSavePanel(); panel.nameFieldStringValue = name; panel.canCreateDirectories = true; panel.allowsOtherFileTypes = true
        if let type = UTType(filenameExtension: URL(fileURLWithPath: name).pathExtension) { panel.allowedContentTypes = [type] }
        let destination: URL? = await withTaskCancellationHandler(operation: {
            await withCheckedContinuation { continuation in panel.beginSheetModal(for: window) { response in continuation.resume(returning: response == .OK ? panel.url : nil) } }
        }, onCancel: { Task { @MainActor in panel.cancel(nil) } })
        try Task.checkCancellation(); guard let destination else { return false }
        try await Task.detached(priority: .userInitiated) { try TaskMediaExportFile.install(file, at: destination) }.value; return true
        #else
        guard var presenter = window.rootViewController else { throw CancellationError() }
        while let next = presenter.presentedViewController, !next.isBeingDismissed { presenter = next }
        let folder = file.directory.appendingPathComponent("export", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let named = folder.appendingPathComponent(name); try FileManager.default.copyItem(at: file.url, to: named)
        let picker = UIDocumentPickerViewController(forExporting: [named], asCopy: true); picker.delegate = self
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation; picker.presentationController?.delegate = self
                presenter.present(picker, animated: true) { picker.presentationController?.delegate = self }
            }
        }, onCancel: { Task { @MainActor [weak self] in picker.dismiss(animated: true); self?.continuation?.resume(throwing: CancellationError()); self?.continuation = nil } })
        #endif
    }
}
#if !os(macOS)
extension TaskMediaExportDestination: UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { continuation?.resume(returning: !urls.isEmpty); continuation = nil }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { continuation?.resume(returning: false); continuation = nil }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { continuation?.resume(returning: false); continuation = nil }
}
#endif
